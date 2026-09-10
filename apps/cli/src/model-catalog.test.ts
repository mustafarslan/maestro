import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@maestro/core";
import { ProviderConfigStore } from "@maestro/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llm } from "./commands/llm.js";

/**
 * An endpoint that lists no models is not a healthy provider.
 *
 * Ollama serves its cloud models without listing them: `/v1/models` comes back empty
 * while `glm-5.3:cloud` answers perfectly. `maestro llm models` printed a green tick
 * beside "0 model(s)", so somebody was told their provider was fine and left with an
 * empty dropdown in the Studio — which is the one thing the catalog exists to fill.
 * Observed against a real Ollama with a working cloud session.
 */
describe("a provider that lists nothing", () => {
  let home: string;
  let originalHome: string | undefined;
  let server: Server;
  let logs: string[];

  beforeEach(async () => {
    originalHome = process.env.MAESTRO_HOME;
    home = mkdtempSync(join(tmpdir(), "maestro-cat-"));
    process.env.MAESTRO_HOME = home;
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });

    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // What Ollama answers with no models pulled locally.
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const db = await openStore();
    new ProviderConfigStore(db).upsert({
      id: "stub",
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      enabled: true,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.MAESTRO_HOME;
    else process.env.MAESTRO_HOME = originalHome;
  });

  it("is not reported as healthy", async () => {
    await llm(["models", "--provider", "stub"]);
    const line = logs.find((l) => l.includes("stub"));
    expect(line).toBeDefined();
    expect(line).toContain("0 model(s)");
    // The mark, not the words: `checkLine` renders ok as ✓ and warn as !.
    expect(line).not.toContain("✓");
    expect(line).toContain("!");
  });

  it("says what to do instead of leaving a bare zero", async () => {
    await llm(["models", "--provider", "stub"]);
    const line = logs.find((l) => l.includes("stub")) ?? "";
    // A model an endpoint does not list can still be bound by name — which is exactly
    // how the live Ollama cloud models are used.
    expect(line).toMatch(/bound by name/);
    expect(line).toMatch(/maestro llm test/);
  });
});
