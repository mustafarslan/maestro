import { describe, expect, it } from "vitest";
import type { ReviewOutcome } from "./engine.js";
import { renderReview } from "./render.js";

const outcome = (agents: { agentId: string; state: "done" | "failed" }[]): ReviewOutcome =>
  ({
    reviewId: "rv-1",
    state: "done",
    nodes: agents.map((a) => ({
      nodeId: `n-${a.agentId}`,
      kind: "agent" as const,
      agentId: a.agentId,
      state: a.state,
      durationMs: 1,
      costCents: 0,
    })),
    triage: { posted: [], suppressed: [], summary: "" },
    costCents: 0,
    durationMs: 1,
    allowedCommands: [],
    // Always set by the engine's finish(); the renderer reads it unguarded and the type
    // requires it, so a fixture without it is the fixture being wrong, not the renderer.
    egressLog: [],
  }) as unknown as ReviewOutcome;

describe("a partial review says so before the details", () => {
  it("warns when an agent did not complete", () => {
    // Observed on a real run: two of three agents died on a provider quota and the
    // headline still read "No findings met the reporting threshold", which is a clean
    // bill of health. Silence from an agent that never ran is not a verdict, and the
    // disclosure was inside a collapsed block where a skimming reader would miss it.
    const out = renderReview(
      outcome([
        { agentId: "product", state: "done" },
        { agentId: "security", state: "failed" },
      ]),
      { title: "t" },
    );
    const aboveFold = out.split("<details>")[0] ?? "";
    expect(aboveFold).toContain("Partial review");
    expect(aboveFold).toContain("security");
  });

  it("names every agent that failed, not just the count", () => {
    const out = renderReview(
      outcome([
        { agentId: "security", state: "failed" },
        { agentId: "architecture", state: "failed" },
      ]),
      { title: "t" },
    );
    const aboveFold = out.split("<details>")[0] ?? "";
    expect(aboveFold).toContain("security");
    expect(aboveFold).toContain("architecture");
  });

  it("says nothing extra when every agent completed", () => {
    // The warning has to stay rare, or it becomes part of the furniture.
    const out = renderReview(
      outcome([
        { agentId: "product", state: "done" },
        { agentId: "security", state: "done" },
      ]),
      { title: "t" },
    );
    expect(out.split("<details>")[0] ?? "").not.toContain("Partial review");
  });
});

describe("what the metrics block says about the environment", () => {
  const withEnv = (over: Partial<ReviewOutcome>): ReviewOutcome =>
    ({ ...outcome([{ agentId: "security", state: "done" }]), ...over }) as ReviewOutcome;

  it("says whether the dependency cache was used", () => {
    // The single biggest lever on how long a review takes. The driver has computed it
    // from the first day and nothing read it, so "why does every review take four
    // minutes" had no answer visible anywhere.
    expect(renderReview(withEnv({ cacheHit: true }), { title: "t" })).toContain(
      "Dependency cache hit",
    );
    expect(renderReview(withEnv({ cacheHit: false }), { title: "t" })).toContain(
      "Dependency cache miss",
    );
  });

  it("says nothing when the driver did not report it, rather than guessing at a miss", () => {
    expect(renderReview(withEnv({}), { title: "t" })).not.toContain("Dependency cache");
  });

  it("reports a command the agent was refused, and why that matters", () => {
    // A refusal used to be recorded nowhere: an agent asking for `pnpm test` in a repo
    // whose allowlist detected only `npm test` produced a review with no commands run and
    // no explanation, which is a misdetected toolchain degrading every review silently.
    const md = renderReview(
      withEnv({
        nodes: [
          {
            nodeId: "n-1",
            kind: "agent",
            agentId: "security",
            state: "done",
            durationMs: 1,
            costCents: 0,
            commandsRun: [{ command: "pnpm test", exitCode: -1, durationMs: 0, refused: true }],
          },
        ],
      }),
      { title: "t" },
    );
    expect(md).toContain("not allowlisted");
    expect(md).toContain("envSpec.allowedCommands");
    expect(md).not.toContain("exit -1");
  });
});
