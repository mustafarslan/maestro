import { describe, expect, it } from "vitest";
import { arg, has, numberArg } from "./args.js";

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

describe("numeric flags", () => {
  it("rejects a value that is not a number instead of passing NaN downstream", () => {
    // Measured before the fix: --workers abc made `for (i = 0; i < NaN; i++)` run zero
    // times, so the daemon started, printed a healthy banner and never reviewed
    // anything. --poll-interval abc became setInterval(fn, NaN), which the spec coerces
    // to 1ms — a tight loop against the GitHub API. Both look like they are working,
    // which is what makes them worse than a crash.
    expect(() => numberArg(["--workers", "abc"], "--workers")).toThrow(/must be a number/);
  });

  it("rejects a fractional count", () => {
    expect(() => numberArg(["--workers", "2.5"], "--workers")).toThrow(/whole number/);
  });

  it("enforces the range it is given", () => {
    expect(() => numberArg(["--workers", "0"], "--workers", { min: 1 })).toThrow(/at least 1/);
    expect(() => numberArg(["--admin-port", "70000"], "--admin-port", { max: 65535 })).toThrow(
      /at most 65535/,
    );
  });

  it("returns the fallback when the flag is absent, and only then", () => {
    expect(numberArg([], "--workers", { fallback: 3 })).toBe(3);
    expect(numberArg(["--workers", "8"], "--workers", { fallback: 3 })).toBe(8);
  });

  it("accepts zero where zero is meaningful", () => {
    // --webhook-port 0 asks the OS for any free port, which the tests rely on.
    expect(numberArg(["--webhook-port", "0"], "--webhook-port", { min: 0 })).toBe(0);
  });

  it("reads the inline spelling too", () => {
    expect(numberArg(["--workers=8"], "--workers")).toBe(8);
  });
});
