import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptPreview, publicScriptResult } from './script-preview.js';

const full = `HOOK (0:00-0:15)
TIME: 0:00-0:15
VOICEOVER: Your morning check starts with one number.
ON SCREEN: A scale shows today's reading.

SCRIPT
TIME: 0:15-0:35
VOICEOVER: Write down today's number. Compare it with yesterday. This third sentence must stay locked.
ON SCREEN: A private visual detail.

WHY WE WROTE IT THIS WAY: Private rationale.
BEST WHEN: Private recommendation.`;

test('preview contains the hook and only the first two spoken script sentences', () => {
  const preview = scriptPreview(full);
  assert.match(preview, /Your morning check starts with one number/);
  assert.match(preview, /Write down today's number\. Compare it with yesterday\./);
  for (const secret of ['third sentence', 'private visual detail', 'Private rationale', 'Private recommendation']) {
    assert.ok(!preview.includes(secret), `${secret} leaked into the preview`);
  }
  assert.ok(!scriptPreview('malformed output').includes('malformed output'));
});

test('public result omits every full-script field and private preface', () => {
  const publicResult = publicScriptResult({ title: 'Sample', duration: '30s-60s', icp: 'healthcare',
    version_a_title: 'A', version_b_title: 'B', version_a_text: full, version_b_md: full,
    preface_md: 'Private planning notes', downloadOwnerToken: 'owner-token' });
  assert.equal(publicResult.locked, true);
  assert.equal(publicResult.downloadOwnerToken, 'owner-token');
  assert.ok(!JSON.stringify(publicResult).includes('third sentence'));
  assert.ok(!JSON.stringify(publicResult).includes('Private planning notes'));
});
