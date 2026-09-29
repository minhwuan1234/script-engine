// A/B preference memory. Stores strategy IDs and votes, never document or script text.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STYLES = {
  journey: 'First-person journey',
  mechanism: 'Explainer / mechanism reveal',
  myth: 'Myth-buster',
  before_after: 'Before/after scenario',
  countdown: 'Countdown / 3 things',
  mystery: 'Mystery / investigation',
  qa: 'Q&A / you asked',
  stakes: 'Stakes story (NGO)',
};

// Each pair has a distinct narrative axis, matching references/narrative-styles.md.
const PAIRS = [
  ['journey', 'mechanism'],
  ['myth', 'journey'],
  ['countdown', 'before_after'],
  ['qa', 'mystery'],
];
const PAIRS_BY_ICP = {
  healthcare: [PAIRS[0], PAIRS[1], PAIRS[2]],
  corporate_lnd: [PAIRS[1], PAIRS[2], PAIRS[3]],
  publishing: [PAIRS[0], PAIRS[1], PAIRS[3]],
  ngo: [['stakes', 'mechanism'], ['stakes', 'journey'], PAIRS[3]],
  unclear: [PAIRS[0], PAIRS[1], PAIRS[2], PAIRS[3]],
};
const VALID_ICP = new Set(['healthcare', 'corporate_lnd', 'publishing', 'ngo', 'unclear']);
const VOTE_TTL_MS = 30 * 24 * 3600_000;

export function createPreferenceStore(filename) {
  const generations = new Map();
  const votes = new Map();
  try {
    if (fs.existsSync(filename)) {
      for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'generated' && VALID_ICP.has(event.icp) &&
              STYLES[event.a] && STYLES[event.b] && !generations.has(event.id)) {
            generations.set(event.id, event);
          } else if (event.type === 'picked' && generations.has(event.id) && !votes.has(event.id) &&
                     ['A', 'B'].includes(event.choice)) {
            votes.set(event.id, event.choice);
          }
        } catch { /* tolerate an incomplete final line after a process crash */ }
      }
    }
  } catch (error) {
    console.error('Could not load preference history:', error.message);
  }

  function append(event) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.appendFileSync(filename, JSON.stringify(event) + '\n', { mode: 0o600 });
  }

  function stats(icp) {
    const out = Object.fromEntries(Object.keys(STYLES).map((key) =>
      [key, { globalWins: 0, globalN: 0, icpWins: 0, icpN: 0 }]));
    for (const [id, choice] of votes) {
      const row = generations.get(id);
      if (!row) continue;
      for (const [side, style] of [['A', row.a], ['B', row.b]]) {
        const s = out[style];
        s.globalN++;
        if (side === choice) s.globalWins++;
        if (row.icp === icp) {
          s.icpN++;
          if (side === choice) s.icpWins++;
        }
      }
    }
    return out;
  }

  function choosePair(icp) {
    const scores = stats(icp);
    const candidates = PAIRS_BY_ICP[icp] || PAIRS_BY_ICP.unclear;
    const value = (style) => {
      const s = scores[style];
      const globalRate = (s.globalWins + 1) / (s.globalN + 2);
      // Eight pseudo-comparisons from the global rate smooth sparse ICP data.
      return (s.icpWins + 8 * globalRate) / (s.icpN + 8);
    };
    // Explore under-tested pairs while favoring strategies with positive feedback.
    const ranked = candidates.map(([a, b]) => ({
      pair: [a, b],
      weight: (value(a) + value(b)) / 2 +
        0.15 / Math.sqrt(1 + Math.min(scores[a].icpN, scores[b].icpN)),
    })).sort((x, y) => y.weight - x.weight);
    // Keep a small exploration probability so a single early win cannot lock the engine.
    const selected = crypto.randomInt(10) === 0
      ? candidates[crypto.randomInt(candidates.length)] : ranked[0].pair;
    return crypto.randomInt(2) ? { a: selected[0], b: selected[1] }
      : { a: selected[1], b: selected[0] };
  }

  function createGeneration(icp, pair) {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const event = {
      type: 'generated', id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      ts: Date.now(), icp: VALID_ICP.has(icp) ? icp : 'unclear',
      a: pair.a, b: pair.b,
    };
    append(event); // If persistence fails, caller won't offer a pick that cannot be saved.
    generations.set(id, event);
    return { id, token };
  }

  function pick({ id, token, choice }) {
    const row = generations.get(id);
    if (!row || !['A', 'B'].includes(choice) || typeof token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(token) || Date.now() - row.ts > VOTE_TTL_MS) {
      return { ok: false, status: 400, error: 'Invalid or expired pick.' };
    }
    const givenHash = crypto.createHash('sha256').update(token).digest();
    const expectedHash = Buffer.from(row.tokenHash, 'hex');
    if (expectedHash.length !== givenHash.length ||
        !crypto.timingSafeEqual(givenHash, expectedHash)) {
      return { ok: false, status: 403, error: 'Invalid pick token.' };
    }
    if (votes.has(id)) {
      if (votes.get(id) === choice) return { ok: true, duplicate: true };
      return { ok: false, status: 409, error: 'A version has already been picked.' };
    }
    append({ type: 'picked', id, choice, ts: Date.now() });
    votes.set(id, choice);
    return { ok: true };
  }

  return { choosePair, createGeneration, pick, stats };
}
