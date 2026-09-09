import { describe, expect, it } from "vitest";
import { arg, has, numberArg, rejectUnknownFlags } from "./args.js";

describe("rejecting a flag no command accepts", () => {
  const serveFlags = ["--admin-host", "--admin-port", "--webhook-port", "--workers"];

  it("refuses one that does not exist", () => {
    // `maestro serve --port 7799` started on the default port and said nothing. The
    // daemon then behaves differently from what the operator asked for, and the only way
    // to find out is to notice.
    expect(() => rejectUnknownFlags(["--port", "7799"], serveFlags)).toThrow(
      /unknown option '--port'/,
    );
  });

  it("names the flag that was probably meant", () => {
    expect(() => rejectUnknownFlags(["--worker", "8"], serveFlags)).toThrow(/--workers/);
  });

  it("accepts the = spelling, which is what Compose passes", () => {
    // docker-compose.yml passes `--webhook-port=8080`. A checker that only understood
    // the space form would reject the project's own deployment.
    expect(() =>
      rejectUnknownFlags(["--webhook-port=8080", "--admin-host=0.0.0.0"], serveFlags),
    ).not.toThrow();
  });

  it("does not mistake a value for a flag", () => {
    expect(() => rejectUnknownFlags(["--admin-host", "0.0.0.0"], serveFlags)).not.toThrow();
  });

  it("always accepts --help", () => {
    expect(() => rejectUnknownFlags(["--help"], [])).not.toThrow();
  });

  it("stops at a bare --, so positional arguments are left alone", () => {
    expect(() => rejectUnknownFlags(["--", "--anything-at-all"], serveFlags)).not.toThrow();
  });

  it("ignores positional arguments", () => {
    expect(() => rejectUnknownFlags(["owner/repo", "--workers", "3"], serveFlags)).not.toThrow();
  });
});

describe("the flag helpers this rests on", () => {
  it("reads both spellings", () => {
    expect(arg(["--admin-port", "7777"], "--admin-port")).toBe("7777");
    expect(arg(["--admin-port=7777"], "--admin-port")).toBe("7777");
  });

  it("treats a following flag as a missing value", () => {
    expect(arg(["--admin-port", "--workers"], "--admin-port")).toBeUndefined();
  });

  it("refuses a number that is not one", () => {
    // `--workers abc` made `for (let i = 0; i < NaN; i++)` run zero times: a daemon that
    // started, printed a healthy banner, and never reviewed anything.
    expect(() => numberArg(["--workers", "abc"], "--workers")).toThrow(/must be a number/);
  });

  it("sees a boolean flag in either spelling", () => {
    expect(has(["--force"], "--force")).toBe(true);
    expect(has(["--force=true"], "--force")).toBe(true);
    expect(has([], "--force")).toBe(false);
  });
});
