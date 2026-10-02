# pi-clm — build & test entry points.
# `make help` lists targets. Model snapshot path is passed as MODEL=...

MODEL ?=
PORT  ?= 8700
TRUNC ?= head
VERSION ?= $(shell node -p "require('./package.json').version")


SWIFT_DIR  := native/clm-server
# Prefer the Xcode-generated products dir when present; plain `swift build` puts
# products in .build/arm64-apple-macosx/release instead.
PRODUCTS   ?= $(shell test -x $(SWIFT_DIR)/.build/out/Products/Release/CLMServer && echo $(SWIFT_DIR)/.build/out/Products/Release || echo $(SWIFT_DIR)/.build/arm64-apple-macosx/release)
SERVER_BIN := bin/clm-server
METALLIB   := bin/mlx.metallib
REFERENCE  := test/fixtures/native-parity-reference.json

# SwiftPM never compiles MLX's Metal kernels (Xcode-only step), so the server
# dies at MLX init with "Failed to load the default metallib" unless we build
# mlx.metallib ourselves and ship it next to the binary (MLX's first lookup
# path). Sources are the kernel files mlx-swift prepares for Xcode builds in
# Source/Cmlx/mlx-generated/metal; flags mirror mlx's
# mlx/backend/metal/kernels/CMakeLists.txt. The remaining kernels are
# JIT-compiled from source embedded in the Cmlx target at runtime.
MLX_CHECKOUT    := $(SWIFT_DIR)/.build/checkouts/mlx-swift
MLX_METAL_DIR   := $(MLX_CHECKOUT)/Source/Cmlx/mlx-generated/metal
MLX_METALLIB_DIR := $(SWIFT_DIR)/.build/mlx-metallib
MLX_KERNELS     := arg_reduce conv dot layer_norm random rms_norm rope scaled_dot_product_attention searchsorted steel/attn/kernels/steel_attention

.DEFAULT_GOAL := help
.PHONY: help build native mlx-metallib install-bin deps test test-swift test-ts typecheck dup parity e2e serve clean

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's|^([a-zA-Z_-]+):.*## (.*)|  \1\t\2|' | awk -F'\t' '{printf "  %-12s %s\n", $$1, $$2}'

deps: ## npm install
	npm install

native: deps ## Build native clm-server (Swift release, arm64)
	cd $(SWIFT_DIR) && swift build -c release --product CLMServer

mlx-metallib: native ## Compile MLX's Metal kernels into mlx.metallib
	@test -d "$(MLX_METAL_DIR)" || { echo "mlx-swift kernel sources missing at $(MLX_METAL_DIR)"; exit 1; }
	rm -rf $(MLX_METALLIB_DIR) && mkdir -p $(MLX_METALLIB_DIR)
	cd $(MLX_METAL_DIR) && for k in $(MLX_KERNELS); do \
		xcrun -sdk macosx metal -x metal -Wall -Wextra -fno-fast-math \
			-Wno-c++17-extensions -Wno-c++20-extensions -Wmetal-addr-spaces \
			-c $$k.metal -I . -o $(CURDIR)/$(MLX_METALLIB_DIR)/$$(basename $$k).air || exit 1; \
	done
	xcrun -sdk macosx metal $(MLX_METALLIB_DIR)/*.air -o $(MLX_METALLIB_DIR)/mlx.metallib

install-bin: mlx-metallib ## Install binary + SwiftPM resource bundles + MLX metallib into bin/
	@test -x $(PRODUCTS)/CLMServer || { echo "build products missing in $(PRODUCTS)"; exit 1; }
	mkdir -p bin
	cp $(PRODUCTS)/CLMServer $(SERVER_BIN)
	rm -rf bin/*.bundle
	cp -R $(PRODUCTS)/*.bundle bin/
	cp $(MLX_METALLIB_DIR)/mlx.metallib $(METALLIB)
	@file $(SERVER_BIN)

build: install-bin test ## Everything: build, install, all checks (scripts/build.sh one-shot equivalent)

test-swift: ## Swift unit tests (no model needed)
	cd $(SWIFT_DIR) && swift test

test-ts: ## TypeScript test suite
	npm test

typecheck: ## tsc --noEmit
	npm run typecheck

dup: ## jscpd duplication check
	npm run check:dup

test: test-swift test-ts typecheck dup ## All checks

parity: ## Engine parity vs Python reference (MODEL=<snapshot-dir>)
	@test -n "$(MODEL)" || { echo "usage: make parity MODEL=<model-snapshot-dir>"; exit 2; }
	$(SERVER_BIN) parity $(REFERENCE) --model-path $(MODEL) --truncation head
	$(SERVER_BIN) parity $(REFERENCE) --model-path $(MODEL) --truncation tail

e2e: ## Native e2e over the wire API (MODEL=<snapshot-dir>)
	@test -n "$(MODEL)" || { echo "usage: make e2e MODEL=<model-snapshot-dir>"; exit 2; }
	PI_CLM_NATIVE_MODEL=$(MODEL) npm test

serve: ## Run the server in the foreground (MODEL=..., PORT=8700, TRUNC=head)
	@test -n "$(MODEL)" || { echo "usage: make serve MODEL=<model-snapshot-dir>"; exit 2; }
	$(SERVER_BIN) --port $(PORT) --model-path $(MODEL) --truncation $(TRUNC)

clean: ## Remove Swift build artifacts and dist output
	cd $(SWIFT_DIR) && swift package clean
	rm -rf dist

# --- Homebrew (in-repo tap: this repo IS the tap, no external tap repos) ---
# Workflow: tap (this repo over SSH) -> pack (source snapshot into the local
# tap) -> install (build from source). The formula prefers the packed tarball
# and falls back to building the tagged release straight from the repo, so
# installs never depend on GitHub release assets or a homebrew-* repo.
# `make start/stop/restart/status/logs` drive `brew services` (the formula has
# a service block; link a model snapshot to $(brew --prefix)/var/pi-clm/model).
BREW    ?= brew
TAP     := jborkowski/pi-clm
FORMULA := $(TAP)/pi-clm-server
export HOMEBREW_NO_AUTO_UPDATE ?= 1
export HOMEBREW_NO_INSTALL_FROM_API ?= 1

.PHONY: tap pack install uninstall start stop restart status logs

tap:
	@if ! $(BREW) tap | grep -qx "$(TAP)"; then \
		$(BREW) tap "$(TAP)" "git@github.com:$(TAP).git"; \
	fi

pack: tap
	@TAPDIR="$$( $(BREW) --repo $(TAP) )"; \
	mkdir -p "$$TAPDIR/Formula"; \
	rm -rf "$$TAPDIR/build-src" "$$TAPDIR/pi-clm-server-src.tar.gz"; \
	rsync -a \
		--exclude '.git/' \
		--exclude 'bin/' \
		--exclude 'dist/' \
		--exclude 'node_modules/' \
		--exclude 'native/clm-server/.build/' \
		--exclude '.tmp-e2e/' \
		--exclude '.cursor/' \
		--exclude '.agents/' \
		--exclude '.claude/' \
		--exclude '.pi/' \
		--exclude '.DS_Store' \
		./ "$$TAPDIR/build-src/"; \
	tar -C "$$TAPDIR" -czf "$$TAPDIR/pi-clm-server-src.tar.gz" build-src; \
	cp -f Formula/pi-clm-server.rb "$$TAPDIR/Formula/pi-clm-server.rb"; \
	echo "packed $$TAPDIR/pi-clm-server-src.tar.gz"

install: pack
	@if $(BREW) list --formula "$(FORMULA)" >/dev/null 2>&1; then \
		$(BREW) reinstall --build-from-source "$(FORMULA)"; \
	else \
		$(BREW) install --build-from-source "$(FORMULA)"; \
	fi

uninstall:
	-$(BREW) uninstall "$(FORMULA)"
	-$(BREW) untap "$(TAP)"

start:
	$(BREW) services start $(FORMULA)

stop:
	$(BREW) services stop $(FORMULA)

restart:
	$(BREW) services restart $(FORMULA)

status:
	-$(BREW) services info $(FORMULA)

logs:
	@prefix="$$($(BREW) --prefix)"; \
	tail -n 80 -f "$$prefix/var/log/pi-clm-server.log" "$$prefix/var/log/pi-clm-server.err.log"
