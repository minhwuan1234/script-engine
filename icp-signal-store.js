// Learns short ICP signals from Haiku without storing the user's source text.
import fs from 'node:fs';
import path from 'node:path';

export const ICP_KEYS = ['healthcare', 'corporate_lnd', 'publishing', 'ngo'];

// A small trusted base lets the matcher work before it has collected enough observations.
const SEED_SIGNALS = {
  healthcare: [
    'patient education', 'clinical guideline', 'care team', 'healthcare provider',
    'medication guide', 'discharge instructions', 'clinical training', 'patient safety',
  ],
  corporate_lnd: [
    'employee onboarding', 'workplace policy', 'standard operating procedure', 'compliance training',
    'learning outcomes', 'employee handbook', 'safety procedure', 'internal training',
  ],
  publishing: [
    'textbook chapter', 'study guide', 'course notes', 'learning objective',
    'lesson plan', 'student workbook', 'classroom activity', 'educational content',
  ],
  ngo: [
    'impact report', 'program brief', 'advocacy campaign', 'donor report',
    'community program', 'social impact', 'humanitarian response', 'policy advocacy',
  ],
};

const GENERIC = new Set([
  'audience', 'content', 'document', 'education', 'information', 'learning', 'people',
  'script', 'training', 'video', 'viewer', 'work',
]);

const normalize = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFKC')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function cleanSignal(value, sourceText) {
  const signal = normalize(value);
  const words = signal.split(' ').filter(Boolean);
  if (!signal || words.length > 5 || signal.length < 3 || signal.length > 80) return null;
  if (words.length === 1 && GENERIC.has(signal)) return null;
  const haystack = ` ${normalize(sourceText)} `;
  return haystack.includes(` ${signal} `) ? signal : null;
}

export function createIcpSignalStore(filename, { minCount = 3 } = {}) {
  const learned = new Map();

  const increment = (icp, signal) => {
    const perIcp = learned.get(signal) || new Map();
    perIcp.set(icp, (perIcp.get(icp) || 0) + 1);
    learned.set(signal, perIcp);
  };

  try {
    if (fs.existsSync(filename)) {
      for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type !== 'model_observation' || !ICP_KEYS.includes(event.icp)) continue;
          for (const signal of new Set(event.signals || [])) {
            const clean = normalize(signal);
            if (clean) increment(event.icp, clean);
          }
        } catch { /* tolerate an incomplete final line */ }
      }
    }
  } catch (error) {
    console.error('Could not load ICP signal history:', error.message);
  }

  function append(event) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.appendFileSync(filename, JSON.stringify(event) + '\n', { mode: 0o600 });
  }

  function observe({ icp, confidence, signals, sourceText }) {
    if (!ICP_KEYS.includes(icp)) return [];
    const accepted = [...new Set((signals || []).map((s) => cleanSignal(s, sourceText)).filter(Boolean))]
      .slice(0, 8);
    if (!accepted.length) return [];
    const event = {
      type: 'model_observation', ts: Date.now(), icp,
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
      signals: accepted,
    };
    append(event);
    for (const signal of accepted) increment(icp, signal);
    return accepted;
  }

  function classify(sourceText) {
    const text = ` ${normalize(sourceText)} `;
    const scores = Object.fromEntries(ICP_KEYS.map((icp) => [icp, 0]));
    const matches = Object.fromEntries(ICP_KEYS.map((icp) => [icp, []]));

    const addIfPresent = (icp, signal, weight) => {
      if (!text.includes(` ${signal} `)) return;
      scores[icp] += weight;
      matches[icp].push(signal);
    };

    for (const icp of ICP_KEYS) {
      for (const raw of SEED_SIGNALS[icp]) {
        const signal = normalize(raw);
        const words = signal.split(' ').length;
        addIfPresent(icp, signal, words >= 3 ? 3 : 2);
      }
    }

    for (const [signal, counts] of learned) {
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const [bestIcp, bestCount] = ranked[0] || [];
      const secondCount = ranked[1]?.[1] || 0;
      // A learned phrase becomes active only after repeated observations and must occur
      // much more often in one ICP than in competing ICPs.
      if (!bestIcp || bestCount < minCount || bestCount < secondCount * 2) continue;
      const words = signal.split(' ').length;
      const weight = (words >= 3 ? 3 : words === 2 ? 2 : 1) + Math.min(2, Math.floor(bestCount / minCount) - 1);
      addIfPresent(bestIcp, signal, weight);
    }

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [topIcp, topScore] = ranked[0];
    const secondScore = ranked[1][1];
    const confident = topScore >= 4 && topScore - secondScore >= 2;
    return { icp: confident ? topIcp : 'unclear', confident, scores, matches };
  }

  return { classify, observe };
}
