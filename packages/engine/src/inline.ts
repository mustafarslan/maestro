import { renderInlineBody } from "./render.js";
import type { TriagedFinding } from "./triage.js";

export interface InlineAnchor {
  path: string;
  line: number;
  body: string;
  /**
   * The triage group this comment speaks for.
   *
   * Carried so the comment's id can be written back to the finding row it belongs to.
   * Without it every finding in a review shared the summary comment's id, and one
   * thumbs-down on that summary was ingested as a verdict on all of them.
   */
  dedupeGroup: string;
}

/** `file:line` — the identity of a place a comment has been left. */
export function anchorKey(file: string, line: number | undefined): string {
  return `${file}:${line ?? 0}`;
}

/**
 * Turns triaged findings into anchored comments, dropping the ones that cannot anchor.
 *
 * Phase 3 asks for "inline comments where line anchors are valid", and the validity check
 * is the whole difficulty: `pulls.createReview` rejects the entire review when one anchor
 * is outside the diff, so one finding pointing at an unchanged line would silently cost
 * every other comment. Filtering against the patch first makes a rejection the exception
 * rather than the design.
 *
 * `already` holds the anchors an earlier round left. A review is re-run on every push and
 * a carried-forward finding is still true, so without this the same comment lands again
 * at the same place on every push — the repetition that makes people mute a reviewer.
 * Keyed on `lineStart`, which is what the previous round recorded.
 */
export function inlineComments(
  findings: TriagedFinding[],
  commentable: Map<string, Set<number>>,
  opts: { cap: number; already?: ReadonlySet<string> },
): InlineAnchor[] {
  const out: InlineAnchor[] = [];
  for (const f of findings) {
    if (out.length >= opts.cap) break;
    if (!f.file) continue;
    if (opts.already?.has(anchorKey(f.file, f.lineStart))) continue;

    const lines = commentable.get(f.file);
    if (!lines) continue;
    // The start of the passage first, then its end. A finding whose first line is
    // context outside the hunk can still anchor at its last.
    const line = [f.lineStart, f.lineEnd].find((n) => n !== undefined && lines.has(n));
    if (!line) continue;

    out.push({ path: f.file, line, body: renderInlineBody(f), dedupeGroup: f.dedupeGroup });
  }
  return out;
}
