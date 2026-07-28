CREATE TABLE fetch_runs (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','partial','completed','failed')),
  discovered_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  summarized_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  discovery_completed_at TEXT
);

CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT,
  author TEXT,
  reddit_url TEXT NOT NULL,
  source_url TEXT,
  score INTEGER NOT NULL,
  upvote_ratio REAL,
  comment_count INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(source, external_id)
);

CREATE TABLE source_comments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  parent_external_id TEXT,
  author TEXT,
  body TEXT,
  score INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  reddit_url TEXT NOT NULL,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(item_id, external_id)
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES fetch_runs(id) ON DELETE CASCADE,
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

CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
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

CREATE TABLE review_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('approve','reject','regenerate')),
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_source_items_published_at
  ON source_items(published_at DESC);

CREATE INDEX idx_source_items_last_checked_at
  ON source_items(last_checked_at);

CREATE INDEX idx_candidates_run_status_rank
  ON candidates(run_id, status, rank);

CREATE INDEX idx_summaries_review_status
  ON summaries(status, reviewed_at);
