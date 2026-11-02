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

export function createSubmissionStore({ pool, objects }) {
  return {
    pool,
    async migrate() {
      const sql = await readFile(new URL('./migrations/001-submissions.sql', import.meta.url), 'utf8');
      await transaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(76432001)');
        await client.query(sql);
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
            (id,submission_id,original_name,object_key,mime_type,size_bytes,sha256)
            VALUES($1,$2,$3,$4,$5,$6,$7)`, [item.id, id, item.file.name, item.key,
            item.file.type || 'application/octet-stream', item.bytes.length,
            crypto.createHash('sha256').update(item.bytes).digest('hex')]);
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
      await pool.query(`UPDATE submissions SET status=$2,result=$3,updated_at=now(),
        revision=revision+1,next_sync_at=now(),sync_attempts=0,sync_error=NULL WHERE id=$1`,
      [id, status, result ? JSON.stringify(result) : null]);
    },
    async get(id) {
      const row = (await pool.query(`SELECT id,created_at,updated_at,input_text,duration,level,status,result
        FROM submissions WHERE id=$1`, [id])).rows[0];
      if (!row) return null;
      row.files = (await pool.query(`SELECT id,original_name,mime_type,size_bytes,stored
        FROM submission_files WHERE submission_id=$1 ORDER BY id`, [id])).rows;
      return row;
    },
    async file(submissionId, fileId) {
      const row = (await pool.query(`SELECT * FROM submission_files
        WHERE submission_id=$1 AND id=$2 AND stored=true`, [submissionId, fileId])).rows[0];
      if (!row) return null;
      return { ...row, body: await objects.get(row.object_key) };
    },
  };
}
