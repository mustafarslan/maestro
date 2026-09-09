import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { listen } from "./listen.js";

/**
 * A bind failure arrives as an `error` EVENT, not through `listen`'s callback. With no
 * listener on it, Node terminates the process — so a promise wrapping only the callback
 * never settles, the CLI's error handling never runs, and starting a second daemon on a
 * busy port printed nine lines of `node:_http_server` source with `EADDRINUSE` somewhere
 * in the middle.
 */
describe("binding a port that is taken", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  const hold = async (): Promise<number> => {
    const s = createServer();
    servers.push(s);
    await listen(s, 0, "127.0.0.1", "test server");
    return (s.address() as AddressInfo).port;
  };

  it("rejects with a sentence rather than killing the process", async () => {
    const port = await hold();
    const second = createServer();
    servers.push(second);

    await expect(listen(second, port, "127.0.0.1", "admin server")).rejects.toThrow(
      /admin server cannot bind 127\.0\.0\.1:\d+.*already listening/s,
    );
  });

  it("names what a person should do about it", async () => {
    const port = await hold();
    const second = createServer();
    servers.push(second);
    await expect(listen(second, port, "127.0.0.1", "admin server")).rejects.toThrow(
      /maestro serve/,
    );
  });

  it("resolves when the port is free", async () => {
    // The other half: a check that always rejected would pass the tests above.
    await expect(hold()).resolves.toBeGreaterThan(0);
  });

  it("explains an address no interface has", async () => {
    const s = createServer();
    servers.push(s);
    await expect(listen(s, 0, "203.0.113.1", "admin server")).rejects.toThrow(
      /no interface on this machine has that address|cannot bind/,
    );
  });
});
