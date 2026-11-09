// Read-only report for AI Agent Lab's Performance tab (protocol app-monitoring-v1, profile-v1).
// Built from the usage records the server already keeps for each /api/generate request
// (timestamps, offsets, status, file extensions). No document text, file names, scripts or
// visitor identifiers leave the app.
import crypto from 'node:crypto';

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

const p95 = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  return sorted.length ? { p95Ms: sorted[Math.ceil(0.95 * sorted.length) - 1], samples: sorted.length } : { p95Ms: null, samples: 0 };
};

export function buildReport(records, { days, now = Date.now(), commit = null, startedAt = null } = {}) {
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
    // Server-side time from the request to Version A being sent (first meaningful result).
    performanceKpis: {
      responseTime: p95(inWindow.map((r) => ms(r.version_a_ms))),
      jobs: { executed: inWindow.length, validCompletions: inWindow.filter((r) => r.status === 'ok').length, technicalErrors: null },
    },
    profile: {
      version: 'profile-v1',
      mainJob: { job: MAIN_JOB, steps: STEPS },
      kpiDescriptions: { responseTime: 'Gửi yêu cầu tạo script → Version A được gửi về trình duyệt (đo phía server)' },
    },
  };
}

// GET /internal/monitoring?days=1..30 — disabled until LAB_MONITORING_TOKEN (≥ 32 chars) is set.
export function handleLabMonitoring(req, res, url, { token, records, commit, startedAt }) {
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
  return send(200, buildReport(records, { days, commit, startedAt }));
}
