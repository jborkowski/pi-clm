# pi-clm — build & test entry points.
# `make help` lists targets. Model snapshot path is passed as MODEL=...

MODEL ?=
PORT  ?= 8700
TRUNC ?= head
VERSION ?= $(shell node -p "require('./package.json').version")
TARBALL := dist/clm-server-$(VERSION)-macos-arm64.tar.gz


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

# --- Homebrew release workflow (prebuilt bottle, no compile-on-install) ---
# `make brew-bottle` packages the release binary + SwiftPM resource bundles
# + MLX's mlx.metallib into dist/: a brew bottle tarball (pi-clm-server-<V>.<tag>.bottle.tar.gz)
# and a plain binary tarball used as the formula's stable URL. Packaging is
# deterministic (fixed mtimes, gzip -n); both sha256 sums are written to
# dist/sha256s.txt — paste them and the new version into Formula/pi-clm-server.rb.
# `make release-upload` (run after the paste) verifies the formula matches
# the built dist/ artifacts exactly, then tags v<V>, uploads those artifacts
# as a GitHub release on jborkowski/pi-clm, and pushes the formula to the
# homebrew-pi-clm tap. It never rebuilds.
BREW          ?= brew
TAP           := jborkowski/pi-clm
GH            ?= gh-axi
BOTTLE_TAG    ?= arm64_tahoe
BOTTLE        := dist/pi-clm-server-$(VERSION).$(BOTTLE_TAG).bottle.tar.gz
RELEASE_TAG   := v$(VERSION)
RELEASE_NOTES ?= "Prebuilt arm64 macOS release (bottle + binary tarball)."
STAGING       := /tmp/pi-clm-bottle
PINNED_MTIME  := 202501010000

.PHONY: brew-bottle release-upload uninstall

brew-bottle: install-bin
	rm -rf dist && mkdir -p dist
	@test -n "$(VERSION)" || { echo "error: cannot derive version (package.json)"; exit 1; }
	rm -rf $(STAGING) && mkdir -p "$(STAGING)/pi-clm-server/$(VERSION)/bin" "$(STAGING)/pi-clm-server/$(VERSION)/libexec" "$(STAGING)/src"
	cp $(SERVER_BIN) "$(STAGING)/pi-clm-server/$(VERSION)/libexec/clm-server"
	cp -R $(PRODUCTS)/*.bundle "$(STAGING)/pi-clm-server/$(VERSION)/libexec/"
	cp $(METALLIB) "$(STAGING)/pi-clm-server/$(VERSION)/libexec/mlx.metallib"
	printf '#!/bin/bash\nexec "$$(dirname "$$(readlink -f "$$0")")/../libexec/clm-server" "$$@"\n' > "$(STAGING)/pi-clm-server/$(VERSION)/bin/pi-clm-server"
	chmod +x "$(STAGING)/pi-clm-server/$(VERSION)/bin/pi-clm-server"
	cp $(SERVER_BIN) "$(STAGING)/src/clm-server"
	cp -R $(PRODUCTS)/*.bundle "$(STAGING)/src/"
	cp $(METALLIB) "$(STAGING)/src/mlx.metallib"
	find $(STAGING) -exec touch -t $(PINNED_MTIME) {} +
	(cd $(STAGING) && tar -cf - pi-clm-server) | gzip -n > $(BOTTLE)
	(cd $(STAGING)/src && tar -cf - clm-server mlx.metallib *.bundle) | gzip -n > $(TARBALL)
	@shasum -a 256 $(BOTTLE) $(TARBALL) | sed 's|dist/||' > dist/sha256s.txt
	@cat dist/sha256s.txt

release-upload:
	@test -f "$(BOTTLE)" -a -f "$(TARBALL)" || { echo "error: $(BOTTLE) and $(TARBALL) not built — run make brew-bottle first"; exit 1; }
	@F_VERSION=$$(sed -n 's/^  version "\(.*\)"/\1/p' Formula/pi-clm-server.rb); \
	F_URL_SHA=$$(sed -n "s/^  sha256 \"\([0-9a-f]\{64\}\)\"/\1/p" Formula/pi-clm-server.rb); \
	F_BOTTLE_SHA=$$(sed -n "s/.*$(BOTTLE_TAG): \"\([0-9a-f]\{64\}\)\"/\1/p" Formula/pi-clm-server.rb); \
	A_URL_SHA=$$(shasum -a 256 $(TARBALL) | cut -d' ' -f1); \
	A_BOTTLE_SHA=$$(shasum -a 256 $(BOTTLE) | cut -d' ' -f1); \
	ok=1; \
	[ "$$F_VERSION" = "$(VERSION)" ] || { echo "error: formula version '$$F_VERSION' != package.json $(VERSION) — update Formula/pi-clm-server.rb"; ok=0; }; \
	[ "$$F_URL_SHA" = "$$A_URL_SHA" ] || { echo "error: formula url sha256 does not match $(TARBALL) — paste the sha256 from dist/sha256s.txt"; ok=0; }; \
	[ "$$F_BOTTLE_SHA" = "$$A_BOTTLE_SHA" ] || { echo "error: formula bottle sha256 does not match $(BOTTLE) — paste the sha256 from dist/sha256s.txt"; ok=0; }; \
	[ "$$ok" = 1 ] || exit 1
	$(GH) release create $(RELEASE_TAG) -R $(TAP) --notes $(RELEASE_NOTES) $(BOTTLE) $(TARBALL) || \
		$(GH) release upload $(RELEASE_TAG) -R $(TAP) --clobber $(BOTTLE) $(TARBALL)
	@TAP_FILE="repos/jborkowski/homebrew-pi-clm/contents/Formula/pi-clm-server.rb"; \
	SHA=$$($(GH) api "$$TAP_FILE" --jq .sha 2>/dev/null || true); \
	COMMIT=$$($(GH) api --method PUT "$$TAP_FILE" -f message="pi-clm-server $(RELEASE_TAG)" \
		-f content="$$(base64 < Formula/pi-clm-server.rb)" $${SHA:+-f sha=$$SHA} --jq .commit.sha); \
	test -n "$$COMMIT" || { echo "error: tap formula push failed"; exit 1; }; \
	echo "tap synced: jborkowski/homebrew-pi-clm@$$COMMIT"

uninstall:
	-$(BREW) uninstall $(TAP)/pi-clm-server
