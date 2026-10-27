---
name: magnetic-script-engine
description: Engine behind F.Learning's "text-wall nightmare → magnetic YouTube video script" lead-magnet tool. Takes a dense document (PDF, Word, PPT, ebook, or pasted text) plus a "crazy" level (Low / Medium / High) and optional picks (narrative style, platform, series vs one-off, duration); diagnoses where viewers will misunderstand the material, recommends platform + duration with reasons, and returns TWO timestamped scripts with a separated 15s hook, what differs, a reason and a "best when" for each. Use WHENEVER F or the team wants to turn a document into a video script, test the engine, or compare crazy levels — e.g. "chạy engine", "test magnetic script", "doc → script", "kéo slider lên High", "làm 2 version script từ tài liệu này", "turn this doc into a YouTube script". Also use when someone pastes a leaflet, manual, policy, textbook chapter or NGO report and asks for a video script from it. Works across ICPs (healthcare, L&D, publishing, NGO).
---

# Magnetic Script Engine

This skill is the engine of a lead magnet. A prospect uploads a document they're drowning in, and the tool hands back a script that makes them think "these people can actually write." The script *is* the sales pitch. A competent-but-bland script kills the concept, so quality is the whole job — everything below serves that.

The engine is the same for every ICP. Only the framing (who the viewer is, what's at stake, which guardrails apply) changes. See `references/icp-lenses.md`.

## Before writing anything

1. Load `brand-lens` (`/mnt/skills/user/brand-lens/SKILL.md`). The *scripts* speak for the client's content, not for F.Learning — but the *thinking* (Understanding Failure → Design Principle) and the voice of the Reason / Best-when copy are F's. That copy is where F's expertise becomes visible to the prospect.
2. If the doc is a file, read it with the right tool (`file-reading` / `pdf-reading` skill, `python-docx`, `python-pptx`). Pasted text is fine.
3. Read these references now — they are the craft, not optional detail:
   - `references/script-craft.md` — how a magnetic script is built, line by line
   - `references/crazy-dial.md` — what each level changes and what it never changes
   - `references/narrative-styles.md` — the style library and how to pick a contrasting pair
   - `references/platform-duration.md` — recommendation rules + word budgets
   - `references/icp-lenses.md` — per-ICP viewer, stakes, guardrails

## Inputs

| Input | Required | Default if missing |
|---|---|---|
| Document / text | Yes | — ask for it |
| Crazy level | Yes | Medium (say so in the output) |
| Narrative style | No | Engine picks two contrasting styles |
| Platform | No | Engine recommends, with reason |
| Series vs one-off | No | Engine recommends, with reason |
| Duration | No | Engine recommends, with reason |
| ICP | No | Infer from the doc; state the inference |

Don't stop to ask about optional inputs — the tool's promise is "drop your doc, get a script". Infer, state the assumption in one line, move on. Only ask if the doc itself is missing or unreadable.

## The flow

### Step 1 — Diagnose the doc (internal, then summarized in output)

This step is what separates F's engine from "summarize this into a video". Answer each, grounded in the doc's actual text:

- **Viewer**: who will watch, in what moment (e.g. a patient at home three days after discharge, phone in hand, family nearby).
- **The one job**: the single behavior the viewer must be able to *do* after watching. If the doc has several, list them and pick the one with the highest cost of getting wrong. More than two jobs that each deserve airtime → series signal.
- **Buried gold**: the 2–4 facts in the doc that matter most and are currently hard to find (usually page 3, paragraph 4, inside a sentence with three clauses). Quote or paraphrase with location.
- **Likely understanding failure**: pick ONE of False Certainty / Cognitive Overload / Concept Fragmentation / Transfer Failure (definitions in brand-lens). Say what the misunderstanding would look like in real behavior ("weighs daily but doesn't know a 2 lb jump means call today").
- **Mechanism to reveal**: the "why" the doc states or implies that makes the rule stick (e.g. extra weight is fluid the heart can't move). If the doc gives no mechanism, note that — do not invent one beyond what's safely standard and uncontroversial; flag it instead.
- **Doc facts that must stay exact**: numbers, thresholds, dosing language, legal wording, "call X when Y" lines. These are locked across every crazy level.

### Step 2 — Recommend platform, format, duration

Use `references/platform-duration.md`. Always show the recommendation with a one-line reason tied to the diagnosis (viewer's moment, number of jobs, attention context). If the user already picked something, respect it — and if the pick fights the content (e.g. 30s Short for a doc with four critical jobs), say so in one sentence and still deliver on their pick.

If series is recommended: give an episode map (3–6 rows: episode, the one job, working title) and write the scripts for **episode 1 only**, saying so. Episode 1 is the job with the highest cost of getting wrong, not the doc's first section — if that breaks the doc's order (or the usual order for this topic), say why in one line. That reordering is often the most visible piece of expertise in the whole output.

### Step 3 — Choose the two versions

Two versions must differ on a real axis — POV, structure, or where the tension comes from — not just wording. Use the pairing guidance in `references/narrative-styles.md`.

- User picked a style → Version A uses it. Version B is the engine's best contrasting pick.
- No pick → choose the two styles that best fit the diagnosis and contrast most usefully.

Both versions use the **same crazy level**. The slider changes temperature; the versions change angle.

### Step 4 — Write the scripts

Follow `references/script-craft.md` and the level spec in `references/crazy-dial.md`. Non-negotiables:

- Word count fits duration (see word budgets). Run `scripts/check_timing.py` on the draft file before delivering.
- Hook = first 15 seconds, written as its own block. It must work alone — it is the free preview before the email gate.
- Every locked fact from Step 1 appears correctly. No invented statistics, studies, quotes, or case stories. If a number would help and the doc doesn't have one, write `[ADD SOURCED STAT]` rather than making one up.
- The script reveals the mechanism, not just the rule (this is the anti–False Certainty move, and the thing that makes F's work different).
- Close on one observable action the viewer can take today.

### Step 5 — Quality gate (do this honestly before output)

Run the checklist in `references/script-craft.md` → "Quality gate". If any item fails, fix the script, don't just note it. Then run:

```bash
python /path/to/skill/scripts/check_timing.py <draft.md>
```

Fix any segment flagged too dense or too thin.

### Step 6 — Output

Use this exact structure. Language: English (the tool is client-facing), unless the user asks otherwise.

```
# [Working title] — Magnetic Script

**Crazy level:** [Low/Medium/High] · **ICP read:** [inferred ICP]

## Doc diagnosis
| | |
|---|---|
| Viewer & moment | ... |
| The one job | ... |
| Buried gold | ... |
| Where understanding breaks | [plain-language description] — *[failure name]* |
| Mechanism we reveal | ... |
| Locked facts | ... |

## Recommended setup
| Choice | Recommendation | Why |
|---|---|---|
| Platform | ... | ... |
| Duration | ... | ... |
| Series or one-off | ... | ... |
(+ episode map if series)

## What's different between the two versions
| | Version A — [style] | Version B — [style] |
|---|---|---|
| Angle | | |
| Hook move | | |
| Structure | | |
| Viewer walks away with | | |

## Version A — [style name]: "[title]"
### Hook (0:00–0:15) — free preview
| Time | Voiceover | On screen |
|---|---|---|
...
### Script
| Time | Voiceover | On screen |
|---|---|---|
...
**Why we wrote it this way:** [3–5 sentences: the diagnosis → the choice → the effect on the viewer. Name the understanding failure conversationally; the label can land at the end.]
**Best when:** [2–3 concrete situations — audience, channel, goal — where this version wins, plus one where it doesn't.]

## Version B — ...
(same structure)

## Engine notes
- Assumptions made (inputs inferred)
- Flags (missing mechanism, [ADD SOURCED STAT] placeholders, doc claims that need client/clinical check)
```

Timestamps are ranges (`0:00–0:05`). Hook rows cover exactly 0:00–0:15; the Script table continues from 0:15. "On screen" says what the viewer sees that does explanatory work — not decoration (see script-craft).

## If the user wants to compare levels

When asked to run the same doc at more than one crazy level, keep the diagnosis and setup identical and only regenerate the versions. Add a short "What the dial changed" table (hook, pacing, language, stakes framing) so the difference is visible at a glance.

## Machine-readable output (for the future UI)

If the user asks for JSON (e.g. to wire into the Magnetic Script Studio mock), follow `references/output-schema.md`. Otherwise use the markdown above.
