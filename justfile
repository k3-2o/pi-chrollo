# Chrollo — justfile
# Pipeline: fmt (writes) · check (read-only) · types · test · ci
# Pi runs index.ts directly via tsx — there is NO compile/build step.

# default: show available recipes
default:
    @just --list

# Format all source (writes). `find` yields zero args when src/ is empty
# (e.g. mid-rewrite), so prettier never sees a non-matching glob.
fmt:
    npx prettier --write index.ts vitest.config.ts $(find src test -name '*.ts' 2>/dev/null)

# Read-only format check
lint:
    npx prettier --check index.ts vitest.config.ts $(find src test -name '*.ts' 2>/dev/null)

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
