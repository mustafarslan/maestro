import { describe, expect, it } from "vitest";
import { arg, has, numberArg, rejectUnknownFlags } from "./args.js";
import { args } from "./commands/review.js";

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

describe("a repeatable flag accepts both spellings too", () => {
  /**
   * `review` had its own `args()` helper matching only the exact token, while this module
   * opens by promising both spellings. So `maestro review . --base=main` silently ran
   * against `HEAD~1`, and `--model=x` silently ran the playbook's model — a different
   * review from the one asked for, with no error.
   *
   * `rejectUnknownFlags` made it worse rather than better: it splits on `=` before
   * matching, so `--model=gpt-5` was accepted as a recognised flag. The check said the
   * flag was known while the command ignored it, which is a false guarantee rather than
   * a missing one. Reported by Maestro reviewing its own commit.
   */
  it("reads the space form", () => {
    expect(args(["--agent", "security", "--agent", "product"], "--agent")).toEqual([
      "security",
      "product",
    ]);
  });

  it("reads the = form", () => {
    expect(args(["--base=main"], "--base")).toEqual(["main"]);
  });

  it("reads both at once, which is what a person actually types", () => {
    expect(args(["--agent=security", "--agent", "product"], "--agent")).toEqual([
      "security",
      "product",
    ]);
  });

  it("does not invent a value for a flag given without one", () => {
    expect(args(["--base="], "--base")).toEqual([]);
    expect(args(["--base"], "--base")).toEqual([]);
  });

  it("does not match a different flag that starts the same way", () => {
    // `--base` must not swallow `--base-ref`.
    expect(args(["--base-ref=x"], "--base")).toEqual([]);
  });
});
