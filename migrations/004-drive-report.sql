ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS drive_file_id text;
ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS drive_view_url text;
ALTER TABLE submission_files ADD COLUMN IF NOT EXISTS drive_sync_requested boolean;
ALTER TABLE submission_files ALTER COLUMN drive_sync_requested SET DEFAULT false;
