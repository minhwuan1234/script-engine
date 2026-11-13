import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const ALLOWED_UPLOADS = ['pdf', 'docx', 'pptx', 'txt', 'md'];
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

export function validateSubmission(text, files) {
  if (!text.trim() && !files.length) throw badRequest('Provide text or a file.');
  if (files.length > 3) throw badRequest('Upload at most 3 files per submission.');
  if (Buffer.byteLength(text) + files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('Upload too large (max 25 MB).'), { status: 413 });
  }
  for (const file of files) {
    if (!ALLOWED_UPLOADS.includes(file.name.split('.').pop().toLowerCase())) {
      throw badRequest('Supported files: PDF, DOCX, PPTX, TXT, MD.');
    }
  }
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function createSubmissionStore({ pool, objects, driveEnabled = false }) {
  return {
    pool,
    async migrate() {
      const sql = await readFile(new URL('./migrations/001-submissions.sql', import.meta.url), 'utf8');
      const downloadSql = await readFile(new URL('./migrations/002-download-email.sql', import.meta.url), 'utf8');
      const hubspotSql = await readFile(new URL('./migrations/003-hubspot-download.sql', import.meta.url), 'utf8');
      const driveSql = await readFile(new URL('./migrations/004-drive-report.sql', import.meta.url), 'utf8');
      await transaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(76432001)');
        await client.query(sql);
        await client.query(downloadSql);
        await client.query(hubspotSql);
        await client.query(driveSql);
      });
    },
    async save({ text, files, duration, level }) {
      validateSubmission(text, files);
      const id = crypto.randomUUID();
      const day = new Date().toISOString().slice(0, 10);
      const items = files.map((file) => {
        const fileId = crypto.randomUUID();
        return { id: fileId, file, key: `submissions/${day}/${id}/${fileId}` };
      });
      // Commit an audit record first. Crashes during object uploads remain visible
      // as "storing" and are reconciled by the worker instead of disappearing.
      await transaction(pool, async (client) => {
        await client.query('INSERT INTO submissions(id,input_text,duration,level) VALUES($1,$2,$3,$4)',
          [id, text, duration, level]);
        for (const item of items) {
          item.bytes = Buffer.from(await item.file.arrayBuffer());
          await client.query(`INSERT INTO submission_files
            (id,submission_id,original_name,object_key,mime_type,size_bytes,sha256,drive_sync_requested)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [item.id, id, item.file.name, item.key,
            item.file.type || 'application/octet-stream', item.bytes.length,
            crypto.createHash('sha256').update(item.bytes).digest('hex'), driveEnabled]);
        }
      });
      try {
        for (const item of items) {
          await objects.put(item.key, item.bytes, item.file.type || 'application/octet-stream');
          await pool.query('UPDATE submission_files SET stored=true WHERE id=$1', [item.id]);
          item.bytes = null;
        }
        await this.finish(id, 'processing');
        return id;
      } catch {
        await this.finish(id, 'archive_failed');
        throw Object.assign(new Error('Could not archive uploaded files. Please retry.'), { status: 503 });
      }
    },
    async finish(id, status, result = null) {
      await pool.query(`UPDATE submissions SET status=$2,
        result=CASE WHEN $3::jsonb IS NULL THEN result ELSE COALESCE(result,'{}'::jsonb)||$3::jsonb END,updated_at=now(),
        revision=revision+1,next_sync_at=now(),sync_attempts=0,sync_error=NULL WHERE id=$1`,
      [id, status, result ? JSON.stringify(result) : null]);
    },
    async saveVersion(id, letter, version) {
      if (!['A', 'B'].includes(letter) || !version?.text?.trim()) throw new Error('Invalid completed version.');
      const key = letter.toLowerCase();
      const patch = { [`version_${key}_text`]: version.text, [`version_${key}_title`]: version.title || `Version ${letter}` };
      if (version.workingTitle) patch.title = version.workingTitle;
      await pool.query(`UPDATE submissions SET result=COALESCE(result,'{}'::jsonb)||$2::jsonb,
        updated_at=now(),revision=revision+1,next_sync_at=now(),sync_attempts=0,sync_error=NULL WHERE id=$1`,
      [id, JSON.stringify(patch)]);
    },
    async get(id) {
      const row = (await pool.query(`SELECT id,created_at,updated_at,input_text,duration,level,status,result,download_email,download_email_at
        FROM submissions WHERE id=$1`, [id])).rows[0];
      if (!row) return null;
      row.files = (await pool.query(`SELECT id,original_name,mime_type,size_bytes,stored
        FROM submission_files WHERE submission_id=$1 ORDER BY id`, [id])).rows;
      return row;
    },
    async captureDownloadEmail(id, email) {
      const row = (await pool.query(`UPDATE submissions SET
        download_email=COALESCE(download_email,$2),download_email_at=COALESCE(download_email_at,now()),
        updated_at=CASE WHEN download_email IS NULL THEN now() ELSE updated_at END,
        revision=revision+CASE WHEN download_email IS NULL THEN 1 ELSE 0 END,
        next_sync_at=CASE WHEN download_email IS NULL THEN now() ELSE next_sync_at END
        WHERE id=$1 AND (
          COALESCE(result->>'version_a_text',result->>'version_a_md','') <> '' OR
          COALESCE(result->>'version_b_text',result->>'version_b_md','') <> '')
        RETURNING download_email`, [id, email])).rows[0];
      return row?.download_email || null;
    },
    async claimHubSpotSubmission(id, claim) {
      // Keep the claim longer than the HubSpot request and let it expire after a process crash.
      const acquired = await pool.query(`UPDATE submissions
        SET hubspot_claim=$2, hubspot_retry_at=now()+interval '30 seconds'
        WHERE id=$1 AND hubspot_submitted_at IS NULL AND download_email IS NOT NULL
          AND (hubspot_retry_at IS NULL OR hubspot_retry_at <= now())
        RETURNING id`, [id, claim]);
      if (acquired.rows.length) return 'claimed';
      const current = await pool.query('SELECT hubspot_submitted_at FROM submissions WHERE id=$1', [id]);
      return current.rows[0]?.hubspot_submitted_at ? 'confirmed' : 'pending';
    },
    async finishHubSpotSubmission(id, claim, accepted, retryMs) {
      const result = await pool.query(`UPDATE submissions SET
        hubspot_submitted_at=CASE WHEN $3::boolean THEN now() ELSE NULL END,
        hubspot_claim=NULL,
        hubspot_retry_at=CASE WHEN $4::integer > 0
          THEN now()+$4::integer * interval '1 millisecond' ELSE NULL END
        WHERE id=$1 AND hubspot_claim=$2 RETURNING id`, [id, claim, accepted, retryMs]);
      return result.rows.length > 0;
    },
    async file(submissionId, fileId) {
      const row = (await pool.query(`SELECT * FROM submission_files
        WHERE submission_id=$1 AND id=$2 AND stored=true`, [submissionId, fileId])).rows[0];
      if (!row) return null;
      return { ...row, body: await objects.get(row.object_key) };
    },
  };
}
