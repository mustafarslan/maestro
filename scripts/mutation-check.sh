#!/usr/bin/env bash
#
# Breaks a guard on purpose and checks whether the suite notices.
#
# A guard nothing notices is a guard that is not tested, however many tests mention it.
# This session found five checks that passed for the wrong reason — four in the repository,
# one in the gate itself — and then found that the fork trust downgrade, which the plan
# calls a blocking security rule, had no test at all: four separate ways to turn a fork
# pull request into arbitrary code execution with network access, each of which left the
# whole suite green.
#
# Not part of the gate: it runs the suite once per mutation. Run it when touching a control.
#
#   scripts/mutation-check.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."

# Refuse to run on a dirty tree. Every mutation is reverted with `git checkout --`, which
# would throw uncommitted work away along with the mutation. The first version of this
# script instead kept one backup at a fixed path, and two overlapping runs restored the
# wrong file over another — truncating daemon.ts to a fragment. git already knows what
# every file should contain; nothing else here does.
if [ -n "$(git status --porcelain -- packages apps)" ]; then
  echo "packages/ or apps/ has uncommitted changes."
  echo "This script reverts files with 'git checkout --', which would discard them."
  exit 2
fi

survivors=0
trap 'git checkout -- packages apps 2>/dev/null' EXIT INT TERM

mutate() {
  python3 -c '
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
if sys.argv[2] not in s:
    sys.exit(3)
p.write_text(s.replace(sys.argv[2], sys.argv[3], 1))
' "$1" "$2" "$3"
}

run() {
  local name="$1" file="$2" from="$3" to="$4"
  if ! mutate "$file" "$from" "$to"; then
    printf '  %-44s %s\n' "$name" "anchor missing - this mutation needs updating"
    return
  fi
  if pnpm -s exec vitest run >/dev/null 2>&1; then
    printf '  %-44s %s\n' "$name" "SURVIVED - nothing tests this"
    survivors=$((survivors + 1))
  else
    printf '  %-44s %s\n' "$name" "caught"
  fi
  git checkout -- "$file"
}

echo
echo "security guards"
run "webhook signature verified" packages/integrations/src/webhook.ts \
  'return await verify(secret, rawBody, signature);' 'return true;'
run "comment trigger gated on association" packages/integrations/src/webhook.ts \
  'if (!TRUSTED_ASSOCIATIONS.has(association ?? "")) {' 'if (false) {'
run "run_command exact allowlist match" packages/agents/src/tools.ts \
  'if (!ctx.allowedCommands.includes(command)) {' 'if (false) {'
run "safePath refuses traversal" packages/agents/src/tools.ts \
  'if (p.startsWith("/") || p.split("/").includes("..")) {' 'if (false) {'
run "egress allowlist suffix matching" packages/sandbox/src/egress-proxy.ts \
  'return bare === e || bare.endsWith(`.${e}`);' 'return bare === e || bare.includes(e);'

echo
echo "the fork downgrade, the plan's blocking rule"
run "fork: env downgraded at all" packages/integrations/src/review-pr.ts \
  'if (!pr.isFork) return base;' 'return base;'
run "fork: setup steps stripped" packages/integrations/src/review-pr.ts \
  '    setup: [],' '    setup: base.setup,'
run "fork: commands stripped" packages/integrations/src/review-pr.ts \
  '    allowedCommands: [],' '    allowedCommands: base.allowedCommands,'
run "fork: egress stripped" packages/integrations/src/review-pr.ts \
  '    egressAllowlist: [],' '    egressAllowlist: base.egressAllowlist,'
run "fork: may not write the dep cache" packages/sandbox/src/cache.ts \
  'return trust !== "untrusted";' 'return true;'

echo
echo "correctness guards"
run "triage minimum confidence" packages/engine/src/triage.ts \
  'minConfidence' '0 * minConfidence'
run "spend cap refuses a review" packages/server/src/daemon.ts \
  'if (!verdict.allowed) {' 'if (false) {'
run "review idempotency on conflict" packages/core/src/reviews.ts \
  'ON CONFLICT(repo_id, pr_number, head_sha) DO NOTHING' ''
run "docker id listing deduplicated" packages/sandbox/src/docker.ts \
  '...new Set(' '...('

echo
if [ "$survivors" -gt 0 ]; then
  echo "$survivors guard(s) that nothing tests"
  exit 1
fi
echo "every guard checked is load-bearing"
