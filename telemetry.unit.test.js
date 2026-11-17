import test from 'node:test';
import assert from 'node:assert/strict';
import { sendTelemetryToDashboard } from './telemetry.js';

test('dispatches schemaVersion 2.2 with stepType, description, llmUsage and no fake browser timings', async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalFetch = globalThis.fetch;
  let capturedPayload = null;
  process.env.NODE_ENV = 'production';

  globalThis.fetch = async (_url, init) => {
    capturedPayload = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => 'ok' };
  };

  try {
    const ok = await sendTelemetryToDashboard({
      status: 'ok',
      model: 'gpt-6-sol',
      files: ['pdf'],
      duration_ms: 12000,
      extract_ms: 400,
      icp_ready_ms: 1200,
      version_a_ms: 5000,
      version_b_ms: 9500,
      accepted_ms: 110,
      input_tokens: 18500,
      output_tokens: 4200,
      est_cost_usd: 0.058,
      llm_calls: 3,
      submission_id: 'unit_123',
    });

    assert.equal(ok, true);
    assert.equal(capturedPayload.schemaVersion, '2.2');
    assert.equal(capturedPayload.model, undefined);
    assert.equal(capturedPayload.responseTimeMs, undefined);
    assert.equal(capturedPayload.clickLatencyMs, undefined);
    assert.ok(capturedPayload.stages.length >= 4);
    for (const s of capturedPayload.stages) {
      assert.ok(s.stepType === 'AI' || s.stepType === 'NON_AI');
      assert.ok(typeof s.description === 'string' && s.description.length > 0);
    }
    assert.equal(capturedPayload.llmUsage.inputTokens, 18500);
    assert.equal(capturedPayload.llmUsage.outputTokens, 4200);
    assert.equal(capturedPayload.llmUsage.estimatedCostUsd, 0.058);
    assert.equal(capturedPayload.llmUsage.llmCallsCount, 3);
  } finally {
    process.env.NODE_ENV = originalEnv;
    globalThis.fetch = originalFetch;
  }
});

test('omits estimatedCostUsd when 0, skips when NODE_ENV=test, and stays fail-safe on network error', async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalFetch = globalThis.fetch;
  let capturedPayload = null;

  try {
    process.env.NODE_ENV = 'test';
    const skipped = await sendTelemetryToDashboard({ status: 'ok', duration_ms: 1000 });
    assert.equal(skipped, false);

    process.env.NODE_ENV = 'production';
    globalThis.fetch = async (_url, init) => {
      capturedPayload = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    await sendTelemetryToDashboard({
      status: 'ok',
      duration_ms: 3000,
      input_tokens: 1000,
      output_tokens: 200,
      est_cost_usd: 0,
    });
    assert.equal(capturedPayload.llmUsage.estimatedCostUsd, undefined);
    assert.equal(capturedPayload.llmUsage.llmCallsCount, undefined);

    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    const ok = await sendTelemetryToDashboard({ status: 'ok', duration_ms: 1000 });
    assert.equal(ok, false);
  } finally {
    process.env.NODE_ENV = originalEnv;
    globalThis.fetch = originalFetch;
  }
});
