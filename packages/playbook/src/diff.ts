import type { PlaybookDocument } from "./schema.js";

/**
 * What changed between two playbook versions.
 *
 * The plan names this twice — "version management: publish, diff, roll back" and a persona
 * editor that shows "diff against the previous version" — and neither existed. Publishing
 * was a one-way door: you could roll back to a version, and nothing anywhere would tell you
 * what rolling back would change.
 *
 * It matters most for personas. A persona is prose, edited by hand, and the most frequently
 * changed thing in a playbook; "v7 vs v8" means nothing without the words that moved.
 */
export interface PlaybookChange {
  /** Dotted path, e.g. `agents.security.persona` or `triage.minConfidence`. */
  path: string;
  kind: "added" | "removed" | "changed";
  /** Rendered for display; long prose is diffed by line rather than shown whole. */
  before?: string;
  after?: string;
  /** Line-level changes, present only for multi-line text like a persona. */
  lines?: { sign: "+" | "-"; text: string }[];
}

const show = (v: unknown): string =>
  typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);

/**
 * A minimal line diff: the common prefix and suffix are dropped and what remains is
 * reported as removals then additions.
 *
 * Not Myers. A persona edit is usually a paragraph rewritten in place, and pulling in a
 * diff library for prose nobody merges would be weight for its own sake — but showing the
 * whole persona twice and calling it a diff would be worse than useless.
 */
export function lineDiff(before: string, after: string): { sign: "+" | "-"; text: string }[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [
    ...a.slice(start, endA).map((text) => ({ sign: "-" as const, text })),
    ...b.slice(start, endB).map((text) => ({ sign: "+" as const, text })),
  ];
}

function compareValue(path: string, before: unknown, after: unknown, out: PlaybookChange[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const change: PlaybookChange = {
    path,
    kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
    before: show(before),
    after: show(after),
  };
  // Prose gets a line diff; a number or a flag is clearer shown whole.
  if (typeof before === "string" && typeof after === "string" && (before + after).includes("\n")) {
    change.lines = lineDiff(before, after);
  }
  out.push(change);
}

/** Every difference between two playbooks, in the order a reader would want them. */
export function diffPlaybooks(before: PlaybookDocument, after: PlaybookDocument): PlaybookChange[] {
  const out: PlaybookChange[] = [];

  // Agents first: they are what people actually edit.
  const ids = [...new Set([...before.agents.map((a) => a.id), ...after.agents.map((a) => a.id)])];
  for (const id of ids) {
    const a = before.agents.find((x) => x.id === id);
    const b = after.agents.find((x) => x.id === id);
    if (!a) {
      out.push({ path: `agents.${id}`, kind: "added", after: b?.name ?? id });
      continue;
    }
    if (!b) {
      out.push({ path: `agents.${id}`, kind: "removed", before: a.name ?? id });
      continue;
    }
    compareValue(`agents.${id}.persona`, a.persona, b.persona, out);
    compareValue(`agents.${id}.model`, a.model, b.model, out);
    compareValue(`agents.${id}.enabled`, a.enabled, b.enabled, out);
    compareValue(`agents.${id}.tools`, a.tools, b.tools, out);
  }

  for (const key of ["router", "triage", "envSpec", "budget", "graph"] as const) {
    compareValue(key, before[key], after[key], out);
  }
  compareValue("description", before.description, after.description, out);

  return out;
}
