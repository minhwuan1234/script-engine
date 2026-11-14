import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { createSubmissionStore, validateSubmission, MAX_UPLOAD_BYTES } from './submission-store.js';
import { syncReports, reportRow } from './sheets-sync.js';
import { archiveConfig, createSheetsClient } from './archive-runtime.js';
import { authorized, handleSubmissionAdmin } from './submission-admin.js';
import { createDownloadGate, normalizeEmail, authorizedPdfInput } from './download-gate.js';
import { createVersionPublisher } from './version-publisher.js';
import { hubspotConfig, createHubSpotLeadConfirmation } from './hubspot.js';

async function fixture(t, putOverride) {
  const db = new PGlite();
  t.after(() => db.close());
  // PGlite runs real PostgreSQL SQL in-process but has no independent sessions.
  // Only advisory session locking is stubbed; schema, transactions and queries run unchanged.
  const query = async (sql, args) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [] };
    if (!args && (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE'))) { await db.exec(sql); return { rows: [] }; }
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

test('Sheets writes clickable document URLs and keeps user input literal', async () => {
  const requests = [];
  const sheets = createSheetsClient({ auth: { getAccessToken: async () => ({ token: 'test-only' }) },
    spreadsheetId: 'sheet123', tab: "User's Submissions", fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      return Response.json(options.method === 'GET' ? { sheets: [{ properties: {
        sheetId: 42, title: "User's Submissions", gridProperties: { rowCount: 1000, columnCount: 11 },
      } }] } : {});
    } });
  await sheets.ensure(9);
  assert.match(requests[1].url, /valueInputOption=RAW/);
  assert.ok(decodeURIComponent(requests[1].url).includes("'User''s Submissions'!A1:K1"));

  const first = 'https://drive.google.com/file/d/first/view?usp=drivesdk';
  const second = 'https://drive.google.com/file/d/second/view';
  const submission = { id: 'id', input_text: '=1+1', created_at: 0, updated_at: 0,
    status: 'completed', duration: '2-3 mins', level: 'High' };
  const values = reportRow(submission, [
    { stored: true, original_name: 'first.txt', drive_view_url: first },
    { stored: true, original_name: 'pending.txt' },
    { stored: false, original_name: 'incomplete.txt' },
    { stored: true, original_name: 'second.txt', drive_view_url: second },
  ], 'https://example.com');
  await sheets.write(9, values);
  assert.ok(requests[2].url.endsWith(':batchUpdate'));
  const { updateCells } = JSON.parse(requests[2].body).requests[0];
  assert.deepEqual(updateCells.start, { sheetId: 42, rowIndex: 8, columnIndex: 0 });
  const cells = updateCells.rows[0].values;
  assert.deepEqual(cells[2].userEnteredValue, { stringValue: '=1+1' });
  assert.deepEqual(cells[3], {
    userEnteredValue: { stringValue: `${first}\n${second}` },
    textFormatRuns: [
      { startIndex: 0, format: { link: { uri: first } } },
      { startIndex: first.length + 1, format: { link: { uri: second } } },
    ],
  });
  assert.deepEqual(cells[7].userEnteredValue, { numberValue: 4 });

  await sheets.write(9, reportRow(submission, [{ stored: true }], 'https://example.com'));
  assert.deepEqual(JSON.parse(requests[3].body).requests[0].updateCells.rows[0].values[3],
    { userEnteredValue: { stringValue: '' }, textFormatRuns: [] });
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

test('email gate rejects missing/invalid email and capabilities from other submissions', async (t) => {
  const { store } = await fixture(t);
  const id = await store.save({ text: 'source', files: [], duration: '2-3 mins', level: 'Medium' });
  await store.finish(id, 'completed', { title: 'Stored title', version_a_title: 'A', version_b_title: 'B',
    version_a_text: 'Stored script A', version_b_text: 'Stored script B' });
  const gate = createDownloadGate({ store, secret: 'test-only-signing-secret' });
  const ownerToken = gate.owner(id);
  await assert.rejects(gate.authorize({ submissionId: id, version: 'A', token: ownerToken }), { status: 403 });
  for (const email of ['', 'bad-email', 'a@localhost', 'a\n@example.com', '.a@example.com']) {
    await assert.rejects(gate.unlock({ submissionId: id, ownerToken, email }), { status: 400 });
  }
  await assert.rejects(gate.unlock({ submissionId: crypto.randomUUID(), ownerToken, email: 'a@example.com' }), { status: 403 });
  await assert.rejects(gate.unlock({ submissionId: id, ownerToken: ownerToken + 'x', email: 'a@example.com' }), { status: 403 });
  assert.equal((await store.get(id)).download_email, null);
});

test('one committed email unlocks both authoritative versions and syncs to column K', async (t) => {
  const { store, pool } = await fixture(t);
  const id = await store.save({ text: 'source', files: [], duration: '2-3 mins', level: 'Medium' });
  await store.finish(id, 'completed', { title: 'Stored title', version_a_title: 'Style A', version_b_title: 'Style B',
    version_a_text: 'Stored script A', version_b_text: 'Stored script B' });
  const gate = createDownloadGate({ store, secret: 'test-only-signing-secret' });
  const ownerToken = gate.owner(id);
  const unlocked = await gate.unlock({ submissionId: id, ownerToken, email: 'person@EXAMPLE.COM' });
  assert.ok(unlocked.downloadToken);
  assert.equal((await store.get(id)).download_email, 'person@example.com');
  for (const version of ['A', 'B']) {
    const result = await gate.authorize({ submissionId: id, version, token: unlocked.downloadToken });
    assert.equal(result.text, `Stored script ${version}`);
  }
  const before = (await pool.query('SELECT revision FROM submissions WHERE id=$1', [id])).rows[0].revision;
  await gate.unlock({ submissionId: id, ownerToken, email: 'another@example.com' });
  assert.equal((await store.get(id)).download_email, 'person@example.com', 'first captured email remains unchanged');
  assert.equal((await pool.query('SELECT revision FROM submissions WHERE id=$1', [id])).rows[0].revision, before);
  let report;
  await syncReports({ pool, baseUrl: 'https://example.com', sheets: {
    ensure: async () => {}, write: async (_, values) => { report = values; },
  } });
  assert.equal(report[10], 'person@example.com');
});

test('direct PDF calls cannot bypass email with DOM edits or arbitrary client text', async (t) => {
  const { store } = await fixture(t);
  const id = await store.save({ text: 'source', files: [], duration: '30s-60s', level: 'Low' });
  await store.finish(id, 'completed', { title: 'Server title', version_a_title: 'A', version_a_text: 'Server text', version_b_text: 'B' });
  const gate = createDownloadGate({ store, secret: 'test-only-signing-secret' });
  const req = (data, token = '') => {
    const stream = Readable.from([Buffer.from(JSON.stringify(data))]);
    stream.headers = { authorization: `Bearer ${token}` }; return stream;
  };
  const data = { submissionId: id, version: 'A', text: 'ATTACKER TEXT', title: 'ATTACKER TITLE', email: 'fake@example.com' };
  await assert.rejects(authorizedPdfInput(req(data), gate), { status: 403 });
  const grant = await gate.unlock({ submissionId: id, ownerToken: gate.owner(id), email: 'person@example.com' });
  const result = await authorizedPdfInput(req(data, grant.downloadToken), gate);
  assert.equal(result.text, 'Server text'); assert.equal(result.title, 'Server title');
  await assert.rejects(authorizedPdfInput(req({ ...data, submissionId: crypto.randomUUID() }, grant.downloadToken), gate), { status: 403 });
  await assert.rejects(authorizedPdfInput(req(data), null), { status: 503 });
});

test('expired grants and failed email persistence never grant a PDF', async (t) => {
  const { store } = await fixture(t);
  const id = await store.save({ text: 'source', files: [], duration: '2-3 mins', level: 'Low' });
  await store.finish(id, 'completed', { version_a_text: 'A', version_b_text: 'B' });
  let time = 1000;
  const gate = createDownloadGate({ store, secret: 'test-only-signing-secret', now: () => time });
  const ownerToken = gate.owner(id);
  const grant = await gate.unlock({ submissionId: id, ownerToken, email: 'person@example.com' });
  time += 3600_000;
  await assert.rejects(gate.authorize({ submissionId: id, version: 'A', token: grant.downloadToken }), { status: 403 });
  const broken = createDownloadGate({ store: { captureDownloadEmail: async () => { throw new Error('Database unavailable'); } }, secret: 'test-only-signing-secret', now: () => 1000 });
  await assert.rejects(broken.unlock({ submissionId: id, ownerToken: broken.owner(id), email: 'person@example.com' }), /Database unavailable/);
  assert.equal(normalizeEmail('  person@EXAMPLE.COM  '), 'person@example.com');
});

test('a streamed A unlocks before completion; the same grant unlocks B when it arrives', async (t) => {
  const { store } = await fixture(t);
  const id = await store.save({ text: 'source', files: [], duration: '2-3 mins', level: 'Medium' });
  const gate = createDownloadGate({ store, secret: 'test-only' });
  const events = [];
  const publisher = createVersionPublisher({ store, submissionId: id, ownerToken: gate.owner(id),
    sendEvent: (type, data) => events.push({ type, ...data }) });
  publisher.publish('A', { title: 'Style A', text: 'Completed A', workingTitle: 'Working title' });
  await publisher.drain();
  assert.equal((await store.get(id)).status, 'processing');
  assert.equal(events[0].type, 'version_a');
  const grant = await gate.unlock({ submissionId: id, ownerToken: events[0].downloadOwnerToken, email: 'early@example.com' });
  assert.equal((await gate.authorize({ submissionId: id, version: 'A', token: grant.downloadToken })).text, 'Completed A');
  await assert.rejects(gate.authorize({ submissionId: id, version: 'B', token: grant.downloadToken }), { status: 403 });
  publisher.publish('B', { title: 'Style B', text: 'Completed B' });
  await publisher.drain();
  assert.equal((await gate.authorize({ submissionId: id, version: 'B', token: grant.downloadToken })).text, 'Completed B');
  await store.finish(id, 'completed', { title: 'Final title' });
  assert.equal((await store.get(id)).download_email, 'early@example.com');
  assert.equal((await gate.authorize({ submissionId: id, version: 'A', token: grant.downloadToken })).title, 'Final title');
  assert.equal((await store.get(id)).result.downloadOwnerToken, undefined);
});

test('HubSpot Forms configuration is opt-in and requires the archive and form IDs', () => {
  assert.equal(hubspotConfig({}), null);
  const env = { HUBSPOT_FORMS_ENABLED: 'true', HUBSPOT_PORTAL_ID: '12345',
    HUBSPOT_FORM_GUID: '00000000-0000-0000-0000-000000000001' };
  assert.throws(() => hubspotConfig(env), /SUBMISSION_ARCHIVE_ENABLED/);
  env.SUBMISSION_ARCHIVE_ENABLED = 'true';
  assert.throws(() => hubspotConfig({ ...env, HUBSPOT_PORTAL_ID: '' }), /HUBSPOT_PORTAL_ID/);
  assert.throws(() => hubspotConfig({ ...env, HUBSPOT_FORM_GUID: 'invalid' }), /HUBSPOT_FORM_GUID/);
  assert.equal(hubspotConfig(env).formGuid, env.HUBSPOT_FORM_GUID);
});

test('HubSpot confirmation gates PDFs and reuses the first email across retries and concurrent unlocks', async (t) => {
  const { store, pool } = await fixture(t);
  const id = await store.save({ text: 'source', files: [], duration: '30s-60s', level: 'Low' });
  await store.saveVersion(id, 'A', { title: 'Style A', text: 'Durable A' });
  const config = { portalId: '12345', formGuid: '00000000-0000-0000-0000-000000000001' };
  const pageUri = 'https://example.com';
  const requests = [];
  let markStarted, releaseRequest;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const release = new Promise((resolve) => { releaseRequest = resolve; });
  const confirmHubSpotLead = createHubSpotLeadConfirmation({
    store, config, pageUri,
    async fetchImpl(url, options) {
      requests.push({ url, options });
      if (requests.length === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
      markStarted();
      await release;
      return new Response(null, { status: 200 });
    },
  });
  const gate = createDownloadGate({ store, secret: 'test-only', confirmHubSpotLead });
  const input = { submissionId: id, ownerToken: gate.owner(id), email: 'person@EXAMPLE.COM' };
  await assert.rejects(gate.unlock({ ...input, ownerToken: 'invalid' }), { status: 403 });
  await assert.rejects(gate.unlock({ ...input, email: 'invalid' }), { status: 400 });
  assert.equal(requests.length, 0);

  await assert.rejects(gate.unlock(input), { status: 503 });
  assert.equal((await store.get(id)).download_email, 'person@example.com');
  await assert.rejects(gate.unlock(input), { status: 503 });
  assert.equal(requests.length, 1, 'rate limited submissions wait before sending again');
  await pool.query("UPDATE submissions SET hubspot_retry_at=now()-interval '1 second' WHERE id=$1", [id]);

  const retry = { ...input, email: 'another@example.com' };
  const first = gate.unlock(retry);
  await Promise.race([started, first]);
  try {
    await assert.rejects(gate.unlock(retry), { status: 503 });
    assert.equal(requests.length, 2);
  } finally {
    releaseRequest();
  }
  const { downloadToken } = await first;
  const { url, options } = requests[1];
  assert.equal(url, `https://api.hsforms.com/submissions/v3/integration/submit/${config.portalId}/${config.formGuid}`);
  assert.equal(options.method, 'POST');
  const { submittedAt, ...payload } = JSON.parse(options.body);
  assert.ok(Number.isFinite(submittedAt));
  assert.deepEqual(payload, {
    fields: [{ name: 'email', value: 'person@example.com' }],
    context: { pageUri, pageName: 'F.Learning Script Engine' },
  });
  assert.equal((await gate.authorize({ submissionId: id, version: 'A', token: downloadToken })).text, 'Durable A');
  await store.saveVersion(id, 'B', { title: 'Style B', text: 'Durable B' });
  assert.equal((await gate.authorize({ submissionId: id, version: 'B', token: downloadToken })).text, 'Durable B');
  await gate.unlock(retry);
  assert.equal(requests.length, 2, 'a confirmed submission is not sent again');
});

test('B-only and failed generations retain the available version and its email gate', async (t) => {
  const { store } = await fixture(t);
  const id = await store.save({ text: 'source', files: [], duration: '30s-60s', level: 'Low' });
  const gate = createDownloadGate({ store, secret: 'test-only' });
  await store.saveVersion(id, 'B', { title: 'B only', text: 'Durable B' });
  const grant = await gate.unlock({ submissionId: id, ownerToken: gate.owner(id), email: 'early@example.com' });
  await store.finish(id, 'failed');
  assert.equal((await gate.authorize({ submissionId: id, version: 'B', token: grant.downloadToken })).text, 'Durable B');
  await assert.rejects(gate.authorize({ submissionId: id, version: 'A', token: grant.downloadToken }), { status: 403 });
});

test('publisher never exposes a version capability before its database write commits', async () => {
  const order = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const publisher = createVersionPublisher({ store: { saveVersion: async (_, letter) => {
    if (letter === 'A') await barrier;
    order.push('stored ' + letter);
  } }, submissionId: crypto.randomUUID(), ownerToken: 'capability',
  sendEvent: (type) => order.push(type) });
  publisher.publish('A', { text: 'A' }); publisher.publish('B', { text: 'B' });
  await Promise.resolve(); assert.deepEqual(order, []);
  release(); await publisher.drain();
  assert.deepEqual(order, ['stored A', 'version_a', 'stored B', 'version_b']);
  const failing = createVersionPublisher({ store: { saveVersion: async () => { throw new Error('write failed'); } },
    submissionId: crypto.randomUUID(), ownerToken: 'capability', sendEvent: () => assert.fail('must not publish') });
  failing.publish('A', { text: 'A' });
  await assert.rejects(failing.drain(), /Could not save/);
});
