# pi-clm — build & test entry points.
# `make help` lists targets. Model snapshot path is passed as MODEL=...

MODEL ?=
PORT  ?= 8700
TRUNC ?= head
VERSION ?= $(shell node -p "require('./package.json').version")
TARBALL := dist/clm-server-$(VERSION)-macos-arm64.tar.gz

SWIFT_DIR  := native/clm-server
PRODUCTS   := $(SWIFT_DIR)/.build/out/Products/Release
SERVER_BIN := bin/clm-server
REFERENCE  := test/fixtures/native-parity-reference.json

.DEFAULT_GOAL := help
.PHONY: help build native install-bin deps test test-swift test-ts typecheck dup parity e2e serve dist clean

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's|^([a-zA-Z_-]+):.*## (.*)|  \1\t\2|' | awk -F'\t' '{printf "  %-12s %s\n", $$1, $$2}'

deps: ## npm install
	npm install

native: deps ## Build native clm-server (Swift release, arm64)
	cd $(SWIFT_DIR) && swift build -c release --product CLMServer

install-bin: native ## Install binary + Metal bundle into bin/
	@test -x $(PRODUCTS)/CLMServer || { echo "build products missing in $(PRODUCTS)"; exit 1; }
	mkdir -p bin
	cp $(PRODUCTS)/CLMServer $(SERVER_BIN)
	rm -rf bin/mlx-swift_Cmlx.bundle
	cp -R $(PRODUCTS)/mlx-swift_Cmlx.bundle bin/
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

dist: install-bin ## Build release tar.gz + Homebrew formula into dist/
	rm -rf dist && mkdir -p dist
	tar -czf $(TARBALL) -C bin clm-server mlx-swift_Cmlx.bundle
	@SHA=$$(shasum -a 256 $(TARBALL) | cut -d' ' -f1); \
	sed -e "s|__VERSION__|$(VERSION)|g" -e "s|__SHA256__|$$SHA|g" \
		scripts/pi-clm-server.rb.tpl > dist/pi-clm-server.rb; \
	echo "$(TARBALL)"; echo "sha256: $$SHA"; ls -la dist/

clean: ## Remove Swift build artifacts and dist output
	cd $(SWIFT_DIR) && swift package clean
	rm -rf dist
