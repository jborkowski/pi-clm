# pi-clm

Contrastive Language Model (CLM) extension for [Pi](https://github.com/earendil-works/pi-coding-agent): a local, Apple-Silicon classifier that answers typed questions — yes/no, single choice, score — with a full probability distribution, without generating any text.

It serves [CLM-v0.1-8B](https://huggingface.co/mlx-community/CLM-v0.1-8B-MLX-8bit) (frozen Qwen3-8B encoder + two contrastive projection heads, MLX) as the classifier provider `clm-local` / model `clm-latest`.

- Typed answers with probabilities and confidence — fast, deterministic in shape.
- Local and private — Metal via MLX, binds `127.0.0.1` only, no API key.
- One shared background server across Pi sessions (ref-counted lockfile), the default ~8.6 GB model in unified memory once (lighter variants via the menu below).
- Zero Python required — prefers the pre-compiled `bin/clm-server` (Swift/MLX) for every published variant (4-bit, 5-bit, 8-bit), falls back to `uv run server/server.py` when no capable native binary is available or the native server fails to start.
- Standard HF hub cache layout — snapshots from other HF tools are adopted without re-downloading.

## Requirements

- macOS on Apple Silicon, ~8.6 GB disk + free memory for the default 8-bit model (downloaded on first use) — memory-constrained Macs can pick the lighter 4-bit variant via `/clm configure`
- Pi ≥ 0.99.0, [uv](https://docs.astral.sh/uv/) only if using the Python fallback

## Install

```bash
pi install git:github.com/jborkowski/pi-clm   # or: pi install ./pi-clm
```

### Native server via Homebrew (prebuilt bottle, no compile)

The native `clm-server` binary is distributed as a Homebrew bottle from this repo's tap — no Xcode or Command Line Tools build required:

```bash
brew tap jborkowski/pi-clm
brew install pi-clm-server
```

Bottle and formula versions track the repo's GitHub releases: `make brew-bottle` builds deterministic artifacts and prints their checksums (`dist/sha256s.txt`); after pasting them into the formula, `make release-upload` verifies the formula matches the built artifacts, uploads them, and syncs the tap formula.

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

## Model & quantization menu

Run `/clm configure` to pick a model and quantization level from a friendly menu:

- **4-bit** — ~4.7 GB download, ~5.5 GB peak memory (16 GB Macs recommended). The practical default for memory-constrained Macs. Approximate: 91.4% same-top-option vs 8-bit, rising to 99.3% when the model is at least 70% confident, so borderline decisions can occasionally flip.
- **5-bit** — listed in the community index; details unverified.
- **8-bit** — ~8 GB download, ~9 GB peak. Highest accuracy (99.0% agreement, essentially upstream-noise level). The out-of-the-box default.

The choice is persisted (in `config.json` under `PI_CLM_STATE_DIR`) and reused by later sessions. If you never open the menu, nothing changes: the existing default (8-bit) stays in effect and the extension starts silently with it; run `/clm configure` to pick a variant. After a change, a server owned solely by the current session is stopped so the next start uses the new variant; a server shared with other sessions or started externally keeps serving the previous variant until it stops.

Note: a variant is served natively only when the native binary reports support for its quantization (`clm-server --capabilities`; pre-capability binaries such as brew v0.1.0 are 8-bit-only, so 4/5-bit uses the Python fallback until a rebuilt binary ships) — see [native/clm-server](native/clm-server#constraints); `PI_CLM_SERVER_BIN=""` forces the Python fallback for any variant (requires `uv`).

## Judgment primitives

The extension registers one codemode-exposed tool (`clm`, namespace `clm`): a single composable call that judges one **state** — the evidence being judged — against a fan-out of independent, caller-labeled **questions**. State and questions are separate; all questions in a call see the same state and are judged independently, so fan-out is one call instead of a `Promise.all` of many. The tool declares an `outputSchema`, so codemode scripts receive the structured answers directly.

Questions are a discriminated union on `kind`:

```ts
{ kind: "bool",   instructions, criteria?: { true?, false? } }
{ kind: "choice", instructions, criteria: Record<string, string | object | null> }
{ kind: "score",  instructions, criteria: Array<string | object> }  // ordered levels, 2–10
```

Answers come back keyed by the same ids, with distributions as first-class data:

```ts
const { answers } = await tools.clm({
  state: { message: "Customer was charged twice" },
  questions: {
    urgent:   { kind: "bool", instructions: "Is this urgent?" },
    action:   { kind: "choice", instructions: "How should this be handled?",
                criteria: { refund: "Issue a refund", deny: "Deny the claim", escalate: "Escalate" } },
    severity: { kind: "score", instructions: "Rate severity.",
                criteria: ["low", "medium", "high"] },
  },
});
// answers.urgent   -> { kind: "bool", probability }                     P(true), 0–1
// answers.action   -> { kind: "choice", choice, probabilities, confidence }
// answers.severity -> { kind: "score", score, legend, probabilities, confidence }
```

Semantics:

- **bool** reports `probability` of true (0–1). No separate confidence — the probability is the whole story.
- **choice** reports the highest-probability key plus the full distribution. `confidence = (pmax − 1/n) / (1 − 1/n)`: 0 for a uniform distribution, 1 for certainty.
- **score** reports the probability-weighted position across the levels, normalized 0–1 (level `i` of `n` sits at `i/(n−1)`), so it can fall between levels. `legend` maps level positions to their texts for interpretation. Its `confidence` accounts for the distance between levels: mass split between adjacent levels is less uncertain than mass split between extremes.
- Thresholds are **application policy** — the primitives report distributions and never bake in a cutoff.

The same surface is exported for programmatic use, fully typed (answers are typed per question kind):

```ts
import { createClm } from "pi-clm";
const clm = createClm(classify); // classify: (context: ClassifierContext) => Promise<ClassifierResult>
const { answers } = await clm.ask({ message: "Customer was charged twice" }, {
  urgent: { kind: "bool", instructions: "Is this urgent?" },
  // …
});
// answers.urgent is typed ClmBoolAnswer, etc.
```

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
| `PI_CLM_STATE_DIR` | `~/.cache/pi-clm` | Lock file, log location, and the saved model/quantization choice |
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

The native server is resolved as: `PI_CLM_SERVER_BIN` → packaged `bin/clm-server` → `pi-clm-server` on `PATH` (e.g. the Homebrew bottle install — see [Install](#install)) → Python fallback. It is used only for published CLM checkpoints whose quantization bits it reports supporting via `--capabilities` (binaries that cannot answer, such as brew v0.1.0, are treated as 8-bit-only); any other repo — and any native server that fails to start — uses the Python fallback.

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
