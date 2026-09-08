export const up = /* sql */ `
-- ── Configuration as data ────────────────────────────────────────────────────
-- A playbook is the whole review pipeline. Versions are IMMUTABLE; the active
-- pointer moves. Reviews pin a version at creation so publishing never disturbs
-- work in flight and every past finding stays explainable.
CREATE TABLE playbooks (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  active_version_id TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE playbook_versions (
  id             TEXT PRIMARY KEY,
  playbook_id    TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  document       TEXT NOT NULL,          -- JSON: graph, agents, router, triage, envSpec
  notes          TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (playbook_id, version)
);

-- ── GitHub surface ───────────────────────────────────────────────────────────
CREATE TABLE installations (
  id              TEXT PRIMARY KEY,
  github_id       INTEGER NOT NULL UNIQUE,
  account_login   TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE repos (
  id              TEXT PRIMARY KEY,
  installation_id TEXT REFERENCES installations(id) ON DELETE SET NULL,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  playbook_id     TEXT REFERENCES playbooks(id) ON DELETE SET NULL, -- NULL => global default
  enabled         INTEGER NOT NULL DEFAULT 1,
  config_json     TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (owner, name)
);

-- ── Reviews ──────────────────────────────────────────────────────────────────
-- The unique key is the idempotency key: it absorbs webhook redelivery and the
-- overlap between webhook and poll mode.
CREATE TABLE reviews (
  id                  TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number           INTEGER NOT NULL,
  head_sha            TEXT NOT NULL,
  base_sha            TEXT,
  base_ref            TEXT,
  title               TEXT,
  author              TEXT,
  is_fork             INTEGER NOT NULL DEFAULT 0,
  trust               TEXT NOT NULL DEFAULT 'trusted',   -- trusted | untrusted
  playbook_version_id TEXT NOT NULL REFERENCES playbook_versions(id),
  state               TEXT NOT NULL,  -- queued|preparing|analyzing|triaging|posting|done|failed|cancelled|superseded
  error               TEXT,
  cost_cents          REAL NOT NULL DEFAULT 0,
  linear_issue_json   TEXT,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  finished_at         TEXT,
  UNIQUE (repo_id, pr_number, head_sha)
);
CREATE INDEX idx_reviews_state ON reviews(state);
CREATE INDEX idx_reviews_repo_pr ON reviews(repo_id, pr_number);

-- ── Tasks: one row per executed graph node ───────────────────────────────────
-- lease_until is the crash-recovery mechanism: an expired lease is requeued.
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,   -- prepare-env|router|agent|gate|triage|post
  agent_id     TEXT,
  state        TEXT NOT NULL,   -- pending|ready|running|done|failed|skipped|cancelled
  attempt      INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_until  TEXT,
  worker_id    TEXT,
  input_json   TEXT,
  output_json  TEXT,
  error        TEXT,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  cost_cents   REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  UNIQUE (review_id, node_id)
);
CREATE INDEX idx_tasks_state ON tasks(state);
CREATE INDEX idx_tasks_review ON tasks(review_id);

CREATE TABLE task_deps (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on)
);

-- ── Environments: the stateful resource. Every row carries a lease + TTL,
-- which is what stops containers and snapshot images leaking on a crash.
CREATE TABLE environments (
  id           TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,   -- prepare | analyze
  agent_id     TEXT,
  container_id TEXT,
  image_id     TEXT,
  volume_ids   TEXT,            -- JSON array
  workdir      TEXT,
  state        TEXT NOT NULL,   -- creating|ready|running|destroying|destroyed|leaked
  spec_json    TEXT NOT NULL,
  lease_until  TEXT,
  ttl_at       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  destroyed_at TEXT
);
CREATE INDEX idx_env_state ON environments(state);
CREATE INDEX idx_env_ttl ON environments(ttl_at);

-- ── Findings ─────────────────────────────────────────────────────────────────
CREATE TABLE findings (
  id                TEXT PRIMARY KEY,
  review_id         TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  task_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id          TEXT NOT NULL,
  file              TEXT,
  line_start        INTEGER,
  line_end          INTEGER,
  category          TEXT NOT NULL,
  severity          TEXT NOT NULL,   -- critical|high|medium|low|info
  confidence        REAL NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  evidence_json     TEXT,
  dedupe_group      TEXT,
  agreement_count   INTEGER NOT NULL DEFAULT 1,
  suppressed_reason TEXT,
  posted_comment_id TEXT,
  status            TEXT NOT NULL DEFAULT 'open', -- open|posted|suppressed|dismissed|accepted
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_findings_review ON findings(review_id);

CREATE TABLE feedback (
  id          TEXT PRIMARY KEY,
  finding_id  TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  signal      TEXT NOT NULL,   -- thumbs_up|thumbs_down|resolved|line_changed
  actor       TEXT,
  created_at  TEXT NOT NULL
);

-- ── Providers & models ───────────────────────────────────────────────────────
-- Key MATERIAL never lands here: only a reference to keychain/0600 storage.
CREATE TABLE provider_configs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,  -- anthropic|openai|gemini|openai-compatible
  base_url      TEXT,
  key_ref       TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE model_catalog (
  provider_id       TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model             TEXT NOT NULL,
  display_name      TEXT,
  capabilities_json TEXT NOT NULL,
  input_cost_per_mtok  REAL,
  output_cost_per_mtok REAL,
  fetched_at        TEXT NOT NULL,
  PRIMARY KEY (provider_id, model)
);

-- ── Observability ────────────────────────────────────────────────────────────
CREATE TABLE spans (
  id          TEXT PRIMARY KEY,
  review_id   TEXT REFERENCES reviews(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  parent_id   TEXT,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok',
  attrs_json  TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  duration_ms INTEGER
);
CREATE INDEX idx_spans_review ON spans(review_id, started_at);

CREATE TABLE llm_calls (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  review_id     TEXT REFERENCES reviews(id) ON DELETE CASCADE,
  provider_id   TEXT NOT NULL,
  model         TEXT NOT NULL,
  step          INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  cost_cents    REAL NOT NULL DEFAULT 0,
  latency_ms    INTEGER,
  finish_reason TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_llm_calls_review ON llm_calls(review_id);

-- ── Queue ────────────────────────────────────────────────────────────────────
-- Claim-in-transaction under BEGIN IMMEDIATE. On single-host SQLite there is one
-- writer by definition, so this is correct without SKIP LOCKED; the Postgres
-- driver swaps that in later.
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  dedupe_key    TEXT UNIQUE,
  priority      INTEGER NOT NULL DEFAULT 0,
  run_after     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  locked_by     TEXT,
  locked_until  TEXT,
  last_error    TEXT,
  state         TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_jobs_claim ON jobs(state, run_after, priority DESC);
`;
