import Foundation

/// Faithful Swift port of `clm_mlx/schema.py` (vendored unchanged from
/// Contrastive-LM/CLM @ bb42c6c5). Builds exactly the same state and
/// candidate texts as upstream — do not change the maths or the layout.
public enum Schema {
    public static let questionTypes = ["noul", "choice", "score"]
    public static let noulKeys = ["false", "true"]

    public enum SchemaError: Error, CustomStringConvertible {
        case message(String)

        public var description: String {
            switch self {
            case .message(let m): return m
            }
        }
    }

    /// Render a state / description (string, object or array) as plain text,
    /// preserving upstream's exact layout. Key order is preserved.
    public static func toText(_ x: JSONValue, indent: Int = 0) -> String {
        let pad = String(repeating: " ", count: indent)
        switch x {
        case .null:
            return ""
        case .string(let s):
            return s
        case .bool(let b):
            return b ? "true" : "false"
        case .int(let i):
            return String(i)
        case .double(let d):
            return pyFloat(d)
        case .array(let items):
            var parts: [String] = []
            for v in items {
                if isNonEmptyContainer(v) {
                    parts.append(pad + "-\n" + toText(v, indent: indent + 2))
                } else {
                    parts.append(pad + "- " + toText(v))
                }
            }
            return parts.joined(separator: "\n")
        case .object(let obj):
            var parts: [String] = []
            for (k, v) in obj.pairs {
                if isNonEmptyContainer(v) {
                    parts.append(pad + k + ":\n" + toText(v, indent: indent + 2))
                } else {
                    parts.append(pad + k + ": " + toText(v))
                }
            }
            return parts.joined(separator: indent == 0 ? "\n\n" : "\n")
        }
    }

    static func isNonEmptyContainer(_ v: JSONValue) -> Bool {
        switch v {
        case .object(let o): return !o.isEmpty
        case .array(let a): return !a.isEmpty
        default: return false
        }
    }

    /// Python `str(float)` — Swift's description is also shortest round-trip.
    static func pyFloat(_ d: Double) -> String {
        d.description
    }

    /// Context first, question last — the layout the heads were trained on.
    public static func stateText(_ state: JSONValue, _ instructions: JSONValue?) -> String {
        let s = toText(state).trimmingCharacters(in: .whitespacesAndNewlines)
        let i = toText(instructions ?? .null).trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty && !i.isEmpty { return s + "\n\n" + i }
        return s.isEmpty ? i : s
    }

    static func normQuestion(_ q: JSONValue) throws -> JSONValue {
        let t = q["type"]
        let name: String
        switch t {
        case .string(let s): name = s
        case .none, .null: name = "None"
        default: name = pyRepr(t ?? .null)
        }
        guard questionTypes.contains(name) else {
            throw SchemaError.message(
                "unknown question type \(pyReprString(name)); expected one of ('noul', 'choice', 'score')")
        }
        return q
    }

    /// -> (option keys in answer order, candidate text per option).
    public static func candidates(_ q: JSONValue) throws -> (keys: [String], texts: [String]) {
        let q = try normQuestion(q)
        let t = q["type"]!.stringValue!
        let crit = q["criteria"]
        let ins = toText(q["instructions"] ?? .null).trimmingCharacters(in: .whitespacesAndNewlines)
        switch t {
        case "choice":
            guard case .object(let c) = crit, !c.isEmpty else {
                throw SchemaError.message("choice question needs a non-empty 'criteria' object")
            }
            // The action head embeds the option's own text: its description
            // when one is given, else the key. Nothing is prefixed.
            let keys = c.keys
            let texts = keys.map { k -> String in
                let v = c[k]!
                if v.isNull || v == .string("") { return k }
                return toText(v)
            }
            return (keys, texts)
        case "score":
            guard case .array(let levels) = crit, levels.count >= 2 else {
                throw SchemaError.message("score question needs 'criteria' as an ordered list of >= 2 levels")
            }
            let keys = (0..<levels.count).map { String($0) }
            return (keys, levels.map { toText($0) })
        default: // noul
            var texts: [String] = []
            for k in noulKeys {
                var d: JSONValue?
                if case .object(let c) = crit { d = c[k] }
                if d == nil || d!.isNull || d! == .string("") {
                    if !ins.isEmpty {
                        d = .string(k == "true" ? "Yes. This is true: \(ins)" : "No. This is false: \(ins)")
                    } else {
                        d = .string(k)
                    }
                }
                texts.append("\(k): \(toText(d!))")
            }
            return (noulKeys, texts)
        }
    }

    /// {qid: (state_text, option_keys, candidate_texts)} in question order.
    public static func buildPairs(
        state: JSONValue, questions: OrderedObject
    ) throws -> [(qid: String, stateText: String, keys: [String], texts: [String])] {
        var result: [(String, String, [String], [String])] = []
        for (qid, q) in questions.pairs {
            let st = stateText(state, q["instructions"])
            let (keys, texts) = try candidates(q)
            result.append((qid, st, keys, texts))
        }
        return result
    }

    // MARK: - Answer assembly

    public static func softmax(_ logits: [Double]) -> [Double] {
        let m = logits.max() ?? 0
        let e = logits.map { exp($0 - m) }
        let z = e.reduce(0, +)
        return e.map { $0 / z }
    }

    /// TypeSafe-style confidence: top probability minus the mean of the rest.
    public static func confidence(_ probs: [Double]) -> Double {
        if probs.count < 2 { return 1.0 }
        let j = argmax(probs)
        let rest = probs.enumerated().filter { $0.offset != j }.map { $0.element }
        return max(0.0, min(1.0, probs[j] - rest.reduce(0, +) / Double(rest.count)))
    }

    static func argmax(_ a: [Double]) -> Int {
        var j = 0
        for i in 1..<a.count where a[i] > a[j] { j = i }
        return j
    }

    /// Assemble the answer object for question `q` from its option distribution.
    public static func answerFromProbs(
        q: JSONValue, keys: [String], probs: [Double]
    ) -> JSONValue {
        let t = q["type"]!.stringValue!
        var dist = OrderedObject()
        for (k, p) in zip(keys, probs) { dist[k] = .double(p) }
        switch t {
        case "noul":
            var noul = OrderedObject()
            noul["type"] = .string("noul")
            noul["noul"] = dist["true"]!
            return .object(noul)
        case "choice":
            let j = argmax(probs)
            var choice = OrderedObject()
            choice["type"] = .string("choice")
            choice["choice"] = .string(keys[j])
            choice["confidence"] = .double(confidence(probs))
            choice["probabilities"] = .object(dist)
            return .object(choice)
        default: // score
            var score = 0.0
            for (i, prob) in probs.enumerated() { score += Double(i) * prob }
            var legend = OrderedObject()
            if case .array(let levels) = q["criteria"] {
                for (i, c) in levels.enumerated() {
                    if case .string(let s) = c {
                        legend[String(i)] = .string(s)
                    } else {
                        legend[String(i)] = .string(toText(c))
                    }
                }
            }
            var answer = OrderedObject()
            answer["type"] = .string("score")
            answer["score"] = .double(score)
            answer["confidence"] = .double(confidence(probs))
            answer["legend"] = .object(legend)
            answer["probabilities"] = .object(dist)
            return .object(answer)
        }
    }

    public static func answerFromLogits(
        q: JSONValue, keys: [String], logits: [Double]
    ) -> JSONValue {
        answerFromProbs(q: q, keys: keys, probs: softmax(logits))
    }

    // MARK: - Python repr helpers (error-message parity)

    static func pyRepr(_ v: JSONValue) -> String {
        switch v {
        case .null: return "None"
        case .bool(let b): return b ? "True" : "False"
        case .int(let i): return String(i)
        case .double(let d): return pyFloat(d)
        case .string(let s): return pyReprString(s)
        case .array(let a): return "[" + a.map(pyRepr).joined(separator: ", ") + "]"
        case .object(let o):
            return "{" + o.pairs.map { pyReprString($0.0) + ": " + pyRepr($0.1) }.joined(separator: ", ") + "}"
        }
    }

    static func pyReprString(_ s: String) -> String {
        "'" + s + "'"
    }
}

extension JSONValue {
    /// String value if this is a string.
    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}
