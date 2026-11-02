import { Pool } from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  const result = await pool.query(`UPDATE submissions SET revision=revision+1,
    sync_attempts=0,sync_error=NULL,next_sync_at=now()`);
  console.log(`Queued ${result.rowCount} submissions for Google Sheets synchronization.`);
} finally { await pool.end(); }
