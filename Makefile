BINARY := tdo
PKG    := ./...

.PHONY: build install uninstall test fmt vet lint scan scan-history hooks clean check

build: ## Build the CLI into ./bin/tdo
	CGO_ENABLED=0 go build -o bin/$(BINARY) ./cmd/$(BINARY)

install: ## Build from this tree and install into ~/.local/bin, then create the store
	./scripts/install-local.sh

uninstall: ## Remove the installed binary (never your tasks)
	./scripts/install-local.sh --uninstall

test: ## Run tests (no network access required)
	go test $(PKG)

fmt:
	gofmt -l -w .

vet:
	go vet $(PKG)

scan: ## Scan tracked files for credentials
	./scripts/scan-secrets.sh --tree

scan-history: ## Scan the full git history for credentials (what CI runs)
	./scripts/scan-secrets.sh --history

hooks: ## Install the pre-commit hook (run once after cloning)
	./scripts/install-hooks.sh

check: fmt vet test scan ## Everything that must pass before a commit

clean:
	rm -rf bin dist coverage.out
