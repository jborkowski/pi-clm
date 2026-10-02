#!/usr/bin/env bash
# Build everything for pi-clm:
#   1. TypeScript dependencies
#   2. Native clm-server (Swift release build, arm64) + mlx.metallib -> bin/
#   3. Test suites: swift test, npm test, typecheck, jscpd
#   4. Optional engine parity vs the Python reference when a model snapshot
#      is available (PI_CLM_NATIVE_MODEL or $1)
#
# Usage:
#   scripts/build.sh                     # build + all checks
#   scripts/build.sh --skip-tests        # build only
#   PI_CLM_NATIVE_MODEL=<dir> scripts/build.sh
#   scripts/build.sh /path/to/model-snapshot
#
# Prerequisite: Xcode with the Metal toolchain installed once:
#   sudo xcode-select -s /Applications/Xcode.app
#   xcodebuild -downloadComponent MetalToolchain
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_DIR="$ROOT/native/clm-server"
BIN_DIR="$ROOT/bin"
MODEL="${1:-${PI_CLM_NATIVE_MODEL:-}}"
RUN_TESTS=1
if [[ "${1:-}" == "--skip-tests" || "${2:-}" == "--skip-tests" ]]; then RUN_TESTS=0; MODEL="${PI_CLM_NATIVE_MODEL:-}"; fi

log() { printf '\n==> %s\n' "$*"; }

log "TypeScript dependencies"
( cd "$ROOT" && npm install )

log "Native clm-server (Swift release build) -> bin/"
# Same flow as `make install-bin`: Swift release build, then binary + SwiftPM
# resource bundles + mlx.metallib into bin/ (PRODUCTS detection included).
# Delegated to the Makefile so the packaging steps have one owner; without
# mlx.metallib (SwiftPM never compiles MLX's Metal kernels) the server dies
# at MLX init with "Failed to load the default metallib".
if ! make -C "$ROOT" install-bin; then
  echo "" >&2
  echo "Native build failed. Two common causes:" >&2
  echo "  1. A beta Xcode is selected and cannot compile the dependencies." >&2
  echo "     Fix: sudo xcode-select -s /Applications/Xcode.app" >&2
  echo "  2. The Metal toolchain is missing for this Xcode." >&2
  echo "     Fix: xcodebuild -downloadComponent MetalToolchain" >&2
  exit 1
fi

if [[ "$RUN_TESTS" == 1 ]]; then
  log "Swift tests"
  ( cd "$SWIFT_DIR" && swift test )

  log "TypeScript tests + typecheck + duplication check"
  ( cd "$ROOT" && npm test && npm run typecheck && npm run check:dup )
fi

if [[ -n "$MODEL" && -d "$MODEL" ]]; then
  log "Engine parity vs Python reference (model: $MODEL)"
  "$BIN_DIR/clm-server" parity "$ROOT/test/fixtures/native-parity-reference.json" \
    --model-path "$MODEL" --truncation head
  "$BIN_DIR/clm-server" parity "$ROOT/test/fixtures/native-parity-reference.json" \
    --model-path "$MODEL" --truncation tail

  log "Native e2e (npm)"
  ( cd "$ROOT" && PI_CLM_NATIVE_MODEL="$MODEL" npm test )
elif [[ -z "$MODEL" ]]; then
  echo
  echo "Skipped engine parity (no model snapshot). Run with:"
  echo "  PI_CLM_NATIVE_MODEL=<model-snapshot-dir> scripts/build.sh"
fi

log "Done"
