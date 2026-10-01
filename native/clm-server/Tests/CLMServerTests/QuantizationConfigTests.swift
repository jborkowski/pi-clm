import XCTest
@testable import CLMServer

/// Unit tests for checkpoint-driven quantization config parsing
/// (`Qwen3Encoder.parseQuantization`): 8-bit default, 4-bit-g32 (the
/// mlx-community CLM-v0.1-8B-MLX-4bit variant), 5-bit, per-module overrides,
/// and malformed configs. No model download needed.
final class QuantizationConfigTests: XCTestCase {
    private func parse(_ json: String) throws -> (default: Qwen3Encoder.Quantization, overrides: [String: (Int, Int)])? {
        Qwen3Encoder.parseQuantization(try JSONParser.parse(json))
    }

    func test8BitGroup64() throws {
        let q = try parse(#"{"bits": 8, "group_size": 64}"#)
        XCTAssertEqual(q?.default, Qwen3Encoder.Quantization(bits: 8, groupSize: 64))
        XCTAssertEqual(q?.overrides.count, 0)
    }

    func test4BitGroup32() throws {
        // mlx-community/CLM-v0.1-8B-MLX-4bit ships this quantization block.
        let q = try parse(#"{"group_size": 32, "bits": 4}"#)
        XCTAssertEqual(q?.default, Qwen3Encoder.Quantization(bits: 4, groupSize: 32))
    }

    func test5BitGroup32() throws {
        let q = try parse(#"{"bits": 5, "group_size": 32}"#)
        XCTAssertEqual(q?.default, Qwen3Encoder.Quantization(bits: 5, groupSize: 32))
    }

    func testPerModuleOverrides() throws {
        let q = try parse(#"{"bits": 4, "group_size": 32, "model.embed_tokens": {"bits": 6, "group_size": 32}}"#)
        XCTAssertEqual(q?.default, Qwen3Encoder.Quantization(bits: 4, groupSize: 32))
        XCTAssertEqual(q?.overrides["model.embed_tokens"]?.0, 6)
        XCTAssertEqual(q?.overrides["model.embed_tokens"]?.1, 32)
    }

    func testMissingQuantizationObject() throws {
        XCTAssertNil(try parse(#"{"bits": 4}"#))  // no group_size
        XCTAssertNil(Qwen3Encoder.parseQuantization(nil))
        XCTAssertNil(Qwen3Encoder.parseQuantization(.null))
        XCTAssertNil(try parse(#"{"group_size": 32}"#))  // no bits
    }

    func testNonObjectEntriesIgnored() throws {
        let q = try parse(#"{"bits": 4, "group_size": 32, "not-a-module": 3}"#)
        XCTAssertEqual(q?.default, Qwen3Encoder.Quantization(bits: 4, groupSize: 32))
        XCTAssertEqual(q?.overrides.count, 0)
    }

    func testConfigQuantLookup() throws {
        var config = Qwen3Encoder.Config()
        config.defaultQuant = Qwen3Encoder.Quantization(bits: 4, groupSize: 32)
        config.quantOverrides = ["model.embed_tokens": (6, 32)]
        XCTAssertEqual(config.quant(for: "model.layers.0.mlp.gate_proj"),
                       Qwen3Encoder.Quantization(bits: 4, groupSize: 32))
        XCTAssertEqual(config.quant(for: "model.embed_tokens"),
                       Qwen3Encoder.Quantization(bits: 6, groupSize: 32))
        // Default config keeps the 8-bit-g64 path unchanged.
        XCTAssertEqual(Qwen3Encoder.Config().quant(for: "model.layers.0.mlp.gate_proj"),
                       Qwen3Encoder.Quantization(bits: 8, groupSize: 64))
    }
}
