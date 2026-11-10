// Read-only report for AI Agent Lab's Performance tab (protocol app-monitoring-v1, profile-v1).
// Built from the usage records the server already keeps for each /api/generate request
// (timestamps, offsets, status, file extensions). No document text, file names, scripts or
// visitor identifiers leave the app.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const APP_ID = 'script-engine';
export const MAIN_JOB = 'Tạo 2 phiên bản script';
export const STEPS = ['Đọc tài liệu', 'Phân loại ICP', 'Viết Version A', 'Viết Version B', 'Hoàn thiện & lưu kết quả'];
const COMBINED_WRITE = 'Viết kịch bản (A + B)';
const HORIZON_DAYS = 61;
// Statuses that are not a script run: refused before any work started.
const NOT_A_RUN = new Set(['rate_limited', 'bad_request']);
const durationLabels = { '30s-60s': 'video 30–60s', '2-3 mins': 'video 2–3 phút', 'upto 5 mins': 'video tới 5 phút' };

const ms = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

// "1 tài liệu · DOCX + text · video 2–3 phút · Medium" — extensions only, never file names.
export function workloadOf(rec) {
  const files = Array.isArray(rec.files) ? [...new Set(rec.files.map((f) => String(f).toUpperCase().slice(0, 6)))] : [];
  const parts = [...files, rec.text_chars > 0 ? 'text' : null].filter(Boolean);
  const kind = files.length > 1 ? files.length + ' tài liệu' : '1 tài liệu';
  return [kind + (parts.length ? ' · ' + parts.join(' + ') : ''), durationLabels[rec.duration] || rec.duration || null, rec.level || null]
    .filter(Boolean).join(' · ').slice(0, 200);
}

// One usage record → the main run and its steps (offsets from the request start).
export function recordRuns(rec, index) {
  if (!rec || NOT_A_RUN.has(rec.status)) return [];
  const start = Date.parse(rec.ts);
  const total = ms(rec.duration_ms);
  if (!Number.isFinite(start) || total === null) return [];
  const runId = 'gen:' + (rec.submission_id || crypto.createHash('sha256').update(rec.ts + ':' + index).digest('hex').slice(0, 16));
  const workload = workloadOf(rec);
  const status = rec.status === 'ok' ? 'success' : 'failed';
  const at = (offset) => new Date(start + offset).toISOString();
  const main = { job: MAIN_JOB, runId, workload, status, startedAt: at(0), endedAt: at(total) };
  // Step boundaries in order; a step is sent only when both ends are known and in order.
  const extract = ms(rec.extract_ms), icp = ms(rec.icp_ready_ms), a = ms(rec.version_a_ms), b = ms(rec.version_b_ms);
  const marks = [['Đọc tài liệu', 0, extract]];
  if (rec.icp_model) marks.push(['Phân loại ICP', extract, icp]);
  const writeFrom = rec.icp_model ? icp : extract;
  if (a !== null && b !== null) {
    marks.push(['Viết Version A', writeFrom, a], ['Viết Version B', a, b], ['Hoàn thiện & lưu kết quả', b, total]);
  } else {
    marks.push([COMBINED_WRITE, writeFrom, total]);
  }
  const steps = marks.flatMap(([job, from, to], k) => from !== null && to !== null && from <= to && to <= total
    ? [{ job, runId: runId + ':' + k, parentRunId: runId, parent: MAIN_JOB, workload,
        // The step that was running when the request failed carries the failure.
        status: status === 'failed' && to === total ? 'failed' : 'success', startedAt: at(from), endedAt: at(to) }]
    : []);
  return [main, ...steps];
}

export const KPI_STANDARD = 'ui-kpi-v2';
// Browser metrics accepted by POST /api/monitoring/ui-sample, with their upper bound (ms).
export const UI_METRICS = { clickLatency: 60000, responseTime: 600000 };

// Nearest-rank P95 over the raw samples (0.1 ms precision as stored), no bucketing or smoothing.
export const p95 = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  return sorted.length
    ? { p95Ms: sorted[Math.ceil(0.95 * sorted.length) - 1], samples: sorted.length, precision: 'exact' }
    : { p95Ms: null, samples: 0, precision: 'exact' };
};

export function buildReport(records, { days, now = Date.now(), commit = null, startedAt = null, uiSamples = [] } = {}) {
  const horizon = now - HORIZON_DAYS * 86400000;
  const windowStart = now - days * 86400000;
  const recent = records.filter((r) => Date.parse(r.ts) >= horizon);
  const runs = recent.flatMap(recordRuns).sort((x, y) => Date.parse(y.endedAt) - Date.parse(x.endedAt));
  const inWindow = recent.filter((r) => Date.parse(r.ts) >= windowStart && !NOT_A_RUN.has(r.status));
  const memory = process.memoryUsage();
  return {
    protocol: 'app-monitoring-v1',
    appId: APP_ID,
    generatedAt: new Date(now).toISOString(),
    window: { days, since: new Date(windowStart).toISOString(), timeZone: 'UTC' },
    runtime: {
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
      uptimeSeconds: Math.round(process.uptime()), nodeVersion: process.version, commit, startedAt,
    },
    // No database is required: the report reads the server's usage records, so it is always ready.
    database: { status: 'ready' },
    jobRuns: { since: new Date(horizon).toISOString(), complete: records.length < 5000, runs: runs.slice(0, 5000) },
    // ui-kpi-v2: both KPIs are measured in the browser (index.html) from the Generate click.
    // responseTime ends when the UI shows the server's first stream event (`accepted`) — it never
    // waits for Version A or the AI; Version A time stays visible as a step in jobRuns.
    performanceKpis: {
      standard: KPI_STANDARD,
      responseTime: p95(uiSamples.filter((x) => x.metric === 'responseTime' && Date.parse(x.ts) >= windowStart).map((x) => x.ms)),
      clickLatency: p95(uiSamples.filter((x) => x.metric === 'clickLatency' && Date.parse(x.ts) >= windowStart).map((x) => x.ms)),
      jobs: { executed: inWindow.length, validCompletions: inWindow.filter((r) => r.status === 'ok').length, technicalErrors: null },
    },
    profile: {
      version: 'profile-v1',
      mainJob: { job: MAIN_JOB, steps: STEPS },
      kpiDescriptions: {
        responseTime: "Bắt đầu: thời điểm bấm 'Generate' (event.timeStamp, hoặc performance.now() khi bắt đầu xử lý) → Kết thúc: "
          + "khung hình thứ 2 (requestAnimationFrame lồng nhau) sau khi giao diện hiển thị hệ thống đã nhận yêu cầu "
          + "(sự kiện stream đầu tiên 'accepted' từ /api/generate). Đo trong trình duyệt, không chờ Version A hay AI viết xong.",
        clickLatency: "Bắt đầu: thời điểm bấm 'Generate' (event.timeStamp, hoặc performance.now() khi bắt đầu xử lý) → Kết thúc: "
          + "khung hình thứ 2 (requestAnimationFrame lồng nhau) sau khi màn hình 'đang tạo script' được hiển thị. Đo trong trình duyệt.",
      },
    },
  };
}

// GET /internal/monitoring?days=1..30 — disabled until LAB_MONITORING_TOKEN (≥ 32 chars) is set.
export function handleLabMonitoring(req, res, url, { token, records, commit, startedAt, uiSamples = [] }) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
    res.end(JSON.stringify(body));
  };
  if (!token || token.length < 32) return send(404, { error: 'Not found' });
  const supplied = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from('Bearer ' + token);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(401, { error: 'Unauthorized' });
  const days = Number(url.searchParams.get('days') || 7);
  if (!Number.isInteger(days) || days < 1 || days > 30) return send(422, { error: 'days must be 1..30' });
  return send(200, buildReport(records, { days, commit, startedAt, uiSamples }));
}

// Browser UI samples (clickLatency, responseTime): bounded, rate-limited per IP and metric, kept in memory and appended to
// a JSONL file next to the usage log so they survive redeploys on a volume. Only the metric name,
// the duration and the time are stored.
export function createUiSamples({ file, max = 5000, perHour = 60, now = () => Date.now() } = {}) {
  let samples = [];
  try {
    if (file && fs.existsSync(file)) {
      samples = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-max)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((x) => x && Object.hasOwn(UI_METRICS, x.metric) && Number.isFinite(x.ms));
    }
  } catch {}
  const hits = new Map();
  return {
    list: () => samples,
    // Returns an HTTP status: 204 stored, 400 invalid, 413 too large, 429 rate limited.
    record(body, ip) {
      if (typeof body !== 'string' || body.length > 200) return 413;
      let input;
      try { input = JSON.parse(body); } catch { return 400; }
      const metric = input?.metric;
      const value = typeof input?.ms === 'number' ? input.ms : NaN;
      if (typeof metric !== 'string' || !Object.hasOwn(UI_METRICS, metric) || !Number.isFinite(value) || value < 0 || value > UI_METRICS[metric]) return 400;
      const t = now(), key = metric + ':' + String(ip || '').slice(0, 64);
      const recent = (hits.get(key) || []).filter((x) => t - x < 3600000);
      if (recent.length >= perHour) return 429;
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) hits.clear();
      const sample = { ts: new Date(t).toISOString(), metric, ms: Math.round(value * 10) / 10 };
      samples.push(sample);
      if (samples.length > max) samples.shift();
      if (file) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.appendFile(file, JSON.stringify(sample) + '\n', () => {});
        } catch {}
      }
      return 204;
    },
  };
}

// POST /api/monitoring/ui-sample — body {"metric":"clickLatency"|"responseTime","ms":number}.
export async function handleUiSample(req, res, uiSamples, ip) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 200) { res.writeHead(413); return res.end(); }
    chunks.push(chunk);
  }
  const status = uiSamples.record(Buffer.concat(chunks).toString('utf8'), ip);
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}
