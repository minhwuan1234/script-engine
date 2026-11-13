export const REPORT_HEADERS = ['Submit ID', 'Created at (UTC)', 'Input text', 'Document upload',
  'Status', 'Duration', 'Level', 'File count', 'Submission details', 'Updated at (UTC)', 'Email'];

export function reportRow(submission, files, baseUrl) {
  const details = `${baseUrl}/admin/submissions/${submission.id}`;
  const text = submission.input_text.length > 40000
    ? submission.input_text.slice(0, 39500) + '\n[Truncated in report. Open Submission details for full text.]'
    : submission.input_text;
  return [submission.id, new Date(submission.created_at).toISOString(), text,
    files.map((file) => `${file.original_name}${file.stored ? ` — ${file.drive_view_url || `${details}#file=${file.id}`}` : ' [upload incomplete]'}`).join('\n').slice(0, 40000),
    submission.status, submission.duration, submission.level, files.length,
    details, new Date(submission.updated_at).toISOString(), submission.download_email || ''];
}

// One durable row number per submission, allocated by PostgreSQL. A network retry
// overwrites the same range, including after a successful write whose reply was lost.
// Keep this dedicated tab in original row order; use filter views for sorting.
export async function syncReports({ pool, sheets, drive, baseUrl, batchSize = 20 }) {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(76432002) AS locked')).rows[0].locked;
    if (!locked) return;
    await client.query(`UPDATE submissions SET status='interrupted',revision=revision+1,
      updated_at=now(),next_sync_at=now() WHERE status IN ('storing','processing')
      AND updated_at < now() - interval '1 hour'`);
    const rows = (await client.query(`SELECT * FROM submissions
      WHERE revision > synced_revision AND next_sync_at <= now() AND status <> 'storing'
      ORDER BY next_sync_at,report_row LIMIT $1`, [batchSize])).rows;
    if (!rows.length) return;
    try {
      await sheets.ensure(Math.max(...rows.map((row) => Number(row.report_row))));
    } catch {
      for (const row of rows) {
        const delay = Math.min(3600, 30 * 2 ** Math.min(row.sync_attempts, 7));
        await client.query(`UPDATE submissions SET sync_attempts=sync_attempts+1,
          sync_error='Google Sheets setup failed; retry scheduled',
          next_sync_at=now()+($2 * interval '1 second') WHERE id=$1 AND revision=$3`,
        [row.id, delay, row.revision]);
      }
      return;
    }
    let folderCheck;
    let driveErrorLogged = false;
    for (const row of rows) {
      let driveFailed = false;
      try {
        const files = (await client.query('SELECT * FROM submission_files WHERE submission_id=$1 ORDER BY id', [row.id])).rows;
        for (const file of files) {
          if (!drive || !file.stored || !file.drive_sync_requested || file.drive_view_url) continue;
          try {
            await (folderCheck ??= drive.checkFolder());
            file.drive_view_url = await drive.copy(client, file);
          } catch (error) {
            driveFailed = true;
            if (!driveErrorLogged) {
              const status = Number.isInteger(error.status) ? error.status : 'unavailable';
              console.warn(`Google Drive report sync pending (HTTP ${status}).`);
              driveErrorLogged = true;
            }
          }
        }
        await sheets.write(Number(row.report_row), reportRow(row, files, baseUrl));
        if (driveFailed) throw new Error('Drive sync pending.');
        await client.query(`UPDATE submissions SET synced_revision=$2,sync_attempts=0,sync_error=NULL
          WHERE id=$1 AND revision=$2`, [row.id, row.revision]);
      } catch {
        // Never persist upstream error text: it can contain credentials or user data.
        const delay = Math.min(3600, 30 * 2 ** Math.min(row.sync_attempts, 7)) + Math.floor(Math.random() * 10);
        await client.query(`UPDATE submissions SET sync_attempts=sync_attempts+1,
          sync_error=$4,
          next_sync_at=now()+($2 * interval '1 second') WHERE id=$1 AND revision=$3`,
        [row.id, delay, row.revision, driveFailed ? 'Google Drive sync pending; retry scheduled' : 'Google Sheets sync failed; retry scheduled']);
      }
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(76432002)').catch(() => {});
    client.release();
  }
}

export function startReportWorker(options, intervalMs = 60000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await syncReports(options); }
    catch { console.error('Submission report sync unavailable; will retry.'); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
