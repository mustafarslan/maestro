import { newId, type SqlDatabase } from "@maestro/core";
import { type Battery, bundledBattery, LIKERT_ANCHORS } from "./battery.js";
import { type DeveloperCognitiveProfile, type Responses, scoreBattery } from "./score.js";

/**
 * Where a person's answers and the profile they score to are kept.
 *
 * Answers MERGE into the sheet already saved, so the questionnaire can be answered over
 * several sittings, and every write re-scores the whole sheet. Storing only the profile
 * would make a later scorer fix unrecoverable; storing only the answers would make every
 * reader re-score. Both are kept, and the answers are the source.
 *
 * A write is refused, whole, if any answer names an item the battery does not have or a
 * label the item does not offer. The scorer tolerates both, because a sheet from elsewhere
 * should still score; a sheet this store wrote should never need to.
 */

export interface StoredProfile {
  id: string;
  subject: string;
  batteryVersion: string;
  responses: Responses;
  profile: DeveloperCognitiveProfile;
  answered: number;
  /** Whether reviews run as this profile when none is named. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  subject: string;
  battery_version: string;
  responses_json: string;
  profile_json: string;
  answered: number;
  active: number;
  created_at: string;
  updated_at: string;
}

const fromRow = (r: Row): StoredProfile => ({
  id: r.id,
  subject: r.subject,
  batteryVersion: r.battery_version,
  responses: JSON.parse(r.responses_json) as Responses,
  profile: JSON.parse(r.profile_json) as DeveloperCognitiveProfile,
  answered: r.answered,
  active: r.active === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Every reason these answers cannot be saved against this battery. */
export function answerProblems(battery: Battery, answers: Responses): string[] {
  const byId = new Map(battery.items.map((i) => [i.id, i]));
  const problems: string[] = [];
  for (const [itemId, label] of Object.entries(answers)) {
    const item = byId.get(itemId);
    if (!item) {
      problems.push(`${itemId}: no such item in battery ${battery.version}`);
      continue;
    }
    const offered =
      item.format === "likert_5" ? [...LIKERT_ANCHORS] : item.options.map((o) => o.label);
    if (!offered.includes(label)) {
      problems.push(`${itemId}: '${label}' is not one of ${offered.join(", ")}`);
    }
  }
  return problems;
}

export class ProfileStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly battery: Battery = bundledBattery(),
  ) {}

  /** This subject's profile against the store's battery version, if they have begun one. */
  get(subject: string): StoredProfile | undefined {
    const row = this.db
      .prepare("SELECT * FROM developer_profiles WHERE subject = ? AND battery_version = ?")
      .get<Row>(subject, this.battery.version);
    return row ? fromRow(row) : undefined;
  }

  /**
   * Merges answers into the subject's sheet and re-scores it.
   *
   * `replace` discards the saved sheet first, for someone starting over.
   */
  record(subject: string, answers: Responses, opts: { replace?: boolean } = {}): StoredProfile {
    const name = subject.trim();
    if (!name) throw new Error("a profile needs a subject: a GitHub login or a name");
    const problems = answerProblems(this.battery, answers);
    if (problems.length) {
      throw new Error(`answers not saved:\n  ${problems.join("\n  ")}`);
    }

    const existing = this.get(name);
    const responses: Responses = { ...(opts.replace ? {} : existing?.responses), ...answers };
    return this.write(name, existing, responses);
  }

  /** Removes answers, so an item can be asked again. All of them when `itemIds` is omitted. */
  forget(subject: string, itemIds?: string[]): StoredProfile | undefined {
    const existing = this.get(subject);
    if (!existing) return undefined;
    const responses = itemIds
      ? Object.fromEntries(
          Object.entries(existing.responses).filter(([id]) => !itemIds.includes(id)),
        )
      : {};
    return this.write(existing.subject, existing, responses);
  }

  /**
   * The profile reviews run as when none is named, if one is active against this battery.
   *
   * A profile activated under an older battery version is not returned: it was scored by a
   * different instrument, and silently gating reviews with it would be gating with nothing.
   */
  active(): StoredProfile | undefined {
    const row = this.db
      .prepare("SELECT * FROM developer_profiles WHERE active = 1 AND battery_version = ?")
      .get<Row>(this.battery.version);
    return row ? fromRow(row) : undefined;
  }

  /** Makes this subject's profile the one reviews run as, and every other profile inactive. */
  activate(subject: string): StoredProfile {
    const existing = this.get(subject);
    if (!existing) {
      throw new Error(
        `no profile for ${subject} against battery ${this.battery.version}. Start one: maestro profile take --subject ${subject}`,
      );
    }
    this.db.transaction(() => {
      this.db.prepare("UPDATE developer_profiles SET active = 0 WHERE active = 1").run();
      this.db.prepare("UPDATE developer_profiles SET active = 1 WHERE id = ?").run(existing.id);
    });
    return this.get(subject) as StoredProfile;
  }

  /** No profile is active afterwards. Returns whose was, if anyone's. */
  deactivate(): string | undefined {
    const was = this.db
      .prepare("SELECT subject FROM developer_profiles WHERE active = 1")
      .get<{ subject: string }>();
    this.db.prepare("UPDATE developer_profiles SET active = 0 WHERE active = 1").run();
    return was?.subject;
  }

  /** Everyone with a profile against this battery version, most recently updated first. */
  list(): Omit<StoredProfile, "responses" | "profile">[] {
    return this.db
      .prepare(
        `SELECT * FROM developer_profiles WHERE battery_version = ?
          ORDER BY updated_at DESC, rowid DESC`,
      )
      .all<Row>(this.battery.version)
      .map((r) => {
        const { responses: _r, profile: _p, ...rest } = fromRow(r);
        return rest;
      });
  }

  private write(
    subject: string,
    existing: StoredProfile | undefined,
    responses: Responses,
  ): StoredProfile {
    const profile = scoreBattery(this.battery, responses);
    const now = new Date().toISOString();
    const answered = profile.coverage.itemsAnswered;

    if (existing) {
      this.db
        .prepare(
          `UPDATE developer_profiles
              SET responses_json = ?, profile_json = ?, answered = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(JSON.stringify(responses), JSON.stringify(profile), answered, now, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO developer_profiles
             (id, subject, battery_version, responses_json, profile_json, answered, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          newId("dp"),
          subject,
          this.battery.version,
          JSON.stringify(responses),
          JSON.stringify(profile),
          answered,
          now,
          now,
        );
    }
    const saved = this.get(subject);
    if (!saved) throw new Error(`profile for ${subject} was written and could not be read back`);
    return saved;
  }
}

/**
 * Which profile a review runs as.
 *
 * A subject named explicitly wins, and must exist: a review asked for as someone and run as no
 * one would read as their judgement while being nobody's. Otherwise the active profile, unless
 * the caller opted out. The shape is what the engine's triage takes.
 */
export function resolveReviewProfile(
  store: ProfileStore,
  opts: { subject?: string; none?: boolean } = {},
): { subject: string; profile: DeveloperCognitiveProfile; responses: Responses } | undefined {
  if (opts.none) return undefined;
  const stored = opts.subject ? store.get(opts.subject) : store.active();
  if (opts.subject && !stored) {
    throw new Error(
      `no profile for ${opts.subject}. Start one: maestro profile take --subject ${opts.subject}`,
    );
  }
  return stored
    ? { subject: stored.subject, profile: stored.profile, responses: stored.responses }
    : undefined;
}
