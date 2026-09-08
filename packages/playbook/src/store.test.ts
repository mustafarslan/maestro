import { openStore, type SqlDatabase } from "@maestro/core";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultPlaybook } from "./default-playbook.js";
import { fromYaml, toYaml } from "./serialize.js";
import { PlaybookStore } from "./store.js";
import { PlaybookInvalidError } from "./validate.js";

let db: SqlDatabase;
let store: PlaybookStore;

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  store = new PlaybookStore(db);
});

describe("PlaybookStore", () => {
  it("seeds the default playbook once and is idempotent", () => {
    const first = store.ensureDefault();
    const second = store.ensureDefault();
    expect(second.id).toBe(first.id);
    expect(store.listVersions()).toHaveLength(1);
  });

  it("publishes monotonically increasing versions", () => {
    const v1 = store.publish(defaultPlaybook());
    const v2 = store.publish({ ...defaultPlaybook(), description: "changed" });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(store.getActive()?.id).toBe(v2.id);
  });

  it("keeps published versions immutable: an old version still reads back as it was", () => {
    // This is what makes a past review explainable and Phase 9 measurement meaningful.
    const v1 = store.publish(defaultPlaybook());
    const mutated = defaultPlaybook();
    mutated.agents[0]!.persona = "totally different persona";
    store.publish(mutated);

    expect(store.getVersion(v1.id)?.doc.agents[0]?.persona).toBe(
      defaultPlaybook().agents[0]?.persona,
    );
  });

  it("can publish without activating, then activate explicitly", () => {
    const v1 = store.publish(defaultPlaybook());
    const v2 = store.publish({ ...defaultPlaybook(), description: "draft" }, { activate: false });

    expect(store.getActive()?.id).toBe(v1.id);
    store.activate(v2.id);
    expect(store.getActive()?.id).toBe(v2.id);
  });

  it("refuses to publish an invalid playbook", () => {
    const broken = defaultPlaybook();
    broken.graph.edges.push({ from: "triage", to: "route" }); // cycle
    expect(() => store.publish(broken)).toThrow(PlaybookInvalidError);
  });

  it("falls back to the global default when a repo has no playbook assigned", () => {
    const v1 = store.ensureDefault();
    db.prepare(
      "INSERT INTO repos (id, owner, name, default_branch, enabled, created_at) VALUES (?,?,?,?,1,?)",
    ).run("repo1", "acme", "web", "main", new Date().toISOString());

    expect(store.resolveForRepo("repo1")?.id).toBe(v1.id);
  });

  it("uses a repo's own playbook when one is assigned", () => {
    store.ensureDefault();
    const mobile = { ...defaultPlaybook(), name: "mobile" };
    const mobileVersion = store.publish(mobile, { name: "mobile" });
    const pbId = db
      .prepare("SELECT id FROM playbooks WHERE name=?")
      .get<{ id: string }>("mobile")!.id;
    db.prepare(
      "INSERT INTO repos (id, owner, name, default_branch, playbook_id, enabled, created_at) VALUES (?,?,?,?,?,1,?)",
    ).run("repo2", "acme", "ios", "main", pbId, new Date().toISOString());

    expect(store.resolveForRepo("repo2")?.id).toBe(mobileVersion.id);
  });
});

describe("YAML round trip", () => {
  it("survives export and re-import unchanged", () => {
    const original = defaultPlaybook();
    expect(fromYaml(toYaml(original))).toEqual(original);
  });
});
