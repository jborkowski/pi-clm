import Foundation
import MLX
import MLXFast
import MLXNN

/// Affine-quantized linear loaded from U32-packed weights.
/// Mirrors the `mx.quantized_matmul` path mlx-lm uses for these checkpoints.
/// Bits/group size come from the checkpoint's `quantization` config (8-bit
/// group-64 by default, but 4-bit-g32 / 5-bit variants load the same way).
struct QuantizedLinear {
    let weight: MLXArray   // [out, in/4] uint32
    let scales: MLXArray
    let biases: MLXArray
    let groupSize: Int
    let bits: Int

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        quantizedMM(x, weight, scales: scales, biases: biases, transpose: true, groupSize: groupSize, bits: bits)
    }
}

func silu(_ x: MLXArray) -> MLXArray {
    x * sigmoid(x)
}

/// One Qwen3 decoder block: RMSNorm -> attention (QK-norm, RoPE, GQA) -> RMSNorm -> SwiGLU MLP.
/// Ported from mlx-lm's `models/qwen3.py` (no cache: full-sequence forward).
final class Qwen3Layer {
    let qProj: QuantizedLinear
    let kProj: QuantizedLinear
    let vProj: QuantizedLinear
    let oProj: QuantizedLinear
    let qNormWeight: MLXArray
    let kNormWeight: MLXArray
    let inputLayernormWeight: MLXArray
    let postAttentionLayernormWeight: MLXArray
    let gateProj: QuantizedLinear
    let upProj: QuantizedLinear
    let downProj: QuantizedLinear
    let cfg: Qwen3Encoder.Config
    let rope: RoPE
    let attnScale: Float

    init(weights: [String: MLXArray], prefix: String, cfg: Qwen3Encoder.Config, rope: RoPE) {
        func ql(_ name: String) -> QuantizedLinear {
            let quant = cfg.quant(for: "\(prefix).\(name)")
            return QuantizedLinear(
                weight: weights["\(prefix).\(name).weight"]!,
                scales: weights["\(prefix).\(name).scales"]!,
                biases: weights["\(prefix).\(name).biases"]!,
                groupSize: quant.groupSize, bits: quant.bits)
        }
        qProj = ql("self_attn.q_proj")
        kProj = ql("self_attn.k_proj")
        vProj = ql("self_attn.v_proj")
        oProj = ql("self_attn.o_proj")
        qNormWeight = weights["\(prefix).self_attn.q_norm.weight"]!
        kNormWeight = weights["\(prefix).self_attn.k_norm.weight"]!
        inputLayernormWeight = weights["\(prefix).input_layernorm.weight"]!
        postAttentionLayernormWeight = weights["\(prefix).post_attention_layernorm.weight"]!
        gateProj = ql("mlp.gate_proj")
        upProj = ql("mlp.up_proj")
        downProj = ql("mlp.down_proj")
        self.cfg = cfg
        self.rope = rope
        self.attnScale = pow(Float(cfg.headDim), -0.5)
    }

    func callAsFunction(_ x: MLXArray, mask: MLXArray) -> MLXArray {
        let B = x.dim(0)
        let L = x.dim(1)
        let nHeads = cfg.numHeads
        let nKV = cfg.numKVHeads
        let headDim = cfg.headDim

        let h = MLXFast.rmsNorm(x, weight: inputLayernormWeight, eps: cfg.rmsNormEps)

        var queries = qProj(h).reshaped([B, L, nHeads, headDim])
        var keys = kProj(h).reshaped([B, L, nKV, headDim])
        let values = vProj(h).reshaped([B, L, nKV, headDim]).transposed(0, 2, 1, 3)

        // QK-norm before rope, per head dim (mlx-lm Qwen3Attention).
        queries = MLXFast.rmsNorm(queries, weight: qNormWeight, eps: cfg.rmsNormEps)
            .transposed(0, 2, 1, 3)
        keys = MLXFast.rmsNorm(keys, weight: kNormWeight, eps: cfg.rmsNormEps)
            .transposed(0, 2, 1, 3)

        queries = rope(queries)
        keys = rope(keys)

        var output = MLXFast.scaledDotProductAttention(
            queries: queries, keys: keys, values: values,
            scale: attnScale, mask: mask.asType(queries.dtype))
        output = output.transposed(0, 2, 1, 3).reshaped([B, L, nHeads * headDim])
        let attnOut = oProj(output)

        let residual = x + attnOut
        let h2 = MLXFast.rmsNorm(residual, weight: postAttentionLayernormWeight, eps: cfg.rmsNormEps)
        let mlpOut = downProj(silu(gateProj(h2)) * upProj(h2))
        return residual + mlpOut
    }
}

/// Qwen3-8B (8-bit affine-quantized MLX checkpoint) as CLM's frozen encoder.
/// Reproduces `clm_mlx/encoder.py`: last-token hidden state after the final
/// RMSNorm, float32, L2-normalised. Batches are right-padded; attention is
/// causal, so pad tokens after a sequence cannot change its last real token.
final class Qwen3Encoder {
    struct Config {
        var hiddenSize = 4096
        var numLayers = 36
        var numHeads = 32
        var numKVHeads = 8
        var headDim = 128
        var intermediateSize = 12288
        var rmsNormEps: Float = 1e-6
        var ropeTheta: Float = 1_000_000
        /// Checkpoint quantization: 8-bit group-64 affine unless the
        /// `quantization` object in config.json says otherwise (e.g. 4-bit-g32).
        var defaultQuant = Quantization(bits: 8, groupSize: 64)
        var quantOverrides: [String: (Int, Int)] = [:]  // module prefix -> (bits, groupSize)

        /// Quantization for a module: a per-module override when the config
        /// carries one, else the checkpoint default.
        func quant(for module: String) -> Quantization {
            if let (b, g) = quantOverrides[module] {
                return Quantization(bits: b, groupSize: g)
            }
            return defaultQuant
        }
    }

    struct Quantization: Equatable {
        var bits: Int
        var groupSize: Int

        init(bits: Int, groupSize: Int) {
            self.bits = bits
            self.groupSize = groupSize
        }
    }

    let config: Config
    let embedWeight: MLXArray  // [vocab, hidden/4] uint32
    let embedScales: MLXArray
    let embedBiases: MLXArray
    let embedGroupSize: Int
    let embedBits: Int
    let layers: [Qwen3Layer]
    let normWeight: MLXArray
    let rope: RoPE
    let maxTokens: Int
    let batchTokens: Int
    let truncation: String  // "head" | "tail"

    init(encoderDir: URL, maxTokens: Int = 2048, batchTokens: Int = 4096, truncation: String = "head") throws {
        guard truncation == "head" || truncation == "tail" else {
            throw NSError(domain: "CLMEncoder", code: 1,
                          userInfo: [NSLocalizedDescriptionKey:
                            "truncation must be 'head' (keep the first tokens, as the server) or 'tail'"])
        }
        self.truncation = truncation
        self.maxTokens = maxTokens
        self.batchTokens = batchTokens

        var config = Config()
        if let configText = try? String(contentsOf: encoderDir.appendingPathComponent("config.json"), encoding: .utf8),
           let configJSON = try? JSONParser.parse(configText),
           case .object(let c) = configJSON
        {
            func readInt(_ key: String, _ def: Int) -> Int {
                if case .int(let v)? = c[key] { return Int(v) }
                return def
            }
            func readFloat(_ key: String, _ def: Float) -> Float {
                switch c[key] {
                case .int(let v): return Float(v)
                case .double(let v): return Float(v)
                default: return def
                }
            }
            config.hiddenSize = readInt("hidden_size", 4096)
            config.numLayers = readInt("num_hidden_layers", 36)
            config.numHeads = readInt("num_attention_heads", 32)
            config.numKVHeads = readInt("num_key_value_heads", 8)
            config.headDim = readInt("head_dim", 128)
            config.intermediateSize = readInt("intermediate_size", 12288)
            config.rmsNormEps = readFloat("rms_norm_eps", 1e-6)
            config.ropeTheta = readFloat("rope_theta", 1_000_000)
            if let q = Self.parseQuantization(c["quantization"]) {
                config.defaultQuant = q.default
                config.quantOverrides = q.overrides
            }
        }
        self.config = config
        let ropeLocal = RoPE(dimensions: config.headDim, traditional: false, base: config.ropeTheta)
        self.rope = ropeLocal

        let weights = try Self.loadShards(encoderDir: encoderDir)

        embedWeight = weights["model.embed_tokens.weight"]!
        embedScales = weights["model.embed_tokens.scales"]!
        embedBiases = weights["model.embed_tokens.biases"]!
        let embedQuant = config.quant(for: "model.embed_tokens")
        embedGroupSize = embedQuant.groupSize
        embedBits = embedQuant.bits
        normWeight = weights["model.norm.weight"]!
        layers = (0..<config.numLayers).map { i in
            Qwen3Layer(weights: weights, prefix: "model.layers.\(i)", cfg: config, rope: ropeLocal)
        }
    }

    /// Parse the `quantization` object from config.json (mlx-lm format):
    /// top-level `bits` / `group_size` plus optional per-module override
    /// entries (e.g. `"model.embed_tokens": {"bits": 6, "group_size": 32}`).
    /// Unknown shapes return nil so callers keep the 8-bit-g64 default.
    static func parseQuantization(_ value: JSONValue?) -> (default: Quantization, overrides: [String: (Int, Int)])? {
        guard case .object(let q)? = value else { return nil }
        guard case .int(let bits)? = q["bits"],
              case .int(let groupSize)? = q["group_size"]
        else { return nil }
        var overrides: [String: (Int, Int)] = [:]
        for (k, v) in q.pairs {
            guard case .object(let o) = v,
                  case .int(let b)? = o["bits"],
                  case .int(let g)? = o["group_size"]
            else { continue }
            overrides[k] = (Int(b), Int(g))
        }
        return (Quantization(bits: Int(bits), groupSize: Int(groupSize)), overrides)
    }

    static func loadShards(encoderDir: URL) throws -> [String: MLXArray] {
        let indexURL = encoderDir.appendingPathComponent("model.safetensors.index.json")
        var files: [String] = []
        if let indexText = try? String(contentsOf: indexURL, encoding: .utf8),
           let indexJSON = try? JSONParser.parse(indexText),
           case .object(let idx) = indexJSON["weight_map"] ?? .null
        {
            var seen = Set<String>()
            for (_, v) in idx.pairs {
                if case .string(let f) = v, !seen.contains(f) {
                    seen.insert(f)
                    files.append(f)
                }
            }
            files.sort()
        } else {
            files = ["model.safetensors"]
        }
        var weights: [String: MLXArray] = [:]
        for f in files {
            for (k, v) in try loadArrays(url: encoderDir.appendingPathComponent(f)) {
                weights[k] = v
            }
        }
        return weights
    }

    /// Token ids cut to maxTokens per the truncation mode ("head" keeps the
    /// first tokens, as the captured vLLM server; "tail" keeps the last).
    func clipIds(_ ids: [Int]) -> [Int] {
        if ids.count > maxTokens {
            return truncation == "head" ? Array(ids.prefix(maxTokens)) : Array(ids.suffix(maxTokens))
        }
        return ids
    }

    /// [n, hidden] float32, L2-normalised, in input order (embed_ids port).
    func embedIds(_ idLists: [[Int]]) -> MLXArray {
        let order = idLists.indices.sorted { idLists[$0].count < idLists[$1].count }
        var out: [MLXArray?] = .init(repeating: nil, count: idLists.count)
        var i = 0
        while i < order.count {
            var j = i + 1  // ascending lengths: the newest row is the longest in the batch
            while j < order.count && (j - i + 1) * idLists[order[j]].count <= batchTokens {
                j += 1
            }
            let rows = order[i..<j].map { idLists[$0] }
            let v = forwardPadded(rows)
            for (r, k) in zip(0..<rows.count, order[i..<j]) {
                out[k] = v[r]
            }
            i = j
        }
        return MLX.stacked(out.map { $0! }, axis: 0)
    }

    /// Forward a batch of right-padded rows; returns per-row last-token states.
    func forwardPadded(_ rows: [[Int]]) -> MLXArray {
        let B = rows.count
        let L = rows.map(\.count).max()!
        let hidden = config.hiddenSize

        let flat = rows.flatMap { row -> [Int] in
            row + Array(repeating: 0, count: L - row.count)
        }
        let ids = MLXArray(flat.map(Int32.init), [B, L])

        // Quantized embedding gather: dequantize only the rows we need
        // (same maths as mx.quantized_gather).
        let rowW = embedWeight.take(ids, axis: 0)
        let rowS = embedScales.take(ids, axis: 0)
        let rowB = embedBiases.take(ids, axis: 0)
        var h = dequantized(rowW, scales: rowS, biases: rowB, groupSize: embedGroupSize, bits: embedBits)

        let mask = Self.causalMask(L)

        for layer in layers {
            h = layer(h, mask: mask)
        }
        h = MLXFast.rmsNorm(h, weight: normWeight, eps: config.rmsNormEps)

        // Read each row at its own last real-token index.
        let last = MLXArray(rows.map { Int32($0.count - 1) }, [B, 1, 1])
        let idx = broadcast(last, to: [B, 1, hidden])
        var v = takeAlong(h, idx, axis: 1).squeezed(axis: 1).asType(.float32)
        let norm = sqrt(sum(v * v, axes: [-1], keepDims: true))
        v = v / (norm + 1e-12)
        eval(v)
        return v
    }

    /// Additive causal mask [L, L] float32 (python passes the "causal" flag
    /// into the same Metal kernel).
    static func causalMask(_ L: Int) -> MLXArray {
        let rowIdx = MLXArray((0..<L).map(Int32.init), [L, 1])
        let colIdx = MLXArray((0..<L).map(Int32.init), [1, L])
        let masked = less(rowIdx, colIdx)  // col > row
        let negInf = MLXArray.zeros([L, L], dtype: .float32) - Float.infinity
        return `where`(masked, negInf, MLXArray.zeros([L, L], dtype: .float32))
    }
}
