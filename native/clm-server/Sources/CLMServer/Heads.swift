import Foundation
import MLX
import MLXFast

/// A CLM projection head, mirroring `clm_mlx/heads.py` exactly:
/// `x -> Linear(4096, width) -> GELU(exact erf) -> [Linear -> LayerNorm(eps 1e-5) -> GELU] * (depth-2)`
/// `-> Linear(width, 512)`, all float32. Weights from `heads/CLM_v0.1-8B.safetensors`.
struct Head {
    let inpW: MLXArray  // [width, hidden]
    let inpB: MLXArray  // [width]
    let hiddenW: [MLXArray]
    let hiddenB: [MLXArray]
    let normW: [MLXArray]?
    let normB: [MLXArray]?
    let outW: MLXArray  // [proj, width]
    let outB: MLXArray  // [proj]

    init(weights: [String: MLXArray], prefix: String, cfg: HeadConfig) {
        func p(_ name: String) -> MLXArray {
            guard let a = weights["\(prefix).\(name)"] else {
                fatalError("missing head weight \(prefix).\(name)")
            }
            return a.asType(.float32)
        }
        inpW = p("inp.weight")
        inpB = p("inp.bias")
        var hw: [MLXArray] = []
        var hb: [MLXArray] = []
        for i in 0..<(cfg.depth - 2) {
            hw.append(p("hidden.\(i).weight"))
            hb.append(p("hidden.\(i).bias"))
        }
        hiddenW = hw
        hiddenB = hb
        if cfg.layernorm {
            var nw: [MLXArray] = []
            var nb: [MLXArray] = []
            for i in 0..<(cfg.depth - 2) {
                nw.append(p("norms.\(i).weight"))
                nb.append(p("norms.\(i).bias"))
            }
            normW = nw
            normB = nb
        } else {
            normW = nil
            normB = nil
        }
        outW = p("out.weight")
        outB = p("out.bias")
    }

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = geluExact(linear(x, inpW, inpB))
        for i in 0..<hiddenW.count {
            var z = linear(h, hiddenW[i], hiddenB[i])
            if let normW, let normB {
                z = MLXFast.layerNorm(z, weight: normW[i], bias: normB[i], eps: 1e-5)
            }
            h = geluExact(z)
        }
        return linear(h, outW, outB)
    }

    /// torch.nn.GELU() default: the exact erf form, not the tanh approximation.
    func geluExact(_ x: MLXArray) -> MLXArray {
        0.5 * x * (1.0 + MLX.erf(x / Float(2.0).squareRoot()))
    }

    /// y = x @ W.T + b, float32.
    func linear(_ x: MLXArray, _ w: MLXArray, _ b: MLXArray) -> MLXArray {
        MLX.matmul(x, w.transposed()) + b
    }
}

struct HeadConfig {
    var width: Int
    var depth: Int
    var proj: Int
    var layernorm: Bool
}

/// State head + action head + score scale, from a capture's `heads/` directory.
final class HeadPair: @unchecked Sendable {
    let state: Head
    let action: Head
    /// min(exp(logit_scale), 100) — upstream clamps at 100.
    let scale: Float
    let projDim: Int

    init(headsDir: URL) throws {
        let configText = try String(contentsOf: headsDir.appendingPathComponent("config.json"), encoding: .utf8)
        guard case .object(let configJSON) = try JSONParser.parse(configText) else {
            throw NSError(domain: "CLMHeads", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "invalid heads config.json"])
        }
        func int(_ obj: OrderedObject, _ key: String) -> Int? {
            if case .int(let v)? = obj[key] { return Int(v) }
            return nil
        }
        let inner: OrderedObject
        if case .object(let o)? = configJSON["cfg"] { inner = o } else { inner = OrderedObject() }
        let headConfig = HeadConfig(
            width: int(inner, "width") ?? 1536,
            depth: int(inner, "depth") ?? 3,
            proj: int(configJSON, "projection_dim") ?? int(inner, "projection_dim") ?? 512,
            layernorm: {
                // python: cfg.get("layernorm", False) — the capture nests it under cfg
                if case .bool(let v)? = inner["layernorm"] { return v }
                if case .bool(let v)? = configJSON["layernorm"] { return v }
                return false
            }())

        let weights = try loadArrays(url: headsDir.appendingPathComponent("CLM_v0.1-8B.safetensors"))
        state = Head(weights: weights, prefix: "state_head", cfg: headConfig)
        action = Head(weights: weights, prefix: "action_head", cfg: headConfig)
        let logitScale: Float = weights["logit_scale"]!.item()
        scale = min(exp(logitScale), 100.0)
        projDim = headConfig.proj
        eval(state.inpW, state.inpB, state.outW, state.outB, action.inpW, action.inpB, action.outW, action.outB)
        for i in 0..<state.hiddenW.count {
            eval(state.hiddenW[i], state.hiddenB[i], action.hiddenW[i], action.hiddenB[i])
            if let nw = state.normW, let nb = state.normB, let anw = action.normW, let anb = action.normB {
                eval(nw[i], nb[i], anw[i], anb[i])
            }
        }
    }

    /// [n, 4096] encoder embeddings -> [n, 512] L2-normalised projections (float32).
    func project(_ emb: MLXArray, which: CLMEngine.HeadKind) -> MLXArray {
        let head = which == .state ? state : action
        return Self.l2(head.callAsFunction(Self.l2(emb.asType(.float32))))
    }

    static func l2(_ x: MLXArray) -> MLXArray {
        let norm = sqrt(sum(x * x, axes: [-1], keepDims: true))
        return x / (norm + 1e-12)
    }
}
