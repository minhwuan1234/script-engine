import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildOriginalSkillSystem, originalSkillInstruction } from './original-skill.js';

test('runtime prompt includes each original reference without editing its text', () => {
  const [block] = buildOriginalSkillSystem();
  assert.match(block.text, /^===== WEB APP RUNTIME ADAPTER/);
  assert.match(block.text, /By the end of its first 15 seconds, the spoken voiceover must make the actual subject/);
  assert.match(block.text, /it does not have to name the subject immediately/);
  assert.match(block.text, /There is no maximum or preferred word count per spoken sentence/);
  assert.match(block.text, /entire Hook \(0:00–0:15\) as exactly ONE timestamped table row/);
  assert.ok(block.text.lastIndexOf('WRITING OVERRIDES FOR THIS COMPARISON VERSION') >
    block.text.lastIndexOf('Most lines ≤ 15 words'), 'override must follow the archived rule');
  const exampleGuidance = fs.readFileSync(new URL(
    './skill-deploy/magnetic-script-engine/references/example-guidance.md', import.meta.url), 'utf8');
  assert.ok(block.text.includes(exampleGuidance), 'additional example guidance must be loaded');
  assert.ok(block.text.lastIndexOf('This mode does not supply an example script excerpt') >
    block.text.lastIndexOf(exampleGuidance), 'runtime clarification must follow example guidance');
  for (const name of [
    'SKILL.md', 'references/script-craft.md', 'references/crazy-dial.md',
    'references/narrative-styles.md', 'references/platform-duration.md',
    'references/icp-lenses.md', 'references/output-schema.md',
  ]) {
    const source = fs.readFileSync(new URL(`./skill-deploy/magnetic-script-engine-original/${name}`, import.meta.url), 'utf8');
    assert.ok(block.text.includes(source), `${name} changed or missing`);
  }
});

test('original mode passes chosen level and duration without assigning styles', () => {
  const instruction = originalSkillInstruction({ duration: '30s-60s', level: 'High' });
  assert.match(instruction, /Crazy level: High\./);
  assert.match(instruction, /Duration: 30s-60s/);
  assert.match(instruction, /style, platform, series and ICP are not specified/);
  assert.throws(() => originalSkillInstruction({ duration: '30s-60s', level: 'Ultra' }));
});
