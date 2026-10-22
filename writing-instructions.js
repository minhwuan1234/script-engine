import fs from 'node:fs';

const root = new URL('./skill-deploy/magnetic-script-engine/', import.meta.url);
const icps = {
  healthcare: 'icp-healthcare.md', corporate_lnd: 'icp-corporate-lnd.md',
  publishing: 'icp-publishing.md', ngo: 'icp-ngo.md', unclear: 'icp-unclear.md',
};
const styles = {
  mechanism: 'style-mechanism.md', myth: 'style-myth.md',
  before_after: 'style-before-after.md', countdown: 'style-countdown.md',
  mystery: 'style-mystery.md', qa: 'style-qa.md', stakes: 'style-stakes.md',
};
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8').trim();
const section = (file) => `===== ${file} =====\n${read(file)}`;
// Load at startup: missing files fail visibly, and no disk reads are needed per request.
const common = ['SKILL.md', ...['source-accuracy', 'materials-analysis', 'script-craft', 'hook-quality', 'tone-of-voice',
  'final-review', 'output-format', 'example-guidance'].map((name) => `references/${name}.md`)]
  .map(section).join('\n\n');
const selected = Object.fromEntries([...new Set([...Object.values(icps), ...Object.values(styles)])]
  .map((file) => [file, section(`references/${file}`)]));

// Keep original reference files intact; send one compatible excerpt per request.
// Scores describe narrative craft, not topical medical relevance.
const examples = [
  { file: 'hopes-a-b.md', weights: { mystery: 3, stakes: 2, countdown: 2, qa: 2 } },
  { file: 'colonoscopy-a-b.md', weights: { mechanism: 3, before_after: 2 } },
  { file: 'cirrhosis-a-b.md', weights: { myth: 3, mechanism: 2 } },
].map((example) => {
  // The source packs contain retired Journey samples. Do not load those into the prompt.
  const excerpts = read(`examples/${example.file}`).split(/(?=^## Version [AB]\b)/m)
    .slice(1).filter((part) => !/^##[^\n]*First-person journey/i.test(part));
  if (!excerpts.length) throw new Error(`No active writing example in ${example.file}`);
  return { ...example, text: `===== examples/${example.file} =====\n` +
    'Writing craft excerpt only. Reference version letters do not assign the new A/B styles.\n\n' + excerpts.join('\n\n').trim() };
});
function selectExample(a, b) {
  return examples.reduce((best, example) => {
    const score = (example.weights[a] || 0) + (example.weights[b] || 0);
    return score > best.score ? { score, text: example.text } : best;
  }, { score: -1, text: '' }).text;
}

export function buildWritingSystem(icp, styleA, styleB) {
  if (!Object.hasOwn(icps, icp) || !Object.hasOwn(styles, styleA) || !Object.hasOwn(styles, styleB)) {
    throw new Error('Invalid ICP or narrative style.');
  }
  return [
    { type: 'text', text: common, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: [selected[icps[icp]], selected[styles[styleA]], selected[styles[styleB]],
      '===== CRAFT EXAMPLE ONLY: NOT SOURCE EVIDENCE =====', selectExample(styleA, styleB)].join('\n\n'),
      cache_control: { type: 'ephemeral', ttl: '1h' } },
  ];
}
