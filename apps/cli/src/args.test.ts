import { describe, expect, it } from "vitest";
import { arg, has } from "./args.js";

describe("flag parsing", () => {
  it("accepts both spellings, because both are conventional", () => {
    // docker-compose.yml passes the `=` form. Six commands each carried a copy that
    // handled only the space form, so the containerised daemon silently ignored
    // --webhook-port=8080 and --admin-host=0.0.0.0: it came up, warned that no trigger
    // was configured as though the operator had forgotten one, and bound the admin API
    // to a loopback address unreachable from the published port.
    expect(arg(["--admin-port", "7777"], "--admin-port")).toBe("7777");
    expect(arg(["--admin-port=7777"], "--admin-port")).toBe("7777");
  });

  it("keeps a value containing '=' intact", () => {
    expect(arg(["--webhook-secret=a=b=c"], "--webhook-secret")).toBe("a=b=c");
  });

  it("accepts an empty inline value rather than reading the next argument", () => {
    expect(arg(["--admin-host=", "--poll", "o/r"], "--admin-host")).toBe("");
  });

  it("treats a following flag as a missing value, not as the value", () => {
    // `maestro reap --review --all` must not read "--all" as a review id: the caller
    // meant to scope the sweep and forgot the id, and the unscoped sweep is destructive.
    expect(arg(["--review", "--all"], "--review")).toBeUndefined();
    expect(arg(["--review"], "--review")).toBeUndefined();
  });

  it("does not match a flag that merely shares a prefix", () => {
    expect(arg(["--admin-port-extra=1"], "--admin-port")).toBeUndefined();
    expect(arg(["--poll-interval", "30"], "--poll")).toBeUndefined();
  });

  it("detects boolean flags in either spelling", () => {
    expect(has(["--force"], "--force")).toBe(true);
    expect(has(["--force=true"], "--force")).toBe(true);
    expect(has(["--other"], "--force")).toBe(false);
  });
});
