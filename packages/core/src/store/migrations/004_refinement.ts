/**
 * Rejection memory for the validation-gated refinement loop.
 *
 * From arXiv:2609.09153: a candidate edit is applied to a copy, scored on a held-out
 * split, and committed only if it does not lose ground. The paper's third contribution is
 * that the REJECTED candidates are kept and fed back as negative evidence, so a refiner
 * stops re-proposing equivalent failing edits — four of its ten rounds committed nothing,
 * which is a lot of wasted rollout to repeat.
 *
 * One row per attempt, accepted or not. `candidate_version_id` is nullable because a
 * candidate that fails structural validation never becomes a version, and that attempt is
 * still worth remembering.
 */
export const up = `
CREATE TABLE IF NOT EXISTS refinement_attempts (
  id                   TEXT PRIMARY KEY,
  playbook_id          TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  from_version_id      TEXT NOT NULL REFERENCES playbook_versions(id) ON DELETE CASCADE,
  candidate_version_id TEXT REFERENCES playbook_versions(id) ON DELETE SET NULL,
  -- What was proposed, so a later round can be told what has already been tried.
  edit_json            TEXT NOT NULL,
  decision             TEXT NOT NULL CHECK (decision IN ('accepted','rejected','invalid')),
  -- Why, in the terms the gate decided on: the per-fixture movement on the held-out half.
  reason               TEXT NOT NULL,
  val_delta_json       TEXT,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refinement_attempts_from
  ON refinement_attempts(playbook_id, from_version_id);
`;
