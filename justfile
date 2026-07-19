# Chrollo — justfile
# Pipeline: fmt (writes) · check (read-only) · types · test · ci
# Pi runs index.ts directly via tsx — there is NO compile/build step.

# default: show available recipes
default:
    @just --list

# Format all source (writes)
fmt:
    npx prettier --write 'index.ts' 'src/*.ts' 'test/**/*.ts' 'vitest.config.ts'

# Read-only format check
lint:
    npx prettier --check 'index.ts' 'src/*.ts' 'test/**/*.ts' 'vitest.config.ts'

# Smoke import test (catches broken modules / unresolved imports)
smoke:
    npm run smoke

# Type-check (no emit). Standalone until render-fn signatures are fixed (PLAN 6.5),
# after which it joins `check`.
types:
    npx tsc --noEmit

# Read-only verification: format-check + types + smoke
check: lint types smoke

# Run the test suite
test:
    npx vitest run

# Full pipeline
ci: check types test

# Remove build/test artifacts and caches
clean:
    rm -rf node_modules/.cache .vitest
    find . -type d -name 'test-results' -prune -exec rm -rf {} +

# Truncate the metrics sidecar (keeps the file, clears contents)
clean-metrics:
    @if [ -f .chrollo/metrics.jsonl ]; then : > .chrollo/metrics.jsonl; echo "cleared .chrollo/metrics.jsonl"; else echo "no metrics file"; fi
