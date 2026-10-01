# pi-clm

Contrastive Language Model (CLM) extension for [Pi](https://github.com/earendil-works/pi-coding-agent): a local, Apple-Silicon classifier that answers typed questions — yes/no, single choice, score — with a full probability distribution, without generating any text.

It serves [CLM-v0.1-8B](https://huggingface.co/mlx-community/CLM-v0.1-8B-MLX-8bit) (frozen Qwen3-8B encoder + two contrastive projection heads, MLX) as the classifier provider `clm-local` / model `clm-latest`.

- Typed answers with probabilities and confidence — fast, deterministic in shape.
- Local and private — Metal via MLX, binds `127.0.0.1` only, no API key.
- One shared background server across Pi sessions (ref-counted lockfile), ~8.6 GB model in unified memory once.
- Zero Python required — prefers the pre-compiled `bin/clm-server` (Swift/MLX), falls back to `uv run server/server.py`.
- Standard HF hub cache layout — snapshots from other HF tools are adopted without re-downloading.

## Requirements

- macOS on Apple Silicon, ~8.6 GB disk + free memory for the model (downloaded on first use)
- Pi ≥ 0.99.0, [uv](https://docs.astral.sh/uv/) only if using the Python fallback

## Install

```bash
pi install git:github.com/jborkowski/pi-clm   # or: pi install ./pi-clm
```

The extension registers classifier model `clm-latest` — it is a classifier, not a chat model, so it will not show up in `/model`.

## Usage

```js
const model = await models.getModelOfType("classifier", "clm-local", "clm-latest");
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
// result.answers.urgent.probability, .action.choice, .severity.score
```

The first call downloads the model if needed and starts the server; subsequent calls are millisecond-scale, with candidate projections cached. Run `/clm` in Pi for a status panel and server controls.

## Wire API

The server speaks a "System One" API on `http://127.0.0.1:8700`:

| Endpoint | Description |
|---|---|
| `GET /health` | `{"status": "ok", "model": "clm-latest"}` once loaded |
| `GET /v1/models` | Lists the served model |
| `POST /v1/systemone` | Answer typed questions for a state |

```bash
curl -s http://127.0.0.1:8700/v1/systemone -H 'Content-Type: application/json' -d '{
  "model": "clm-latest",
  "state": "Customer was charged twice",
  "questions": { "urgent": { "type": "noul", "instructions": "Is this urgent?" } }
}'
```

- `state` — any JSON value; objects/lists render as prose fields.
- `questions` — 1–64 of `noul` (yes/no), `choice` (criteria map), or `score` (ordered levels). Max 256 candidates per question.
- `temperature` — `(0, 100]`, scales the contrastive logits.
- `usage.input_tokens` — real encoder token usage; cached candidates cost zero.

Run the server manually (same flags for the binary and `server.py`):

```bash
bin/clm-server --port 8700 --model-path <model-snapshot-dir> --truncation head|tail
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PI_CLM_SERVER_BIN` | auto | Explicit native-server path; empty string forces the Python fallback |
| `PI_CLM_PORT` / `PI_CLM_HOST` | `8700` / `127.0.0.1` | Server bind address |
| `PI_CLM_STATE_DIR` | `~/.cache/pi-clm` | Lock file + log location |
| `HF_HUB_CACHE`, `HF_HOME`, `XDG_CACHE_HOME` | `~/.cache/huggingface/hub` | HF hub cache resolution |
| `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` | — | Optional token for gated HF repos |

## Development

```bash
npm install
npm test          # TS suite (model cache, server manager, extension e2e)
npm run typecheck

cd native/clm-server && swift test            # Swift suite, no model needed
bin/clm-server parity test/fixtures/native-parity-reference.json \
  --model-path <model-snapshot-dir> --truncation head   # engine parity vs Python
```

The native server is resolved as: `PI_CLM_SERVER_BIN` → packaged `bin/clm-server` → `pi-clm-server` on `PATH` (e.g. a Homebrew install) → Python fallback.

To rebuild everything:

```bash
make build                                     # TS deps, native binary, all checks
make parity MODEL=<model-snapshot-dir>         # engine parity vs Python
```

One-time machine setup for the Swift build:

```bash
sudo xcode-select -s /Applications/Xcode.app
xcodebuild -downloadComponent MetalToolchain
```
