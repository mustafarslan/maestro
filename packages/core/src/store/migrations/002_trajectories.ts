export const up = /* sql */ `
-- ── Agent trajectories ───────────────────────────────────────────────────────
-- What an agent actually did, turn by turn.
--
-- Until this table existed, an agent run left behind its cost and nothing else:
-- llm_calls records one row per model step with token counts and a finish reason,
-- and tasks.output_json records a *count* of findings. Neither can answer the
-- question people actually ask of a review — "why did this agent submit nothing" —
-- because the messages that would answer it reached the engine inside LoopResult
-- and were dropped on the floor.
--
-- One row per turn rather than per step: a step is one model call, but a turn is
-- what a reader follows — the prompt, the assistant's text and tool calls, the tool
-- results that came back. seq orders them; step ties a turn to its
-- llm_calls row and is NULL for the opening prompts, which precede every call.
--
-- Written from LoopStep rather than from LoopResult.messages, because
-- trimHistory splices old turns out of that array in place to fit the context
-- window, and truncates oversized tool outputs in place. The steps keep what the
-- messages lose, and hold their own copy of the results so that truncation cannot
-- reach them.
--
-- Content is repository text the agent read. That crosses no new boundary — findings
-- already quote it as evidence, and the analyze sandbox runs with secrets: none,
-- so there is no credential in a tool result to leak here. It is bulk, though, which
-- is why pruneTelemetry deletes it alongside spans and llm_calls.
CREATE TABLE trajectory_turns (
  id           TEXT PRIMARY KEY,
  review_id    TEXT REFERENCES reviews(id) ON DELETE CASCADE,
  task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,   -- order within the run
  step         INTEGER,            -- model step index; NULL for the opening prompts
  role         TEXT NOT NULL,      -- system | user | assistant | tool
  content_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE INDEX idx_trajectory_turns_task ON trajectory_turns(task_id, seq);
CREATE INDEX idx_trajectory_turns_review ON trajectory_turns(review_id, seq);
`;
