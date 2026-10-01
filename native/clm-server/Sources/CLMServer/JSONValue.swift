import Foundation

/// JSON value with insertion-ordered objects and int/double distinction,
/// mirroring Python's `json` module semantics that the CLM schema depends on
/// (key order for candidate texts, `str(int)` vs `str(float)` rendering).
public indirect enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object(OrderedObject)

    public var isNull: Bool { if case .null = self { return true }; return false }

    /// Object member lookup; nil for non-objects or missing keys.
    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    /// Array element lookup; nil for non-arrays or out-of-bounds.
    public subscript(index: Int) -> JSONValue? {
        if case .array(let a) = self, index >= 0, index < a.count { return a[index] }
        return nil
    }
}

/// Order-preserving string-keyed map with Python dict duplicate-key semantics:
/// first insertion fixes the position, the last value wins.
public struct OrderedObject: Sendable, Equatable {
    public private(set) var keys: [String] = []
    var map: [String: JSONValue] = [:]

    public init() {}

    public init(_ pairs: [(String, JSONValue)]) {
        for (k, v) in pairs { self[k] = v }
    }

    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }

    public subscript(key: String) -> JSONValue? {
        get { map[key] }
        set {
            if let newValue {
                if map[key] == nil { keys.append(key) }
                map[key] = newValue
            } else {
                if map[key] != nil {
                    keys.removeAll { $0 == key }
                    map[key] = nil
                }
            }
        }
    }

    public var pairs: [(String, JSONValue)] { keys.map { ($0, map[$0]!) } }
}

public struct JSONError: Error, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

// MARK: - Parsing

/// Strict JSON parser producing `JSONValue` with ordered objects.
/// Mirrors Python `json.loads` with a `parse_constant` hook: `NaN`/`Infinity`
/// literals are recognized and rejected as non-finite numbers.
public enum JSONParser {
    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Array(text.utf8))
    }

    public static func parse(_ bytes: [UInt8]) throws -> JSONValue {
        var p = Parser(bytes: bytes)
        p.skipWhitespace()
        let value = try p.parseValue()
        p.skipWhitespace()
        guard p.atEnd else { throw p.pyMessage("Extra data") }
        return value
    }

    struct Parser {
        let bytes: [UInt8]
        var pos = 0

        init(bytes: [UInt8]) { self.bytes = bytes }

        /// Python `json.loads`-style message: "Expecting value: line 1 column 1 (char 0)".
        func pyMessage(_ message: String, at index: Int? = nil) -> JSONError {
            let i = index ?? pos
            var line = 1
            var lineStart = 0
            for (j, b) in bytes.enumerated() where j < i {
                if b == 0x0A { line += 1; lineStart = j + 1 }
            }
            let column = i - lineStart + 1
            return JSONError("\(message): line \(line) column \(column) (char \(i))")
        }

        var atEnd: Bool { pos >= bytes.count }

        mutating func skipWhitespace() {
            while pos < bytes.count {
                switch bytes[pos] {
                case 0x20, 0x09, 0x0A, 0x0D: pos += 1
                default: return
                }
            }
        }

        mutating func parseValue() throws -> JSONValue {
            guard !atEnd else { throw pyMessage("Expecting value") }
            switch bytes[pos] {
            case UInt8(ascii: "{"): return try parseObject()
            case UInt8(ascii: "["): return try parseArray()
            case UInt8(ascii: "\""): return .string(try parseString())
            case UInt8(ascii: "t"): try expect("true"); return .bool(true)
            case UInt8(ascii: "f"): try expect("false"); return .bool(false)
            case UInt8(ascii: "n"): try expect("null"); return .null
            case UInt8(ascii: "N"), UInt8(ascii: "I"):
                if isNonFiniteLiteral() {
                    throw JSONError("non-finite JSON number")
                }
                throw pyMessage("Expecting value")
            case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"):
                if bytes[pos] == UInt8(ascii: "-"), isNonFiniteLiteral() {
                    throw JSONError("non-finite JSON number")
                }
                return try parseNumber()
            default:
                throw pyMessage("Expecting value")
            }
        }

        func isNonFiniteLiteral() -> Bool {
            let rest = bytes[pos...]
            return rest.starts(with: Array("NaN".utf8))
                || rest.starts(with: Array("Infinity".utf8))
                || rest.starts(with: Array("-Infinity".utf8))
        }

        mutating func expect(_ word: String) throws {
            let w = Array(word.utf8)
            guard bytes[pos...].starts(with: w) else {
                throw pyMessage("Expecting value")
            }
            pos += w.count
        }

        mutating func parseObject() throws -> JSONValue {
            pos += 1 // {
            var obj = OrderedObject()
            skipWhitespace()
            if pos < bytes.count, bytes[pos] == UInt8(ascii: "}") {
                pos += 1
                return .object(obj)
            }
            while true {
                skipWhitespace()
                guard !atEnd, bytes[pos] == UInt8(ascii: "\"") else {
                    throw pyMessage("Expecting property name enclosed in double quotes")
                }
                let key = try parseString()
                skipWhitespace()
                guard !atEnd, bytes[pos] == UInt8(ascii: ":") else {
                    throw pyMessage("Expecting ':' delimiter")
                }
                pos += 1
                skipWhitespace()
                let value = try parseValue()
                obj[key] = value
                skipWhitespace()
                guard !atEnd else { throw pyMessage("Expecting ',' delimiter") }
                if bytes[pos] == UInt8(ascii: ",") { pos += 1; continue }
                if bytes[pos] == UInt8(ascii: "}") { pos += 1; return .object(obj) }
                throw pyMessage("Expecting ',' delimiter")
            }
        }

        mutating func parseArray() throws -> JSONValue {
            pos += 1 // [
            var items: [JSONValue] = []
            skipWhitespace()
            if pos < bytes.count, bytes[pos] == UInt8(ascii: "]") {
                pos += 1
                return .array(items)
            }
            while true {
                skipWhitespace()
                items.append(try parseValue())
                skipWhitespace()
                guard !atEnd else { throw pyMessage("Expecting ',' delimiter") }
                if bytes[pos] == UInt8(ascii: ",") { pos += 1; continue }
                if bytes[pos] == UInt8(ascii: "]") { pos += 1; return .array(items) }
                throw pyMessage("Expecting ',' delimiter")
            }
        }

        mutating func parseString() throws -> String {
            let stringStart = pos
            pos += 1 // opening quote
            var out: [UInt8] = []
            while pos < bytes.count {
                let b = bytes[pos]
                if b == UInt8(ascii: "\"") {
                    pos += 1
                    guard let s = String(bytes: out, encoding: .utf8) else {
                        throw JSONError("invalid UTF-8 in string")
                    }
                    return s
                }
                if b == UInt8(ascii: "\\") {
                    pos += 1
                    guard pos < bytes.count else {
                        throw pyMessage("Unterminated string starting at", at: stringStart)
                    }
                    let e = bytes[pos]
                    switch e {
                    case UInt8(ascii: "\""): out.append(UInt8(ascii: "\""))
                    case UInt8(ascii: "\\"): out.append(UInt8(ascii: "\\"))
                    case UInt8(ascii: "/"): out.append(UInt8(ascii: "/"))
                    case UInt8(ascii: "b"): out.append(0x08)
                    case UInt8(ascii: "f"): out.append(0x0C)
                    case UInt8(ascii: "n"): out.append(0x0A)
                    case UInt8(ascii: "r"): out.append(0x0D)
                    case UInt8(ascii: "t"): out.append(0x09)
                    case UInt8(ascii: "u"):
                        let first = try parseUnicodeEscape()
                        if first >= 0xD800 && first <= 0xDBFF {
                            // surrogate pair
                            guard pos + 1 < bytes.count,
                                  bytes[pos + 1] == UInt8(ascii: "\\"),
                                  pos + 2 < bytes.count,
                                  bytes[pos + 2] == UInt8(ascii: "u")
                            else { throw pyMessage("Invalid \\escape") }
                            pos += 1
                            let second = try parseUnicodeEscape()
                            guard second >= 0xDC00 && second <= 0xDFFF else {
                                throw JSONError("invalid surrogate pair")
                            }
                            let scalar = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
                            guard let us = Unicode.Scalar(scalar) else {
                                throw JSONError("invalid unicode scalar")
                            }
                            appendScalar(us, to: &out)
                        } else if first >= 0xDC00 && first <= 0xDFFF {
                            throw pyMessage("Invalid \\escape")
                        } else if let us = Unicode.Scalar(first) {
                            appendScalar(us, to: &out)
                        } else {
                            throw JSONError("invalid unicode scalar")
                        }
                    default:
                        throw pyMessage("Invalid \\escape", at: pos - 1)
                    }
                    pos += 1
                } else if b < 0x20 {
                    throw pyMessage("Invalid control character at")
                } else {
                    out.append(b)
                    pos += 1
                }
            }
            throw pyMessage("Unterminated string starting at", at: stringStart)
        }

        func appendScalar(_ us: Unicode.Scalar, to out: inout [UInt8]) {
            out.append(contentsOf: Array(String(Character(us)).utf8))
        }

        /// Parses the 4 hex digits after `\u`; `pos` must sit on `u`.
        mutating func parseUnicodeEscape() throws -> UInt32 {
            pos += 1 // u
            guard pos + 4 <= bytes.count else { throw JSONError("truncated \\u escape") }
            var value: UInt32 = 0
            for _ in 0..<4 {
                let c = bytes[pos]
                let digit: UInt32
                switch c {
                case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt32(c - UInt8(ascii: "0"))
                case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt32(c - UInt8(ascii: "a")) + 10
                case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt32(c - UInt8(ascii: "A")) + 10
                default: throw JSONError("invalid hex digit in \\u escape")
                }
                value = value << 4 | digit
                pos += 1
            }
            return value
        }

        mutating func parseNumber() throws -> JSONValue {
            let start = pos
            var isDouble = false
            if pos < bytes.count, bytes[pos] == UInt8(ascii: "-") { pos += 1 }
            guard pos < bytes.count, bytes[pos].isDigit else {
                throw pyMessage("Expecting value", at: start)
            }
            if bytes[pos] == UInt8(ascii: "0") {
                pos += 1
            } else {
                while pos < bytes.count, bytes[pos].isDigit { pos += 1 }
            }
            if pos < bytes.count, bytes[pos] == UInt8(ascii: ".") {
                isDouble = true
                pos += 1
                guard pos < bytes.count, bytes[pos].isDigit else {
                    throw pyMessage("Expecting value")
                }
                while pos < bytes.count, bytes[pos].isDigit { pos += 1 }
            }
            if pos < bytes.count, bytes[pos] == UInt8(ascii: "e") || bytes[pos] == UInt8(ascii: "E") {
                isDouble = true
                pos += 1
                if pos < bytes.count, bytes[pos] == UInt8(ascii: "+") || bytes[pos] == UInt8(ascii: "-") { pos += 1 }
                guard pos < bytes.count, bytes[pos].isDigit else {
                    throw pyMessage("Expecting value")
                }
                while pos < bytes.count, bytes[pos].isDigit { pos += 1 }
            }
            let text = String(bytes: bytes[start..<pos], encoding: .utf8)!
            if !isDouble, let i = Int64(text) { return .int(i) }
            guard let d = Double(text) else { throw pyMessage("Expecting value", at: start) }
            return .double(d)
        }
    }
}

extension UInt8 {
    var isDigit: Bool { self >= UInt8(ascii: "0") && self <= UInt8(ascii: "9") }
}

// MARK: - Serialization

/// Serializes with Python `json.dumps` defaults: `ensure_ascii=False`,
/// `allow_nan=False`, separators `", "` / `": "`.
public enum JSONSerializer {
    public static func serialize(_ value: JSONValue) throws -> String {
        var out = ""
        try write(value, into: &out)
        return out
    }

    static func write(_ value: JSONValue, into out: inout String) throws {
        switch value {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .double(let d): out += try formatDouble(d)
        case .string(let s):
            writeString(s, into: &out)
        case .array(let items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += ", " }
                try write(item, into: &out)
            }
            out += "]"
        case .object(let obj):
            out += "{"
            for (i, (k, v)) in obj.pairs.enumerated() {
                if i > 0 { out += ", " }
                writeString(k, into: &out)
                out += ": "
                try write(v, into: &out)
            }
            out += "}"
        }
    }

    /// Shortest round-trip formatting, matching Python `repr(float)` for the
    /// common cases (Swift's description is also shortest round-trip).
    static func formatDouble(_ d: Double) throws -> String {
        guard d.isFinite else { throw JSONError("non-finite JSON number") }
        return d.description
    }

    static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case Unicode.Scalar(0x08): out += "\\b"
            case Unicode.Scalar(0x0C): out += "\\f"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}
