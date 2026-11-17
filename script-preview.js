// Only this excerpt is sent before the visitor supplies an email address.
// The complete script stays in the submission store until a grant is issued.
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

export function scriptPreview(text) {
  const lines = String(text || '').split(/\r?\n/);
  const hook = lines.findIndex((line) => /^HOOK(?:\s|\(|$)/i.test(line.trim()));
  const script = lines.findIndex((line, index) => index > hook && /^SCRIPT\s*$/i.test(line.trim()));
  if (hook < 0 || script < 0) return 'Preview unavailable. Enter your email to view the full script.';

  const hookText = lines.slice(hook, script).join('\n').trim().slice(0, 2500);
  const remainder = lines.slice(script + 1);
  const notes = remainder.findIndex((line) =>
    /^(?:WHY WE WROTE IT(?: THIS WAY)?|BEST WHEN|ENGINE NOTES):?/i.test(line.trim()));
  const scriptLines = notes < 0 ? remainder : remainder.slice(0, notes);
  const spoken = scriptLines.filter((line) => /^VOICEOVER:\s*/i.test(line.trim()))
    .map((line) => line.trim().replace(/^VOICEOVER:\s*/i, '')).join(' ').trim();
  const firstTwo = [...sentenceSegmenter.segment(spoken)].slice(0, 2)
    .map(({ segment }) => segment).join('').trim().slice(0, 400);
  return `${hookText}\n\nSCRIPT${firstTwo ? `\nVOICEOVER: ${firstTwo}` : ''}`;
}

export function publicScriptResult(result) {
  return {
    title: result.title,
    duration: result.duration,
    icp: result.icp,
    version_a_title: result.version_a_title,
    version_b_title: result.version_b_title,
    version_a_text: scriptPreview(result.version_a_text ?? result.version_a_md),
    version_b_text: scriptPreview(result.version_b_text ?? result.version_b_md),
    level: result.level,
    skill_source: result.skill_source,
    skipped: result.skipped,
    stop_reason: result.stop_reason,
    ab_pick: result.ab_pick,
    ab_pick_status: result.ab_pick_status,
    usage: result.usage,
    submissionId: result.submissionId,
    downloadOwnerToken: result.downloadOwnerToken,
    locked: true,
  };
}
