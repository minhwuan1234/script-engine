// Telemetry Client for F.Learning Tool Performance Dashboard
// Zero-configuration telemetry sender for script-engine

const DEFAULT_DASHBOARD_URL = 'https://dashboard-tool-performance.up.railway.app';
const TOOL_SLUG = 'script-engine';
const TOOL_NAME = 'Magnetic Script Engine';
const MAIN_JOB_NAME = 'Tạo 2 phiên bản script';

/**
 * Builds discrete, non-overlapping subjob stages from the actual execution timing offsets.
 */
export function buildSubJobStages(rec) {
  const total = Number(rec.duration_ms) || 0;
  const extractMs = Number(rec.extract_ms) || 0;
  const icpMs = Number(rec.icp_ready_ms) || extractMs;
  const versionAMs = Number(rec.version_a_ms) || null;
  const versionBMs = Number(rec.version_b_ms) || null;

  const stages = [];

  // Stage 1: Document Extraction
  const dur1 = Math.max(0, extractMs);
  stages.push({
    code: '01_extract_doc',
    name: 'Bóc tách văn bản gốc',
    nameEn: 'Document Extraction',
    durationMs: dur1,
    status: 'SUCCESS',
    summary: rec.files && rec.files.length ? `Đọc ${rec.files.length} tài liệu (${rec.files.join(', ')})` : 'Đọc tài liệu đầu vào',
  });

  // Stage 2: ICP Classification & Strategy
  const dur2 = Math.max(0, icpMs - extractMs);
  if (dur2 > 0 || rec.icp_guess) {
    stages.push({
      code: '02_icp_strategy',
      name: 'Phân loại ICP & Chiến lược',
      nameEn: 'ICP & Strategy Selection',
      durationMs: dur2,
      status: 'SUCCESS',
      summary: rec.icp_guess ? `ICP: ${rec.icp_guess} (Source: ${rec.icp_source || 'skill'})` : 'Xác định nhóm đối tượng',
    });
  }

  // Stage 3 & 4: Version A & B or Combined Writing
  const writeStart = dur2 > 0 ? icpMs : extractMs;
  if (versionAMs !== null && versionBMs !== null && versionAMs >= writeStart && versionBMs >= versionAMs) {
    const durA = Math.max(0, versionAMs - writeStart);
    stages.push({
      code: '03_write_version_a',
      name: 'Viết kịch bản Version A',
      nameEn: 'Script Version A Generation',
      durationMs: durA,
      status: 'SUCCESS',
      summary: 'Hoàn thành bản thảo kịch bản Version A',
    });

    const durB = Math.max(0, versionBMs - versionAMs);
    stages.push({
      code: '04_write_version_b',
      name: 'Viết kịch bản Version B',
      nameEn: 'Script Version B Generation',
      durationMs: durB,
      status: 'SUCCESS',
      summary: 'Hoàn thành bản thảo kịch bản Version B tương phản',
    });

    const dur5 = Math.max(0, total - versionBMs);
    stages.push({
      code: '05_parse_finalize',
      name: 'Chuẩn hóa kịch bản & Lưu trữ',
      nameEn: 'Parsing & Archiving',
      durationMs: dur5,
      status: rec.status === 'ok' ? 'SUCCESS' : 'ERROR',
      summary: rec.status === 'ok' ? 'Hoàn thiện bảng thoại, trực quan & lưu trữ' : (rec.error || 'Lỗi xử lý'),
    });
  } else {
    // Non-streaming fallback: writing is recorded as one block
    const durWrite = Math.max(0, total - writeStart);
    stages.push({
      code: '03_write_combined',
      name: 'Viết kịch bản (Version A + B)',
      nameEn: 'Full Script Generation (A + B)',
      durationMs: durWrite,
      status: rec.status === 'ok' ? 'SUCCESS' : 'ERROR',
      summary: rec.status === 'ok' ? 'Sinh hoàn thiện 2 bản kịch bản tương phản' : (rec.error || 'Lỗi xử lý'),
    });
  }

  return stages;
}

/**
 * Dispatches a completed generation execution to Dashboard Control Plane
 */
export async function sendTelemetryToDashboard(rec, options = {}) {
  const dashboardUrl = (process.env.FLEARNING_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
  const secret = process.env.FLEARNING_TELEMETRY_SECRET || '';
  const appUrl = process.env.PUBLIC_APP_URL || '';

  const endpoint = `${dashboardUrl}/api/webhooks/telemetry/${TOOL_SLUG}`;

  const stages = buildSubJobStages(rec);
  const totalDurationMs = Math.max(1, Number(rec.duration_ms) || 0);

  // Response time: time to accepted event (or fallback to extract_ms / 50ms)
  const responseTimeMs = rec.accepted_ms ? Number(rec.accepted_ms) : (options.responseTimeMs || 120);
  const clickLatencyMs = options.clickLatencyMs || 90;

  const workloadParts = [];
  if (rec.files && rec.files.length) {
    workloadParts.push(`${rec.files.length} tài liệu (${rec.files.map((f) => String(f).toUpperCase()).join(', ')})`);
  } else if (rec.text_chars) {
    workloadParts.push(`${rec.text_chars} ký tự`);
  }
  if (rec.duration) workloadParts.push(rec.duration);
  if (rec.level) workloadParts.push(`Level: ${rec.level}`);
  const workload = workloadParts.join(' · ') || 'Tài liệu video script';

  const payload = {
    toolSlug: TOOL_SLUG,
    toolName: TOOL_NAME,
    mainJob: MAIN_JOB_NAME,
    jobName: MAIN_JOB_NAME,
    appUrl: appUrl || undefined,
    railwayProjectId: process.env.RAILWAY_PROJECT_ID || 'script-engine-project',
    railwayServiceId: process.env.RAILWAY_SERVICE_ID || undefined,
    runId: rec.submission_id ? `sub_${rec.submission_id}` : `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: rec.status === 'ok' ? 'SUCCESS' : 'ERROR',
    durationMs: totalDurationMs,
    responseTimeMs,
    clickLatencyMs,
    workload,
    modelName: rec.model || process.env.OPENAI_MODEL || 'gpt-6-sol',
    inputTokens: rec.input_tokens || undefined,
    outputTokens: rec.output_tokens || undefined,
    costUsd: rec.est_cost_usd || undefined,
    stages,
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (secret) {
      headers['Authorization'] = `Bearer ${secret}`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[Telemetry] Failed to dispatch to dashboard (HTTP ${res.status}): ${errText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[Telemetry] Network error dispatching to dashboard:`, err.message);
    return false;
  }
}
