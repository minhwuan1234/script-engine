
// Magnetic Script backend: single file, zero dependencies (Node >= 20).
// Serves index.html and POST /api/generate -> Claude Messages API + custom skill.
//
// Env vars (set in Railway Variables):
//   ANTHROPIC_API_KEY   required
//   SKILL_ID            required  (skill_01... from the skill upload)
//   CLAUDE_MODEL        optional  default claude-sonnet-4-5
//   MAX_TOKENS          optional  default 16000
//   RATE_LIMIT_PER_HOUR optional  default 10 (per IP)
//   PORT                set by Railway
 
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  ANTHROPIC_API_KEY,
  SKILL_ID,
  CLAUDE_MODEL = 'claude-sonnet-4-5',
  MAX_TOKENS = '16000',
  RATE_LIMIT_PER_HOUR = '10',
  PORT = '3000',
} = process.env;
 
const MAX_BODY = 25 * 1024 * 1024; // total upload cap
const hits = new Map();
 
/* ---------- helpers ---------- */
const json = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
 
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
 
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
 
// Call Messages API with streaming (avoids long-request timeouts), return the joined text.
async function callClaude(content) {
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
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
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
      else if (ev.type === 'message_delta') stopReason = ev.delta?.stop_reason || stopReason;
      else if (ev.type === 'error') throw new Error(ev.error?.message || 'Upstream stream error');
    }
  }
  return { markdown: text.trim(), stopReason };
}
 
/* ---------- routes ---------- */
async function handleGenerate(req, res) {
  if (!ANTHROPIC_API_KEY || !SKILL_ID) {
    return json(res, 500, { error: 'Server missing ANTHROPIC_API_KEY or SKILL_ID.' });
  }
  if (rateLimited(clientIp(req))) {
    return json(res, 429, { error: `Rate limit: ${RATE_LIMIT_PER_HOUR} requests/hour on this demo.` });
  }
 
  const form = await readForm(req);
  const text = String(form.get('text') || '').trim();
  const crazyRaw = String(form.get('crazy') || 'Medium');
  const crazy = ['Low', 'Medium', 'High'].includes(crazyRaw) ? crazyRaw : 'Medium';
 
  const blocks = [];
  const skipped = [];
  for (const f of form.getAll('files').slice(0, 3)) {
    if (typeof f === 'string') continue;
    const b = await fileToBlock(f);
    if (b) blocks.push(b); else skipped.push(f.name);
  }
  if (!text && blocks.length === 0) {
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
 
  const { markdown, stopReason } = await callClaude([...blocks, { type: 'text', text: instruction }]);
  json(res, 200, { markdown, crazy, skipped, stop_reason: stopReason });
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
      const { pathname } = new URL(req.url, 'http://x');
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return serveIndex(res);
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { ok: true, hasKey: !!ANTHROPIC_API_KEY, hasSkill: !!SKILL_ID, model: CLAUDE_MODEL });
      }
      if (req.method === 'POST' && pathname === '/api/generate') return await handleGenerate(req, res);
      res.writeHead(404); res.end('Not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Server error' });
    }
  })
  .listen(Number(PORT), () => console.log(`Listening on :${PORT}`));
