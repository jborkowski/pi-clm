import Foundation
import MLX
import Tokenizers

/// CLM engine: frozen Qwen3 encoder + projection heads + LRU projection
/// cache, mirroring `clm_mlx/engine.py`. Inference is serialized by the
/// caller (the server actor); MLX/cache access is never concurrent.
final class CLMEngine: @unchecked Sendable {
    enum HeadKind: String {
        case state
        case action
    }

    enum EngineError: Error, CustomStringConvertible {
        case message(String)

        var description: String {
            switch self {
            case .message(let m): return m
            }
        }
    }

    let encoder: Qwen3Encoder
    let heads: HeadPair
    let tokenizer: Tokenizer
    let maxTokens: Int
    private var cache: [String: MLXArray] = [:]  // key: "\(which)\u{0}\(text)"
    private var cacheOrder: [String] = []        // LRU: least recently used first
    let cacheSize: Int
    private(set) var tokensSpent = 0

    init(modelDir: URL, cacheSize: Int = 50_000, truncation: String = "head") async throws {
        self.maxTokens = 2048
        self.cacheSize = cacheSize
        self.encoder = try Qwen3Encoder(
            encoderDir: modelDir.appendingPathComponent("encoder"),
            maxTokens: maxTokens,
            truncation: truncation)
        self.heads = try HeadPair(headsDir: modelDir.appendingPathComponent("heads"))
        self.tokenizer = try await AutoTokenizer.from(modelFolder: modelDir.appendingPathComponent("encoder"))
    }

    /// Token ids for a text through the Qwen3 tokenizer; empty input maps to
    /// the tokenization of " " (python encoder.ids behaviour).
    func ids(_ text: String) -> [Int] {
        let raw = tokenizer.encode(text: text, addSpecialTokens: false)
        guard !raw.isEmpty else {
            return encoder.clipIds(tokenizer.encode(text: " ", addSpecialTokens: false))
        }
        return encoder.clipIds(raw)
    }


    /// Projections for `texts` under `which`, embedding and caching misses (LRU).
    private func vectors(_ texts: [String], which: HeadKind) -> MLXArray {
        var missing: [String] = []
        var seen = Set<String>()
        for t in texts where cache[key(which, t)] == nil && !seen.contains(t) {
            seen.insert(t)
            missing.append(t)
        }
        if !missing.isEmpty {
            let idLists = missing.map { ids($0) }
            let tokens = idLists.map(\.count).reduce(0, +)
            tokensSpent += tokens
            let emb = encoder.embedIds(idLists)
            let proj = heads.project(emb, which: which)
            eval(proj)
            for (t, v) in zip(missing, proj) {
                store(key(which, t), v)
            }
        }
        for t in texts {
            touch(key(which, t))
        }
        return MLX.stacked(texts.map { cache[key(which, $0)]! }, axis: 0)
    }

    private func key(_ which: HeadKind, _ text: String) -> String {
        "\(which.rawValue)\u{0}\(text)"
    }

    private func store(_ k: String, _ v: MLXArray) {
        if cache[k] == nil {
            cacheOrder.append(k)
        }
        cache[k] = v
        while cacheOrder.count > cacheSize {
            let oldest = cacheOrder.removeFirst()
            cache[oldest] = nil
        }
    }

    private func touch(_ k: String) {
        if let i = cacheOrder.firstIndex(of: k) {
            cacheOrder.remove(at: i)
            cacheOrder.append(k)
        }
    }

    /// Projections for parity verification (uses the same cached path the
    /// engine serves traffic with).
    func vectorsForParity(_ texts: [String], _ which: HeadKind) -> MLXArray {
        vectors(texts, which: which)
    }

    /// state + typed questions -> distributions, same wire format as the
    /// Python Engine.answer. Returns the answers object and usage counters.
    func answer(
        state: JSONValue, questions: OrderedObject, temperature: Double
    ) throws -> (answers: OrderedObject, billingUnits: Int, inputTokens: Int) {
        guard !questions.isEmpty else {
            throw EngineError.message("questions must not be empty")
        }
        guard temperature > 0 && temperature <= 100 else {
            throw EngineError.message("temperature must be in (0, 100]")
        }
        let pairs = try Schema.buildPairs(state: state, questions: questions)
        let before = tokensSpent

        let stateTexts = pairs.map(\.stateText)
        let actionTexts = pairs.flatMap(\.texts)
        let zs = vectors(stateTexts, which: .state)
        let za = vectors(actionTexts, which: .action)

        var answers = OrderedObject()
        var k = 0
        for (i, pair) in pairs.enumerated() {
            let n = pair.texts.count
            let zaSlice = za[k..<k + n]                       // [n, proj]
            let zRow = zs[i].reshaped([heads.projDim, 1])     // [proj, 1]
            let cos = MLX.matmul(zaSlice, zRow).squeezed(axis: 1)  // [n]
            let logits = scalars(cos).map { Double(Float(heads.scale) * $0 / Float(temperature)) }
            answers[pair.qid] = Schema.answerFromLogits(
                q: questions[pair.qid]!, keys: pair.keys, logits: logits)
            k += n
        }
        return (answers, questions.count, tokensSpent - before)
    }

    private func scalars(_ a: MLXArray) -> [Float] {
        (0..<a.dim(0)).map { a[$0].item(Float.self) }
    }
}
