import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profile } from "./profile.js";

/**
 * The command end to end, against a real database file in a temporary directory.
 *
 * `take` is driven by a scripted input stream: a questionnaire that loses answers when a
 * session stops half-way would be worse than none, so stopping half-way is what is tested.
 */
describe("maestro profile", () => {
  let dir: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const printed = () => log.mock.calls.flat().join("\n");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maestro-profile-"));
    vi.stubEnv("MAESTRO_DB", join(dir, "maestro.db"));
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    log.mockRestore();
    err.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const json = async (subject: string) => {
    log.mockClear();
    expect(await profile(["show", "--json", "--subject", subject])).toBe(0);
    return JSON.parse(printed());
  };

  it("answer, then show --json", async () => {
    expect(await profile(["answer", "DEBT-01", "b", "--subject", "octocat"])).toBe(0);
    const saved = await json("octocat");
    expect(saved.responses).toEqual({ "DEBT-01": "B" });
    expect(saved.profile.attributes.blocking_threshold).toBe(0.1);
  });

  it("refuses a label the item does not offer, and saves nothing", async () => {
    expect(await profile(["answer", "LING-01", "D", "--subject", "octocat"])).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toMatch(/'D' is not one of A, B, C/);
    expect(await profile(["show", "--subject", "octocat"])).toBe(1);
  });

  it("import merges, and --replace starts over", async () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, JSON.stringify({ "COG-01": "E", "COG-03": "A" }));
    writeFileSync(b, JSON.stringify({ "DEBT-01": "D" }));
    expect(await profile(["import", a, "--subject", "octocat"])).toBe(0);
    expect(await profile(["import", b, "--subject", "octocat"])).toBe(0);
    expect(Object.keys((await json("octocat")).responses)).toHaveLength(3);
    expect(await profile(["import", b, "--replace", "--subject", "octocat"])).toBe(0);
    expect((await json("octocat")).responses).toEqual({ "DEBT-01": "D" });
  });

  it("forget one item, then everything", async () => {
    await profile(["answer", "COG-01", "E", "--subject", "octocat"]);
    await profile(["answer", "COG-03", "A", "--subject", "octocat"]);
    expect(await profile(["forget", "--item", "cog-03", "--subject", "octocat"])).toBe(0);
    expect((await json("octocat")).responses).toEqual({ "COG-01": "E" });
    expect(await profile(["forget", "--subject", "octocat"])).toBe(0);
    expect((await json("octocat")).answered).toBe(0);
  });

  it("show prints a readable profile", async () => {
    await profile(["answer", "LING-01", "A", "--subject", "octocat"]);
    log.mockClear();
    expect(await profile(["show", "--subject", "octocat"])).toBe(0);
    expect(printed()).toMatch(/1 of 100 items answered/);
    expect(printed()).toMatch(/Direct_Imperative/);
  });

  it("list and review-first", async () => {
    await profile(["answer", "COG-01", "E", "--subject", "octocat"]);
    log.mockClear();
    expect(await profile(["list"])).toBe(0);
    expect(printed()).toMatch(/octocat/);
    log.mockClear();
    expect(await profile(["review-first"])).toBe(0);
    for (const id of ["DEBT-01", "DEBT-11", "GATE-13", "HAB-09"]) expect(printed()).toContain(id);
  });

  it("take saves each answer as it goes and survives a stop half-way", async () => {
    // COG-01: a wrong letter is asked again; then E. COG-02: skipped. COG-03: A. Then stop.
    const input = Readable.from(["x\n", "e\n", "s\n", "a\n", "q\n"]);
    const output = new PassThrough();
    let screen = "";
    output.on("data", (c) => {
      screen += String(c);
    });

    expect(
      await profile(["take", "--category", "cog", "--subject", "octocat"], { input, output }),
    ).toBe(0);
    expect(screen).toMatch(/\[1\/15\] COG-01/);
    expect(screen).toMatch(/'x' is not one of A, B, C, D, E/);
    expect(screen).toMatch(/2 answer\(s\) saved for octocat/);
    expect((await json("octocat")).responses).toEqual({ "COG-01": "E", "COG-03": "A" });

    // The next session resumes at the first unanswered item, and ends cleanly when input does.
    const again = new PassThrough();
    let second = "";
    again.on("data", (c) => {
      second += String(c);
    });
    expect(
      await profile(["take", "--category", "COG", "--subject", "octocat"], {
        input: Readable.from(["c\n"]),
        output: again,
      }),
    ).toBe(0);
    expect(second).toMatch(/\[1\/13\] COG-02/);
    expect((await json("octocat")).responses).toEqual({
      "COG-01": "E",
      "COG-02": "C",
      "COG-03": "A",
    });
  });

  it("take can present every item in the battery", async () => {
    // Skipping all 100 renders each one. Six Likert items have no diff and four no PR
    // context; the first of them crashed the questionnaire on its third question.
    const output = new PassThrough();
    let screen = "";
    output.on("data", (c) => {
      screen += String(c);
    });
    const skips = Readable.from(Array.from({ length: 100 }, () => "s\n"));
    expect(await profile(["take", "--subject", "octocat"], { input: skips, output })).toBe(0);
    expect(screen).toMatch(/\[100\/100\] BUG-05/);
    expect(screen).toMatch(/0 answer\(s\) saved/);
  });

  it("take with a prefix no item has is an error", async () => {
    const output = new PassThrough();
    expect(await profile(["take", "--category", "ZZZ"], { input: Readable.from([]), output })).toBe(
      1,
    );
  });
});
