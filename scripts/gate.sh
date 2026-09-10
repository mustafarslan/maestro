#!/usr/bin/env bash
# Clean-checkout gate: exactly what CI does, from tracked files plus uncommitted changes,
# in a directory with no node_modules and no stale tsbuildinfo. Catches the class of bug
# where the working tree builds only because of state that is not in the repository.
set -euo pipefail
# `set -e` exits on the first failing step; this makes that visible rather than silent.
trap 'status=$?; [ "$status" -ne 0 ] && echo && echo "GATE FAILED (exit $status)"; exit $status' EXIT
export PATH="$HOME/.bun/bin:$PATH"   # bun is the compile target and is not on the default PATH
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${1:?usage: scripts/gate.sh <empty-dir>}"
rm -rf "$DST"; mkdir -p "$DST"
cd "$SRC"
git ls-files -z | tar --null -cf - -T - | (cd "$DST" && tar xf -)
# Overlay uncommitted changes; deletions too.
#
# `-uall` because the default collapses a wholly-new directory to one entry ending in
# `/`. Without it, a new file in a new directory never reached the checkout — and the
# `[ -f ] && { … }` idiom this loop used then returned 1 as the last command of the loop
# body, which under `set -e` killed the gate before it printed a single line. A gate that
# dies with no output is indistinguishable from one that fails a check, and the fix for
# only that half would have been worse: the gate would have passed while testing a tree
# missing the new file.
#
# `if` rather than `&&` so a skipped entry is a skip, not a non-zero exit.
git status --porcelain -z -uall | while IFS= read -r -d '' entry; do
  st="${entry:0:2}"; f="${entry:3}"
  case "$st" in
    *D*) rm -f "$DST/$f" ;;
    *)
      if [ -f "$f" ]; then
        mkdir -p "$DST/$(dirname "$f")"
        cp "$f" "$DST/$f"
      fi
      ;;
  esac
done
cd "$DST"
echo "=== install ==="  && pnpm install --frozen-lockfile >/dev/null
echo "=== lint ==="     && pnpm run lint
echo "=== typecheck ===" && pnpm run typecheck
# The Linux binary the egress proxy container runs, built BEFORE the tests because the
# integration suite prepares real environments and the enforced posture needs one. A clean
# checkout has no `dist/`, and the alternative — falling back to a published release — would
# test whatever was released rather than the code in this tree. Costs about a second: the
# bundle is already built by the typecheck above.
echo "=== proxy binary ===" && pnpm exec tsc -b >/dev/null && node scripts/build-proxy-binary.mjs 2>&1 | tail -1
echo "=== test ==="     && pnpm run test 2>&1 | tail -6
# The suite runs on Node; the binary ships bun:sqlite. Check the driver contract on both,
# or a divergence between the two builtins is invisible until a user hits it.
echo "=== store contract (node) ==="
node --experimental-strip-types scripts/store-contract-check.ts 2>/dev/null | grep -E "passed on|FAIL"
node --experimental-strip-types scripts/store-contract-check.ts >/dev/null 2>&1
echo "=== store contract (bun) ==="
bun scripts/store-contract-check.ts 2>/dev/null | grep -E "passed on|FAIL"
bun scripts/store-contract-check.ts >/dev/null 2>&1
# Cheap, and the class it catches is this project's own subject matter: a document that
# refers to something no longer there.
echo "=== docs ==="
node scripts/docs-check.mjs | tail -1
node scripts/docs-check.mjs >/dev/null 2>&1

echo "=== build ==="    && pnpm run build:binary >/dev/null 2>&1
# The binary's own surfaces, which no unit test reaches: the MCP server only exists as a
# subprocess with stdout as a pipe, and the admin server only serves the embedded UI once
# it is embedded. Both had defects that were invisible until run this way.
# Five processes contending for one SQLite file: the queue's core promise is that no job is
# claimed twice, and a single-process test cannot exercise it.
echo "=== queue race ==="
node scripts/queue-race-check.mjs 2>/dev/null | grep -E "safe under|FAIL" || true
node scripts/queue-race-check.mjs >/dev/null 2>&1

echo "=== mcp protocol ==="
node scripts/mcp-protocol-check.mjs ./dist/maestro | grep -E "verified|FAIL" || true
node scripts/mcp-protocol-check.mjs ./dist/maestro >/dev/null 2>&1

# `init` and `playbook nodes` on a fresh MAESTRO_HOME, which is the first thing any new
# user runs. They were in CI and not here, so the gate never checked that a clean install
# works — the one path a broken migration or a missing embedded asset shows up on first.
echo "=== smoke ==="    && ./dist/maestro --version
MAESTRO_HOME="$(mktemp -d)" ./dist/maestro init >/dev/null
MAESTRO_HOME="$(mktemp -d)" ./dist/maestro playbook nodes >/dev/null
./dist/maestro doctor 2>&1 | tail -12

# Linear owns this schema and can change it without telling us. The check needs no
# credential — Linear validates a query before it authenticates. Advisory: their
# availability is not this build's business, so a failure prints and does not stop.
echo "=== linear query shape (advisory) ==="
node scripts/live-linear-check.mjs 2>&1 | tail -3 || echo "  (advisory check unavailable)"

# The gate's own verdict, and the only line that means the gate passed.
#
# Until this existed the last thing printed was `doctor`'s "all checks passed, 2
# warning(s)" — another program's success message about a different question. I grepped for
# it, saw it, and pushed a commit whose gate had failed two steps earlier. A script whose
# success is inferred from somebody else's output invites exactly that, so it says so
# itself, and says the opposite on any failure.
echo
echo "GATE PASSED"
