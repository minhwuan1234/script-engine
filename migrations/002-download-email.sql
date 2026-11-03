ALTER TABLE submissions ADD COLUMN IF NOT EXISTS download_email text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS download_email_at timestamptz;
