# pi-clm

Contrastive Language Model (CLM) extension for [Pi](https://github.com/earendil-works/pi-coding-agent): a local, Apple-Silicon classifier that answers typed questions — yes/no, single choice, score — with a full probability distribution, **without generating any text**.

It wraps [CLM-v0.1-8B](https://huggingface.co/mlx-community/CLM-v0.1-8B-MLX-8bit) (a frozen Qwen3-8B encoder + two small contrastive projection heads, ported to MLX) behind a shared background server and exposes it to Pi sessions as the classifier provider `clm-local` / model `clm-latest`.

## What it gives you

- **Typed answers, not prose** — a `bool`, `choice`, or `score` question returns probabilities (and a TypeSafe-style confidence) instead of generated tokens. Fast (one encoder pass), cheap, and deterministic in shape.
- **Local & private** — the model runs on your machine (Metal, via MLX). Nothing leaves the loopback interface; the server binds `127.0.0.1` only and needs no API key.
- **Shared across sessions** — the extension keeps one background server alive with a ref-counted lockfile, so multiple concurrent Pi sessions share a single copy of the model in unified memory (~8.6 GB total) instead of one per session.
- **Zero Python required** — serving prefers `bin/clm-server`, a pre-compiled arm64 Swift/MLX binary (engine load ≈ 0.3 s). If the binary is missing, it falls back to `uv run server/server.py`, which needs [uv](https://docs.astral.sh/uv/) but nothing else (deps are resolved from the script header).
- **Standard model storage** — weights live in the regular Hugging Face hub cache (`~/.cache/huggingface/hub/models--mlx-community--CLM-v0.1-8B-MLX-8bit`, honoring `HF_HUB_CACHE` / `HF_HOME`), shared seamlessly with `huggingface-cli`, python `huggingface_hub`, and friends. A snapshot downloaded by another tool is adopted without re-downloading.

## Requirements

- macOS on Apple Silicon (M-series). The native binary is arm64; the Python fallback needs `mlx`, which is Apple-Silicon only.
- ~8.6 GB of disk for the model snapshot (downloaded automatically on first use) and enough free memory for it.
- Pi ≥ 0.99.0.

## Install

```bash
pi install ./pi-clm          # or: pi install git:github.com/jborkowski/pi-clm
```

To try it for a single session without installing:

```bash
pi -e ./pi-clm
```

The extension registers provider `clm-local` with classifier model `clm-latest`. It appears wherever Pi classifiers are usable — it is a classifier, not a chat model, so it will not show up in `/model`.

## Using it

### In codemode (models API)

```js
const model = await models.getModelOfType("classifier", "clm-local", "clm-latest");
if (!model) throw new Error("pi-clm is not loaded");
const result = await models.classify(model, {
  state: { message: "My invoice was charged twice. Please refund it." },
  questions: {
    urgent: { type: "bool", instructions: "Is this urgent?" },
    action: {
      type: "choice",
      instructions: "How should this be handled?",
      criteria: { refund: "Issue a refund", deny: "Deny the claim", escalate: "Escalate to a human" },
    },
    severity: { type: "score", instructions: "Rate severity.", criteria: [1, 2, 3, 4, 5] },
  },
});
// result.answers.urgent.probability     (bool)
// result.answers.action.choice          ("refund" | "deny" | "escalate") + probabilities + confidence
// result.answers.severity.score         (0..4, expected value) + legend + probabilities
```

The first call transparently downloads the model if needed, starts the shared server, and only then answers — a persistent status line shows download/startup progress. Every subsequent call is a millisecond-scale request to the local server, with candidate projections cached.

### `/clm` panel

Run `/clm` in Pi for the status panel: model state (not-downloaded / downloading / downloaded / running), server controls (start/stop/refresh), and the current error, if any.

### The wire API (any local process)

The server speaks a small "System One" API on `http://127.0.0.1:8700/v1`:

| Endpoint | Description |
|---|---|
| `GET /health` | `{"status": "ok", "model": "clm-latest"}` once the engine is loaded |
| `GET /v1/models` | Lists the served model |
| `POST /v1/systemone` | Answer typed questions for a state (see below) |

```bash
curl -s http://127.0.0.1:8700/v1/systemone -H 'Content-Type: application/json' -d '{
  "model": "clm-latest",
  "state": "Customer was charged twice",
  "questions": { "urgent": { "type": "noul", "instructions": "Is this urgent?" } },
  "temperature": 1.0
}'
# {"model": "clm-latest", "answers": {"urgent": {"type": "noul", "noul": 0.82}}, "usage": {...}}
```

- **`state`** — any JSON value; objects/lists render as prose fields (`key: value`, `- item`), which is what the heads were trained on.
- **`questions`** — 1–64 questions, each `noul` (yes/no; the extension's `bool` maps to this), `choice` (criteria map; empty descriptions fall back to the key), or `score` (ordered levels). Max 256 candidates per question.
- **`temperature`** — in `(0, 100]`, scales the contrastive logits (default 1).
- **`usage.input_tokens`** — real encoder token usage; repeated states/candidates hit the projection cache and cost zero.

The native binary and the Python server implement the exact same protocol, byte-for-byte error messages included, verified by a [parity suite](#development).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PI_CLM_SERVER_BIN` | `<package>/bin/clm-server` | Path to the native server. Set to an empty string to force the `uv run server.py` fallback. |
| `PI_CLM_PORT` / `PI_CLM_HOST` | `8700` / `127.0.0.1` | Server bind address |
| `PI_CLM_STATE_DIR` | `~/.cache/pi-clm` | Server lock file + log location |
| `HF_HUB_CACHE`, `HF_HOME`, `XDG_CACHE_HOME` | `~/.cache/huggingface/hub` | Standard HF hub cache resolution for the model snapshot |
| `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` | — | Optional token for gated/private HF repos |

Run the server manually (same flags for the native binary and `server.py`):

```bash
bin/clm-server --port 8700 --model-path <model-snapshot-dir> --truncation head|tail
# or: uv run server/server.py --port 8700 --model-path <model-snapshot-dir> --truncation tail
```

`--truncation head` keeps the first 2048 tokens of long inputs (matches the upstream vLLM server); `tail` keeps the last ones (the upstream training recipe).

## Architecture

```
index.ts             Pi extension: registers provider clm-local, single-flight
                     ensure/download/start lifecycle, status widget, /clm panel
src/model-manager.ts HF hub cache: standard models--org--repo layout, blob
                     integrity checks (sha256 / git oid), resume, adoption of
                     snapshots written by other HF tools
src/server-manager.ts Shared server lifecycle: lockfile with per-session
                     refcount, health checks, native-binary preference with
                     `uv run` fallback, graceful shutdown
server/server.py     Python reference server (System One wire API)
native/clm-server    Swift port: mlx-swift Qwen3-8B 8-bit encoder + CLM heads
                     + Hummingbird HTTP server; bin/clm-server is its release
                     build (plus mlx-swift_Cmlx.bundle with the Metal kernels)
```

**Inference pipeline** (identical in Python and Swift): the state and each candidate text go through the frozen Qwen3-8B encoder (8-bit quantized); the last token's hidden state is L2-normalised and projected by two small MLP heads into a shared 512-d space; answers score candidate projections against the state projection (`scale · cos / temperature`, `scale` clamped at 100) and softmax over candidates.

## Development

```bash
npm install
npm test          # TS suite (model cache, server manager, extension e2e)
npm run typecheck
npm run check:dup

# Swift package (tests use Python-generated fixtures; no model needed)
cd native/clm-server && swift test

# Engine parity against the Python reference (needs the model snapshot):
bin/clm-server parity test/fixtures/native-parity-reference.json \
  --model-path <model-snapshot-dir> --truncation head
# -> PARITY PASS (222 checks); tail -> PARITY PASS (212 checks)

# Optional live e2e of the packaged binary:
PI_CLM_NATIVE_MODEL=<model-snapshot-dir> npm test
```

`test/fixtures/native-parity-reference.json` is generated by `gen-parity-reference.py` in the model experiment repo (schema texts, token ids, embeddings, projections, full answers for head+tail truncation). The Swift tokenizer, encoder, heads, validation, and JSON error strings are all pinned to Python outputs; acceptance mirrors the MLX port's own parity report (choice top-1 100%, prob deltas ≤ 0.04 with ≤ 0.03 observed — Metal batch-shape noise amplified by the 100× logit scale).

To rebuild everything (TS deps, native release binary into `bin/`, all test suites, and — when given a model snapshot — the engine parity runs):

```bash
make help                                    # list all targets
make build                                   # build + install + all checks
make parity MODEL=<model-snapshot-dir>       # engine parity vs Python (222/212)
make serve MODEL=<model-snapshot-dir>        # run the server in the foreground
# or the one-shot script equivalent:
scripts/build.sh
PI_CLM_NATIVE_MODEL=<model-snapshot-dir> scripts/build.sh   # + parity & e2e
npm run build:native                         # build only
```

One-time machine setup (Xcode + Metal toolchain):

```bash
sudo xcode-select -s /Applications/Xcode.app   # beta toolchains cannot compile the deps
xcodebuild -downloadComponent MetalToolchain
```

The manual equivalent of the native step:

```bash
cd native/clm-server
swift build -c release --product CLMServer
cp .build/out/Products/Release/CLMServer ../../bin/clm-server
cp -R .build/out/Products/Release/mlx-swift_Cmlx.bundle ../../bin/
```

## Status & scope

Phase 1 of the [CLM MLX experiment](https://huggingface.co/mlx-community/CLM-v0.1-8B-MLX-8bit) productised as a Pi extension. The model is an unofficial community port of Contrastive-LM's CLM-v0.1-8B; answers are distributions over the candidates you provide — there is no text-generation endpoint.
