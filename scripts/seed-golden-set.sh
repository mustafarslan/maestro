#!/usr/bin/env bash
# Rebuilds the golden set from this repository, on any checkout.
#
# `docs/golden-set/*.json` holds the answer keys — the hand-written half, and the half no
# script can regenerate. This builds the other half: one fixture repository per key, from
# the commit that fixed the defect the key describes. `docs/STATUS.md` finding 232 reports a
# baseline measured against these eight, and finding 234 an experiment measured against the
# same eight; neither number is checkable without them.
#
# The commits below are the provenance. Each pairs with the key of the same name, and the
# paths are the source files that commit touched, minus its tests, docs and generated files.
#
# Splits are assigned by the parity of the fix commit's last hex digit — even is held out,
# odd is training. A rule rather than a judgement, because a split chosen per fixture is a
# split chosen to make a result look good, and this file is where anyone checking that has
# to be able to see it. The first eight fixtures predate the rule and keep the splits they
# were authored with; everything added since follows it.
#
# A fixture repository holds source files and nothing else: no package.json, no lockfile,
# no tests. So `run_command` has nothing to run in any of them, and the part of the
# architecture persona that says to confirm a suspicion by running the repository's own
# tests is untestable here. That is a real limit on what these twenty can measure.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
home=${MAESTRO_HOME:-$HOME/.maestro}

fixtures=(
  "db-world-readable   da0db7ab164ff09f3df2083ca23f6e9cd4ee5f46 packages/core/src/store/db.ts"
  "doctor-first-line   f347e71e1c0701e3638babf734a111f0e27a2690 apps/cli/src/commands/doctor.ts"
  "failure-policy      4a00b9a58c1da00a02235126b4748d8084300e22 packages/engine/src/engine.ts"
  "fence-closable      0785ba4cc78a2c32540fe9f99f66e717f3b2077f packages/playbook/src/prompt.ts"
  "numeric-flag-nan    01301d457b29c9f4b6af5117f439f78c3a1403d7 apps/cli/src/args.ts apps/cli/src/commands/serve.ts"
  "reaper-double-count 9edec73758fbcf85c3ea9d6eb8e207b90eaecf57 apps/cli/src/commands/doctor.ts packages/sandbox/src/docker.ts"
  "severity-sql-order  c25bc1d8302a8af0ae22afe8194f06dbbdd564b3 packages/agents/src/finding.ts packages/core/src/incremental.ts packages/core/src/index.ts packages/core/src/severity.ts packages/server/src/api.ts"
  "unhandled-rejection 838cf7461a1b887cd3a3563adc7081ce9527b453 packages/server/src/daemon.ts apps/cli/src/commands/serve.ts"
  "body-utf8-split          ff0e7be87ec45d2ee784af695bf965a9672c4f70 packages/server/src/api.ts packages/server/src/daemon.ts"
  "checkout-cache-merge     f26431eda10506ebdf9739207a28f1ca0767bcc6 packages/sandbox/src/docker.ts"
  "comment-marker-author    cee160c96a94c8dfc10aa524def453e067d01d7d packages/integrations/src/github.ts"
  "lease-never-renewed      c42a5e987b49433619866b524b8bda64f35e9d36 packages/server/src/daemon.ts"
  "reaction-poll-ratelimit  946964070f301062aaa8a584bb4704bfda9edc9c packages/integrations/src/feedback.ts"
  "reaper-no-startup-sweep  902f074f6ca385b34bf4408d751aedd5037652c2 packages/sandbox/src/types.ts packages/server/src/daemon.ts"
  "retry-nonhttp            5ab716c658a1537882509fa54bacce250d83d0ff packages/llm/src/provider.ts"
  "review-create-race       7a297a4d0f7b60ac58db94c14e5461fa268444a9 packages/core/src/reviews.ts"
  "scheduler-fairness       488893bfec35352b23862d2b1dc963a10749708d packages/server/src/scheduler.ts"
  "secrets-atomic-write     5ebe8cd68131ab2b551301f12e63b8fd7aaf4a09 packages/llm/src/keys.ts"
  "spa-immutable-cache      857f6742129572e525cbe416767541c7e45efa13 packages/server/src/admin.ts"
  "thinking-budget-google   adffde0a6fb0d9856f54586d79066dd4a01cb46f packages/llm/src/provider.ts"
)

for row in "${fixtures[@]}"; do
  # shellcheck disable=SC2086 -- the row is a deliberate word list.
  set -- $row
  git -C "$repo" cat-file -e "$2^{commit}" 2>/dev/null || {
    echo "$1: commit $2 is not in this checkout - fetch the full history" >&2
    exit 1
  }
  MAESTRO_HOME="$home" "$repo/scripts/make-eval-fixture.sh" "$@"
done

# The keys ship with `~/.maestro/fixture-repos/<name>` as their target, because a committed
# absolute path is one machine's. `maestro eval` does no tilde expansion, so it is resolved
# here, against the MAESTRO_HOME the repositories were just written under.
mkdir -p "$home/fixtures"
for key in "$repo"/docs/golden-set/*.json; do
  name=$(basename "$key" .json)
  sed "s#\"~/.maestro/fixture-repos/#\"$home/fixture-repos/#" "$key" > "$home/fixtures/$name.json"
done

echo "seeded $(ls "$repo"/docs/golden-set/*.json | wc -l | tr -d ' ') fixtures into $home"
