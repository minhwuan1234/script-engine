CREATE TABLE IF NOT EXISTS submissions (
  id uuid PRIMARY KEY,
  report_row bigint GENERATED ALWAYS AS IDENTITY (START WITH 2) UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  input_text text NOT NULL,
  duration text NOT NULL,
  level text NOT NULL,
  status text NOT NULL DEFAULT 'storing',
  revision integer NOT NULL DEFAULT 1,
  synced_revision integer NOT NULL DEFAULT 0,
  sync_attempts integer NOT NULL DEFAULT 0,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  sync_error text,
  result jsonb
);
CREATE TABLE IF NOT EXISTS submission_files (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  original_name text NOT NULL,
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  stored boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS submission_sync_pending ON submissions(next_sync_at)
  WHERE revision > synced_revision;
CREATE INDEX IF NOT EXISTS submission_created ON submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS submission_files_parent ON submission_files(submission_id);
