#!/usr/bin/env bash
# Builds a golden-set fixture repository from a commit that FIXED a real defect.
#
# The fixture's base is that commit's tree and its head is the same tree with the fix
# reverted, so the diff under review is exactly the introduction of a defect this project
# actually shipped, in the code that actually shipped it. Inventing a bug and then writing
# an answer key for it measures how well the bug was invented.
#
# Only source files are carried over. The fix's own tests are excluded on purpose: a diff
# that deletes the test naming the defect is a fixture that measures reading the answer,
# and docs are excluded for the same reason.
#
# For the same reason the fix's explanatory comments are stripped from the base before the
# revert is applied. This project writes down *why* alongside every fix, so reverting one
# produced a diff whose deleted lines described the defect in prose — an answer key an
# agent could read rather than derive. Only whole comment blocks absent from the reverted
# file are removed, so the base stays valid source.
#
#   scripts/make-eval-fixture.sh <name> <fix-commit> <path>...
set -euo pipefail

name=${1:?fixture name}
commit=${2:?commit that fixed the defect}
shift 2
[ "$#" -gt 0 ] || { echo "give at least one source path" >&2; exit 1; }

repo=$(git rev-parse --show-toplevel)
out="${MAESTRO_HOME:-$HOME/.maestro}/fixture-repos/$name"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

rm -rf "$out"
mkdir -p "$out"

for path in "$@"; do
  mkdir -p "$out/$(dirname "$path")" "$work/$(dirname "$path")"
  git -C "$repo" show "$commit:$path" > "$out/$path"
  # The pre-fix version, used only to decide which comments are the fix's own. A file the
  # fix created has none, and is deleted rather than emptied when the head is built.
  git -C "$repo" show "$commit~1:$path" > "$work/$path" 2>/dev/null || rm -f "$work/$path"
done

MAESTRO_FIXTURE_PATHS="$*" python3 - "$out" "$work" <<'PY'
import os, re, sys

base_root, prefix_root = sys.argv[1], sys.argv[2]

def blocks(lines):
    """Whole comment blocks: a /* ... */ run, or a run of // lines."""
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if s.startswith("/*"):
            j = i
            while j < len(lines) and "*/" not in lines[j]:
                j += 1
            yield (i, min(j, len(lines) - 1))
            i = j + 1
        elif s.startswith("//"):
            j = i
            while j + 1 < len(lines) and lines[j + 1].strip().startswith("//"):
                j += 1
            yield (i, j)
            i = j + 1
        else:
            i += 1

for path in os.environ["MAESTRO_FIXTURE_PATHS"].split():
    base_file = os.path.join(base_root, path)
    with open(base_file) as f:
        lines = f.read().split("\n")
    prefix_file = os.path.join(prefix_root, path)
    before = open(prefix_file).read() if os.path.exists(prefix_file) else ""

    drop = set()
    for start, end in blocks(lines):
        text = "\n".join(l.strip() for l in lines[start : end + 1])
        # Present before the fix, so it is not the fix's account of the defect.
        if text and text not in "\n".join(l.strip() for l in before.split("\n")):
            drop.update(range(start, end + 1))

    with open(base_file, "w") as f:
        f.write("\n".join(l for i, l in enumerate(lines) if i not in drop))
PY

git -C "$out" init -q
git -C "$out" config user.email fixtures@maestro.local
git -C "$out" config user.name "maestro fixtures"
git -C "$out" add -A
git -C "$out" commit -q -m "the code as it stands"

# The pre-fix source is the head: the defect, exactly as this project once shipped it.
for path in "$@"; do
  if [ -f "$work/$path" ]; then cp "$work/$path" "$out/$path"; else rm -f "$out/$path"; fi
done
git -C "$out" add -A
git -C "$out" commit -q -m "$(git -C "$repo" log -1 --format=%s "$commit" | sed 's/^[a-z+-]*: //')"

echo "$name  $(git -C "$out" diff --shortstat HEAD~1 HEAD | tr -d '\n')"
