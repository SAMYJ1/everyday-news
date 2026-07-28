PRAGMA defer_foreign_keys = ON;

CREATE TABLE new_fetch_runs (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','partial','completed','failed')),
  discovered_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  summarized_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  discovery_completed_at TEXT,
  discovery_claim_token TEXT,
  discovery_claimed_at TEXT
);

CREATE TABLE new_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES new_fetch_runs(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  reasons TEXT NOT NULL,
  rank INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('selected','comments_ready','summarizing','summarized','failed')
  ),
  selected_at TEXT NOT NULL,
  summary_claimed_at TEXT,
  summary_claim_token TEXT UNIQUE,
  UNIQUE(run_id, item_id),
  UNIQUE(run_id, rank)
);

CREATE TABLE new_summaries (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES new_candidates(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('draft','approved','rejected','failed','source_deleted')
  ),
  title_zh TEXT NOT NULL,
  one_line_fact TEXT NOT NULL,
  why_interesting TEXT NOT NULL,
  comment_insights TEXT NOT NULL,
  caveats TEXT NOT NULL,
  confidence_note TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE(candidate_id, prompt_version, input_hash)
);

CREATE TABLE new_review_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_id TEXT NOT NULL REFERENCES new_summaries(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('approve','reject','regenerate')),
  created_at TEXT NOT NULL
);

CREATE TABLE new_regeneration_requests (
  id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL REFERENCES new_summaries(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES new_candidates(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES new_fetch_runs(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  delivery_claim_token TEXT,
  delivery_claimed_at TEXT,
  enqueued_at TEXT,
  completed_at TEXT
);

INSERT INTO new_fetch_runs (
  id, local_date, status, discovered_count, selected_count, summarized_count,
  error_code, error_message, started_at, finished_at, discovery_completed_at,
  discovery_claim_token, discovery_claimed_at
)
SELECT
  id, local_date, status, discovered_count, selected_count, summarized_count,
  error_code, error_message, started_at, finished_at, discovery_completed_at,
  discovery_claim_token, discovery_claimed_at
FROM fetch_runs;

INSERT INTO new_candidates (
  id, run_id, item_id, score, reasons, rank, status, selected_at,
  summary_claimed_at, summary_claim_token
)
SELECT
  id, run_id, item_id, score, reasons, rank, status, selected_at,
  summary_claimed_at, summary_claim_token
FROM candidates;

INSERT INTO new_summaries (
  id, candidate_id, status, title_zh, one_line_fact, why_interesting,
  comment_insights, caveats, confidence_note, model, prompt_version,
  input_hash, generated_at, reviewed_at
)
SELECT
  id, candidate_id, status, title_zh, one_line_fact, why_interesting,
  comment_insights, caveats, confidence_note, model, prompt_version,
  input_hash, generated_at, reviewed_at
FROM summaries;

INSERT INTO new_review_actions (id, summary_id, action, created_at)
SELECT id, summary_id, action, created_at
FROM review_actions;

INSERT INTO new_regeneration_requests (
  id, summary_id, candidate_id, run_id, item_id, nonce, created_at,
  delivery_claim_token, delivery_claimed_at, enqueued_at, completed_at
)
SELECT
  id, summary_id, candidate_id, run_id, item_id, nonce, created_at,
  delivery_claim_token, delivery_claimed_at, enqueued_at, completed_at
FROM regeneration_requests;

DROP TABLE review_actions;
DROP TABLE regeneration_requests;
DROP TABLE summaries;
DROP TABLE candidates;
DROP TABLE fetch_runs;

ALTER TABLE new_fetch_runs RENAME TO fetch_runs;
ALTER TABLE new_candidates RENAME TO candidates;
ALTER TABLE new_summaries RENAME TO summaries;
ALTER TABLE new_review_actions RENAME TO review_actions;
ALTER TABLE new_regeneration_requests RENAME TO regeneration_requests;

CREATE INDEX idx_fetch_runs_local_date_started
  ON fetch_runs(local_date, started_at DESC);

CREATE UNIQUE INDEX idx_fetch_runs_one_active_local_date
  ON fetch_runs(local_date)
  WHERE status IN ('queued', 'running');

CREATE INDEX idx_candidates_run_status_rank
  ON candidates(run_id, status, rank);

CREATE INDEX idx_summaries_review_status
  ON summaries(status, reviewed_at);

CREATE UNIQUE INDEX idx_regeneration_requests_active_summary
  ON regeneration_requests(summary_id) WHERE completed_at IS NULL;

CREATE TRIGGER record_summary_review_action
AFTER UPDATE OF status ON summaries
WHEN OLD.status != NEW.status AND NEW.status IN ('approved', 'rejected')
BEGIN
  INSERT INTO review_actions (summary_id, action, created_at)
  VALUES (NEW.id, CASE NEW.status WHEN 'approved' THEN 'approve' ELSE 'reject' END, NEW.reviewed_at);
END;

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = OFF;
