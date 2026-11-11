// Test script for verifying script-engine telemetry dispatch to Dashboard
import { sendTelemetryToDashboard } from './telemetry.js';

async function main() {
  console.log('Testing script-engine telemetry dispatch...');

  const mockRec = {
    ts: new Date().toISOString(),
    status: 'ok',
    model: 'gpt-6-sol',
    provider: 'openai',
    files: ['pdf', 'docx'],
    duration: '2-3 mins',
    level: 'Medium',
    duration_ms: 84500,
    extract_ms: 1250,
    icp_ready_ms: 3800,
    icp_guess: 'medical_educator',
    icp_source: 'original_skill',
    version_a_ms: 41200,
    version_b_ms: 78900,
    accepted_ms: 110,
    input_tokens: 18500,
    output_tokens: 4200,
    est_cost_usd: 0.058,
    submission_id: 'test_demo_' + Date.now(),
  };

  const ok = await sendTelemetryToDashboard(mockRec, {
    clickLatencyMs: 85,
    responseTimeMs: 110,
  });

  console.log(`Telemetry test result: ${ok ? 'SUCCESS' : 'FAILED'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
