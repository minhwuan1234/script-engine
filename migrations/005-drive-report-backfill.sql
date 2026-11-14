WITH applied AS (
  INSERT INTO submission_report_migrations(name)
  VALUES ('clickable-drive-links-backfill')
  ON CONFLICT DO NOTHING
  RETURNING name
), queued_files AS (
  UPDATE submission_files SET drive_sync_requested=true
  WHERE stored AND drive_view_url IS NULL AND drive_sync_requested IS DISTINCT FROM true
    AND EXISTS (SELECT 1 FROM applied)
  RETURNING id
), queued_rows AS (
  UPDATE submissions SET revision=revision+1, sync_attempts=0, sync_error=NULL, next_sync_at=now()
  WHERE EXISTS (SELECT 1 FROM applied)
  RETURNING id
)
SELECT EXISTS (SELECT 1 FROM applied) AS applied,
  (SELECT count(*)::integer FROM queued_files) AS files,
  (SELECT count(*)::integer FROM queued_rows) AS rows;
