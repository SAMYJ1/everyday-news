DROP TRIGGER IF EXISTS record_summary_review_action;

ALTER TABLE summaries
ADD COLUMN publication_reason TEXT NOT NULL DEFAULT '';

UPDATE summaries
SET status = 'approved',
    reviewed_at = COALESCE(reviewed_at, generated_at),
    publication_reason = 'Legacy public card migrated to automatic publishing'
WHERE status = 'draft';

UPDATE summaries
SET publication_reason = 'Legacy reviewed card preserved during automatic publishing migration'
WHERE status = 'approved' AND publication_reason = '';
