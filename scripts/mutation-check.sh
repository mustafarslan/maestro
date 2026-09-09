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
# Anchors may span lines; the caller writes them with \n escapes.
frm = sys.argv[2].replace("\\n", "\n")
to = sys.argv[3].replace("\\n", "\n")
if frm not in s:
    sys.exit(3)
p.write_text(s.replace(frm, to, 1))
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
echo "the admin surface"
run "admin token compared at all" packages/server/src/api.ts \
  'return a.length === b.length && timingSafeEqual(a, b);' 'return true;'
run "UI routes are not cached immutable" packages/server/src/admin.ts \
  'const immutable = exact !== undefined && assetPath !== "/index.html";' 'const immutable = true;'
run "missing hashed assets 404" packages/server/src/admin.ts \
  'if (!exact && assetPath.startsWith("/assets/")) {' 'if (false) {'

echo
echo "trigger routing"
run "issue vs pull request discriminator" packages/integrations/src/webhook.ts \
  '!issue.pull_request' 'false'
run "only Maestro's own comment is updated" packages/integrations/src/github.ts \
  'if (self.login) return c.user?.login === self.login;' 'if (self.login) return true;'
run "manual-only mode honoured" packages/server/src/daemon.ts \
  'active.doc.router.automaticTriggers === false' 'false'
run "a request is not treated as a supersede" packages/server/src/daemon.ts \
  'if (t.source !== "lifecycle") return false;' 'if (false) return false;'

echo
echo "the sandbox and the reaper"
run "reap fails closed on an undatable image" packages/sandbox/src/docker.ts \
  'if (cutoff !== undefined && (createdAt === undefined || createdAt > cutoff)) {' 'if (false) {'
run "an aborted command does not start" packages/sandbox/src/docker.ts \
  'if (opts.signal?.aborted) {' 'if (false) {'
run "read_file line clamp" packages/agents/src/tools.ts \
  'const end = Math.min(requestedEnd, start + MAX_READ_LINES);' 'const end = requestedEnd;'

echo
echo "the analyze container's posture (runs the docker integration tests)"
run "analyze has no network" packages/sandbox/src/docker.ts \
  '      "--network",\n      "none",\n      "--read-only",' '      "--read-only",'
run "analyze rootfs is read-only" packages/sandbox/src/docker.ts \
  '      "--read-only",\n      "--cap-drop",' '      "--cap-drop",'
run "analyze drops all capabilities" packages/sandbox/src/docker.ts \
  '      "--cap-drop",\n      "ALL",' '      "--cap-drop",\n      "NET_RAW",'
run "analyze forbids new privileges" packages/sandbox/src/docker.ts \
  '      "--security-opt",\n      "no-new-privileges",' '      "--label",\n      "posture=weakened",'

echo
if [ "$survivors" -gt 0 ]; then
  echo "$survivors guard(s) that nothing tests"
  exit 1
fi
echo "every guard checked is load-bearing"
