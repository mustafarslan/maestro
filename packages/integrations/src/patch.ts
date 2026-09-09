/**
 * Which lines of a pull request can carry an inline comment.
 *
 * GitHub accepts a review comment only on a line that appears in the diff — an addition
 * or a context line inside a hunk, on the RIGHT side. Anchoring anywhere else is rejected,
 * and `pulls.createReview` rejects the whole review rather than the one bad anchor, so a
 * single finding pointing at an unchanged part of a file would lose every comment.
 *
 * The patch is already fetched: `listFiles` returns it beside the filename, and it was
 * being discarded.
 */

/**
 * Cap on remembered anchors per pull request.
 *
 * A large change has hundreds of files and tens of thousands of diff lines, and this map
 * lives for the length of a review. Beyond the cap a finding simply has no anchor and its
 * comment stays in the summary, which is the same outcome as a file GitHub gave no patch
 * for. Losing an anchor is a smaller problem than holding a review's worth of line
 * numbers per concurrent review.
 */
const MAX_ANCHORS = 20_000;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * RIGHT-side line numbers a comment may anchor to, from one file's unified patch.
 *
 * The counter advances on additions and on context lines and not on deletions, which is
 * exactly the set of lines that exist in the head revision. `\ No newline at end of file`
 * is a note about the line before it, not a line.
 */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;

  let cursor = 0;
  for (const line of patch.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      cursor = Number(hunk[1]);
      continue;
    }
    if (!cursor) continue; // preamble before the first hunk
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) continue;
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      lines.add(cursor);
      cursor++;
    }
  }
  return lines;
}

/** The same, for every file in a pull request, bounded by `MAX_ANCHORS`. */
export function commentableAnchors(
  files: { filename: string; patch?: string }[],
): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let total = 0;
  for (const f of files) {
    if (total >= MAX_ANCHORS) break;
    const lines = commentableLines(f.patch);
    if (!lines.size) continue;
    map.set(f.filename, lines);
    total += lines.size;
  }
  return map;
}
