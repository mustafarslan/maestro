import { openStore, type SqlDatabase } from "@maestro/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type Battery, bundledBattery } from "./battery.js";
import { answerProblems, ProfileStore, resolveReviewProfile } from "./store.js";

describe("the profile store", () => {
  let db: SqlDatabase;
  let store: ProfileStore;

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    store = new ProfileStore(db);
  });

  it("has nothing for someone who has not begun", () => {
    expect(store.get("octocat")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("saves a first answer and scores the sheet with the battery's version", () => {
    const saved = store.record("octocat", { "COG-01": "E" });
    expect(saved.subject).toBe("octocat");
    expect(saved.batteryVersion).toBe(bundledBattery().version);
    expect(saved.answered).toBe(1);
    expect(saved.profile.attributes.kai_index).toBe(0);
    expect(saved.id).toMatch(/^dp_/);
  });

  it("merges later sittings into the saved sheet and re-scores all of it", () => {
    store.record("octocat", { "COG-01": "E" });
    const second = store.record("octocat", { "COG-03": "A", "DEBT-01": "D" });
    expect(second.responses).toEqual({ "COG-01": "E", "COG-03": "A", "DEBT-01": "D" });
    expect(second.answered).toBe(3);
    expect(second.profile.coverage.nPerAttribute.kai_index).toBe(2);
  });

  it("a changed answer replaces the old one rather than counting twice", () => {
    store.record("octocat", { "DEBT-01": "D" });
    const changed = store.record("octocat", { "DEBT-01": "B" });
    expect(changed.answered).toBe(1);
    expect(changed.profile.attributes.blocking_threshold).toBe(0.1);
  });

  it("replace starts the sheet over", () => {
    store.record("octocat", { "COG-01": "E", "COG-03": "A" });
    const fresh = store.record("octocat", { "DEBT-01": "D" }, { replace: true });
    expect(fresh.responses).toEqual({ "DEBT-01": "D" });
  });

  it("refuses the whole write when any answer is wrong, and names every one", () => {
    store.record("octocat", { "COG-01": "E" });
    expect(() =>
      store.record("octocat", { "COG-03": "A", "COG-02": "F", "NOPE-01": "A", "LING-01": "D" }),
    ).toThrow(/COG-02: 'F' is not one of A, B, C, D, E[\s\S]*NOPE-01[\s\S]*LING-01: 'D'/);
    // Nothing from the refused write landed, including its one valid answer.
    expect(store.get("octocat")?.responses).toEqual({ "COG-01": "E" });
  });

  it("treats a login's case as GitHub does", () => {
    store.record("Octocat", { "COG-01": "E" });
    store.record("octocat", { "COG-03": "A" });
    expect(store.list()).toHaveLength(1);
    expect(store.get("OCTOCAT")?.answered).toBe(2);
  });

  it("needs a subject", () => {
    expect(() => store.record("  ", { "COG-01": "E" })).toThrow(/needs a subject/);
  });

  it("forgets chosen answers, or all of them", () => {
    store.record("octocat", { "COG-01": "E", "COG-03": "A", "DEBT-01": "D" });
    expect(store.forget("octocat", ["COG-03"])?.responses).toEqual({
      "COG-01": "E",
      "DEBT-01": "D",
    });
    const cleared = store.forget("octocat");
    expect(cleared?.answered).toBe(0);
    expect(cleared?.profile.attributes.blocking_threshold).toBeNull();
    expect(store.forget("nobody")).toBeUndefined();
  });

  it("keeps a profile per battery version, and a store reads only its own", () => {
    store.record("octocat", { "COG-01": "E" });
    const next = structuredClone(bundledBattery()) as Battery;
    next.version = "2.4";
    const nextStore = new ProfileStore(db, next);
    expect(nextStore.get("octocat")).toBeUndefined();
    nextStore.record("octocat", { "COG-01": "A" });
    expect(nextStore.get("octocat")?.profile.attributes.kai_index).toBe(1);
    expect(store.get("octocat")?.profile.attributes.kai_index).toBe(0);
  });

  it("lists without the sheets, most recently updated first", async () => {
    store.record("a", { "COG-01": "E" });
    await new Promise((r) => setTimeout(r, 5));
    store.record("b", { "COG-01": "E" });
    const rows = store.list();
    expect(rows.map((r) => r.subject)).toEqual(["b", "a"]);
    expect(rows[0]).not.toHaveProperty("responses");
  });
});

describe("answerProblems", () => {
  it("accepts every label an item actually offers", () => {
    const b = bundledBattery();
    const all = Object.fromEntries(b.items.map((i) => [i.id, i.options[0]?.label ?? "A"]));
    expect(answerProblems(b, all)).toEqual([]);
  });
});

describe("the active profile", () => {
  let db: SqlDatabase;
  let store: ProfileStore;

  beforeEach(async () => {
    db = await openStore({ path: ":memory:" });
    store = new ProfileStore(db);
    store.record("octocat", { "COG-01": "E" });
    store.record("hubot", { "COG-01": "A" });
  });

  it("is nobody until someone is activated", () => {
    expect(store.active()).toBeUndefined();
    expect(store.list().every((p) => !p.active)).toBe(true);
  });

  it("is one subject at a time, and activating another deactivates the first", () => {
    expect(store.activate("octocat").active).toBe(true);
    expect(store.active()?.subject).toBe("octocat");
    store.activate("HUBOT");
    expect(store.active()?.subject).toBe("hubot");
    expect(store.get("octocat")?.active).toBe(false);
    expect(
      store
        .list()
        .filter((p) => p.active)
        .map((p) => p.subject),
    ).toEqual(["hubot"]);
  });

  it("needs a profile to exist", () => {
    expect(() => store.activate("nobody")).toThrow(/no profile for nobody/);
  });

  it("survives answering more questions", () => {
    store.activate("octocat");
    store.record("octocat", { "COG-03": "A" });
    expect(store.active()?.answered).toBe(2);
  });

  it("deactivates, and says whose it was", () => {
    store.activate("octocat");
    expect(store.deactivate()).toBe("octocat");
    expect(store.active()).toBeUndefined();
    expect(store.deactivate()).toBeUndefined();
  });

  it("the database refuses two active profiles, whoever writes them", () => {
    store.activate("octocat");
    expect(() =>
      db.prepare("UPDATE developer_profiles SET active = 1 WHERE subject = 'hubot'").run(),
    ).toThrow();
  });

  it("an active profile from an older battery version is not used", () => {
    store.activate("octocat");
    const next = structuredClone(bundledBattery()) as Battery;
    next.version = "2.4";
    expect(new ProfileStore(db, next).active()).toBeUndefined();
  });

  describe("which profile a review runs as", () => {
    it("the named subject, which must exist", () => {
      store.activate("hubot");
      expect(resolveReviewProfile(store, { subject: "octocat" })?.subject).toBe("octocat");
      expect(() => resolveReviewProfile(store, { subject: "nobody" })).toThrow(
        /no profile for nobody/,
      );
    });

    it("otherwise the active one, with its answers for exemplars", () => {
      expect(resolveReviewProfile(store)).toBeUndefined();
      store.activate("hubot");
      const p = resolveReviewProfile(store);
      expect(p?.subject).toBe("hubot");
      expect(p?.responses).toEqual({ "COG-01": "A" });
    });

    it("or none, when the caller opts out", () => {
      store.activate("hubot");
      expect(resolveReviewProfile(store, { none: true })).toBeUndefined();
    });
  });
});
