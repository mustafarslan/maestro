import { openStore, ReviewStore, type SqlDatabase } from "@maestro/core";
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

describe("assigning a playbook to one repository", () => {
  // `repos.playbook_id` was in the first migration, `resolveForRepo` read it from the
  // day the daemon learned to, and nothing anywhere could write it — so a mobile repo and
  // a backend repo wanting different personas, the reason the column exists, was a
  // documented capability with no way to reach it. It is also what makes one repository
  // review only on request while another reviews every push.
  it("makes resolveForRepo return the assigned playbook, not the default", () => {
    const store = new PlaybookStore(db);
    store.ensureDefault();
    const mobile = { ...defaultPlaybook(), name: "mobile" };
    store.publish(mobile, { name: "mobile", activate: true });

    const repoId = new ReviewStore(db).ensureRepo("acme", "ios");
    expect(store.resolveForRepo(repoId)?.doc.name).toBe("default");

    expect(store.assignToRepo(repoId, "mobile")).toBe(true);
    expect(store.resolveForRepo(repoId)?.doc.name).toBe("mobile");
    expect(store.assignmentFor(repoId)).toBe("mobile");
  });

  it("goes back to the global default", () => {
    const store = new PlaybookStore(db);
    store.ensureDefault();
    store.publish({ ...defaultPlaybook(), name: "mobile" }, { name: "mobile", activate: true });
    const repoId = new ReviewStore(db).ensureRepo("acme", "ios");
    store.assignToRepo(repoId, "mobile");

    store.assignToRepo(repoId, null);
    expect(store.assignmentFor(repoId)).toBeNull();
    expect(store.resolveForRepo(repoId)?.doc.name).toBe("default");
  });

  it("refuses a name that does not exist rather than assigning nothing", () => {
    // A typo that silently left the repository on the default would look identical to
    // success, and the next review would quietly use the wrong personas.
    const store = new PlaybookStore(db);
    store.ensureDefault();
    const repoId = new ReviewStore(db).ensureRepo("acme", "ios");
    expect(store.assignToRepo(repoId, "typo")).toBe(false);
    expect(store.assignmentFor(repoId)).toBeNull();
  });
});

describe("a version stored before a schema field existed stays usable", () => {
  it("fills in fields the stored document predates", () => {
    // Versions are immutable, so a document written before a field was added never gains
    // it. `hydrate` used to cast the parsed JSON straight to PlaybookDocument, asserting
    // that yesterday's shape matches today's type — and adding envSpec.compareCommands
    // made `maestro doctor` crash on every pre-existing install, iterating a property
    // that was undefined. Found by the gate against a real database, not reasoned about.
    const seeded = store.ensureDefault();

    // Rewrite the row as an older Maestro would have written it.
    const old = JSON.parse(JSON.stringify(seeded.doc)) as {
      envSpec: Record<string, unknown>;
    };
    delete old.envSpec.compareCommands;
    db.prepare("UPDATE playbook_versions SET document=? WHERE id=?").run(
      JSON.stringify(old),
      seeded.id,
    );

    const read = store.ensureDefault();
    expect(read.doc.envSpec.compareCommands).toEqual([]);
  });
});
