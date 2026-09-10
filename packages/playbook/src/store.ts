import { newId, type SqlDatabase } from "@maestro/core";
import { defaultPlaybook } from "./default-playbook.js";
import {
  PLAYBOOK_SCHEMA_VERSION,
  type PlaybookDocument,
  PlaybookDocumentSchema,
} from "./schema.js";
import { parsePlaybook } from "./validate.js";

export interface PlaybookVersionRecord {
  id: string;
  playbookId: string;
  version: number;
  schemaVersion: number;
  doc: PlaybookDocument;
  notes?: string;
  createdAt: string;
}

interface VersionRow {
  id: string;
  playbook_id: string;
  version: number;
  schema_version: number;
  document: string;
  notes: string | null;
  created_at: string;
}

/**
 * Reads a stored version, filling in fields that did not exist when it was written.
 *
 * Versions are immutable, so a document stored before a schema field was added never
 * gains it — and this used to be `JSON.parse(...) as PlaybookDocument`, a bare cast
 * asserting that yesterday's JSON matches today's type. That assertion is false the
 * moment a field is added: adding `envSpec.compareCommands` made `maestro doctor` crash
 * on every pre-existing install, iterating a property that was undefined.
 *
 * Parsing through the schema applies each field's default instead, which is what the
 * defaults are for. A document that cannot be parsed at all is returned as it was found:
 * old versions must stay readable for trace inspection even after the schema moves on,
 * and refusing to hydrate one would make past reviews unexplainable — which is the thing
 * immutable versions exist to guarantee.
 */
function hydrate(row: VersionRow): PlaybookVersionRecord {
  const raw = JSON.parse(row.document) as PlaybookDocument;
  const parsed = PlaybookDocumentSchema.safeParse(raw);
  return {
    id: row.id,
    playbookId: row.playbook_id,
    version: row.version,
    schemaVersion: row.schema_version,
    doc: parsed.success ? parsed.data : raw,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Versions are immutable and the active pointer moves. Reviews pin a version id at
 * creation, so publishing never disturbs work in flight and every past finding stays
 * explainable.
 */
export class PlaybookStore {
  constructor(private readonly db: SqlDatabase) {}

  publish(
    doc: PlaybookDocument,
    opts: { name?: string; notes?: string; activate?: boolean } = {},
  ): PlaybookVersionRecord {
    const validated = parsePlaybook(doc);
    const name = opts.name ?? validated.name;
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      let pb = this.db.prepare("SELECT id FROM playbooks WHERE name=?").get<{ id: string }>(name);
      if (!pb) {
        const id = newId("pb");
        this.db
          .prepare("INSERT INTO playbooks (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .run(id, name, now, now);
        pb = { id };
      }

      const max = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) as v FROM playbook_versions WHERE playbook_id=?")
        .get<{ v: number }>(pb.id);
      const version = (max?.v ?? 0) + 1;
      const versionId = newId("pv");

      this.db
        .prepare(
          `INSERT INTO playbook_versions (id, playbook_id, version, schema_version, document, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          pb.id,
          version,
          PLAYBOOK_SCHEMA_VERSION,
          JSON.stringify(validated),
          opts.notes ?? null,
          now,
        );

      if (opts.activate !== false) {
        this.db
          .prepare("UPDATE playbooks SET active_version_id=?, updated_at=? WHERE id=?")
          .run(versionId, now, pb.id);
      }

      return {
        id: versionId,
        playbookId: pb.id,
        version,
        schemaVersion: PLAYBOOK_SCHEMA_VERSION,
        doc: validated,
        notes: opts.notes,
        createdAt: now,
      };
    });
  }

  getVersion(versionId: string): PlaybookVersionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM playbook_versions WHERE id=?")
      .get<VersionRow>(versionId);
    return row ? hydrate(row) : null;
  }

  getActive(name = "default"): PlaybookVersionRecord | null {
    const row = this.db
      .prepare(
        `SELECT v.* FROM playbook_versions v
         JOIN playbooks p ON p.active_version_id = v.id
         WHERE p.name = ?`,
      )
      .get<VersionRow>(name);
    return row ? hydrate(row) : null;
  }

  /**
   * Points a repository at a named playbook, or back at the global default.
   *
   * `repos.playbook_id` has been in the schema since the first migration and
   * `resolveForRepo` has read it since the daemon learned to, and nothing anywhere could
   * write it — so per-repo assignment was a documented capability with no way to use it.
   * A mobile repo and a backend repo wanting different personas is the reason the column
   * exists; since the router's `automaticTriggers` also lives in the playbook, it is also
   * the only way one repository reviews on demand while another reviews everything.
   *
   * Returns false when the playbook does not exist, so a typo does not silently assign
   * nothing.
   */
  assignToRepo(repoId: string, playbookName: string | null): boolean {
    if (playbookName === null) {
      this.db.prepare("UPDATE repos SET playbook_id=NULL WHERE id=?").run(repoId);
      return true;
    }
    const pb = this.db
      .prepare("SELECT id FROM playbooks WHERE name=?")
      .get<{ id: string }>(playbookName);
    if (!pb) return false;
    this.db.prepare("UPDATE repos SET playbook_id=? WHERE id=?").run(pb.id, repoId);
    return true;
  }

  /** Which playbook a repository is assigned, or null when it follows the global default. */
  assignmentFor(repoId: string): string | null {
    return (
      this.db
        .prepare("SELECT p.name FROM repos r JOIN playbooks p ON p.id=r.playbook_id WHERE r.id=?")
        .get<{ name: string }>(repoId)?.name ?? null
    );
  }

  /** Resolves the playbook a repo should use: its own assignment, else the global default. */
  resolveForRepo(repoId: string): PlaybookVersionRecord | null {
    const row = this.db
      .prepare(
        `SELECT v.* FROM repos r
         JOIN playbooks p ON p.id = r.playbook_id
         JOIN playbook_versions v ON v.id = p.active_version_id
         WHERE r.id = ?`,
      )
      .get<VersionRow>(repoId);
    return row ? hydrate(row) : this.getActive("default");
  }

  listVersions(name = "default"): PlaybookVersionRecord[] {
    return this.db
      .prepare(
        `SELECT v.* FROM playbook_versions v JOIN playbooks p ON p.id = v.playbook_id
         WHERE p.name = ? ORDER BY v.version DESC`,
      )
      .all<VersionRow>(name)
      .map(hydrate);
  }

  activate(versionId: string): void {
    const row = this.db
      .prepare("SELECT playbook_id FROM playbook_versions WHERE id=?")
      .get<{ playbook_id: string }>(versionId);
    if (!row) throw new Error(`unknown playbook version: ${versionId}`);
    this.db
      .prepare("UPDATE playbooks SET active_version_id=?, updated_at=? WHERE id=?")
      .run(versionId, new Date().toISOString(), row.playbook_id);
  }

  /** Idempotent: seeds the shipped template on first run only. */
  ensureDefault(): PlaybookVersionRecord {
    return (
      this.getActive("default") ??
      this.publish(defaultPlaybook(), { name: "default", notes: "shipped default" })
    );
  }
}
