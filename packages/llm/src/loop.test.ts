import { describe, expect, it, vi } from "vitest";
import { ECHO_TOOL, SUBMIT_TOOL } from "./conformance.js";
import { runAgent } from "./loop.js";
import { Provider } from "./provider.js";
import { anthropicTransport, failingTransport, fakeConfig, flakyTransport } from "./testing.js";
import { ProviderError } from "./types.js";

const base = {
  model: "claude-opus-5",
  system: "sys",
  prompt: "go",
  tools: [ECHO_TOOL, SUBMIT_TOOL],
  terminalTool: "submit",
};

describe("agent loop", () => {
  it("stops on the terminal tool and returns its input as the result", async () => {
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: { value: "ping" } }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "done", confidence: 0.9 } }] },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async (c) => ({ output: JSON.stringify(c.input) }),
      budget: { maxSteps: 10, costCapCents: 100 },
    });

    expect(result.stopKind).toBe("terminal-tool");
    expect(result.terminalInput).toEqual({ answer: "done", confidence: 0.9 });
    expect(result.steps).toHaveLength(2);
  });

  it("feeds tool results back and keeps parallel results in one message", async () => {
    const t = anthropicTransport([
      {
        toolCalls: [
          { id: "1", name: "echo", input: { value: "a" } },
          { id: "2", name: "echo", input: { value: "b" } },
        ],
      },
      { toolCalls: [{ id: "3", name: "submit", input: { answer: "ok" } }] },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async (c) => ({ output: `echoed:${(c.input as { value: string }).value}` }),
      budget: { maxSteps: 10, costCapCents: 100 },
    });

    // Splitting parallel results across messages teaches models to stop calling in parallel.
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({ results: [{ callId: "1" }, { callId: "2" }] });
  });

  it("stops at max steps rather than looping forever", async () => {
    const t = anthropicTransport([
      { toolCalls: [{ id: "x", name: "echo", input: { value: "again" } }] },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 3, costCapCents: 1000 },
    });

    expect(result.stopKind).toBe("max-steps");
    expect(result.steps).toHaveLength(3);
  });

  it("stops when the cost cap is reached", async () => {
    // 1M input tokens per turn on Opus 5 = 500 cents, so a 600-cent cap allows
    // exactly two turns before the pre-call check trips.
    const t = anthropicTransport([
      {
        toolCalls: [{ id: "x", name: "echo", input: { value: "a" } }],
        usage: { input: 1e6, output: 0 },
      },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 50, costCapCents: 600 },
    });

    expect(result.stopKind).toBe("cost-cap");
    expect(result.steps).toHaveLength(2);
    expect(result.costCents).toBeGreaterThan(600);
  });

  it("stops when the token cap is reached", async () => {
    const t = anthropicTransport([
      { toolCalls: [{ id: "x", name: "echo", input: {} }], usage: { input: 5000, output: 1000 } },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 50, costCapCents: 1e9, maxTokens: 10_000 },
    });

    expect(result.stopKind).toBe("token-cap");
  });

  it("ends when the model answers without calling a tool", async () => {
    const t = anthropicTransport([{ text: "No issues found." }]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "" }),
      budget: { maxSteps: 5, costCapCents: 100 },
    });

    expect(result.stopKind).toBe("no-tool-calls");
    expect(result.finalText).toBe("No issues found.");
  });

  it("accumulates usage and cost across every step", async () => {
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: {} }], usage: { input: 1000, output: 100 } },
      {
        toolCalls: [{ id: "2", name: "submit", input: { answer: "x" } }],
        usage: { input: 2000, output: 200 },
      },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 10, costCapCents: 100 },
    });

    expect(result.usage.inputTokens).toBe(3000);
    expect(result.usage.outputTokens).toBe(300);
    expect(result.costCents).toBeGreaterThan(0);
  });

  it("surfaces a failing tool to the model instead of crashing the run", async () => {
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: {} }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "recovered" } }] },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => {
        throw new Error("sandbox exploded");
      },
      budget: { maxSteps: 10, costCapCents: 100 },
    });

    expect(result.stopKind).toBe("terminal-tool");
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ results: [{ isError: true }] });
    expect(JSON.stringify(toolMsg)).toContain("sandbox exploded");
  });

  it("retries a rate limit and recovers", async () => {
    const t = flakyTransport(2, 429);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 2, costCapCents: 100 },
      maxRetriesPerStep: 4,
      backoffBaseMs: 1,
    });

    expect(result.finalText).toBe("recovered");
    expect(t.requests.length).toBeGreaterThanOrEqual(3);
  });

  it("does not retry a 400, because the request itself is wrong", async () => {
    const t = failingTransport(400, "bad request");
    await expect(
      runAgent({
        ...base,
        provider: new Provider(fakeConfig(t)),
        dispatch: async () => ({ output: "ok" }),
        budget: { maxSteps: 2, costCapCents: 100 },
        maxRetriesPerStep: 4,
        backoffBaseMs: 1,
      }),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(t.requests).toHaveLength(1);
  });

  it("honours an abort signal", async () => {
    const t = anthropicTransport([{ toolCalls: [{ id: "1", name: "echo", input: {} }] }]);
    const controller = new AbortController();
    controller.abort();

    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 5, costCapCents: 100 },
      signal: controller.signal,
    });

    expect(result.stopKind).toBe("aborted");
    expect(t.requests).toHaveLength(0);
  });

  it("reports each step to the observer for live tracing", async () => {
    const onStep = vi.fn();
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: {} }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "x" } }] },
    ]);
    await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 10, costCapCents: 100 },
      onStep,
    });

    expect(onStep).toHaveBeenCalledTimes(2);
  });
});

describe("budget awareness", () => {
  it("tells the agent to wrap up as its step budget runs out", async () => {
    // Without this nudge an exploratory model spends the whole budget reading and never
    // submits - full cost, zero findings.
    const t = anthropicTransport([{ toolCalls: [{ id: "x", name: "echo", input: {} }] }]);
    await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 5, costCapCents: 1000 },
      wrapUpAtStepsRemaining: 2,
    });

    const nudges = t.requests.filter((r) =>
      JSON.stringify(r.body).includes("call submit now with what you already have"),
    );
    expect(nudges.length).toBeGreaterThan(0);
  });

  it("does not nag while there is plenty of budget left", async () => {
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: {} }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "done" } }] },
    ]);
    await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 30, costCapCents: 1000 },
      wrapUpAtStepsRemaining: 2,
    });

    expect(t.requests.every((r) => !JSON.stringify(r.body).includes("steps left"))).toBe(true);
  });

  it("also wraps up when the cost budget is nearly spent", async () => {
    // 1M input tokens on Opus 5 = 500 cents, so one turn crosses 80% of a 600-cent cap.
    const t = anthropicTransport([
      { toolCalls: [{ id: "x", name: "echo", input: {} }], usage: { input: 1e6, output: 0 } },
    ]);
    await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 30, costCapCents: 600 },
    });

    expect(t.requests.some((r) => JSON.stringify(r.body).includes("near your cost budget"))).toBe(
      true,
    );
  });
});

describe("prose answers", () => {
  it("asks once for a proper submission before discarding a prose answer", async () => {
    // A model that answers in text has still done the analysis; throwing that away
    // wastes the entire agent run.
    const t = anthropicTransport([
      { text: "I reviewed it and found a SQL injection." },
      { toolCalls: [{ id: "1", name: "submit", input: { answer: "sql injection" } }] },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 6, costCapCents: 100 },
    });

    expect(result.stopKind).toBe("terminal-tool");
    expect(result.terminalInput).toEqual({ answer: "sql injection" });
    expect(JSON.stringify(t.requests.at(-1)?.body)).toContain("is discarded");
  });

  it("gives up after one re-ask rather than looping", async () => {
    const t = anthropicTransport([{ text: "Still just prose." }]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 8, costCapCents: 100 },
    });

    expect(result.stopKind).toBe("no-tool-calls");
    expect(t.requests).toHaveLength(2);
  });
});
