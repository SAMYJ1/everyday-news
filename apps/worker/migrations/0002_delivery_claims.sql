ALTER TABLE fetch_runs ADD COLUMN discovery_claim_token TEXT;
ALTER TABLE fetch_runs ADD COLUMN discovery_claimed_at TEXT;

CREATE TABLE regeneration_requests (
  id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES fetch_runs(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  delivery_claim_token TEXT,
  delivery_claimed_at TEXT,
  enqueued_at TEXT,
  completed_at TEXT
);

CREATE UNIQUE INDEX idx_regeneration_requests_active_summary
  ON regeneration_requests(summary_id) WHERE completed_at IS NULL;

CREATE TRIGGER record_summary_review_action
AFTER UPDATE OF status ON summaries
WHEN OLD.status != NEW.status AND NEW.status IN ('approved', 'rejected')
BEGIN
  INSERT INTO review_actions (summary_id, action, created_at)
  VALUES (NEW.id, CASE NEW.status WHEN 'approved' THEN 'approve' ELSE 'reject' END, NEW.reviewed_at);
END;
