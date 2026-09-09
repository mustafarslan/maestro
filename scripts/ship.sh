#!/usr/bin/env bash
#
# Runs the gate and commits only if it passed.
#
# Twice in one session I ran the gate, read its output, and pushed a commit whose gate had
# failed — once because the last line printed was another program's success message, and
# once because I piped the gate into `grep` and the pipeline's exit status was grep's. Both
# times the information was there and I did not act on it.
#
# The fix is not to be more careful. It is to make committing depend on the exit code
# rather than on my reading of the output:
#
#   scripts/ship.sh <<'MSG'
#   Commit subject
#
#   Body.
#   MSG
#
set -euo pipefail
cd "$(dirname "$0")/.."

message="$(cat)"
[ -n "$message" ] || { echo "refusing to commit with an empty message"; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# No pipe. The gate's exit code is the whole point, and `set -e` stops here if it fails.
echo "running the gate…"
if ! scripts/gate.sh "$work/gate" > "$work/out" 2>&1; then
  tail -25 "$work/out"
  echo
  echo "GATE FAILED — nothing committed, nothing pushed."
  exit 1
fi
grep -E "Tests |GATE PASSED" "$work/out" | tail -2

git add -A
printf '%s\n' "$message" | git commit -q -F -
git push origin master
