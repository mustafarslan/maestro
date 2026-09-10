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
# paths are the source files that commit touched, minus its tests and docs.
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
