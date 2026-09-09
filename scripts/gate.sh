#!/usr/bin/env bash
# Clean-checkout gate: exactly what CI does, from tracked files plus uncommitted changes,
# in a directory with no node_modules and no stale tsbuildinfo. Catches the class of bug
# where the working tree builds only because of state that is not in the repository.
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"   # bun is the compile target and is not on the default PATH
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${1:?usage: scripts/gate.sh <empty-dir>}"
rm -rf "$DST"; mkdir -p "$DST"
cd "$SRC"
git ls-files -z | tar --null -cf - -T - | (cd "$DST" && tar xf -)
# Overlay uncommitted changes; deletions too.
git status --porcelain -z | while IFS= read -r -d '' entry; do
  st="${entry:0:2}"; f="${entry:3}"
  case "$st" in
    *D*) rm -f "$DST/$f" ;;
    *)   [ -f "$f" ] && { mkdir -p "$DST/$(dirname "$f")"; cp "$f" "$DST/$f"; } ;;
  esac
done
cd "$DST"
echo "=== install ==="  && pnpm install --frozen-lockfile >/dev/null
echo "=== lint ==="     && pnpm run lint
echo "=== typecheck ===" && pnpm run typecheck
echo "=== test ==="     && pnpm run test 2>&1 | tail -6
# The suite runs on Node; the binary ships bun:sqlite. Check the driver contract on both,
# or a divergence between the two builtins is invisible until a user hits it.
echo "=== store contract (node) ==="
node --experimental-strip-types scripts/store-contract-check.ts 2>/dev/null | grep -E "passed on|FAIL"
node --experimental-strip-types scripts/store-contract-check.ts >/dev/null 2>&1
echo "=== store contract (bun) ==="
bun scripts/store-contract-check.ts 2>/dev/null | grep -E "passed on|FAIL"
bun scripts/store-contract-check.ts >/dev/null 2>&1
echo "=== build ==="    && pnpm run build:binary >/dev/null 2>&1
# The binary's own surfaces, which no unit test reaches: the MCP server only exists as a
# subprocess with stdout as a pipe, and the admin server only serves the embedded UI once
# it is embedded. Both had defects that were invisible until run this way.
echo "=== mcp protocol ==="
node scripts/mcp-protocol-check.mjs ./dist/maestro | grep -E "verified|FAIL"
node scripts/mcp-protocol-check.mjs ./dist/maestro >/dev/null 2>&1

echo "=== smoke ==="    && ./dist/maestro --version && ./dist/maestro doctor 2>&1 | tail -12
