import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, recordRuns, workloadOf, handleLabMonitoring, MAIN_JOB, STEPS } from './lab-monitoring.js';

const NOW = Date.parse('2026-11-10T10:00:00Z');
const rec = (extra) => ({ ts: '2026-11-10T09:00:00.000Z', status: 'ok', duration: '2-3 mins', level: 'Medium', files: ['docx'], text_chars: 0,
  extract_ms: 55, icp_ready_ms: 55, version_a_ms: 40000, version_b_ms: 80000, duration_ms: 82000, visitor: 'v1', submission_id: 'sub-1', ...extra });

test('a generate request becomes a run with timed steps and no personal data', () => {
  const runs = recordRuns(rec({ files: ['docx', 'pdf'], text_chars: 120 }), 0);
  assert.deepEqual(runs[0], { job: MAIN_JOB, runId: 'gen:sub-1', workload: '2 tài liệu · DOCX + PDF + text · video 2–3 phút · Medium',
    status: 'success', startedAt: '2026-11-10T09:00:00.000Z', endedAt: '2026-11-10T09:01:22.000Z' });
  assert.deepEqual(runs.slice(1).map((r) => [r.job, Date.parse(r.endedAt) - Date.parse(r.startedAt), r.parentRunId]), [
    ['Đọc tài liệu', 55, 'gen:sub-1'], ['Viết Version A', 39945, 'gen:sub-1'], ['Viết Version B', 40000, 'gen:sub-1'], ['Hoàn thiện & lưu kết quả', 2000, 'gen:sub-1']]);
  assert.ok(!JSON.stringify(runs).includes('v1'), 'no visitor id');
});

test('repository mode adds ICP classification; failures and refusals are handled', () => {
  const icp = recordRuns(rec({ icp_model: 'gpt-5.6-luna', icp_ready_ms: 1200 }), 0).map((r) => r.job);
  assert.ok(icp.includes('Phân loại ICP'));
  const failed = recordRuns(rec({ status: 'output_limit', version_a_ms: 40000, version_b_ms: undefined, duration_ms: 120000 }), 0);
  assert.equal(failed[0].status, 'failed');
  assert.deepEqual(failed.slice(1).map((r) => [r.job, r.status]), [['Đọc tài liệu', 'success'], ['Viết kịch bản (A + B)', 'failed']],
    'without both version marks the writing is one step, and it carries the failure');
  assert.deepEqual(recordRuns(rec({ status: 'rate_limited' }), 0), [], 'refused requests are not runs');
  assert.equal(workloadOf({ duration: 'upto 5 mins', level: 'High', text_chars: 50 }), '1 tài liệu · text · video tới 5 phút · High');
});

test('the report follows app-monitoring-v1 with profile, runs and response time', () => {
  const records = [rec({}), rec({ ts: '2026-11-01T09:00:00.000Z', submission_id: 'sub-2', version_a_ms: 30000 }), rec({ ts: '2026-08-01T00:00:00.000Z', submission_id: 'old' })];
  const r = buildReport(records, { days: 7, now: NOW });
  assert.equal(r.protocol, 'app-monitoring-v1');
  assert.equal(r.appId, 'script-engine');
  assert.equal(r.window.days, 7);
  assert.deepEqual(r.profile.mainJob, { job: MAIN_JOB, steps: STEPS });
  assert.equal(r.jobRuns.runs.filter((x) => x.job === MAIN_JOB).length, 2, 'runs older than 61 days are left out');
  assert.deepEqual(r.performanceKpis.responseTime, { p95Ms: 40000, samples: 1 }, 'only the 7-day window counts for the KPI');
  assert.equal(r.database.status, 'ready');
});

test('the endpoint is disabled without a token and checks the bearer token and days', () => {
  const call = (token, auth, days = '7') => {
    const out = {};
    handleLabMonitoring({ headers: { authorization: auth } }, { writeHead: (s, h) => { out.status = s; out.headers = h; }, end: (b) => { out.body = b; } },
      new URL('http://x/internal/monitoring?days=' + days), { token, records: [rec({})], commit: 'abc', startedAt: null });
    return out;
  };
  const token = 't'.repeat(40);
  assert.equal(call('', 'Bearer x').status, 404);
  assert.equal(call(token, 'Bearer nope').status, 401);
  assert.equal(call(token, 'Bearer ' + token, '99').status, 422);
  const ok = call(token, 'Bearer ' + token);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['Cache-Control'], 'private, no-store');
  assert.equal(JSON.parse(ok.body).runtime.commit, 'abc');
});
