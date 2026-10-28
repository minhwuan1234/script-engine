import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

test('original mode returns two parsed versions and skips the ICP key', async (t) => {
  const script = `# A familiar number — Magnetic Script
## Doc diagnosis
The viewer checks a daily weight.
## Version A — Myth-buster: "The morning check"
### Hook (0:00–0:15) — free preview
| Time | Voiceover | On screen |
|---|---|---|
| 0:00–0:15 | My scale tells me when to call. | A scale by the bed. |
### Script
| Time | Voiceover | On screen |
|---|---|---|
| 0:15–0:30 | Write down the number. | A daily log. |
**Why we wrote it this way:** A familiar routine becomes useful.
**Best when:** Viewers already own a scale.
## Version B — Mechanism reveal: "What changes"
### Hook (0:00–0:15) — free preview
| Time | Voiceover | On screen |
|---|---|---|
| 0:00–0:15 | A small change can tell a larger story. | A rising scale. |
### Script
| Time | Voiceover | On screen |
|---|---|---|
| 0:15–0:30 | Track the change each morning. | Two dates in a log. |
**Why we wrote it this way:** A number becomes a signal.
**Best when:** Viewers need the reason to remember the habit.
## Engine notes
- Mocked generation for parser verification.
`;
  let upstreamRequest;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequest = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: {
      input_tokens: 120, cache_read_input_tokens: 50, cache_creation_input_tokens: 10,
    } } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: script } })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 80 } })}\n\n`);
  });
  await listen(upstream);
  t.after(() => close(upstream));
  const appPortServer = http.createServer();
  await listen(appPortServer);
  const appPort = appPortServer.address().port;
  await close(appPortServer);
  const app = spawn(process.execPath, ['server.js'], {
    cwd: new URL('.', import.meta.url).pathname,
    env: { ...process.env, PORT: String(appPort), SKILL_SOURCE: 'original',
      WRITING_PROVIDER: 'anthropic', CLAUDE_API: 'test-key', OPENAI_API_KEY: '',
      ANTHROPIC_API_URL: `http://127.0.0.1:${upstream.address().port}/messages`,
      USAGE_LOG: '/tmp/original-mode-test-usage.jsonl',
      PREFERENCE_LOG: '/tmp/original-mode-test-prefs.jsonl',
      ICP_SIGNAL_LOG: '/tmp/original-mode-test-icp.jsonl' },
  });
  t.after(() => app.kill());
  const base = `http://127.0.0.1:${appPort}`;
  let health;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { health = await (await fetch(`${base}/api/health`)).json(); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  assert.equal(health?.skillSource, 'original');
  assert.equal(health.hasKey, true);
  const form = new FormData();
  form.append('text', 'Track your weight every morning.');
  form.append('duration', '30s-60s');
  // The unchanged main UI has no Crazy-level control; the backend uses Medium.
  const response = await fetch(`${base}/api/generate`, { method: 'POST', body: form });
  const result = await response.json();
  assert.equal(result.skill_source, 'original');
  assert.equal(result.level, 'Medium');
  assert.equal(result.ab_pick_status, 'skill_selected');
  assert.equal(result.ab_pick, null);
  assert.equal(result.usage.input_tokens, 120);
  assert.equal(result.usage.cache_read_input_tokens, 50);
  assert.equal(result.usage.output_tokens, 80);
  assert.ok(result.usage.duration_s >= 0);
  assert.match(result.version_a_text, /Why we wrote it this way:/i);
  assert.match(result.version_a_text, /^HOOK \(0:00-0:15\)$/m);
  assert.match(result.version_b_text, /Best when:/i);
  assert.match(upstreamRequest.system[0].text, /===== SKILL.md =====/);
  assert.match(upstreamRequest.system[0].text, /===== ADDITIONAL REFERENCE: example-guidance\.md =====/);
  assert.match(upstreamRequest.messages[0].content.at(-1).text, /Crazy level: Medium/);
  const streamed = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { Accept: 'application/x-ndjson' }, body: form,
  });
  const events = (await streamed.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['version_a', 'version_b', 'complete']);
  assert.equal(events.at(-1).data.usage.output_tokens, 80);
  const pdf = await fetch(`${base}/api/download-pdf`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 'A', title: result.title, style: result.version_a_title,
      duration: result.duration, text: result.version_a_text }),
  });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});
