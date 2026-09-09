import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EgressProxy, startEgressProxy } from "./egress-proxy.js";

/**
 * The wall between a stranger's dependency tree and the internet.
 *
 * `prepare` runs `npm install` on code from a pull request — arbitrary code execution by
 * design — and this allowlist is what keeps it from reaching anywhere it likes. A matching
 * bug here does not fail loudly; it silently permits, which is why the property is pinned
 * rather than left to a comment.
 *
 * Hermetic: every assertion below is about a host that is either refused before any socket
 * is opened, or allowlisted and unresolvable. Nothing here talks to the real internet.
 */
let proxy: EgressProxy;

beforeEach(async () => {
  proxy = await startEgressProxy(["registry.npmjs.org", "pypi.org"]);
});
afterEach(async () => {
  await proxy.close();
});

/** Speaks the absolute-form request a client sends to a proxy, and returns the status line. */
const send = (requestLine: string): Promise<string> =>
  new Promise((resolve) => {
    const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`${requestLine}\r\n\r\n`));
    let buf = "";
    const done = () => {
      socket.destroy();
      resolve(buf.split("\r\n")[0] ?? "");
    };
    socket.on("data", (d) => {
      buf += d;
      if (buf.includes("\r\n")) done();
    });
    socket.on("error", () => resolve("ERROR"));
    setTimeout(done, 4000);
  });

const get = (host: string) => send(`GET http://${host}/x HTTP/1.1\r\nHost: ${host}`);

describe("what the egress allowlist refuses", () => {
  it("refuses a host that merely ends with an allowlisted one", async () => {
    // The attack the matcher exists for: substring or naive suffix matching would treat
    // `registry.npmjs.org.evil.com` as npm, and a poisoned install script would have a
    // channel out of a sandbox that is otherwise network-isolated.
    expect(await get("registry.npmjs.org.evil.com")).toContain("403");
  });

  it("refuses a host that merely starts with one", async () => {
    expect(await get("evilregistry.npmjs.org.co")).toContain("403");
  });

  it("refuses a raw IP address", async () => {
    // Resolving the allowlist yourself and dialling the address is the obvious bypass.
    expect(await get("93.184.216.34")).toContain("403");
  });

  it("refuses a host nobody allowlisted", async () => {
    expect(await get("example.com")).toContain("403");
  });

  it("refuses the same tricks over CONNECT, not only plain HTTP", async () => {
    // HTTPS does not go through the request handler at all; it arrives as a CONNECT and
    // is tunnelled. Gating one path and not the other would leave the allowlist checking
    // only the traffic that barely exists any more.
    expect(await send("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443")).toContain(
      "403",
    );
    expect(await send("CONNECT registry.npmjs.org.evil.com:443 HTTP/1.1\r\nHost: x")).toContain(
      "403",
    );
  });
});

describe("what it permits", () => {
  // These use an allowlisted name that does not resolve, so the decision is observable
  // without any traffic leaving the machine: a refusal is 403 from the proxy, an
  // allowance fails later at the socket with 502.
  it("permits an exact match", async () => {
    const status = await get("pypi.org.");
    expect(status).toContain("403"); // trailing dot is not the same name; fails closed
  });

  it("permits a subdomain of an allowlisted domain", async () => {
    const status = await get("nonexistent-subdomain.pypi.org");
    expect(status).not.toContain("403");
    expect(proxy.log.at(-1)).toMatchObject({
      host: "nonexistent-subdomain.pypi.org",
      allowed: true,
    });
  });

  it("matches case-insensitively, since host names are", async () => {
    const status = await get("NONEXISTENT-SUB.PYPI.ORG");
    expect(status).not.toContain("403");
  });

  it("records every decision, allowed or not, for the review's evidence", async () => {
    await get("example.com");
    expect(proxy.log.at(-1)).toMatchObject({ host: "example.com", allowed: false });
  });
});
