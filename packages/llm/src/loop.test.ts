import { describe, expect, it, vi } from "vitest";
import { ECHO_TOOL, SUBMIT_TOOL } from "./conformance.js";
import { runAgent, trimHistory } from "./loop.js";
import { Provider } from "./provider.js";
import { anthropicTransport, failingTransport, fakeConfig, flakyTransport } from "./testing.js";
import { type Message, ProviderError } from "./types.js";

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

describe("context window guard", () => {
  it("ends cleanly when the provider rejects an oversized prompt", async () => {
    // Regression: a real run lost an entire agent to "prompt is too long". Returning
    // what the agent has beats throwing the whole review away.
    const t = failingTransport(
      400,
      "The prompt is too long: 293267, model maximum context length: 131072",
    );
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 5, costCapCents: 100 },
    });

    expect(result.stopKind).toBe("context-limit");
  });

  it("does not retry an oversized prompt, which would only burn budget", async () => {
    const t = failingTransport(400, "prompt is too long");
    await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 5, costCapCents: 100 },
      maxRetriesPerStep: 5,
      backoffBaseMs: 1,
    });

    expect(t.requests).toHaveLength(1);
  });

  it("drops the oldest tool results rather than letting history grow unbounded", async () => {
    // Each step returns a large tool result; without trimming the conversation would
    // grow past any context window.
    const big = "x".repeat(50_000);
    const t = anthropicTransport([{ toolCalls: [{ id: "1", name: "echo", input: {} }] }]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: big }),
      budget: { maxSteps: 8, costCapCents: 1000, maxPromptChars: 120_000 },
    });

    const total = result.messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
    expect(total).toBeLessThanOrEqual(200_000);
    expect(result.stopKind).toBe("max-steps");
  });

  it("keeps the task and the most recent exchange when trimming", async () => {
    const big = "y".repeat(60_000);
    const t = anthropicTransport([{ toolCalls: [{ id: "1", name: "echo", input: {} }] }]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: big }),
      budget: { maxSteps: 6, costCapCents: 1000, maxPromptChars: 100_000 },
    });

    // The original task must survive: without it the model loses what it was asked.
    expect(result.messages[0]).toMatchObject({ role: "user", content: "go" });
  });
});

describe("trimHistory", () => {
  const pair = (i: number, size: number): Message[] => [
    { role: "assistant", content: "", toolCalls: [{ id: `${i}`, name: "read", input: {} }] },
    { role: "tool", results: [{ callId: `${i}`, name: "read", output: "z".repeat(size) }] },
  ];

  const conversation = (pairs: number, size = 20_000): Message[] => [
    { role: "user", content: "review this" },
    ...Array.from({ length: pairs }, (_, i) => pair(i, size)).flat(),
  ];

  it("never splices into the last four messages it promises to protect", () => {
    // The bound was `length - 4`, and splice(i, 2) at i = length-5 reached one message
    // into the live exchange. The protected window silently became three, in exactly
    // the long runs this code exists to rescue.
    const messages = conversation(4);
    const tail = messages.slice(-4);

    trimHistory(messages, 1_000);

    // Identity, not bytes: an over-long conversation also has its remaining tool output
    // truncated, which legitimately rewrites these messages. What must not happen is
    // one of them being removed.
    expect(messages.slice(-4)).toEqual(tail);
  });

  it("keeps the task and drops whole assistant/tool pairs", () => {
    // Dropping a tool result without its call orphans the call: providers reject the
    // whole request with "tool result is missing".
    const messages = conversation(6);
    const dropped = trimHistory(messages, 50_000);

    expect(dropped).toBeGreaterThan(0);
    expect(dropped % 2).toBe(0);
    expect(messages[0]).toMatchObject({ role: "user", content: "review this" });
    for (const [i, m] of messages.entries()) {
      if (m.role !== "tool") continue;
      expect(messages[i - 1]).toMatchObject({ role: "assistant" });
    }
  });

  it("leaves a conversation that already fits completely alone", () => {
    const messages = conversation(3, 10);
    const before = JSON.stringify(messages);
    expect(trimHistory(messages, 1_000_000)).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
  });
});

describe("the wall-clock deadline", () => {
  // A stuck agent holds a container and a scheduler slot for as long as it runs. The step
  // and cost caps do not bound that: a model answering slowly, or a tool call that blocks,
  // burns wall-clock without burning either. This is the only guard that does, and
  // mutation showed deleting it failed nothing.
  it("stops a run that has outlived its deadline", async () => {
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: { value: "a" } }] },
      { toolCalls: [{ id: "2", name: "echo", input: { value: "b" } }] },
      { toolCalls: [{ id: "3", name: "submit", input: { answer: "never reached" } }] },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      // Each dispatch takes longer than the whole budget allows.
      dispatch: async (c) => {
        await new Promise((r) => setTimeout(r, 25));
        return { output: JSON.stringify(c.input) };
      },
      budget: { maxSteps: 50, costCapCents: 1e9, deadlineMs: 10 },
    });

    expect(result.stopKind).toBe("deadline");
  });

  it("tells the agent to submit before the deadline cuts it off, with steps to spare", async () => {
    // Plenty of steps and budget; only the clock is running out. Each step takes ~40ms of a
    // 150ms deadline, so by the second step two more at that pace no longer fit.
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: { value: "a" } }] },
      { toolCalls: [{ id: "2", name: "echo", input: { value: "b" } }] },
      { toolCalls: [{ id: "3", name: "submit", input: { answer: "in time" } }] },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async (c) => {
        await new Promise((r) => setTimeout(r, 40));
        return { output: JSON.stringify(c.input) };
      },
      budget: { maxSteps: 50, costCapCents: 1e9, deadlineMs: 150 },
    });

    expect(t.requests.some((r) => JSON.stringify(r.body).includes("almost out of time"))).toBe(
      true,
    );
    expect(result.stopKind).toBe("terminal-tool");
    // And the step says so, which is what the transcript is written from.
    expect(result.steps.some((s) => s.followUp?.includes("almost out of time"))).toBe(true);
    expect(result.steps.every((s) => typeof s.elapsedMs === "number")).toBe(true);
  });

  it("does not warn about time on a run with room to spare", async () => {
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: {} }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "done" } }] },
    ]);
    await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 50, costCapCents: 1e9, deadlineMs: 60_000 },
    });

    expect(t.requests.every((r) => !JSON.stringify(r.body).includes("almost out of time"))).toBe(
      true,
    );
  });

  it("does not stop a run that finishes inside it", async () => {
    // The guard must not be a timer that fires regardless: a fast run reaches its terminal
    // tool, and reporting "deadline" there would mark good reviews as degraded.
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "submit", input: { answer: "quick" } }] },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async (c) => ({ output: JSON.stringify(c.input) }),
      budget: { maxSteps: 50, costCapCents: 1e9, deadlineMs: 60_000 },
    });

    expect(result.stopKind).toBe("terminal-tool");
  });
});

describe("what a step keeps", () => {
  it("keeps the full tool output on the step after trimming truncates the message copy", async () => {
    // trimHistory's last resort truncates oversized tool outputs in place. Those objects
    // were shared with the LoopStep, so the step — the thing the recorder builds a
    // transcript from — silently lost the same bytes the model did. The trimming is
    // right; a transcript that quietly matches the trimmed prompt rather than what the
    // tool actually returned is not.
    const big = "x".repeat(5_000);
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: { value: "a" } }] },
      { toolCalls: [{ id: "2", name: "echo", input: { value: "b" } }] },
      { toolCalls: [{ id: "3", name: "submit", input: { answer: "ok" } }] },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: big }),
      // Small enough that the second pass has to truncate rather than splice: the loop
      // never touches index 0 or the last four messages, and there is nothing else here.
      budget: { maxSteps: 10, costCapCents: 100, maxPromptChars: 2_000 },
    });

    const firstResult = result.steps[0]?.toolResults[0];
    expect(firstResult?.output).toHaveLength(5_000);
    expect(firstResult?.output).not.toContain("truncated");

    // The prompt really was trimmed — otherwise this asserts nothing.
    const trimmed = result.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => (m.role === "tool" ? m.results : []));
    expect(trimmed.some((r) => r.output.includes("truncated"))).toBe(true);
  });
});

describe("per-step guidance", () => {
  /**
   * Every user turn the loop sent, across all requests.
   *
   * Empties are dropped: the Anthropic wire format carries tool results as a `user`
   * message of `tool_result` blocks, which have no text of their own.
   */
  const userTurns = (t: ReturnType<typeof anthropicTransport>) =>
    t.requests
      .flatMap((r) => (r.body.messages as { role: string; content: unknown }[]) ?? [])
      .filter((m) => m.role === "user")
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : (m.content as { text?: string }[]).map((b) => b.text ?? "").join(""),
      )
      .filter(Boolean);

  it("is offered on every tool-calling step, not once at the top", () => {
    // The whole claim of the mechanism this serves: a rule stated once at the start of a
    // long run is not the same thing as the same rule restated where it applies.
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: { value: "a" } }] },
      { toolCalls: [{ id: "2", name: "echo", input: { value: "b" } }] },
      { toolCalls: [{ id: "3", name: "submit", input: { answer: "ok" } }] },
    ]);
    const seen: { index: number; toolNames: string[] }[] = [];

    return runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 10, costCapCents: 100 },
      guidance: (step) => {
        seen.push(step);
        return `GUIDE-${step.index}`;
      },
    }).then(() => {
      // Two tool-calling steps; the terminal call ends the run before a third.
      expect(seen.map((s) => s.index)).toEqual([0, 1]);
      expect(seen[0]?.toolNames).toEqual(["echo"]);
      const turns = userTurns(t);
      expect(turns.filter((c) => c.includes("GUIDE-0"))).not.toHaveLength(0);
      expect(turns.filter((c) => c.includes("GUIDE-1"))).not.toHaveLength(0);
    });
  });

  it("replaces the previous step's guidance instead of stacking it", async () => {
    // `trimHistory` drops assistant/tool pairs and can never touch a synthetic user turn,
    // so these used to stay for the rest of the run: twenty steps meant twenty stacked
    // neighbourhoods, which between them are most of the graph — the whole-graph
    // configuration whose ablation is the entire reason to localize. Guidance is what to
    // do now, so exactly one of them is in the conversation at a time.
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: { value: "a" } }] },
      { toolCalls: [{ id: "2", name: "echo", input: { value: "b" } }] },
      { toolCalls: [{ id: "3", name: "echo", input: { value: "c" } }] },
      { toolCalls: [{ id: "4", name: "submit", input: { answer: "ok" } }] },
    ]);

    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 10, costCapCents: 100 },
      guidance: (step) => `GUIDE-${step.index}`,
    });

    const carrying = result.messages.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("GUIDE-"),
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.role === "user" && carrying[0].content).toContain("GUIDE-2");

    // And the last request really sent only the newest one: the point is what the model
    // reads, not what the array happens to hold.
    const last = t.requests.at(-1);
    const wire = JSON.stringify(last?.body.messages ?? []);
    expect(wire).toContain("GUIDE-2");
    expect(wire).not.toContain("GUIDE-0");
    expect(wire).not.toContain("GUIDE-1");
  });

  it("merges into the wrap-up turn instead of appending a second user message", async () => {
    // Asserted on the loop's OWN message list, not on the request body: the Anthropic
    // provider coalesces a tool-result message with the text that follows it, so the wire
    // format shows one `user` turn either way and cannot tell the two shapes apart. That
    // coalescing is one provider's behaviour and not a contract — `toModelMessages` maps
    // Maestro's messages one to one and promises nothing — so the loop is what has to hold
    // the shape, and the loop is where it has to be checked.
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: { value: "a" } }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "ok" } }] },
    ]);
    const result = await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      // One step left after the first, so the wrap-up nudge fires on the same step as
      // the guidance.
      budget: { maxSteps: 2, costCapCents: 100 },
      guidance: () => "GUIDE",
    });

    const roles = result.messages.map((m) => m.role);
    expect(roles.some((r, i) => r === "user" && roles[i + 1] === "user")).toBe(false);

    const merged = result.messages.find((m) => m.role === "user" && m.content.includes("GUIDE"));
    expect(merged?.role === "user" && merged.content).toContain("step left");
  });

  it("is not offered on a turn that called no tool", async () => {
    // A prose turn has no action to localize from, and the loop already answers it with
    // its own ask to submit.
    const t = anthropicTransport([{ text: "here are my thoughts" }, { text: "still thinking" }]);
    let calls = 0;
    await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 4, costCapCents: 100 },
      guidance: () => {
        calls++;
        return "GUIDE";
      },
    });
    expect(calls).toBe(0);
    expect(userTurns(t).some((c) => c.includes("GUIDE"))).toBe(false);
  });

  it("sends nothing extra when the hook declines", async () => {
    const t = anthropicTransport([
      { toolCalls: [{ id: "1", name: "echo", input: { value: "a" } }] },
      { toolCalls: [{ id: "2", name: "submit", input: { answer: "ok" } }] },
    ]);
    await runAgent({
      ...base,
      provider: new Provider(fakeConfig(t)),
      dispatch: async () => ({ output: "ok" }),
      budget: { maxSteps: 10, costCapCents: 100 },
      guidance: () => undefined,
    });
    // Only the opening prompt: an unmatched step gets silence, not an empty turn.
    expect(userTurns(t).filter((c) => c !== base.prompt)).toEqual([]);
  });
});
