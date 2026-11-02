import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { createSubmissionStore, validateSubmission, MAX_UPLOAD_BYTES } from './submission-store.js';
import { syncReports, reportRow } from './sheets-sync.js';
import { archiveConfig, createSheetsClient } from './archive-runtime.js';
import { authorized, handleSubmissionAdmin } from './submission-admin.js';

async function fixture(t, putOverride) {
  const db = new PGlite();
  t.after(() => db.close());
  // PGlite runs real PostgreSQL SQL in-process but has no independent sessions.
  // Only advisory session locking is stubbed; schema, transactions and queries run unchanged.
  const query = async (sql, args) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [] };
    if (!args && sql.includes('CREATE TABLE')) { await db.exec(sql); return { rows: [] }; }
    return db.query(sql, args);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const saved = new Map();
  const objects = { put: putOverride || (async (key, bytes) => saved.set(key, Buffer.from(bytes))),
    get: async (key) => Readable.from([saved.get(key)]) };
  const store = createSubmissionStore({ pool, objects });
  await store.migrate(); await store.migrate();
  return { store, pool, saved };
}

test('archive preserves original whitespace, file bytes, metadata and outcome', async (t) => {
  const { store, pool, saved } = await fixture(t);
  const source = '  original text\n\n';
  const bytes = Buffer.from('original document\n');
  const id = await store.save({ text: source, files: [new File([bytes], '../../unsafe.txt', { type: 'text/plain' })], duration: '2-3 mins', level: 'Medium' });
  await store.finish(id, 'completed', { title: 'A result' });
  const row = await store.get(id);
  assert.equal(row.input_text, source);
  assert.equal(row.status, 'completed');
  assert.equal(row.result.title, 'A result');
  assert.equal(row.files[0].original_name, '../../unsafe.txt');
  const stored = (await pool.query('SELECT * FROM submission_files')).rows[0];
  assert.ok(!stored.object_key.includes('unsafe'));
  assert.deepEqual(saved.get(stored.object_key), bytes);
  assert.equal(stored.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(Number((await pool.query('SELECT report_row FROM submissions')).rows[0].report_row), 2);
});

test('failed object upload remains auditable and cannot be downloaded', async (t) => {
  const { store, pool } = await fixture(t, async () => { throw new Error('private upstream error'); });
  await assert.rejects(store.save({ text: 'source', files: [new File(['x'], 'a.txt')], duration: '2-3 mins', level: 'Low' }), /Could not archive/);
  const row = (await pool.query('SELECT * FROM submissions')).rows[0];
  assert.equal(row.status, 'archive_failed');
  assert.equal(row.input_text, 'source');
  const file = (await store.get(row.id)).files[0];
  assert.equal(file.stored, false);
  assert.equal(await store.file(row.id, file.id), null);
});

test('rejects excess files, unsupported types and actual aggregate bytes', () => {
  assert.throws(() => validateSubmission('', []), /Provide text/);
  assert.throws(() => validateSubmission('x', Array(4).fill({ name: 'a.txt', size: 1 })), /at most 3/);
  assert.throws(() => validateSubmission('x', [{ name: 'a.exe', size: 1 }]), /Supported files/);
  assert.throws(() => validateSubmission('x', [{ name: 'a.pdf', size: MAX_UPLOAD_BYTES }]), /too large/);
});

test('lost Sheets response retries the same row, without duplicate append', async (t) => {
  const { store, pool } = await fixture(t);
  const id = await store.save({ text: '=IMPORTXML("https://example.com")', files: [], duration: '2-3 mins', level: 'Medium' });
  const sheetRows = new Map(); let fail = true; const writes = [];
  const sheets = { ensure: async () => {}, write: async (row, values) => {
    writes.push(row); sheetRows.set(row, values);
    if (fail) { fail = false; throw new Error('Response lost after write'); }
  } };
  await syncReports({ pool, sheets, baseUrl: 'https://example.com' });
  let row = (await pool.query('SELECT * FROM submissions WHERE id=$1', [id])).rows[0];
  assert.equal(row.synced_revision, 0);
  assert.equal(row.sync_attempts, 1);
  await pool.query('UPDATE submissions SET next_sync_at=now()');
  await syncReports({ pool, sheets, baseUrl: 'https://example.com' });
  row = (await pool.query('SELECT * FROM submissions WHERE id=$1', [id])).rows[0];
  assert.equal(row.synced_revision, row.revision);
  assert.deepEqual(writes, [2, 2]); assert.equal(sheetRows.size, 1);
  assert.ok(sheetRows.get(2)[2].startsWith('='));
});

test('a newer status during Sheets write remains queued for another sync', async (t) => {
  const { store, pool } = await fixture(t);
  const id = await store.save({ text: 'source', files: [], duration: '30s-60s', level: 'Low' });
  const sheets = { ensure: async () => {}, write: async () => store.finish(id, 'completed') };
  await syncReports({ pool, sheets, baseUrl: 'https://example.com' });
  const row = (await pool.query('SELECT * FROM submissions WHERE id=$1', [id])).rows[0];
  assert.ok(row.revision > row.synced_revision);
  assert.equal(row.status, 'completed');
});

test('Sheet setup failures retain pending records with backoff', async (t) => {
  const { store, pool } = await fixture(t);
  await store.save({ text: 'source', files: [], duration: '2-3 mins', level: 'Medium' });
  await syncReports({ pool, baseUrl: 'https://example.com', sheets: {
    ensure: async () => { throw new Error('temporary API failure'); },
    write: async () => assert.fail('must not write before Sheet setup succeeds'),
  } });
  const row = (await pool.query('SELECT * FROM submissions')).rows[0];
  assert.equal(row.synced_revision, 0); assert.equal(row.sync_attempts, 1);
  assert.ok(new Date(row.next_sync_at) > new Date(row.updated_at));
  assert.match(row.sync_error, /setup failed/);
});

test('worker reconciles abandoned uploads and report text stays within cell bounds', async (t) => {
  const { store, pool } = await fixture(t);
  const id = await store.save({ text: 'a'.repeat(60000), files: [], duration: '2-3 mins', level: 'High' });
  await pool.query("UPDATE submissions SET status='storing',updated_at=now()-interval '2 hours' WHERE id=$1", [id]);
  let values;
  await syncReports({ pool, sheets: { ensure: async () => {}, write: async (_, row) => { values = row; } }, baseUrl: 'https://example.com' });
  assert.equal(values[4], 'interrupted');
  assert.ok(values[2].length < 40000); assert.match(values[2], /Truncated/);
  const row = (await pool.query('SELECT * FROM submissions')).rows[0];
  assert.equal(row.input_text.length, 60000);
});

test('Sheets writes RAW into deterministic ranges and escapes tab names', async () => {
  const requests = [];
  const sheets = createSheetsClient({ auth: { getAccessToken: async () => ({ token: 'test-only' }) },
    spreadsheetId: 'sheet123', tab: "User's Submissions", fetchImpl: async (url, options) => {
      requests.push({ url, ...options }); return Response.json({});
    } });
  await sheets.write(9, ['=1+1']);
  assert.match(requests[0].url, /valueInputOption=RAW/);
  assert.ok(decodeURIComponent(requests[0].url).includes("'User''s Submissions'!A9:J9"));
  assert.deepEqual(JSON.parse(requests[0].body).values, [['=1+1']]);
});

test('archive disabled by default; enable requires configuration and a safe origin', () => {
  assert.equal(archiveConfig({}), null);
  assert.throws(() => archiveConfig({ SUBMISSION_ARCHIVE_ENABLED: 'true' }), /Missing DATABASE_URL/);
  assert.equal(authorized({ headers: {} }, 'secret'), false);
  assert.equal(authorized({ headers: { authorization: 'Bearer secret' } }, 'secret'), true);
  assert.equal(authorized({ headers: { authorization: 'Bearer wrong' } }, 'secret'), false);
});

test('admin routes deny anonymous requests and stream exact bytes with auth', async (t) => {
  const { store } = await fixture(t);
  const id = await store.save({ text: 'private text', files: [new File(['private bytes'], 'private.txt')], duration: '2-3 mins', level: 'Medium' });
  const fileId = (await store.get(id)).files[0].id;
  function response() {
    const chunks = [];
    const res = new Writable({ write(chunk, _, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.setHeader = () => {};
    res.writeHead = (status) => { res.statusCode = status; };
    res.content = () => Buffer.concat(chunks).toString();
    return res;
  }
  const route = `/api/admin/submissions/${id}/files/${fileId}`;
  const denied = response();
  await handleSubmissionAdmin({ method: 'GET', headers: {} }, denied, route, { store }, 'secret');
  assert.equal(denied.statusCode, 401); assert.ok(!denied.content().includes('private bytes'));
  const allowed = response();
  await handleSubmissionAdmin({ method: 'GET', headers: { authorization: 'Bearer secret' } }, allowed, route, { store }, 'secret');
  assert.equal(allowed.statusCode, 200); assert.equal(allowed.content(), 'private bytes');
});
