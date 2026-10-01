import Testing
import Foundation
@testable import CLMServer

struct JSONValueTests {
    @Test func parsesAndPreservesObjectOrder() throws {
        let value = try JSONParser.parse(#"{"b": 1, "a": 2, "c": {"z": true, "y": null}}"#)
        guard case .object(let obj) = value else {
            Issue.record("expected object"); return
        }
        #expect(obj.keys == ["b", "a", "c"])
        #expect(obj["a"] == .int(2))
        #expect(obj["c"]?["z"] == .bool(true))
        #expect(obj["c"]?["y"] == .null)
    }

    @Test func duplicateKeysKeepFirstPositionLastValue() throws {
        let value = try JSONParser.parse(#"{"a": 1, "b": 2, "a": 3}"#)
        guard case .object(let obj) = value else {
            Issue.record("expected object"); return
        }
        #expect(obj.keys == ["a", "b"])
        #expect(obj["a"] == .int(3))
    }

    @Test func intVsDoublePreserved() throws {
        let value = try JSONParser.parse(#"{"i": 2, "d": 2.0, "e": 2e3, "neg": -7}"#)
        #expect(value["i"] == .int(2))
        #expect(value["d"] == .double(2.0))
        #expect(value["e"] == .double(2000))
        #expect(value["neg"] == .int(-7))
    }

    @Test func stringEscapesAndUnicode() throws {
        let value = try JSONParser.parse(
            #"{"s": "a\"b\\c\/\b\f\n\r\t😀", "u": "é"}"#)
        #expect(value["s"]?.stringValue == "a\"b\\c/\u{08}\u{0C}\n\r\t😀")
        #expect(value["u"]?.stringValue == "é")
    }

    @Test func rejectsNonFiniteLikePythonsParseConstant() {
        #expect(throws: JSONError.self) {
            _ = try JSONParser.parse(#"{"x": NaN}"#)
        }
        #expect(throws: JSONError.self) {
            _ = try JSONParser.parse(#"{"x": Infinity}"#)
        }
        #expect(throws: JSONError.self) {
            _ = try JSONParser.parse(#"{"x": -Infinity}"#)
        }
        // exact python message
        do {
            _ = try JSONParser.parse(#"{"x": NaN}"#)
            Issue.record("should throw")
        } catch let e as JSONError {
            #expect(e.message == "non-finite JSON number")
        } catch {
            Issue.record("wrong error type")
        }
    }

    @Test func pythonStyleErrorMessages() throws {
        func message(_ text: String) -> String {
            do {
                _ = try JSONParser.parse(text)
                return "<no error>"
            } catch let e as JSONError {
                return e.message
            } catch {
                return "<other>"
            }
        }
        // expected values verified against python json.loads
        #expect(message("not json") == "Expecting value: line 1 column 1 (char 0)")
        #expect(message(#"{"a": 1} extra"#) == "Extra data: line 1 column 10 (char 9)")
        #expect(message("1 x") == "Extra data: line 1 column 3 (char 2)")
        #expect(message(#"{a: 1}"#) == "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)")
        #expect(message(#"{"a" 1}"#) == "Expecting ':' delimiter: line 1 column 6 (char 5)")
        #expect(message(#"{"a": 1 "b"}"#) == "Expecting ',' delimiter: line 1 column 9 (char 8)")
        #expect(message("[1 2]") == "Expecting ',' delimiter: line 1 column 4 (char 3)")
        #expect(message(#"{"a": "\q"}"#) == "Invalid \\escape: line 1 column 8 (char 7)")
        #expect(message("\"abc") == "Unterminated string starting at: line 1 column 1 (char 0)")
        #expect(message("\"ab\tc\"") == "Invalid control character at: line 1 column 4 (char 3)")
        #expect(message("[1,\n2") == "Expecting ',' delimiter: line 2 column 2 (char 5)")
    }

    @Test func serializesWithPythonDefaults() throws {
        let value = JSONValue.object(OrderedObject([
            ("b", .int(1)),
            ("a", .double(2.5)),
            ("s", .string("é\"x")),
            ("arr", .array([.bool(true), .null])),
        ]))
        let text = try JSONSerializer.serialize(value)
        #expect(text == #"{"b": 1, "a": 2.5, "s": "é\"x", "arr": [true, null]}"#)
    }

    @Test func rejectsNaNOnSerialize() {
        #expect(throws: JSONError.self) {
            _ = try JSONSerializer.serialize(.double(.nan))
        }
    }
}

struct ValidationTests {
    func validPayload(_ mutate: (inout OrderedObject) -> Void = { _ in }) throws -> JSONValue {
        var obj = OrderedObject()
        obj["model"] = .string("clm-latest")
        obj["state"] = .string("hello")
        obj["questions"] = .object(OrderedObject([
            ("q", .object(OrderedObject([
                ("type", .string("choice")),
                ("criteria", .object(OrderedObject([("a", .string("A")), ("b", .string("B"))]))),
            ]))),
        ]))
        mutate(&obj)
        return .object(obj)
    }

    @Test func acceptsValidPayloadWithDefaults() throws {
        let (state, questions, temperature) = try validate(validPayload())
        #expect(state == .string("hello"))
        #expect(questions.count == 1)
        #expect(temperature == 1.0)
    }

    @Test func mapsBoolToNoulAndKeepsOrder() throws {
        let payload = JSONValue.object(OrderedObject([
            ("model", .string("clm-latest")),
            ("state", .null),
            ("questions", .object(OrderedObject([
                ("b", .object(OrderedObject([("type", .string("bool")), ("instructions", .string("ok?"))]))),
                ("a", .object(OrderedObject([("type", .string("score")), ("criteria", .array([.int(1), .int(2)]))]))),
            ]))),
        ]))
        let (_, questions, _) = try validate(payload)
        #expect(questions.keys == ["b", "a"])
        #expect(questions["b"]?["type"] == .string("noul"))
    }

    @Test func missingModelDefaultsToLatest() throws {
        let payload = JSONValue.object(OrderedObject([
            ("state", .string("x")),
            ("questions", .object(OrderedObject([
                ("q", .object(OrderedObject([("type", .string("noul"))]))),
            ]))),
        ]))
        #expect(throws: Never.self) { _ = try validate(payload) }
    }

    @Test func errorMessagesMatchPython() {
        func run(_ payload: JSONValue) -> String {
            do {
                _ = try validate(payload)
                return "<no error>"
            } catch RequestValidationError.message(let m) {
                return m
            } catch Schema.SchemaError.message(let m) {
                return m
            } catch {
                return "<other: \(error)>"
            }
        }
        #expect(run(.int(5)) == "request must be an object")
        #expect(run(JSONValue.object(OrderedObject([("model", .string("x"))]))) == "unknown model")
        #expect(run(JSONValue.object(OrderedObject([("model", .string("clm-latest"))]))) == "state is required")

        var noQ = OrderedObject()
        noQ["model"] = .string("clm-latest")
        noQ["state"] = .null
        #expect(run(.object(noQ)) == "questions must contain 1–64 questions")
        noQ["questions"] = .array([])
        #expect(run(.object(noQ)) == "questions must contain 1–64 questions")

        var badQ = noQ
        badQ["questions"] = .object(OrderedObject([("q", .int(3))]))
        #expect(run(.object(badQ)) == "each question must be an object")

        badQ["questions"] = .object(OrderedObject([
            ("q", .object(OrderedObject([("type", .string("rank"))]))),
        ]))
        #expect(run(.object(badQ)) == "unknown question type 'rank'; expected one of ('noul', 'choice', 'score')")

        var temp = noQ
        temp["questions"] = .object(OrderedObject([
            ("q", .object(OrderedObject([("type", .string("noul"))]))),
        ]))
        temp["temperature"] = .bool(true)
        #expect(run(.object(temp)) == "temperature must be in (0, 100]")
        temp["temperature"] = .double(0)
        #expect(run(.object(temp)) == "temperature must be in (0, 100]")
        temp["temperature"] = .int(101)
        #expect(run(.object(temp)) == "temperature must be in (0, 100]")
        temp["temperature"] = .string("2")
        #expect(run(.object(temp)) == "temperature must be in (0, 100]")

        var tooMany = noQ
        let criteria = OrderedObject((0..<300).map { (String($0), .string("c")) })
        tooMany["questions"] = .object(OrderedObject([
            ("q", .object(OrderedObject([("type", .string("choice")), ("criteria", .object(criteria))]))),
        ]))
        #expect(run(.object(tooMany)) == "maximum 256 candidates per question")
    }
}
