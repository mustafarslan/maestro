import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqlDatabase } from "@maestro/core";
import { defaultPlaybook, PlaybookStore } from "@maestro/playbook";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate, resolveEvalPlaybook } from "./commands/evaluate.js";
import { llm } from "./commands/llm.js";
import { playbook } from "./commands/playbook.js";

/**
 * Two messages that were accurate about the wrong thing.
 *
 * Found by running the compiled binary rather than by reading it, which is the second
 * time today that has been the difference.
 */
describe("errors that name the actual problem", () => {
  let home: string;
  let originalHome: string | undefined;
  let errors: string[];
  let logs: string[];

  beforeEach(() => {
    originalHome = process.env.MAESTRO_HOME;
    home = mkdtempSync(join(tmpdir(), "maestro-msg-"));
    process.env.MAESTRO_HOME = home;
    errors = [];
    logs = [];
    vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.MAESTRO_HOME;
    else process.env.MAESTRO_HOME = originalHome;
  });

  it("says which fixtures exist when the named one does not", async () => {
    // "No fixtures found in <dir>" sent somebody looking in a directory that held
    // exactly what they had asked about, under a different name.
    mkdirSync(join(home, "fixtures"), { recursive: true });
    writeFileSync(
      join(home, "fixtures", "my-case.json"),
      JSON.stringify({ name: "my-case", repo: ".", base: "main", expected: [] }),
    );

    expect(await evaluate(["run", "--fixture", "nope"])).toBe(1);
    const said = errors.join("\n");
    expect(said).toContain("no fixture named 'nope'");
    expect(said).toContain("my-case");
    expect(said).not.toContain("no fixtures found");
  });

  it("still says the directory is empty when it is", async () => {
    expect(await evaluate(["run", "--fixture", "nope"])).toBe(1);
    expect(errors.join("\n")).toContain("no fixtures found");
  });

  it("reports a missing playbook file as a sentence, not as ENOENT", async () => {
    expect(await playbook(["validate", join(home, "not-here.yaml")])).toBe(1);
    const said = logs.join("\n");
    expect(said).toContain("no such file");
    expect(said).not.toContain("ENOENT");
  });
});

describe("registering a provider does not quietly replace one", () => {
  let home: string;
  let originalHome: string | undefined;
  let logs: string[];

  beforeEach(() => {
    originalHome = process.env.MAESTRO_HOME;
    home = mkdtempSync(join(tmpdir(), "maestro-llm-"));
    process.env.MAESTRO_HOME = home;
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.MAESTRO_HOME;
    else process.env.MAESTRO_HOME = originalHome;
  });

  const baseUrlOf = async (id: string) => {
    const { openStore } = await import("@maestro/core");
    const { ProviderConfigStore } = await import("@maestro/llm");
    const db = await openStore();
    return new ProviderConfigStore(db).list().find((p) => p.id === id)?.baseUrl;
  };

  it("refuses an id that already exists, and changes nothing", async () => {
    // `add` went straight to the store's upsert, so reusing an id repointed that
    // provider and still said "registered". Every agent bound to it then called a
    // different endpoint, with nothing in the output saying so.
    expect(
      await llm(["add", "ollama", "--kind", "openai-compatible", "--base-url", "http://x/v1"]),
    ).toBe(1);
    expect(logs.join("\n")).toContain("already registered");
    expect(await baseUrlOf("ollama")).not.toBe("http://x/v1");
  });

  it("replaces it when asked, and says 'replaced' rather than 'registered'", async () => {
    expect(
      await llm([
        "add",
        "ollama",
        "--kind",
        "openai-compatible",
        "--base-url",
        "http://x/v1",
        "--force",
      ]),
    ).toBe(0);
    expect(logs.join("\n")).toContain("replaced");
    expect(await baseUrlOf("ollama")).toBe("http://x/v1");
  });

  it("registers a genuinely new one", async () => {
    expect(
      await llm(["add", "my-vllm", "--kind", "openai-compatible", "--base-url", "http://y/v1"]),
    ).toBe(0);
    expect(logs.join("\n")).toContain("registered");
    expect(await baseUrlOf("my-vllm")).toBe("http://y/v1");
  });
});

/**
 * `--playbook` scores a version without activating it.
 *
 * Two arms of an experiment used to be two `playbook activate` calls, so a measurement
 * changed what every other review on the machine would use, and a run that died between
 * them left the wrong one active with nothing saying so.
 *
 * Against a real store, because the interesting half is the lookup and not the message:
 * the message names the requested version on both branches, so a test that only read it
 * passed with the lookup mutated back to `getActive`.
 */
describe("choosing which playbook version a run scores", () => {
  let db: SqlDatabase;
  let store: PlaybookStore;

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    store = new PlaybookStore(db);
  });

  it("scores the version named, not the active one", () => {
    const active = store.publish(defaultPlaybook(), { activate: true });
    const other = store.publish(defaultPlaybook(), { activate: false });
    expect(other.id).not.toBe(active.id);

    const resolved = resolveEvalPlaybook(store, other.id);
    expect("record" in resolved && resolved.record.id).toBe(other.id);
  });

  it("falls back to the active default when none is named", () => {
    const active = store.publish(defaultPlaybook(), { activate: true });
    const resolved = resolveEvalPlaybook(store, undefined);
    expect("record" in resolved && resolved.record.id).toBe(active.id);
  });

  it("names the version that does not exist rather than sending anyone to 'maestro init'", () => {
    store.publish(defaultPlaybook(), { activate: true });
    const resolved = resolveEvalPlaybook(store, "pv_nope");
    expect("error" in resolved && resolved.error).toContain("pv_nope");
    expect("error" in resolved && resolved.error).not.toContain("maestro init");
  });
});
