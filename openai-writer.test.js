import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAI, estimateOpenAICost } from './openai-writer.js';

function mockStream(events, inspect = () => {}) {
  return async (url, options) => {
    inspect(url, JSON.parse(options.body));
    const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}`).join('\r\n\r\n'));
    // Split UTF-8 and CRLF boundaries, and omit the last event separator.
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
      controller.close();
    } }));
  };
}
const done = { type: 'response.completed', response: { status: 'completed', usage: {
  input_tokens: 12000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000 },
  output_tokens: 1000, output_tokens_details: { reasoning_tokens: 600 },
} } };
const delta = text => ({ type: 'response.output_text.delta', delta: text });

test('streams Unicode before completion, maps PDF and instructions, accounts for cache without double counting', async () => {
  const partials = [], usage = {};
  const result = await callOpenAI([
    { type: 'text', text: 'Source' },
    { type: 'document', title: 'scan.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'dGVzdA==' } },
  ], [{ text: 'Shared rules', cache_control: { type: 'ephemeral' } }], usage,
  text => partials.push(text), { apiKey: 'test', fetchImpl: mockStream([
    delta('VERSION A — Giải thích\n'), delta('VERSION B — Journey\n'), done,
  ], (url, body) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(body.model, 'gpt-6-sol');
    assert.deepEqual(body.reasoning, { effort: 'medium' });
    assert.equal(body.store, false);
    assert.equal(body.input[0].content[0].text, 'Shared rules');
    assert.equal(body.input[0].content[0].cache_control, undefined);
    assert.equal(body.input[1].content[1].file_data, 'data:application/pdf;base64,dGVzdA==');
  }) });
  assert.equal(partials.length, 2);
  assert.match(partials[0], /Giải thích/);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.cache_read_input_tokens, 4000);
  assert.equal(usage.cache_creation_input_tokens, 7000);
  assert.equal(usage.reasoning_tokens, 600);
  assert.equal(estimateOpenAICost(usage), 0.0303);
});

test('truncated streams and upstream errors cannot become successful output', async () => {
  for (const events of [
    [delta('Partial')],
    [{ type: 'response.failed', response: { error: { message: 'Failed' } } }],
    [{ type: 'error', message: 'Failed' }],
    [{ type: 'response.refusal.done', refusal: 'Declined' }],
  ]) await assert.rejects(callOpenAI([], [], {}, undefined, { apiKey: 'test', fetchImpl: mockStream(events) }));
});

test('output limit is passed to the existing incomplete-output guard', async () => {
  const response = await callOpenAI([], [], {}, undefined, { apiKey: 'test', fetchImpl: mockStream([
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
  ]) });
  assert.equal(response.stopReason, 'max_tokens');
});

test('HTTP error and missing key are actionable', async () => {
  await assert.rejects(callOpenAI([], [], {}, undefined, {}), /OPENAI_API_KEY/);
  await assert.rejects(callOpenAI([], [], {}, undefined, { apiKey: 'test', fetchImpl: async () =>
    new Response(JSON.stringify({ error: { message: 'Invalid key' } }), { status: 401 }) }), /Invalid key/);
});

test('long prompt pricing includes cached and written tokens', () => {
  assert.equal(estimateOpenAICost({ input_tokens: 100000, cache_read_input_tokens: 100000,
    cache_creation_input_tokens: 100000, output_tokens: 10000 }), 1.09);
});
