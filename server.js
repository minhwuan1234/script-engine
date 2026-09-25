// Magnetic Script backend: single file, zero dependencies (Node >= 20).
// Serves index.html and POST /api/generate -> Claude Messages API + custom skill.
// Every generate request is tracked (tokens, estimated cost, duration, status) - see GET /api/usage.
//
// Env vars (set in Railway Variables):
//   CLAUDE_API          required  (ANTHROPIC_API_KEY also accepted)
//   SKILL_ID            required  (skill_01... from the skill upload)
//   CLAUDE_MODEL        optional  default claude-sonnet-4-5
//   MAX_TOKENS          optional  default 16000
//   RATE_LIMIT_PER_HOUR optional  default 10 (per IP)
//   ADMIN_TOKEN         optional  enables GET /api/usage (send as ?key=... or Authorization: Bearer ...)
//   USAGE_LOG           optional  JSONL file for usage records. Default ./usage.jsonl
//                                 (Railway disk is wiped on redeploy: mount a Volume at /data and set /data/usage.jsonl)
//   PRICE_IN_PER_M      optional  USD per 1M input tokens, default 3   (cost is an ESTIMATE; set to your model's price)
//   PRICE_OUT_PER_M     optional  USD per 1M output tokens, default 15
//   PORT                set by Railway

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  SKILL_ID,
  CLAUDE_MODEL = 'claude-sonnet-4-5',
  MAX_TOKENS = '16000',
  RATE_LIMIT_PER_HOUR = '10',
  ADMIN_TOKEN,
  USAGE_LOG = path.join(__dirname, 'usage.jsonl'),
  PRICE_IN_PER_M = '3',
  PRICE_OUT_PER_M = '15',
  ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages', // overridable for testing
  PORT = '3000',
} = process.env;

// Secret is named CLAUDE_API; ANTHROPIC_API_KEY also works as a fallback.
const ANTHROPIC_API_KEY = process.env.CLAUDE_API || process.env.ANTHROPIC_API_KEY;

const MAX_BODY = 25 * 1024 * 1024; // total upload cap
const hits = new Map();

/* ---------- usage tracking ---------- */
const MAX_RECORDS = 5000;
let records = [];

try {
  if (fs.existsSync(USAGE_LOG)) {
    records = fs
      .readFileSync(USAGE_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_RECORDS)
      .map((l) => JSON.parse(l));
    console.log(`Loaded ${records.length} usage records from ${USAGE_LOG}`);
  }
} catch (err) {
  console.error('Could not load usage log:', err.message);
}

function estimateCost(u) {
  const pin = Number(PRICE_IN_PER_M);
  const pout = Number(PRICE_OUT_PER_M);
  const usd =
    ((u.input_tokens || 0) * pin +
      (u.cache_creation_input_tokens || 0) * pin * 1.25 + // cache write = 1.25x input
      (u.cache_read_input_tokens || 0) * pin * 0.1 + //      cache read  = 0.1x input
      (u.output_tokens || 0) * pout) /
    1e6;
  return Math.round(usd * 10000) / 10000;
}

function recordUsage(rec) {
  records.push(rec);
  if (records.length > MAX_RECORDS) records.shift();
  console.log('[usage] ' + JSON.stringify(rec)); // also visible in Railway logs
  try {
    fs.mkdirSync(path.dirname(USAGE_LOG), { recursive: true });
    fs.appendFile(USAGE_LOG, JSON.stringify(rec) + '\n', () => {});
  } catch {}
}

function totals(list) {
  const t = { requests: list.length, ok: 0, errors: 0, rate_limited: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, est_cost_usd: 0, avg_duration_s: 0 };
  let dur = 0, durN = 0;
  for (const r of list) {
    if (r.status === 'ok') t.ok++; else if (r.status === 'rate_limited') t.rate_limited++; else t.errors++;
    t.input_tokens += r.input_tokens || 0;
    t.output_tokens += r.output_tokens || 0;
    t.cache_read_tokens += r.cache_read_input_tokens || 0;
    t.cache_write_tokens += r.cache_creation_input_tokens || 0;
    t.est_cost_usd += r.est_cost_usd || 0;
    if (r.status === 'ok' && r.duration_ms) { dur += r.duration_ms; durN++; }
  }
  t.est_cost_usd = Math.round(t.est_cost_usd * 10000) / 10000;
  t.avg_duration_s = durN ? Math.round(dur / durN / 100) / 10 : 0;
  return t;
}

function usageSummary() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = Date.now() - 7 * 86400_000;
  const byDay = {};
  const byCrazy = {};
  for (const r of records) {
    const d = r.ts.slice(0, 10);
    (byDay[d] ||= []).push(r);
    if (r.status === 'ok') byCrazy[r.crazy] = (byCrazy[r.crazy] || 0) + 1;
  }
  return {
    model: CLAUDE_MODEL,
    note: 'Costs are estimates from token counts x PRICE_IN_PER_M / PRICE_OUT_PER_M; other charges (e.g. code execution) are not included.',
    records_in_memory: records.length,
    unique_visitors: new Set(records.map((r) => r.visitor)).size,
    all_time: totals(records),
    today: totals(records.filter((r) => r.ts.startsWith(today))),
    last_7_days: totals(records.filter((r) => Date.parse(r.ts) >= weekAgo)),
    by_day: Object.fromEntries(Object.entries(byDay).slice(-14).map(([d, l]) => [d, totals(l)])),
    ok_requests_by_crazy_level: byCrazy,
    latest: records.slice(-20).reverse(),
  };
}

function isAdmin(req, url) {
  if (!ADMIN_TOKEN) return false;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const given = String(url.searchParams.get('key') || req.headers['x-admin-token'] || bearer || '');
  const a = Buffer.from(given);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- helpers ---------- */
const json = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

const visitorId = (ip) => crypto.createHash('sha256').update(ip).digest('hex').slice(0, 8); // anonymised

function rateLimited(ip) {
  const limit = Number(RATE_LIMIT_PER_HOUR);
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (arr.length >= limit) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

// Parse multipart with Node's built-in Request.formData()
async function readForm(req) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BODY) throw Object.assign(new Error('Upload too large (max 25 MB).'), { status: 413 });
  const request = new Request('http://local/', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] || '' },
    body: req,
    duplex: 'half',
  });
  return request.formData();
}

async function fileToBlock(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    const b64 = Buffer.from(await file.arrayBuffer()).toString('base64');
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 }, title: file.name };
  }
  if (ext === 'txt' || ext === 'md') {
    return { type: 'text', text: `--- ${file.name} ---\n${await file.text()}` };
  }
  return null; // doc/docx/xlsx/images: not supported yet
}

// Call Messages API with streaming (avoids long-request timeouts).
// Returns the final text, stop reason and token usage. `usage` is filled in as events arrive,
// so a caller can still read partial usage if the stream fails midway.
async function callClaude(content, usage) {
  const upstream = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: Number(MAX_TOKENS),
      stream: true,
      container: { skills: [{ type: 'custom', skill_id: SKILL_ID, version: 'latest' }] },
      tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
      messages: [{ role: 'user', content }],
    }),
  });

  if (!upstream.ok) {
    let msg = `Anthropic API error ${upstream.status}`;
    try { msg = (await upstream.json()).error?.message || msg; } catch {}
    throw Object.assign(new Error(msg), { status: upstream.status });
  }

  const pickUsage = (u) => {
    if (!u) return;
    for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
      if (typeof u[k] === 'number') usage[k] = u[k];
    }
  };

  let text = '';
  let stopReason = null;
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      let ev;
      try { ev = JSON.parse(dataLine.slice(6)); } catch { continue; }
      if (ev.type === 'message_start') pickUsage(ev.message?.usage);
      else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
      else if (ev.type === 'message_delta') { stopReason = ev.delta?.stop_reason || stopReason; pickUsage(ev.usage); }
      else if (ev.type === 'error') throw new Error(ev.error?.message || 'Upstream stream error');
    }
  }
  // The skill wraps its final answer in markers; drop any narration outside them.
  const m = text.match(/<<<MSE_OUTPUT_START>>>([\s\S]*?)(?:<<<MSE_OUTPUT_END>>>|$)/);
  const out = (m ? m[1] : text).trim();
  return { markdown: out, stopReason };
}

/* ---------- routes ---------- */
async function handleGenerate(req, res) {
  if (!ANTHROPIC_API_KEY || !SKILL_ID) {
    return json(res, 500, { error: 'Server missing CLAUDE_API or SKILL_ID.' });
  }

  const ip = clientIp(req);
  const t0 = Date.now();
  const rec = { ts: new Date().toISOString(), visitor: visitorId(ip), status: 'error', model: CLAUDE_MODEL };
  const usage = {};

  try {
    if (rateLimited(ip)) {
      rec.status = 'rate_limited';
      return json(res, 429, { error: `Rate limit: ${RATE_LIMIT_PER_HOUR} requests/hour on this demo.` });
    }

    const form = await readForm(req);
    const text = String(form.get('text') || '').trim();
    const crazyRaw = String(form.get('crazy') || 'Medium');
    const crazy = ['Low', 'Medium', 'High'].includes(crazyRaw) ? crazyRaw : 'Medium';
    rec.crazy = crazy;
    rec.text_chars = text.length;

    const blocks = [];
    const skipped = [];
    const fileTypes = [];
    for (const f of form.getAll('files').slice(0, 3)) {
      if (typeof f === 'string') continue;
      fileTypes.push(f.name.split('.').pop().toLowerCase());
      const b = await fileToBlock(f);
      if (b) blocks.push(b); else skipped.push(f.name);
    }
    rec.files = fileTypes; // extensions only, never file names or contents
    if (!text && blocks.length === 0) {
      rec.status = 'bad_request';
      return json(res, 400, {
        error: skipped.length
          ? `File type not supported yet: ${skipped.join(', ')}. Use PDF, TXT, MD or paste text.`
          : 'Provide text or a file.',
      });
    }

    const instruction =
      `Use the magnetic-script-engine skill on the document provided below (attached file(s) and/or pasted text).\n` +
      `Crazy level: ${crazy}. All other inputs: let the engine choose and state its assumptions.\n` +
      `Return the final result in the skill's markdown output structure, as plain text in your reply.` +
      (text ? `\n\n--- Pasted text / instructions ---\n${text}` : '');

    const { markdown, stopReason } = await callClaude([...blocks, { type: 'text', text: instruction }], usage);
    rec.status = markdown.startsWith('ERROR:') ? 'engine_error' : 'ok';
    rec.stop_reason = stopReason;
    json(res, 200, {
      markdown, crazy, skipped, stop_reason: stopReason,
      usage: { ...usage, est_cost_usd: estimateCost(usage), duration_s: Math.round((Date.now() - t0) / 100) / 10 },
    });
  } catch (err) {
    rec.error = String(err.message || err).slice(0, 300);
    throw err;
  } finally {
    Object.assign(rec, usage);
    rec.est_cost_usd = estimateCost(usage);
    rec.duration_ms = Date.now() - t0;
    recordUsage(rec);
  }
}

function serveIndex(res) {
  const candidates = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) { res.writeHead(404); return res.end('index.html not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const { pathname } = url;
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return serveIndex(res);
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { ok: true, hasKey: !!ANTHROPIC_API_KEY, hasSkill: !!SKILL_ID, model: CLAUDE_MODEL });
      }
      if (req.method === 'GET' && pathname === '/api/usage') {
        if (!isAdmin(req, url)) { res.writeHead(404); return res.end('Not found'); }
        return json(res, 200, usageSummary());
      }
      if (req.method === 'POST' && pathname === '/api/generate') return await handleGenerate(req, res);
      res.writeHead(404); res.end('Not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Server error' });
    }
  })
  .listen(Number(PORT), () => console.log(`Listening on :${PORT}`));
