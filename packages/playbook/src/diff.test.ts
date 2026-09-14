import { describe, expect, it } from "vitest";
import { defaultPlaybook } from "./default-playbook.js";
import { diffPlaybooks, lineDiff } from "./diff.js";
import type { PlaybookDocument } from "./schema.js";

const clone = (): PlaybookDocument => structuredClone(defaultPlaybook());

describe("what changed between two playbook versions", () => {
  it("says nothing changed when nothing did", () => {
    expect(diffPlaybooks(clone(), clone())).toEqual([]);
  });

  it("reports a persona edit as the lines that moved, not the whole prose", () => {
    // A persona is the most frequently edited thing in a playbook and the reason this
    // exists: "v7 vs v8" means nothing without the words that changed, and showing the
    // whole persona twice would be worse than useless.
    const before = clone();
    const after = clone();
    const agent = after.agents.find((a) => a.id === "security");
    if (agent) agent.persona = `${agent.persona.replace("\n", "\nCheck for IDOR first.\n")}`;

    const change = diffPlaybooks(before, after).find((c) => c.path === "agents.security.persona");
    expect(change?.kind).toBe("changed");
    expect(change?.lines?.some((l) => l.sign === "+" && l.text.includes("IDOR"))).toBe(true);
    // Unchanged lines are not reported; a diff that lists everything is a listing.
    expect(change?.lines?.length).toBeLessThan(before.agents[0]?.persona.split("\n").length ?? 99);
  });

  it("reports a rebound model", () => {
    const after = clone();
    const agent = after.agents.find((a) => a.id === "security");
    if (agent) agent.model = { ...agent.model, model: "kimi-k3:cloud" };

    const change = diffPlaybooks(clone(), after).find((c) => c.path === "agents.security.model");
    expect(change?.after).toContain("kimi-k3:cloud");
  });

  it("reports an agent added and an agent removed", () => {
    const after = clone();
    const removed = after.agents.shift();
    after.agents.push({ ...(removed as PlaybookDocument["agents"][number]), id: "performance" });

    const changes = diffPlaybooks(clone(), after);
    expect(changes.some((c) => c.path === "agents.performance" && c.kind === "added")).toBe(true);
    expect(changes.some((c) => c.kind === "removed")).toBe(true);
  });

  it("reports settings changes without a line diff, which would obscure a number", () => {
    const after = clone();
    after.triage.minConfidence = 0.9;
    const change = diffPlaybooks(clone(), after).find((c) => c.path === "triage");
    expect(change).toBeTruthy();
    expect(change?.lines).toBeUndefined();
  });

  it("notices the manual-only setting flipping, which changes what gets reviewed", () => {
    const after = clone();
    after.router.automaticTriggers = false;
    expect(diffPlaybooks(clone(), after).some((c) => c.path === "router")).toBe(true);
  });
});

describe("the line diff", () => {
  it("reports only the lines that moved", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { sign: "-", text: "b" },
      { sign: "+", text: "B" },
    ]);
  });

  it("is empty for identical text", () => {
    expect(lineDiff("same\ntext", "same\ntext")).toEqual([]);
  });

  it("handles an insertion at the end and at the start", () => {
    expect(lineDiff("a", "a\nb")).toEqual([{ sign: "+", text: "b" }]);
    expect(lineDiff("b", "a\nb")).toEqual([{ sign: "+", text: "a" }]);
  });
});
