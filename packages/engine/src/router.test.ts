import { defaultPlaybook } from "@maestro/playbook";
import { describe, expect, it } from "vitest";
import { route } from "./router.js";

const doc = defaultPlaybook();

describe("deterministic router", () => {
  it("runs every agent on a change that touches both frontend and backend", () => {
    const d = route(doc, {
      changedFiles: ["components/Button.tsx", "pages/api/delete-account.ts", "lib/db.ts"],
      changedLines: 300,
    });
    expect(d.activeAgentIds.sort()).toEqual(["architecture", "product", "security", "ui-ux"]);
  });

  it("does not run the ui/ux agent on a backend-only change", () => {
    // Cost and noise control: a ui/ux agent with no UI to look at produces generic
    // comments, which is exactly what makes people mute an automated reviewer.
    const d = route(doc, {
      changedFiles: ["lib/api/upsertNote.ts", "server/db.go"],
      changedLines: 120,
    });
    expect(d.activeAgentIds).not.toContain("ui-ux");
    expect(d.skipped.find((s) => s.agentId === "ui-ux")?.reason).toMatch(/no changed file matches/);
  });

  it("does not run security or architecture on a docs-only change", () => {
    const d = route(doc, { changedFiles: ["docs/guide.md"], changedLines: 10 });
    expect(d.skipReview).toBeTruthy();
  });

  it("skips the whole review for a bot author", () => {
    const d = route(doc, {
      changedFiles: ["package-lock.json"],
      changedLines: 4000,
      author: "dependabot[bot]",
    });
    expect(d.skipReview).toContain("dependabot[bot]");
    expect(d.activeAgentIds).toEqual([]);
  });

  it("excludes test files from the ui/ux agent's path rules", () => {
    const d = route(doc, { changedFiles: ["components/Button.test.tsx"], changedLines: 20 });
    expect(d.activeAgentIds).not.toContain("ui-ux");
  });

  it("picks a budget tier from the size of the diff", () => {
    // A two-line change must not be allowed to spend like a two-thousand-line one.
    expect(route(doc, { changedFiles: ["a.ts"], changedLines: 10 }).costCapCents).toBe(50);
    expect(route(doc, { changedFiles: ["a.ts"], changedLines: 900 }).costCapCents).toBe(200);
    expect(route(doc, { changedFiles: ["a.ts"], changedLines: 50_000 }).costCapCents).toBe(600);
  });

  it("runs an agent that has no rule rather than silently dropping it", () => {
    // A user who adds an agent but forgets a router rule should get that agent, not
    // a silent no-op that looks like a bug.
    const custom = structuredClone(doc);
    custom.agents.push({ ...custom.agents[0]!, id: "performance", name: "Performance" });
    const d = route(custom, { changedFiles: ["lib/x.ts"], changedLines: 10 });
    expect(d.activeAgentIds).toContain("performance");
  });

  it("respects an agent disabled in the playbook", () => {
    const custom = structuredClone(doc);
    custom.agents.find((a) => a.id === "security")!.enabled = false;
    const d = route(custom, { changedFiles: ["lib/x.ts"], changedLines: 10 });
    expect(d.activeAgentIds).not.toContain("security");
    expect(d.skipped.find((s) => s.agentId === "security")?.reason).toBe("disabled in playbook");
  });
});
