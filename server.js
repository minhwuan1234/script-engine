// Magnetic Script backend: single file, Node >= 20. Now has 3 deps for server-side
// file -> plain text extraction (mammoth, pdf-parse, jszip) — see "file text extraction" below.
// Serves index.html and POST /api/generate with repository writing instructions.
// Every generate request is tracked (tokens, estimated cost, duration, status) - see GET /api/usage.
//
// Env vars (set in Railway Variables):
//   WRITING_PROVIDER    optional  anthropic (default) or openai
//   OPENAI_API_KEY      required for Luna ICP and OpenAI writing
//   OPENAI_MODEL        optional  default gpt-6-sol (medium effort)
//   CLAUDE_API          required for Anthropic writing  (ANTHROPIC_API_KEY also accepted)
//   CLAUDE_MODEL        optional  default claude-sonnet-5-5
//   ICP_MODEL           optional  default gpt-5.6-luna
//   MAX_TOKENS          optional  default 32000 (thinking and visible text share this cap)
//   RATE_LIMIT_PER_HOUR optional  default 10 (per IP)
//   ADMIN_TOKEN         optional  enables GET /api/usage (send as ?key=... or Authorization: Bearer ...)
//   USAGE_LOG           optional  JSONL file for usage records. Default ./usage.jsonl
//                                 (Railway disk is wiped on redeploy: mount a Volume at /data and set /data/usage.jsonl)
//   ICP_SIGNAL_LOG      optional  learned ICP words/phrases. Default ./icp-signals.jsonl
//   ICP_SIGNAL_MIN_COUNT optional observations before a learned signal can select an ICP. Default 3
//   PRICE_IN_PER_M      optional  USD per 1M input tokens, default 2 for Sonnet 5.5
//   PRICE_OUT_PER_M     optional  USD per 1M output tokens, default 10 for Sonnet 5.5
//   PORT                set by Railway
//
// After pulling this version: run `npm install` (adds mammoth, pdf-parse, jszip to node_modules).
// Railway runs npm install automatically on deploy because package.json now lists dependencies.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mammoth from 'mammoth';
// Import pdf-parse's inner module directly, NOT the package root. pdf-parse@1.1.1's index.js
// runs a "debug mode" self-test (`if (!module.parent) { ...open a test PDF from disk... }`) —
// under ESM import, module.parent is always undefined, so it thinks it's the entry point and
// crashes on import (ENOENT). Its lib file has the real, side-effect-free export.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { createPreferenceStore, STYLES } from './preference-store.js';
import { createIcpSignalStore, ICP_KEYS } from './icp-signal-store.js';
import { buildWritingSystem } from './writing-instructions.js';
import { callOpenAI, estimateOpenAICost } from './openai-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  WRITING_PROVIDER = 'anthropic',
  OPENAI_MODEL = 'gpt-6-sol',
  OPENAI_API_KEY,
  OPENAI_PRICE_IN_PER_M = '2',
  OPENAI_PRICE_OUT_PER_M = '10',
  CLAUDE_MODEL = 'claude-sonnet-5-5',
  ICP_MODEL = 'gpt-5.6-luna', // small/cheap model, only for the ICP guess below
  MAX_TOKENS = '32000',
  RATE_LIMIT_PER_HOUR = '10',
  ADMIN_TOKEN,
  USAGE_LOG = path.join(__dirname, 'usage.jsonl'),
  PREFERENCE_LOG = path.join(__dirname, 'preferences.jsonl'),
  ICP_SIGNAL_LOG = path.join(__dirname, 'icp-signals.jsonl'),
  ICP_SIGNAL_MIN_COUNT = '3',
  PRICE_IN_PER_M = CLAUDE_MODEL === 'claude-haiku-5-5' ? '0.10' : CLAUDE_MODEL === 'claude-sonnet-5-5' ? '2' : '3',
  PRICE_OUT_PER_M = CLAUDE_MODEL === 'claude-haiku-5-5' ? '0.50' : CLAUDE_MODEL === 'claude-sonnet-5-5' ? '10' : '15',
  ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages', // overridable for testing
  PORT = '3000',
} = process.env;

if (!['anthropic', 'openai'].includes(WRITING_PROVIDER)) throw new Error('WRITING_PROVIDER must be anthropic or openai.');
const WRITING_MODEL = WRITING_PROVIDER === 'openai' ? OPENAI_MODEL : CLAUDE_MODEL;

// Secret is named CLAUDE_API; ANTHROPIC_API_KEY also works as a fallback.
const ANTHROPIC_API_KEY = process.env.CLAUDE_API || process.env.ANTHROPIC_API_KEY;

const MAX_BODY = 25 * 1024 * 1024; // total upload cap
const hits = new Map();
const preferenceStore = createPreferenceStore(PREFERENCE_LOG);
const icpSignalStore = createIcpSignalStore(ICP_SIGNAL_LOG, {
  minCount: Math.max(2, Number(ICP_SIGNAL_MIN_COUNT) || 3),
});
const DURATION_OPTIONS = ['30s-60s', '2-3 mins', 'upto 5 mins'];
const DEFAULT_DURATION = '2-3 mins';
// Same three buckets the UI's dropdown offers, as [min_seconds, max_seconds].
// 'upto 5 mins' has min 0 — "up to" means no floor, only a ceiling.
const DURATION_TARGETS = {
  '30s-60s': [30, 60],
  '2-3 mins': [120, 180],
  'upto 5 mins': [0, 300],
};

/* ---------- output gateway: code-side, not AI-side ----------
 * The model writes plain text in the fixed Step 7 structure (see SKILL.md). The
 * parser also accepts the old Markdown headings/tables while skill versions roll out.
 * It is never asked to produce JSON. This deterministic gateway creates stable
 * fields without model tokens or model-authored JSON syntax.
 * duration is NOT parsed out of the text — the caller already knows it (it's what
 * it asked for), so they're passed in directly instead of trusting the model to restate them.
 */
function toPlainText(section) {
  const lines = [];
  for (const rawLine of String(section || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (/^\|\s*(?:Time|[-: ]+)\s*\|/i.test(line)) continue;
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
      if (cells.length >= 3 && /^\d+:\d+\s*[-–]\s*\d+:\d+/.test(cells[0])) {
        lines.push(`TIME: ${cells[0]}`, `VOICEOVER: ${cells[1]}`, `ON SCREEN: ${cells.slice(2).join(' | ')}`, '');
        continue;
      }
    }
    line = line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').replace(/\*\*/g, '').replace(/`/g, '');
    lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function workingTitle(output) {
  const match = /^(?:TITLE:\s*|#\s+)([^\n]+)$/im.exec(output);
  return match ? match[1].replace(/\s*[—-]\s*Magnetic Script\s*$/i, '').trim() : '';
}

function parseGateway(output, { duration, icp }) {
  const raw = String(output || '').trim();

  const titleMatch = /^(?:TITLE:\s*|#\s+)([^\n]+)$/im.exec(raw);
  const title = workingTitle(raw);

  const headingRe = (label) => new RegExp(`^(?:##\\s+)?${label}\\b[^\\n]*$`, 'im');
  const aHead = headingRe('Version\\s+A').exec(raw);
  const bHead = headingRe('Version\\s+B').exec(raw);
  const notesHead = headingRe('Engine\\s+notes').exec(raw);

  if (!aHead || !bHead || bHead.index < aHead.index) {
    return { ok: false, fields: null };
  }

  // Preface is anything after the title line and before Version A.
  const titleEnd = titleMatch ? titleMatch.index + titleMatch[0].length : 0;
  const preface_text = toPlainText(raw.slice(titleEnd, aHead.index));

  const versionTitle = (headMatch) =>
    headMatch[0].replace(/^(?:##\s+)?Version\s+[AB]\s*[—-]?\s*/i, '').trim();

  const bEnd = notesHead ? notesHead.index : raw.length;
  const version_a_text = toPlainText(raw.slice(aHead.index + aHead[0].length, bHead.index));
  const version_b_text = toPlainText(raw.slice(bHead.index + bHead[0].length, bEnd));
  const engine_notes_text = notesHead ? toPlainText(raw.slice(notesHead.index)) : '';
  if (!version_a_text || !version_b_text) return { ok: false, fields: null };

  return {
    ok: true,
    fields: {
      title,
      duration,
      icp,
      preface_text,
      version_a_title: versionTitle(aHead),
      version_a_text,
      version_b_title: versionTitle(bHead),
      version_b_text,
      engine_notes_text,
      // Existing API consumers can read the old keys during migration. Their
      // values are plain text too, never raw Markdown.
      preface_md: preface_text,
      version_a_md: version_a_text,
      version_b_md: version_b_text,
      engine_notes_md: engine_notes_text,
    },
  };
}

// A section is safe to display only after the next heading has arrived. This avoids
// exposing an unfinished script while Claude is still streaming its text.
function completedVersion(output, letter) {
  const current = new RegExp(`^(?:##\\s+)?Version\\s+${letter}[^\\n]*\\n`, 'im').exec(output);
  const next = (letter === 'A'
    ? /^(?:##\s+)?Version\s+B[^\n]*\n/im
    : /^(?:##\s+)?Engine\s+notes[^\n]*\n/im).exec(output);
  if (!current || !next || next.index <= current.index) return null;
  const body = output.slice(current.index + current[0].length, next.index).trim();
  if (!/^(?:###\s+)?Hook\b/im.test(body) || !/^(?:###\s+)?Script\b/im.test(body)) return null;
  return {
    workingTitle: workingTitle(output),
    title: current[0].replace(/^(?:##\s+)?Version\s+[AB]\s*[—-]?\s*/i, '').trim(),
    text: toPlainText(body),
  };
}

/* ---------- duration -> word/timing budget: code-side, not AI-side ----------
 * The visitor already picked a duration bucket in the UI. Instead of making the model read
 * word-per-minute arithmetic itself every run, compute
 * the exact target numbers here (~150 wpm long-form,
 * 160-170 wpm short-form, ~10% of time reserved for pauses/visual-only beats) and hand them to
 * the model as a small JSON block alongside the instruction. The model still WRITES the script —
 * that's judgment — it just never has to compute the budget itself.
 */
const LONG_FORM_WPM = 150;
const SHORT_FORM_WPM_MIN = 160;
const SHORT_FORM_WPM_MAX = 170;
const PAUSE_RESERVE = 0.9; // keep ~90% of raw pace-derived words for pauses/visual-only beats

function wordsFor(seconds, wpm) {
  return Math.round((seconds / 60) * wpm * PAUSE_RESERVE);
}

function durationBudget(duration) {
  const [loS, hiS] = DURATION_TARGETS[duration] || DURATION_TARGETS[DEFAULT_DURATION];
  return {
    duration_bucket: duration,
    target_seconds: { min: loS, max: hiS, note: loS === 0 ? "no real floor ('up to') — only the max matters" : undefined },
    hook: { seconds: { max: duration === '30s-60s' ? 8 : 15 },
      word_limit: duration === '30s-60s' ? 20 : 40,
      note: 'Maximums, not quotas. Use a shorter natural opening when sufficient; begin SCRIPT at the actual hook end.' },
    vo_word_budget: {
      long_form_pace_150wpm: { min: wordsFor(loS, LONG_FORM_WPM), max: wordsFor(hiS, LONG_FORM_WPM) },
      short_form_pace_160_170wpm: { min: wordsFor(loS, SHORT_FORM_WPM_MIN), max: wordsFor(hiS, SHORT_FORM_WPM_MAX) },
    },
    per_segment_words_per_second_healthy_range: { min: 1.5, max: 3.0 },
  };
}

/* ---------- ICP guess: small/cheap model, not the main model ----------
 * A cheap/fast model (Haiku) reads a short excerpt and selects one ICP key. The main
 * model receives only that key. The skill's loader opens just that ICP reference
 * together with the two selected style references.
 */
const ICP_EXCERPT_CHARS = 3000; // plenty to tell these 4 domains apart; keeps the classifier call tiny

// Local signals provide a prior guess, but Luna checks every input so the collection
// keeps learning new phrases instead of stopping once a confident local match exists.
async function classifyIcp(excerpt) {
  if (!excerpt || excerpt.trim().length < 20) return { icp: 'unclear', source: 'no_text' };
  const local = icpSignalStore.classify(excerpt);
  const refresh = local.confident;
  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: ICP_MODEL,
        reasoning: { effort: 'none' },
        max_output_tokens: 600,
        store: false,
        text: { format: { type: 'json_object' } },
        instructions:
          'Classify which audience a document excerpt is written for. Return only valid JSON in this shape: ' +
          '{"icp":"healthcare|corporate_lnd|publishing|ngo|unclear","confidence":0.0,"signals":["exact phrase"]}. ' +
          'Signals must be 1-5 word lowercase phrases copied exactly from the excerpt. Return 2-8 distinctive ' +
          'signals that explain the classification. Do not return generic words such as content, video, audience, ' +
          'training, education, learning, or document by themselves. Use an empty signals array for unclear.\n' +
          '- healthcare: patient/clinical material (discharge instructions, medication guides, HCP education)\n' +
          '- corporate_lnd: internal workplace material (policies, SOPs, handbooks, onboarding, safety procedures)\n' +
          '- publishing: educational/editorial material (textbook chapters, course notes, ebooks, study guides)\n' +
          '- ngo: mission-driven material (impact reports, program briefs, advocacy papers)\n' +
          '- unclear: none of these fit clearly',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Return JSON for this excerpt:\n' + excerpt.slice(0, ICP_EXCERPT_CHARS) }] }],
      }),
    });
    if (!res.ok) return local.confident ? { ...local, source: 'signals_fallback' } : { icp: 'unclear', source: 'model_error' };
    const data = await res.json();
    if (data.status !== 'completed') throw new Error('ICP response incomplete');
    const raw = (data.output || []).filter(item => item.type === 'message')
      .flatMap(item => item.content || []).filter(part => part.type === 'output_text')
      .map(part => part.text).join('').trim();
    const answer = JSON.parse(raw);
    const modelIcp = ICP_KEYS.includes(answer.icp) ? answer.icp : 'unclear';
    const confidence = Math.max(0, Math.min(1, Number(answer.confidence) || 0));
    let acceptedSignals = [];
    if (modelIcp !== 'unclear' && confidence >= 0.6) {
      try {
        acceptedSignals = icpSignalStore.observe({
          icp: modelIcp, confidence, signals: answer.signals, sourceText: excerpt,
        });
      } catch (error) {
        console.error('Could not save ICP signals:', error.message);
      }
    }
    if (modelIcp !== 'unclear') {
      return { icp: modelIcp, confidence, signals: acceptedSignals, source: refresh ? 'model_refresh' : 'model' };
    }
    return local.confident ? { ...local, source: 'signals_after_model_unclear' } : { icp: 'unclear', confidence, source: 'model' };
  } catch {
    return local.confident ? { ...local, source: 'signals_fallback' } : { icp: 'unclear', source: 'model_error' };
  }
}

/* ---------- file text extraction: code-side, not AI-side ----------
 * Turning an uploaded PDF/DOCX/PPTX into plain text is a deterministic parsing job —
 * no judgment involved — so it happens here in code instead of asking the model to read
 * the file itself (which used to mean loading file-reading/pdf-reading/python-docx/pptx
 * skill instructions and running code_execution, all of which cost tokens and thinking time).
 * Once this returns plain text, the model just gets a text block like any pasted instructions.
 *
 * The one case code can't handle: a PDF that's actually a scan (an image with no real text
 * layer) — pdf-parse then returns ~nothing. MIN_TEXT_CHARS catches that and falls back to
 * sending the file natively so Claude reads it with vision, exactly like before this change.
 */
const MIN_TEXT_CHARS = 40;

async function extractPdfText(buffer) {
  try {
    const { text } = await pdfParse(buffer);
    return (text || '').trim();
  } catch {
    return '';
  }
}

async function extractDocxText(buffer) {
  try {
    const { value } = await mammoth.extractRawText({ buffer });
    return (value || '').trim();
  } catch {
    return '';
  }
}

async function extractPptxText(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/slide(\d+)\.xml/)[1]) - Number(b.match(/slide(\d+)\.xml/)[1]));

    const parts = [];
    for (const name of slideFiles) {
      const xml = await zip.files[name].async('string');
      const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
      if (texts.length) parts.push(`--- Slide ${parts.length + 1} ---\n${texts.join(' ')}`);
    }
    return parts.join('\n\n').trim();
  } catch {
    return '';
  }
}

// Returns { block, mode }. block is a Messages API content block (or null if unsupported/failed).
// mode is for the usage log only (which extraction path ran) — never filenames or file content.
async function fileToBlock(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const asBuffer = async () => Buffer.from(await file.arrayBuffer());
  const textBlock = (t) => ({ type: 'text', text: `--- ${file.name} ---\n${t}` });

  if (ext === 'pdf') {
    const buffer = await asBuffer();
    const text = await extractPdfText(buffer);
    if (text.length >= MIN_TEXT_CHARS) {
      return { block: textBlock(text), mode: 'pdf_text' };
    }
    // No usable text layer — likely a scanned PDF. Fall back to native (vision) reading.
    return {
      block: {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
        title: file.name,
      },
      mode: 'pdf_native_fallback',
    };
  }
  if (ext === 'docx') {
    const text = await extractDocxText(await asBuffer());
    return text ? { block: textBlock(text), mode: 'docx_text' } : { block: null, mode: 'docx_extract_failed' };
  }
  if (ext === 'pptx') {
    const text = await extractPptxText(await asBuffer());
    return text ? { block: textBlock(text), mode: 'pptx_text' } : { block: null, mode: 'pptx_extract_failed' };
  }
  if (ext === 'txt' || ext === 'md') {
    return { block: textBlock(await file.text()), mode: 'plain_text' };
  }
  return { block: null, mode: 'unsupported' };
}

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
  if (WRITING_PROVIDER === 'openai') return estimateOpenAICost(u, Number(OPENAI_PRICE_IN_PER_M), Number(OPENAI_PRICE_OUT_PER_M));
  const promptTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const haikuLongPrompt = CLAUDE_MODEL === 'claude-haiku-5-5' && promptTokens > 100_000;
  const pin = Number(PRICE_IN_PER_M) * (haikuLongPrompt ? 5 : 1);
  const pout = Number(PRICE_OUT_PER_M) * (haikuLongPrompt ? 5 : 1);
  const cacheWrite5m = u.cache_write_5m_tokens || 0;
  const cacheWrite1h = u.cache_write_1h_tokens || 0;
  const cacheWriteOther = Math.max(0, (u.cache_creation_input_tokens || 0) - cacheWrite5m - cacheWrite1h);
  const usd =
    ((u.input_tokens || 0) * pin +
      cacheWrite5m * pin * 1.25 +
      (cacheWrite1h + cacheWriteOther) * pin * 2 +
      (u.cache_read_input_tokens || 0) * pin * (CLAUDE_MODEL === 'claude-sonnet-5-5' ? 0.05 : 0.1) +
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
  for (const r of records) {
    const d = r.ts.slice(0, 10);
    (byDay[d] ||= []).push(r);
  }
  return {
    model: WRITING_MODEL,
    provider: WRITING_PROVIDER,
    note: 'Costs are estimates using model token prices, cache write duration, and model-specific long-prompt pricing. ICP classification and other charges (e.g. code execution) are not included.',
    records_in_memory: records.length,
    unique_visitors: new Set(records.map((r) => r.visitor)).size,
    all_time: totals(records),
    today: totals(records.filter((r) => r.ts.startsWith(today))),
    last_7_days: totals(records.filter((r) => Date.parse(r.ts) >= weekAgo)),
    by_day: Object.fromEntries(Object.entries(byDay).slice(-14).map(([d, l]) => [d, totals(l)])),
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

async function handleDownloadPdf(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 80_000) return json(res, 413, { error: 'Script is too large for PDF download.' });
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return json(res, 400, { error: 'Invalid PDF request.' }); }
  const version = input?.version;
  const title = String(input?.title || '').replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, 200);
  const style = String(input?.style || '').replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, 120);
  const duration = String(input?.duration || '').replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, 40);
  const script = toPlainText(input?.text).slice(0, 50_001);
  if (!['A', 'B'].includes(version) || !script || script.length > 50_000) {
    return json(res, 400, { error: 'Provide one complete Version A or B script.' });
  }

  const doc = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 54, left: 54, right: 54 },
    info: { Title: `Magnetic Script - Version ${version}`, Author: 'Magnetic Script Studio' } });
  doc.on('error', (error) => { console.error('PDF generation failed:', error.message); res.destroy(error); });
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="magnetic-script-version-${version.toLowerCase()}.pdf"`,
    'Cache-Control': 'no-store',
  });
  doc.pipe(res);
  doc.rect(54, 52, doc.page.width - 108, 4).fill('#ff9436');
  doc.moveDown(1);
  doc.fillColor('#22252a').font('Helvetica-Bold').fontSize(18).text(title || 'Magnetic Script');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(11).text(`VERSION ${version}${style ? ` - ${style}` : ''}`);
  if (duration) doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(`Duration: ${duration}`);
  doc.moveDown(1);
  for (const line of script.split('\n')) {
    if (!line.trim()) { doc.moveDown(0.45); continue; }
    if (/^(HOOK\b|SCRIPT$)/i.test(line)) {
      doc.moveDown(0.35);
      doc.fillColor('#22252a').font('Helvetica-Bold').fontSize(12).text(line, { paragraphGap: 5 });
    } else if (/^TIME:/i.test(line)) {
      doc.moveDown(0.2);
      doc.fillColor('#b45309').font('Helvetica-Bold').fontSize(9).text(line, { paragraphGap: 2 });
    } else {
      doc.fillColor('#22252a').font('Helvetica').fontSize(10).text(line, { lineGap: 3, paragraphGap: 2 });
    }
  }
  doc.end();
}

// Call Messages API with streaming (avoids long-request timeouts).
// Returns the final text, stop reason and token usage. `usage` is filled in as events arrive,
// so a caller can still read partial usage if the stream fails midway.
async function callClaude(content, system, usage, onText = () => {}) {
  const upstream = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      ...(CLAUDE_MODEL === 'claude-sonnet-5-5' ? { output_config: { effort: 'medium' } } : {}),
      max_tokens: Number(MAX_TOKENS),
      stream: true,
      system,
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
    if (typeof u.server_tool_use?.code_execution_requests === 'number') {
      usage.code_execution_requests = Math.max(
        usage.code_execution_requests || 0,
        u.server_tool_use.code_execution_requests,
      );
    }
    if (typeof u.cache_creation?.ephemeral_5m_input_tokens === 'number') {
      usage.cache_write_5m_tokens = u.cache_creation.ephemeral_5m_input_tokens;
    }
    if (typeof u.cache_creation?.ephemeral_1h_input_tokens === 'number') {
      usage.cache_write_1h_tokens = u.cache_creation.ephemeral_1h_input_tokens;
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
      else if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use' &&
        /code_execution/.test(ev.content_block.name || '')) {
        usage.code_execution_requests = (usage.code_execution_requests || 0) + 1;
      }
      else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        text += ev.delta.text;
        // A section closes at a heading line, so no scan is needed until a newline arrives.
        if (ev.delta.text.includes('\n')) onText(text);
      }
      else if (ev.type === 'message_delta') { stopReason = ev.delta?.stop_reason || stopReason; pickUsage(ev.usage); }
      else if (ev.type === 'error') throw new Error(ev.error?.message || 'Upstream stream error');
    }
  }
  // The skill returns plain text in the fixed Step 7 structure — never JSON.
  // Strip a stray code fence if an older skill version wraps it anyway.
  let markdown = text.trim();
  const fenced = markdown.match(/^```(?:markdown)?\s*([\s\S]*?)\s*```$/);
  if (fenced) markdown = fenced[1].trim();

  return { markdown, stopReason };
}

/* ---------- routes ---------- */
async function handleGenerate(req, res) {
  if (!OPENAI_API_KEY) {
    return json(res, 500, { error: 'Server missing OPENAI_API_KEY.' });
  }
  if (WRITING_PROVIDER === 'anthropic' && !ANTHROPIC_API_KEY) {
    return json(res, 500, { error: 'Server missing CLAUDE_API (or ANTHROPIC_API_KEY).' });
  }

  const ip = clientIp(req);
  const t0 = Date.now();
  const rec = { ts: new Date().toISOString(), visitor: visitorId(ip), status: 'error', model: WRITING_MODEL, provider: WRITING_PROVIDER, icp_model: ICP_MODEL };
  const usage = {};
  let heartbeat = null;
  const streamResults = String(req.headers.accept || '').includes('application/x-ndjson');
  let sentA = false;
  let sentB = false;
  const sendEvent = (type, payload = {}) => {
    if (streamResults && !res.destroyed) res.write(JSON.stringify({ type, ...payload }) + '\n');
  };

  // Once callClaude() starts, this can run for a while. Node was already streaming from
  // Anthropic internally, but the browser never saw a byte until everything was done —
  // on a slow run, a proxy or the browser itself can give up waiting on a connection with
  // no traffic. The browser requests NDJSON so each completed version can arrive early;
  // older clients still receive one JSON object. Heartbeats keep either response alive.
  // Since headers go out early with status 200, later errors live in the response body.
  const finish = (obj) => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    try {
      if (streamResults) sendEvent(obj.error ? 'error' : 'complete', obj.error ? { error: obj.error } : { data: obj });
      else res.write(JSON.stringify(obj));
      res.end();
    } catch {} // client likely disconnected — nothing to do
  };

  try {
    if (rateLimited(ip)) {
      rec.status = 'rate_limited';
      return json(res, 429, { error: `Rate limit: ${RATE_LIMIT_PER_HOUR} requests/hour on this demo.` });
    }

    const form = await readForm(req);
    const text = String(form.get('text') || '').trim();
    const durationRaw = String(form.get('duration') || DEFAULT_DURATION);
    const duration = DURATION_OPTIONS.includes(durationRaw) ? durationRaw : DEFAULT_DURATION;
    rec.duration = duration;
    rec.text_chars = text.length;

    const blocks = [];
    const skipped = [];
    const fileTypes = [];
    const extractModes = [];
    for (const f of form.getAll('files').slice(0, 3)) {
      if (typeof f === 'string') continue;
      fileTypes.push(f.name.split('.').pop().toLowerCase());
      const { block, mode } = await fileToBlock(f);
      extractModes.push(mode);
      if (block) blocks.push(block); else skipped.push(f.name);
    }
    rec.files = fileTypes; // extensions only, never file names or contents
    rec.extract_modes = extractModes; // which extraction path ran — debugging/insight only
    rec.extract_ms = Date.now() - t0;
    if (!text && blocks.length === 0) {
      rec.status = 'bad_request';
      return json(res, 400, {
        error: skipped.length
          ? `Could not read file(s): ${skipped.join(', ')}. Use PDF, DOCX, PPTX, TXT, MD or paste text.`
          : 'Provide text or a file.',
      });
    }

    // Pre-computed here, not asked of the model: the exact word/timing budget for the
    // duration bucket the visitor picked. See "duration -> word/timing budget" above.
    const budget = durationBudget(duration);

    // Pre-computed here too: which ICP applies, guessed by a small/cheap model from a
    // short excerpt. The skill's loader opens only the selected reference.
    const classifyExcerpt = [text, ...blocks.filter((b) => b.type === 'text').map((b) => b.text)]
      .join('\n\n')
      .slice(0, ICP_EXCERPT_CHARS);
    const icpDecision = await classifyIcp(classifyExcerpt);
    rec.icp_ready_ms = Date.now() - t0;
    const icpKey = icpDecision.icp;
    const strategyPair = preferenceStore.choosePair(icpKey);
    rec.icp_guess = icpKey; // logging/debugging only, never document content
    rec.icp_source = icpDecision.source;
    rec.icp_new_signal_count = icpDecision.signals?.length || 0;

    const instruction =
      `Use the magnetic-script-engine skill on the document provided below (attached file(s) and/or pasted text).\n` +
      `Target duration: ${duration} (user-picked — respect it per the engine's rules; ` +
      `note in one line if it fights the content, but still deliver on it).\n` +
      `Word/timing budget for this duration — pre-computed, use these numbers directly, do not recompute them:\n` +
      '```json\n' + JSON.stringify(budget, null, 2) + '\n```\n' +
      `Selected ICP key: ${icpKey}\n` +
      `Narrative pair selected from prior A/B picks:\n` +
      `- Version A style key: ${strategyPair.a}\n` +
      `- Version A exact style name: ${STYLES[strategyPair.a]}\n` +
      `- Version B style key: ${strategyPair.b}\n` +
      `- Version B exact style name: ${STYLES[strategyPair.b]}\n` +
      `The system prompt includes all required writing rules and the selected references. Apply them directly. Do not swap the assigned styles.\n\n` +
      `Return the final result in the skill's exact Step 7 format, as plain text — nothing else before or after it. Do not use Markdown or JSON.` +
      (text ? `\n\n--- Pasted text / instructions ---\n${text}` : '');

    // From here on, the wait can run well past a minute — start the keep-alive.
    res.writeHead(200, {
      'Content-Type': streamResults ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    heartbeat = setInterval(() => {
      try { if (streamResults) sendEvent('heartbeat'); else res.write(' '); } catch {}
    }, 15000);

    const onText = (partial) => {
      if (!streamResults) return;
      if (!sentA) {
        const a = completedVersion(partial, 'A');
        if (a) { rec.version_a_ms = Date.now() - t0; sendEvent('version_a', a); sentA = true; }
      }
      if (sentA && !sentB) {
        const b = completedVersion(partial, 'B');
        if (b) { rec.version_b_ms = Date.now() - t0; sendEvent('version_b', b); sentB = true; }
      }
    };
    const system = buildWritingSystem(icpKey, strategyPair.a, strategyPair.b);
    const content = [...blocks, { type: 'text', text: instruction }];
    const { markdown, stopReason } = WRITING_PROVIDER === 'openai'
      ? await callOpenAI(content, system, usage, onText, { apiKey: OPENAI_API_KEY, model: OPENAI_MODEL, maxTokens: MAX_TOKENS })
      : await callClaude(content, system, usage, onText);
    rec.stop_reason = stopReason;

    // Adaptive-thinking models can spend the whole output budget on adaptive thinking before it
    // emits any visible text. Never turn that case into a successful empty result.
    // A capped response may also contain an unfinished script, so don't present it
    // as a complete A/B pair. Already streamed versions remain visible in the UI.
    if (stopReason === 'max_tokens') {
      rec.status = 'output_limit';
      throw new Error('Generation reached its output limit before both scripts were complete. Please retry.');
    }
    if (!markdown) {
      rec.status = 'empty_response';
      throw new Error('Generation finished without a script. Please retry.');
    }

    // Code-side gateway: turn the model's plain text into a stable field set.
    // No AI involved in this step — pure parsing, so it costs no tokens and can't
    // fail on JSON syntax the way asking the model to hand-write JSON could.
    const parsed = parseGateway(markdown, { duration, icp: icpKey });
    rec.status = parsed.ok ? 'ok' : 'parse_error';

    if (!parsed.ok) {
      // Engine didn't follow the fixed heading structure — still hand back readable
      // text so nothing is lost; the frontend has a fallback path for this case.
      return finish({
        text: toPlainText(markdown), skipped, stop_reason: stopReason,
        usage: { ...usage, est_cost_usd: estimateCost(usage), duration_s: Math.round((Date.now() - t0) / 100) / 10 },
      });
    }

    // Only offer feedback for a complete parsed pair; no document or script is stored.
    let abPick = null;
    let abPickStatus = 'ready';
    const stylesMatch =
      parsed.fields.version_a_title.toLowerCase().includes(STYLES[strategyPair.a].toLowerCase()) &&
      parsed.fields.version_b_title.toLowerCase().includes(STYLES[strategyPair.b].toLowerCase());
    if (stylesMatch) {
      try {
        abPick = preferenceStore.createGeneration(icpKey, strategyPair);
      } catch (error) {
        console.error('Could not save A/B generation:', error.message);
        abPickStatus = 'storage_unavailable';
      }
    } else {
      rec.strategy_mismatch = true; // Do not learn from output that ignored the assigned styles.
      abPickStatus = 'strategy_mismatch';
    }
    finish({
      ...parsed.fields, skipped, stop_reason: stopReason,
      ab_pick: abPick ? { ...abPick, icp: icpKey, strategies: strategyPair } : null,
      ab_pick_status: abPickStatus,
      usage: { ...usage, est_cost_usd: estimateCost(usage), duration_s: Math.round((Date.now() - t0) / 100) / 10 },
    });
  } catch (err) {
    rec.error = String(err.message || err).slice(0, 300);
    if (heartbeat || res.headersSent) {
      // Headers already went out as 200 — report the failure inside the JSON body
      // instead of a status code, since the status can no longer be changed.
      finish({ error: err.message || 'Server error' });
    } else {
      throw err; // headers not sent yet — let the outer handler set a proper status code
    }
  } finally {
    Object.assign(rec, usage);
    rec.est_cost_usd = estimateCost(usage);
    rec.duration_ms = Date.now() - t0;
    recordUsage(rec);
  }
}

async function handlePick(req, res) {
  // A bearer token is generated per successful response. Reject oversized input.
  const body = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) return json(res, 413, { error: 'Pick too large.' });
    body.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(body).toString('utf8')); }
  catch { return json(res, 400, { error: 'Invalid JSON.' }); }
  const result = preferenceStore.pick(input || {});
  return json(res, result.ok ? 200 : result.status, result);
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
        return json(res, 200, { ok: true, hasKey: !!OPENAI_API_KEY && (WRITING_PROVIDER !== 'anthropic' || !!ANTHROPIC_API_KEY), skillSource: 'repository', model: WRITING_MODEL, provider: WRITING_PROVIDER, icpModel: ICP_MODEL });
      }
      if (req.method === 'GET' && pathname === '/api/usage') {
        if (!isAdmin(req, url)) { res.writeHead(404); return res.end('Not found'); }
        return json(res, 200, usageSummary());
      }
      if (req.method === 'POST' && pathname === '/api/generate') return await handleGenerate(req, res);
      if (req.method === 'POST' && pathname === '/api/download-pdf') return await handleDownloadPdf(req, res);
      if (req.method === 'POST' && pathname === '/api/pick') return await handlePick(req, res);
      res.writeHead(404); res.end('Not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Server error' });
    }
  })
  .listen(Number(PORT), () => console.log(`Listening on :${PORT}`));
