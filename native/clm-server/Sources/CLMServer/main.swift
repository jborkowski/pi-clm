import Foundation
import MLX

struct CLIError: Error, CustomStringConvertible {
    let description: String
}

// MARK: - Argument parsing

struct CLIArguments {
    var command = "serve"  // "serve" | "parity"
    var port = 8700
    var modelPath: String?
    var truncation = "head"
    var referencePath: String?

    static func parse(_ args: [String]) throws -> CLIArguments {
        var parsed = CLIArguments()
        var i = 0
        if let first = args.first, first == "parity" {
            parsed.command = "parity"
            i = 1
            guard args.count > 1 else {
                throw CLIError(description: "usage: clm-server parity REFERENCE.json [--model-path DIR] [--truncation head|tail]")
            }
            parsed.referencePath = args[1]
            i = 2
        }
        while i < args.count {
            let a = args[i]
            func nextValue(_ flag: String) throws -> String {
                guard i + 1 < args.count else {
                    throw CLIError(description: "missing value for \(flag)")
                }
                i += 1
                return args[i]
            }
            switch a {
            case "--port": parsed.port = Int(try nextValue(a)) ?? 8700
            case "--model-path": parsed.modelPath = try nextValue(a)
            case "--truncation":
                parsed.truncation = try nextValue(a)
                guard parsed.truncation == "head" || parsed.truncation == "tail" else {
                    throw CLIError(description: "--truncation must be head or tail")
                }
            default:
                throw CLIError(description: "unknown argument \(a)")
            }
            i += 1
        }
        guard parsed.modelPath != nil else {
            throw CLIError(description: "--model-path is required")
        }
        return parsed
    }
}

// MARK: - Main

let args: CLIArguments
do {
    args = try CLIArguments.parse(Array(CommandLine.arguments.dropFirst()))
} catch let e {
    FileHandle.standardError.write(Data("clm-server: \(e)\n".utf8))
    exit(2)
}

let modelDir = URL(fileURLWithPath: args.modelPath!, isDirectory: true)

do {
    if args.command == "parity" {
        let exitCode = try await runParity(referencePath: args.referencePath!, modelDir: modelDir, truncation: args.truncation)
        exit(exitCode)
    }

    let loadStart = Date()
    let engine = try await CLMEngine(modelDir: modelDir, cacheSize: 4096, truncation: args.truncation)
    FileHandle.standardError.write(
        Data("loaded CLM engine in \(Date().timeIntervalSince(loadStart))s\n".utf8))
    try await runServer(engine: engine, port: args.port)
} catch {
    FileHandle.standardError.write(Data("clm-server: \(error)\n".utf8))
    exit(1)
}
