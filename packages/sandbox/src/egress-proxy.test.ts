import { afterEach, describe, expect, it } from "vitest";
import { startEgressProxy } from "./egress-proxy.js";

describe("fixed port range", () => {
  const original = process.env.MAESTRO_PROXY_PORT_RANGE;
  afterEach(() => {
    if (original === undefined) delete process.env.MAESTRO_PROXY_PORT_RANGE;
    else process.env.MAESTRO_PROXY_PORT_RANGE = original;
  });

  it("binds inside the configured range so Compose can publish the port", async () => {
    // An ephemeral port cannot be published ahead of time, so under Compose the sibling
    // sandboxes dial the bridge gateway and find nothing listening. Every dependency
    // install fails, with no error that points here.
    process.env.MAESTRO_PROXY_PORT_RANGE = "7890-7899";
    const proxy = await startEgressProxy(["registry.npmjs.org"]);
    try {
      expect(proxy.port).toBeGreaterThanOrEqual(7890);
      expect(proxy.port).toBeLessThanOrEqual(7899);
    } finally {
      await proxy.close();
    }
  });

  it("moves to the next port rather than failing, because reviews run concurrently", async () => {
    // One fixed port would serialise the prepare phase — the opposite of what the
    // scheduler exists to do.
    process.env.MAESTRO_PROXY_PORT_RANGE = "7900-7901";
    const first = await startEgressProxy(["registry.npmjs.org"]);
    const second = await startEgressProxy(["registry.npmjs.org"]);
    try {
      expect(first.port).not.toBe(second.port);
      expect([7900, 7901]).toContain(second.port);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("rejects a malformed range instead of silently falling back to ephemeral", async () => {
    process.env.MAESTRO_PROXY_PORT_RANGE = "not-a-range";
    await expect(startEgressProxy(["registry.npmjs.org"])).rejects.toThrow(
      /MAESTRO_PROXY_PORT_RANGE/,
    );
  });
});
