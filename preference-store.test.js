import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPreferenceStore, STYLES } from './preference-store.js';
import { buildWritingSystem } from './writing-instructions.js';

function fixture(t, events = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-preference-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'preferences.jsonl');
  fs.writeFileSync(filename, events.map((event) => JSON.stringify(event)).join('\n'));
  return createPreferenceStore(filename);
}

test('retired comparisons retain the active opponent history without a retired score', (t) => {
  const store = fixture(t, [
    { type: 'generated', id: 'old-journey', icp: 'healthcare', a: 'journey', b: 'myth', ts: Date.now() },
    { type: 'picked', id: 'old-journey', choice: 'B' },
    { type: 'generated', id: 'old-mechanism', icp: 'healthcare', a: 'mechanism', b: 'journey', ts: Date.now() },
    { type: 'picked', id: 'old-mechanism', choice: 'B' },
  ]);
  const scores = store.stats('healthcare');
  assert.equal(scores.journey, undefined);
  assert.deepEqual(scores.myth, { globalWins: 1, globalN: 1, icpWins: 1, icpN: 1 });
  assert.deepEqual(scores.mechanism, { globalWins: 0, globalN: 1, icpWins: 0, icpN: 1 });
});

test('retired styles cannot create new generations; active feedback remains idempotent', (t) => {
  const store = fixture(t);
  assert.throws(() => store.createGeneration('healthcare', { a: 'journey', b: 'myth' }), /retired/);
  const generation = store.createGeneration('healthcare', { a: 'myth', b: 'mechanism' });
  assert.deepEqual(store.pick({ ...generation, choice: 'A' }), { ok: true });
  assert.deepEqual(store.pick({ ...generation, choice: 'A' }), { ok: true, duplicate: true });
  assert.equal(store.stats('healthcare').myth.globalN, 1);
});

test('all ICP candidates and writing prompts exclude retired Journey style and samples', (t) => {
  const store = fixture(t);
  assert.equal(STYLES.journey, undefined);
  for (const icp of ['healthcare', 'corporate_lnd', 'publishing', 'ngo', 'unclear']) {
    const pairs = new Set();
    for (let i = 0; i < 300; i++) {
      const pair = store.choosePair(icp);
      assert.ok(STYLES[pair.a] && STYLES[pair.b]);
      assert.notEqual(pair.a, pair.b);
      pairs.add([pair.a, pair.b].sort().join('/'));
    }
    assert.ok(pairs.size > 1, `${icp} must still support alternative exploration`);
    for (const a of Object.keys(STYLES)) for (const b of Object.keys(STYLES)) {
      const prompt = buildWritingSystem(icp, a, b).map((block) => block.text).join('\n');
      assert.doesNotMatch(prompt, /First-person journey|style-journey\.md/i);
    }
  }
  assert.throws(() => buildWritingSystem('healthcare', 'journey', 'myth'), /Invalid/);
});
