/**
 * What reviews need from a developer profile, added after 005 had already been applied.
 *
 * `active` marks the profile reviews run as when none is named. At most one, enforced by the
 * database rather than by every writer remembering to clear the others.
 *
 * `findings.personalization_json` keeps what the profile decided about each finding beside the
 * diagnosis, and `reviews.profile_subject` whose profile it was: the battery's behavioural
 * indicators exist to be correlated against what people then do with a review, which needs both.
 */
export const up = `
ALTER TABLE developer_profiles ADD COLUMN active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1));

CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_profiles_one_active
  ON developer_profiles(active) WHERE active = 1;

ALTER TABLE findings ADD COLUMN personalization_json TEXT;
ALTER TABLE reviews ADD COLUMN profile_subject TEXT;
-- The review state Maestro last set on GitHub for this review: REQUEST_CHANGES or COMMENT, NULL
-- when it set none. A later round without a profile reads it to lift a block it placed.
ALTER TABLE reviews ADD COLUMN posted_state TEXT;
`;
