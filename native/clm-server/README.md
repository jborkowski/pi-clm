# clm-server (native)

Native macOS (arm64) port of [`server/server.py`](../../server/server.py): the full CLM
inference pipeline plus the System One wire API in one Swift binary, built on
[mlx-swift](https://github.com/ml-explore/mlx-swift) (same C++/Metal core as Python MLX),
[Hummingbird](https://github.com/hummingbird-project/hummingbird) (HTTP) and
[swift-transformers](https://github.com/huggingface/swift-transformers) (tokenizer).
See the [root README](../../README.md) for the product picture and [ADR 003](../../docs/adr/003-native-mlx-swift-server.md) for the decision record.

## Layout

| File | Role |
|---|---|
| `main.swift` | CLI: `serve` (`--port`, `--model-path`, `--truncation head\|tail`), `--capabilities` (prints the supported quantization bits as JSON), and the `parity` subcommand |
| `JSONValue.swift` | Strict JSON parser/serializer with **ordered objects** and int-vs-double distinction, producing Python `json.loads`-style error messages (`Expecting value: line 1 column 1 (char 0)`) and rejecting `NaN`/`Infinity` |
| `Schema.swift` | Faithful port of `clm_mlx/schema.py`: state/candidate text building, `noul`/`choice`/`score` answers, softmax, TypeSafe-style confidence |
| `Qwen3Encoder.swift` | Frozen Qwen3-8B encoder: affine-quantized linears (U32-packed weights, BF16 scales) with checkpoint-driven bits/group size (8-bit-g64 default, 4-bit-g32 / 5-bit variants supported), QK-RMSNorm, RoPE, GQA attention, right-padded batches, last-token hidden state after the final RMSNorm (L2-normalised), head/tail truncation |
| `Heads.swift` | CLM projection heads (exact-erf GELU, LayerNorm ε=1e-5, clamped logit scale) |
| `Engine.swift` | Tokenizer wrapper, LRU projection cache, `answer()` with usage accounting |
| `Server.swift` | Hummingbird app + request validation — byte-level parity with `server.py` (limits, error strings, 413/404/chunked semantics); inference serialized by an actor |
| `Parity.swift` | `parity` runner comparing the engine against the Python reference fixture |

## Pipeline

State and candidate texts → tokenizer (2048-token truncation) → encoder →
last-token hidden state → L2 → projection head (state vs action) →
`scale · cos(state, action) / temperature` → softmax → typed answers.
`scale = min(exp(logit_scale), 100)`. Projections are cached per text (LRU);
token usage counts only newly embedded texts.

## Parity discipline

The Python engine is the reference implementation. The fixture
[`test/fixtures/native-parity-reference.json`](../../test/fixtures/native-parity-reference.json)
records its outputs (schema texts, token ids, embeddings, projections, full answers,
usage, head+tail truncation) for a fixed corpus. Verify a build:

```bash
bin/clm-server parity test/fixtures/native-parity-reference.json \
  --model-path <model-snapshot-dir> --truncation head   # 222/222
bin/clm-server parity ... --truncation tail             # 212/212
```

Checks and thresholds: schema texts and token ids **exact**; embeddings cosine
≥ 0.9995; projections ≥ 0.999; choice top-1 agreement 100%; prob delta ≤ 0.04
(observed ≤ 0.03) and score delta ≤ 0.08 (observed ≤ 0.055). Residual deltas
come from Metal batch-shape nondeterminism (~5e-4 embedding cos) amplified by
the 100× logit scale — well inside the MLX port's own acceptance vs the
upstream vLLM server (`parity.json` in the model repo: median 0.036, p95 0.087).
`Tests/` additionally pins schema/JSON/validation behaviour to Python-generated
fixtures (`swift test`, no model needed).

## Build & test

```bash
swift build -c release --product CLMServer
swift test
```

Deploy: copy `.build/out/Products/Release/CLMServer` **and**
`.build/out/Products/Release/mlx-swift_Cmlx.bundle` next to each other into
`bin/` — the MLX C++ runtime loads
`<exe dir>/mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib` at startup.
[`scripts/build.sh`](../../scripts/build.sh) automates build, install, and checks.

Prerequisites: a stable Xcode selected via `xcode-select` (beta toolchains
currently cannot compile the dependency tree) and, once per Xcode,
`xcodebuild -downloadComponent MetalToolchain`.

## Constraints

- Apple Silicon only; arm64 Mach-O.
- Affine-quantized checkpoints loaded from U32-packed weights; bits and
  group size come from the `quantization` block in the encoder's
  `config.json` (8-bit group-64 by default; 4-bit-g32 and 5-bit variants
  such as `mlx-community/CLM-v0.1-8B-MLX-4bit` load natively).
- Head/tail truncation to `max_tokens = 2048`; batch budget 4096 tokens.
- Qwen3-8B dimensions (hidden 4096, 36 layers, 32/8 heads, head dim 128) are
  defaults read from the encoder's `config.json`.
