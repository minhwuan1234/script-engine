// Magnetic Script backend: single file, Node >= 20. Now has 3 deps for server-side
// file -> plain text extraction (mammoth, pdf-parse, jszip) — see "file text extraction" below.
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
//   ICP_SIGNAL_LOG      optional  learned ICP words/phrases. Default ./icp-signals.jsonl
//   ICP_REFRESH_RATE    optional  share of confident matches still checked by Haiku. Default 0.1
//   ICP_SIGNAL_MIN_COUNT optional observations before a learned signal can select an ICP. Default 3
//   PRICE_IN_PER_M      optional  USD per 1M input tokens, default 3   (cost is an ESTIMATE; set to your model's price)
//   PRICE_OUT_PER_M     optional  USD per 1M output tokens, default 15
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
import { createPreferenceStore, STYLES } from './preference-store.js';
import { createIcpSignalStore, ICP_KEYS } from './icp-signal-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  SKILL_ID,
  CLAUDE_MODEL = 'claude-sonnet-4-5',
  ICP_MODEL = 'claude-haiku-4-5-20251001', // small/cheap model, only for the ICP guess below
  MAX_TOKENS = '16000',
  RATE_LIMIT_PER_HOUR = '10',
  ADMIN_TOKEN,
  USAGE_LOG = path.join(__dirname, 'usage.jsonl'),
  PREFERENCE_LOG = path.join(__dirname, 'preferences.jsonl'),
  ICP_SIGNAL_LOG = path.join(__dirname, 'icp-signals.jsonl'),
  ICP_REFRESH_RATE = '0.1',
  ICP_SIGNAL_MIN_COUNT = '3',
  PRICE_IN_PER_M = '3',
  PRICE_OUT_PER_M = '15',
  ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages', // overridable for testing
  PORT = '3000',
} = process.env;

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
 * The model only ever writes plain markdown in the fixed Step 6 structure (see SKILL.md).
 * It is never asked to produce JSON. This function IS the gateway: deterministic, regex-based
 * parsing of that fixed markdown into a stable field set, done entirely in code — costs no
 * model tokens and never depends on the model getting JSON syntax right.
 * duration is NOT parsed out of the text — the caller already knows it (it's what
 * it asked for), so they're passed in directly instead of trusting the model to restate them.
 */
function parseGateway(markdown, { duration }) {
  const md = String(markdown || '').trim();

  const titleMatch = /^#\s+(.*?)(?:\s*[—-]\s*Magnetic Script\s*)?$/m.exec(md);
  const title = titleMatch ? titleMatch[1].trim() : '';

  const icpMatch = /\*\*ICP read:\*\*\s*([^\n]+)/i.exec(md);
  const icp = icpMatch ? icpMatch[1].trim() : '';

  const headingRe = (label) => new RegExp(`^##\\s+${label}\\b[^\\n]*$`, 'im');
  const aHead = headingRe('Version\\s+A').exec(md);
  const bHead = headingRe('Version\\s+B').exec(md);
  const notesHead = headingRe('Engine notes').exec(md);

  if (!aHead || !bHead || bHead.index < aHead.index) {
    return { ok: false, fields: null };
  }

  // preface = everything after the "# ... Magnetic Script" title line and before "## Version A"
  // (ICP line, Doc diagnosis, Recommended setup, What's different tables).
  const titleEnd = titleMatch ? titleMatch.index + titleMatch[0].length : 0;
  const preface_md = md.slice(titleEnd, aHead.index).trim();

  const versionTitle = (headMatch) =>
    headMatch[0].replace(/^##\s+Version\s+[AB]\s*[—-]?\s*/i, '').trim();

  const bEnd = notesHead ? notesHead.index : md.length;
  const version_a_md = md.slice(aHead.index + aHead[0].length, bHead.index).trim();
  const version_b_md = md.slice(bHead.index + bHead[0].length, bEnd).trim();
  const engine_notes_md = notesHead ? md.slice(notesHead.index).trim() : '';

  return {
    ok: true,
    fields: {
      title,
      duration,
      icp,
      preface_md,
      version_a_title: versionTitle(aHead),
      version_a_md,
      version_b_title: versionTitle(bHead),
      version_b_md,
      engine_notes_md,
    },
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
    hook: { seconds: { min: 0, max: 15 }, word_target: { min: 30, max: 40 } },
    vo_word_budget: {
      long_form_pace_150wpm: { min: wordsFor(loS, LONG_FORM_WPM), max: wordsFor(hiS, LONG_FORM_WPM) },
      short_form_pace_160_170wpm: { min: wordsFor(loS, SHORT_FORM_WPM_MIN), max: wordsFor(hiS, SHORT_FORM_WPM_MAX) },
    },
    per_segment_words_per_second_healthy_range: { min: 1.5, max: 3.0 },
  };
}

/* ---------- ICP guess: small/cheap model, not the main model ----------
 * references/icp-lenses.md has 4 branches (healthcare, corporate L&D, publishing, NGO) but any
 * one document only ever needs 1. Instead of having the main model read all 4 every run, a
 * cheap/fast model (Haiku) reads a short excerpt of the doc first and picks one label. Code then
 * hands the main model ONLY that section's text, verbatim from icp-lenses.md, as a pre-computed
 * block — same pattern as the duration budget above. If the guess is wrong or the model has no
 * text to look at (e.g. a scanned PDF), it falls back to "unclear", which is icp-lenses.md's own
 * safest-guardrails default — never a hard failure.
 */
const ICP_LENSES = {
  healthcare: {
    label: 'Healthcare / pharma / patient education',
    text:
      '## Healthcare / pharma / patient education\n\n' +
      '- **Typical docs**: discharge instructions, condition leaflets, medication guides, pre-op prep, HCP education decks.\n' +
      '- **Viewer**: patients and caregivers, often low health literacy, stressed, older, multilingual; or HCPs short on time.\n' +
      '- **What magnetic means**: "this finally makes sense and I know what to do tomorrow morning". Calm clarity beats spectacle; High still works if the drama is the body\'s real signal.\n' +
      '- **Guardrails**:\n' +
      '  - Never contradict, soften, or reinterpret clinical instructions. Thresholds and "call when…" lines stay in the doc\'s terms.\n' +
      '  - No blame ("if you\'d just followed the rules…"). No shame about weight, diet, adherence.\n' +
      '  - No invented outcomes or mortality numbers. Use the doc\'s numbers or `[ADD SOURCED STAT]`.\n' +
      '  - Include "your care team" as an ally; calling is normal, expected, not a failure.\n' +
      '  - Flag in Engine notes anything that needs clinical review (e.g. the engine added a mechanism explanation the doc doesn\'t state).\n' +
      '- **Common failures**: Transfer Failure (knows the rule, misses the moment), False Certainty (nodded at discharge, can\'t explain why).',
  },
  corporate_lnd: {
    label: 'Corporate L&D / compliance / onboarding',
    text:
      '## Corporate L&D / compliance / onboarding\n\n' +
      '- **Typical docs**: policies, SOPs, handbooks, product manuals, safety procedures.\n' +
      '- **Viewer**: employees who were assigned this; skeptical of training; know the "right answer" but act on habit.\n' +
      '- **What magnetic means**: "that\'s actually my Tuesday" — recognisable workplace moments, a bit of wit, no corporate voice.\n' +
      '- **Guardrails**: legal/policy wording that defines obligations stays exact; don\'t imply consequences the policy doesn\'t state; no mocking coworkers or roles.\n' +
      '- **Common failures**: Transfer Failure (knows policy, doesn\'t act under pressure), Cognitive Overload (40-page policy, no hierarchy).',
  },
  publishing: {
    label: 'Publishing / education',
    text:
      '## Publishing / education\n\n' +
      '- **Typical docs**: textbook chapters, course notes, ebooks, study guides, non-fiction excerpts.\n' +
      '- **Viewer**: students or curious adults; may be studying for an exam; used to creator-style YouTube.\n' +
      '- **What magnetic means**: "I get it now, and I want the next one". Curiosity and mental models; High can be very creator-like.\n' +
      '- **Guardrails**: accuracy to the source; don\'t oversimplify into wrongness; keep the author\'s claims attributed as theirs if contestable.\n' +
      '- **Common failures**: Concept Fragmentation (memorised pieces, no model), False Certainty.',
  },
  ngo: {
    label: 'NGO / mission-driven',
    text:
      '## NGO / mission-driven\n\n' +
      '- **Typical docs**: impact reports, program briefs, advocacy papers, research summaries.\n' +
      '- **Viewer**: public, donors, partners, policymakers; emotionally saturated, skeptical of guilt-trips.\n' +
      '- **What magnetic means**: "I see the system, and there\'s something I can do". Stakes story + clear ask.\n' +
      '- **Guardrails**: no poverty/suffering spectacle; no invented beneficiary stories — use the doc\'s, or frame a composite clearly as "imagine"; dignity-first language; the ask must match what the org actually asks for.\n' +
      '- **Common failures**: Transfer Failure (cares, doesn\'t act), Fragmentation (sees tragedy, not cause).',
  },
  unclear: {
    label: 'Unclear ICP',
    text:
      '## Unclear ICP\n\n' +
      'Default to the lens whose guardrails are strictest among the plausible options (in practice: healthcare\'s), and say which you assumed.\n\n' +
      'ICP_LENSES_HEALTHCARE_TEXT_PLACEHOLDER',
  },
};
// "unclear" ships healthcare's guardrails alongside it (strictest set) so the model has a
// concrete lens to fall back to instead of just a label with nothing under it.
ICP_LENSES.unclear.text = ICP_LENSES.unclear.text.replace(
  'ICP_LENSES_HEALTHCARE_TEXT_PLACEHOLDER',
  ICP_LENSES.healthcare.text
);

const ICP_EXCERPT_CHARS = 3000; // plenty to tell these 4 domains apart; keeps the classifier call tiny

// Existing signals make confident classifications locally. Uncertain inputs go to Haiku, and
// a configurable share of confident matches also goes to Haiku so the collection keeps learning.
async function classifyIcp(excerpt) {
  if (!excerpt || excerpt.trim().length < 20) return { icp: 'unclear', source: 'no_text' };
  const local = icpSignalStore.classify(excerpt);
  const refreshRate = Math.max(0, Math.min(1, Number(ICP_REFRESH_RATE) || 0));
  const refresh = local.confident && Math.random() < refreshRate;
  if (local.confident && !refresh) {
    return { ...local, source: 'signals' };
  }
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ICP_MODEL,
        max_tokens: 300,
        system:
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
        messages: [{ role: 'user', content: excerpt.slice(0, ICP_EXCERPT_CHARS) }],
      }),
    });
    if (!res.ok) return local.confident ? { ...local, source: 'signals_fallback' } : { icp: 'unclear', source: 'model_error' };
    const data = await res.json();
    const raw = String(data.content?.[0]?.text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
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
  for (const r of records) {
    const d = r.ts.slice(0, 10);
    (byDay[d] ||= []).push(r);
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
      // Prompt caching: this text block never changes between requests, and the
      // cache_control marker on it tells Anthropic to cache everything up through here
      // (the skill + tool setup). The next request within the cache window reads that
      // whole chunk from cache instead of reprocessing it — this is the fix for "every
      // call pays to reload the skill from scratch". Only the per-request user message
      // below stays dynamic. If a new skill version is pushed, the very next call pays
      // to rebuild the cache once, then goes back to the cheap/fast path.
      system: [
        {
          type: 'text',
          text: 'You are running the magnetic-script-engine skill for the F.Learning Magnetic Script Studio tool. Follow the skill exactly.',
          cache_control: { type: 'ephemeral' },
        },
      ],
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
  // The skill returns plain markdown in the fixed Step 6 structure — never JSON.
  // Strip a stray ```markdown fence in case the model wraps it anyway.
  let markdown = text.trim();
  const fenced = markdown.match(/^```(?:markdown)?\s*([\s\S]*?)\s*```$/);
  if (fenced) markdown = fenced[1].trim();

  return { markdown, stopReason };
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
  let heartbeat = null;

  // Once callClaude() starts, this can run for a while. Node was already streaming from
  // Anthropic internally, but the browser never saw a byte until everything was done —
  // on a slow run, a proxy or the browser itself can give up waiting on a connection with
  // no traffic. finish() sends the response headers up front, then a small space character
  // every 15s to keep the connection visibly alive, and writes the real JSON as the last
  // chunk. Because headers go out early with status 200, success/failure from this point on
  // is signalled by an `error` field inside the JSON body, not the HTTP status — the
  // frontend checks that field first (see index.html).
  const finish = (obj) => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    try {
      res.write(JSON.stringify(obj));
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

    // Pre-computed here too: which ICP lens applies, guessed by a small/cheap model from a
    // short excerpt, so the main model gets only the one section it needs. See "ICP guess" above.
    const classifyExcerpt = [text, ...blocks.filter((b) => b.type === 'text').map((b) => b.text)]
      .join('\n\n')
      .slice(0, ICP_EXCERPT_CHARS);
    const icpDecision = await classifyIcp(classifyExcerpt);
    const icpKey = icpDecision.icp;
    const icpLens = ICP_LENSES[icpKey];
    const strategyPair = preferenceStore.choosePair(icpKey);
    rec.icp_guess = icpKey; // logging/debugging only, never document content
    rec.icp_source = icpDecision.source;
    rec.icp_new_signal_count = icpDecision.signals?.length || 0;

    const instruction =
      `Use the magnetic-script-engine skill on the document provided below (attached file(s) and/or pasted text).\n` +
      `Target duration: ${duration} (user-picked — respect it per the engine's rules; ` +
      `note in one line if it fights the content, but still deliver on it). Infer the platform and series recommendation from the document; state any document-based assumptions in Engine notes.\n` +
      `Word/timing budget for this duration — pre-computed, use these numbers directly, do not recompute them:\n` +
      '```json\n' + JSON.stringify(budget, null, 2) + '\n```\n' +
      `ICP lens — pre-computed guess from the document's own text, already the matching section of references/icp-lenses.md. Use it as-is; if the doc clearly reads as a different ICP once you actually read it, say so in one line in Engine notes and use the better-fitting lens instead:\n` +
      icpLens.text + '\n\n' +
      `Narrative pair for this run, selected by the app from prior A/B picks: Version A must use "${STYLES[strategyPair.a]}" and Version B must use "${STYLES[strategyPair.b]}". Preserve two contrasting scripts and all source facts. Do not swap their styles or substitute another style. State each style in its Version heading.\n\n` +
      `Return the final result in the skill's exact Step 6 markdown structure, as plain text — nothing else before or after it. Do not output JSON.` +
      (text ? `\n\n--- Pasted text / instructions ---\n${text}` : '');

    // From here on, the wait can run well past a minute — start the keep-alive.
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    heartbeat = setInterval(() => { try { res.write(' '); } catch {} }, 15000);

    const { markdown, stopReason } = await callClaude([...blocks, { type: 'text', text: instruction }], usage);

    // Code-side gateway: turn the model's plain markdown into a stable field set.
    // No AI involved in this step — pure parsing, so it costs no tokens and can't
    // fail on JSON syntax the way asking the model to hand-write JSON could.
    const parsed = parseGateway(markdown, { duration });
    rec.status = parsed.ok ? 'ok' : 'parse_error';
    rec.stop_reason = stopReason;

    if (!parsed.ok) {
      // Engine didn't follow the fixed heading structure — still hand back the raw
      // text so nothing is lost; the frontend has a fallback path for this case.
      return finish({
        markdown, skipped, stop_reason: stopReason,
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
        return json(res, 200, { ok: true, hasKey: !!ANTHROPIC_API_KEY, hasSkill: !!SKILL_ID, model: CLAUDE_MODEL });
      }
      if (req.method === 'GET' && pathname === '/api/usage') {
        if (!isAdmin(req, url)) { res.writeHead(404); return res.end('Not found'); }
        return json(res, 200, usageSummary());
      }
      if (req.method === 'POST' && pathname === '/api/generate') return await handleGenerate(req, res);
      if (req.method === 'POST' && pathname === '/api/pick') return await handlePick(req, res);
      res.writeHead(404); res.end('Not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Server error' });
    }
  })
  .listen(Number(PORT), () => console.log(`Listening on :${PORT}`));
