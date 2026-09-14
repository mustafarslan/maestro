/**
 * Developer cognitive profiles, scored from the calibration battery.
 *
 * One row per person per battery version. A questionnaire is answered over several sittings,
 * so `responses_json` is the running sheet and `profile_json` is what it scored to at
 * `updated_at` — a prior, to be updated later from what the person actually does in review.
 *
 * Keyed by version as well as subject because a profile is only meaningful against the
 * instrument that produced it: a later battery can move an item between attributes, and a
 * sheet answered against 2.1 scored as 2.2 would be a number about nothing.
 *
 * `subject` is compared case-insensitively. It is usually a GitHub login, and GitHub treats
 * `Octocat` and `octocat` as one account.
 *
 * Frozen as first applied: databases already carry this version, and a migration that has run
 * is never run again. Everything added after that lives in 006.
 */
export const up = `
CREATE TABLE IF NOT EXISTS developer_profiles (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL COLLATE NOCASE,
  battery_version TEXT NOT NULL,
  responses_json  TEXT NOT NULL,
  profile_json    TEXT NOT NULL,
  answered        INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (subject, battery_version)
);
`;
