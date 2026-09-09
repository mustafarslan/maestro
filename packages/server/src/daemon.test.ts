import { openStore, type SqlDatabase } from "@maestro/core";
import { PlaybookStore } from "@maestro/playbook";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningDaemon, startDaemon } from "./daemon.js";

let db: SqlDatabase;
let running: RunningDaemon | undefined;

beforeEach(async () => {
  db = await openStore({ path: ":memory:" });
  new PlaybookStore(db).ensureDefault();
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
  db.close();
});

describe("the webhook listener's secret", () => {
  it("refuses to start without one", async () => {
    // It binds 0.0.0.0 by necessity — GitHub has to reach it — and without a secret it
    // accepted every delivery from anyone, each of which starts a review that spawns
    // containers. A log warning was the only mitigation, which is warning about
    // something and then doing it anyway.
    await expect(startDaemon({ db, webhookPort: 0 })).rejects.toThrow(/secret/i);
  });

  it("says how to fix it, including the environment variable", async () => {
    // An error that names the flag but not the variable sends a Compose user looking in
    // the wrong place.
    await expect(startDaemon({ db, webhookPort: 0 })).rejects.toThrow(/GITHUB_WEBHOOK_SECRET/);
  });

  it("points at --poll, which needs no listener at all", async () => {
    await expect(startDaemon({ db, webhookPort: 0 })).rejects.toThrow(/--poll/);
  });

  it("starts when a secret is supplied", async () => {
    running = await startDaemon({ db, webhookPort: 0, webhookSecret: "s3cret" });
    expect(running.webhookPort).toBeGreaterThan(0);
  });

  it("leaves the admin-only daemon alone, which exposes no public listener", async () => {
    // No webhook port means no unauthenticated surface, so no secret is required.
    running = await startDaemon({ db, adminPort: 0 });
    expect(running.webhookPort).toBeUndefined();
    expect(running.adminToken).toBeTruthy();
  });
});
