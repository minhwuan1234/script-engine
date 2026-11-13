ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS hubspot_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS hubspot_claim uuid,
  ADD COLUMN IF NOT EXISTS hubspot_retry_at timestamptz;
