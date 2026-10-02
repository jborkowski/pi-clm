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
REFERENCE  := test/fixtures/native-parity-reference.json

.DEFAULT_GOAL := help
.PHONY: help build native install-bin deps test test-swift test-ts typecheck dup parity e2e serve clean

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's|^([a-zA-Z_-]+):.*## (.*)|  \1\t\2|' | awk -F'\t' '{printf "  %-12s %s\n", $$1, $$2}'

deps: ## npm install
	npm install

native: deps ## Build native clm-server (Swift release, arm64)
	cd $(SWIFT_DIR) && swift build -c release --product CLMServer

install-bin: native ## Install binary + SwiftPM resource bundles into bin/
	@test -x $(PRODUCTS)/CLMServer || { echo "build products missing in $(PRODUCTS)"; exit 1; }
	mkdir -p bin
	cp $(PRODUCTS)/CLMServer $(SERVER_BIN)
	rm -rf bin/*.bundle
	cp -R $(PRODUCTS)/*.bundle bin/
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
# into dist/: a brew bottle tarball (pi-clm-server-<V>.<tag>.bottle.tar.gz)
# and a plain binary tarball used as the formula's stable URL. Both sha256
# sums are printed; paste them into Formula/pi-clm-server.rb.
# `make release-upload` tags v<V>, uploads both assets as a GitHub release
# on jborkowski/pi-clm, and pushes the updated formula to the homebrew-pi-clm tap.
BREW          ?= brew
TAP           := jborkowski/pi-clm
GH            ?= gh-axi
BOTTLE_TAG    ?= arm64_tahoe
BOTTLE        := dist/pi-clm-server-$(VERSION).$(BOTTLE_TAG).bottle.tar.gz
RELEASE_TAG   := v$(VERSION)
RELEASE_NOTES ?= "Prebuilt arm64 macOS release (bottle + binary tarball)."

.PHONY: brew-bottle release-upload uninstall

brew-bottle: install-bin
	rm -rf dist && mkdir -p dist
	@test -n "$(VERSION)" || { echo "error: cannot derive version (package.json)"; exit 1; }
	rm -rf /tmp/pi-clm-bottle && mkdir -p "/tmp/pi-clm-bottle/pi-clm-server/$(VERSION)/bin" "/tmp/pi-clm-bottle/pi-clm-server/$(VERSION)/libexec"
	cp $(SERVER_BIN) "/tmp/pi-clm-bottle/pi-clm-server/$(VERSION)/libexec/clm-server"
	cp -R $(PRODUCTS)/*.bundle "/tmp/pi-clm-bottle/pi-clm-server/$(VERSION)/libexec/"
	printf '#!/bin/bash\nexec "$$(dirname "$$(readlink -f "$$0")")/../libexec/clm-server" "$$@"\n' > "/tmp/pi-clm-bottle/pi-clm-server/$(VERSION)/bin/pi-clm-server"
	chmod +x "/tmp/pi-clm-bottle/pi-clm-server/$(VERSION)/bin/pi-clm-server"
	tar -C /tmp/pi-clm-bottle -czf $(BOTTLE) pi-clm-server
	tar -C bin -czf $(TARBALL) clm-server $$(cd bin && ls -d *.bundle)
	@echo "$(BOTTLE)"; echo "bottle sha256: $$(shasum -a 256 $(BOTTLE) | cut -d' ' -f1)"
	@echo "$(TARBALL)";  echo "url   sha256: $$(shasum -a 256 $(TARBALL) | cut -d' ' -f1)"

release-upload: brew-bottle
	$(GH) release create $(RELEASE_TAG) -R $(TAP) --notes $(RELEASE_NOTES) $(BOTTLE) $(TARBALL)
	@TAP_FILE="repos/jborkowski/homebrew-pi-clm/contents/Formula/pi-clm-server.rb"; \
	SHA=$$($(GH) api "$$TAP_FILE" --jq .sha 2>/dev/null || true); \
	$(GH) api --method PUT "$$TAP_FILE" -f message="pi-clm-server $(RELEASE_TAG)" \
		-f content="$$(base64 < Formula/pi-clm-server.rb)" $${SHA:+-f sha=$$SHA}

uninstall:
	-$(BREW) uninstall $(TAP)/pi-clm-server
