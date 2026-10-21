BINARY := tdo

.PHONY: build install uninstall test typecheck scan scan-history \
        hooks clean check binary emit icons

build: ## Type-check and build the TypeScript workspace
	npm run build

test: ## Run tests (no network access required)
	npm test

typecheck: ## Type-check without emitting
	npx tsc --build --force

emit: ## Emit JavaScript into ./dist (what the npm packages ship)
	npx tsc -p tsconfig.build.json

binary: ## Build the single executable into ./dist-bin (add ARGS=--all to cross-compile)
	@# Needs the bun pinned in mise.toml; the script smoke-tests what it built.
	node scripts/build-binary.mjs $(ARGS)

icons: ## Redraw the viewer's icons into packages/cli/assets (only when the mark changes)
	node scripts/genicon.mjs

install: ## Build from this tree and install into ~/.local/bin, then create the store
	./scripts/install-local.sh

uninstall: ## Remove the installed binary (never your tasks)
	./scripts/install-local.sh --uninstall

scan: ## Scan tracked files for credentials
	./scripts/scan-secrets.sh --tree

scan-history: ## Scan the full git history for credentials (what CI runs)
	./scripts/scan-secrets.sh --history

hooks: ## Install the pre-commit hook (run once after cloning)
	./scripts/install-hooks.sh

check: typecheck test scan ## Everything that must pass before a commit

clean:
	rm -rf dist dist-bin node_modules/.cache
	find packages -name dist -type d -prune -exec rm -rf {} + 2>/dev/null || true
	find packages -name '*.tsbuildinfo' -delete 2>/dev/null || true
