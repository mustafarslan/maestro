import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "./db.js";

let home: string;
const original = process.env.MAESTRO_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "maestro-perms-"));
  process.env.MAESTRO_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (original === undefined) delete process.env.MAESTRO_HOME;
  else process.env.MAESTRO_HOME = original;
});

const mode = (p: string) => statSync(p).mode & 0o777;

describe("store file permissions", () => {
  it("creates a database only its owner can read", async () => {
    // SQLite uses the process umask, which is 0644 on a normal system. The file holds
    // every review: pull request titles, diff summaries, findings and provider config,
    // all from private repositories — readable by every local account on a shared host,
    // from a tool whose whole job is looking at code people did not publish.
    const db = await openStore();
    try {
      expect(mode(join(home, "maestro.db"))).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it("tightens a home directory that already existed with looser permissions", async () => {
    // mkdirSync's mode applies only when it creates the directory, so an upgrade from an
    // earlier version — or a hand-made ~/.maestro — kept whatever mode it had.
    chmodSync(home, 0o755);
    const db = await openStore();
    try {
      expect(mode(home)).toBe(0o700);
    } finally {
      db.close();
    }
  });

  it("restricts the write-ahead log too, which holds the same content", async () => {
    const db = await openStore();
    try {
      db.prepare(
        "INSERT INTO playbooks (id, name, created_at, updated_at) VALUES ('p','n',datetime('now'),datetime('now'))",
      ).run();
      // The -wal file only exists once something has been written through it.
      const wal = join(home, "maestro.db-wal");
      const reopened = await openStore();
      reopened.close();
      const { existsSync } = await import("node:fs");
      if (existsSync(wal)) expect(mode(wal)).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it("does not fail when the store is in memory", async () => {
    // The tests and the MCP server both open :memory:; chmod on that path would throw.
    const db = await openStore({ path: ":memory:" });
    expect(db).toBeDefined();
    db.close();
  });
});
