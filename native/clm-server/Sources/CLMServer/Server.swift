import Foundation
import Hummingbird
import NIOCore

/// Serializes access to the engine (mirrors the single-threaded Python server).
actor EngineActor {
    let engine: CLMEngine

    init(engine: CLMEngine) {
        self.engine = engine
    }

    nonisolated var loadSeconds: TimeInterval { 0 }

    func answer(state: JSONValue, questions: OrderedObject, temperature: Double) throws -> JSONValue {
        let (answers, billingUnits, inputTokens) = try engine.answer(
            state: state, questions: questions, temperature: temperature)
        var usage = OrderedObject()
        usage["billing_units"] = .int(Int64(billingUnits))
        usage["input_tokens"] = .int(Int64(inputTokens))
        usage["output_tokens"] = .int(0)
        var body = OrderedObject()
        body["model"] = .string("clm-latest")
        body["answers"] = .object(answers)
        body["usage"] = .object(usage)
        return .object(body)
    }
}

enum RequestValidationError: Error {
    case message(String)
}

/// Port of server.py's `validate`: same checks, same order, same messages.
func validate(_ payload: JSONValue) throws -> (state: JSONValue, questions: OrderedObject, temperature: Double) {
    guard case .object(let obj) = payload else {
        throw RequestValidationError.message("request must be an object")
    }
    // payload.get("model", MODEL) != MODEL  (absent model defaults to MODEL)
    let modelOK: Bool
    switch obj["model"] {
    case .none: modelOK = true
    case .string(let m): modelOK = m == "clm-latest"
    default: modelOK = false
    }
    guard modelOK else { throw RequestValidationError.message("unknown model") }
    guard obj.keys.contains("state") else {
        throw RequestValidationError.message("state is required")
    }
    guard case .object(let questions) = obj["questions"], (1...64).contains(questions.count) else {
        throw RequestValidationError.message("questions must contain 1–64 questions")
    }
    var normalized = OrderedObject()
    for (name, qRaw) in questions.pairs {
        guard case .object(let qObj) = qRaw else {
            throw RequestValidationError.message("each question must be an object")
        }
        var q = qObj
        if q["type"] == .string("bool") {
            q["type"] = .string("noul")
        }
        let (keys, _) = try Schema.candidates(.object(q))
        if keys.count > 256 {
            throw RequestValidationError.message("maximum 256 candidates per question")
        }
        normalized[name] = .object(q)
    }
    let temperature: Double
    switch obj["temperature"] {
    case .none: temperature = 1.0
    case .int(let i): temperature = Double(i)
    case .double(let d): temperature = d
    default: throw RequestValidationError.message("temperature must be in (0, 100]")
    }
    guard temperature.isFinite, temperature > 0, temperature <= 100 else {
        throw RequestValidationError.message("temperature must be in (0, 100]")
    }
    return (obj["state"]!, normalized, temperature)
}

let MAX_BODY = 1024 * 1024

enum Wire {
    static func json(_ status: HTTPResponse.Status, _ value: JSONValue) -> Response {
        let text = (try? JSONSerializer.serialize(value)) ?? "{}"
        var buffer = ByteBufferAllocator().buffer(capacity: text.utf8.count)
        buffer.writeString(text)
        return Response(
            status: status,
            headers: [.contentType: "application/json"],
            body: .init(byteBuffer: buffer))
    }

    static let health = json(.ok, .object(OrderedObject([
        ("status", JSONValue.string("ok")),
        ("model", JSONValue.string("clm-latest")),
    ])))

    static let models = json(.ok, .object(OrderedObject([
        ("object", JSONValue.string("list")),
        ("data", JSONValue.array([.object(OrderedObject([
            ("id", JSONValue.string("clm-latest")),
            ("object", JSONValue.string("model")),
            ("owned_by", JSONValue.string("local")),
        ]))])),
    ])))

    static let notFound = json(.notFound, .object(OrderedObject([
        ("error", JSONValue.string("not found")),
    ])))

    static func error(_ status: HTTPResponse.Status, _ message: String) -> Response {
        json(status, .object(OrderedObject([
            ("error", JSONValue.string(message)),
        ])))
    }
}

func buildRouter(engineActor: EngineActor) -> Router<BasicRequestContext> {
    let router = Router()

    router.get("health") { _, _ in Wire.health }
    router.get("v1/models") { _, _ in Wire.models }

    router.post("v1/systemone") { req, _ in
        // server.py rejects chunked requests outright
        if let te = req.headers[.transferEncoding], te.lowercased().contains("chunked") {
            return Wire.error(.badRequest, "chunked requests are not supported")
        }
        let contentLength = req.headers[.contentLength].flatMap(Int.init) ?? 0
        guard contentLength > 0, contentLength <= MAX_BODY else {
            return Wire.error(.contentTooLarge, "body must be 1 byte to 1 MiB")
        }
        let body: ByteBuffer
        do {
            body = try await req.body.collect(upTo: MAX_BODY + 1)
        } catch {
            return Wire.error(.contentTooLarge, "body must be 1 byte to 1 MiB")
        }
        let payload: JSONValue
        do {
            payload = try JSONParser.parse(Array(body.readableBytesView))
        } catch let e as JSONError {
            return Wire.error(.badRequest, e.message)
        }
        do {
            let (state, questions, temperature) = try validate(payload)
            let result = try await engineActor.answer(
                state: state, questions: questions, temperature: temperature)
            return Wire.json(.ok, result)
        } catch RequestValidationError.message(let m) {
            return Wire.error(.badRequest, m)
        } catch Schema.SchemaError.message(let m) {
            return Wire.error(.badRequest, m)
        } catch {
            FileHandle.standardError.write(
                Data("CLM inference failed: \(error)\n".utf8))
            return Wire.error(
                .internalServerError, "CLM inference failed; see server log")
        }
    }

    router.get("*") { _, _ in Wire.notFound }
    router.post("*") { _, _ in Wire.notFound }

    return router
}

func runServer(engine: CLMEngine, port: Int) async throws {
    let engineActor = EngineActor(engine: engine)
    let router = buildRouter(engineActor: engineActor)
    let app = Application(
        router: router,
        configuration: .init(address: .hostname("127.0.0.1", port: port)),
        onServerRunning: { _ in
            print("CLM ready: http://127.0.0.1:\(port)/v1", terminator: "\n")
            fflush(stdout)
        })
    try await app.run()
}
