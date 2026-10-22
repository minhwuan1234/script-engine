import fs from 'node:fs';

const root = new URL('./skill-deploy/magnetic-script-engine/', import.meta.url);
const icps = {
  healthcare: 'icp-healthcare.md', corporate_lnd: 'icp-corporate-lnd.md',
  publishing: 'icp-publishing.md', ngo: 'icp-ngo.md', unclear: 'icp-unclear.md',
};
const styles = {
  journey: 'style-journey.md', mechanism: 'style-mechanism.md', myth: 'style-myth.md',
  before_after: 'style-before-after.md', countdown: 'style-countdown.md',
  mystery: 'style-mystery.md', qa: 'style-qa.md', stakes: 'style-stakes.md',
};
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8').trim();
const section = (file) => `===== ${file} =====\n${read(file)}`;
// Load at startup: missing files fail visibly, and no disk reads are needed per request.
const common = ['SKILL.md', ...['source-accuracy', 'materials-analysis', 'script-craft', 'hook-quality',
  'final-review', 'output-format'].map((name) => `references/${name}.md`)]
  .map(section).join('\n\n');
const selected = Object.fromEntries([...new Set([...Object.values(icps), ...Object.values(styles)])]
  .map((file) => [file, section(`references/${file}`)]));

export function buildWritingSystem(icp, styleA, styleB) {
  if (!Object.hasOwn(icps, icp) || !Object.hasOwn(styles, styleA) || !Object.hasOwn(styles, styleB)) {
    throw new Error('Invalid ICP or narrative style.');
  }
  return [
    { type: 'text', text: common, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: [selected[icps[icp]], selected[styles[styleA]], selected[styles[styleB]]].join('\n\n'),
      cache_control: { type: 'ephemeral', ttl: '1h' } },
  ];
}
