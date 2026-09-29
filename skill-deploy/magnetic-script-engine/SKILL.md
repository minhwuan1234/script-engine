---
name: "magnetic-script-engine"
description: "Engine behind F.Learning's \"text-wall nightmare → magnetic YouTube video script\" lead-magnet tool. Takes a dense document (PDF, Word, PPT, ebook, or pasted text) and optional picks (narrative style, platform, series vs one-off, duration); diagnoses where viewers will misunderstand the material, recommends platform + duration with reasons, and returns TWO timestamped scripts with a separated 15s hook, what differs, a reason and a \"best when\" for each. Use WHENEVER F or the team wants to turn a document into a video script, test the engine — e.g. \"chạy engine\", \"test magnetic script\", \"doc → script\", \"làm 2 version script từ tài liệu này\", \"turn this doc into a YouTube script\". Also use when someone pastes a leaflet, manual, policy, textbook chapter or NGO report and asks for a video script from it. Works across ICPs (healthcare, L&D, publishing, NGO)."
---

# Magnetic Script Engine

This skill is the engine of a lead magnet. A prospect uploads a document they're drowning in, and the tool hands back a script that makes them think "these people can actually write." The script *is* the sales pitch. A competent-but-bland script kills the concept, so quality is the whole job — everything below serves that.

The engine is the same for every ICP. Only the framing (who the viewer is, what's at stake, which guardrails apply) changes. See `references/icp-lenses.md`.

This skill writes the finished markdown. The app extracts text from files, supplies a duration and word budget, and parses the markdown into JSON. Follow the pacing checks below while writing; the app currently computes the budget but does not validate each finished timestamp row. Do not run code for these checks.

The app invokes this skill through one API request containing the document, selected duration and narrative styles for A/B. Return one finished response. The server rejects empty input before calling the model.

**The document arrives as plain text already — you never extract it yourself.** The app converts any uploaded PDF/DOCX/PPTX to plain text in its own code (deterministic parsing, not a model call) before it ever reaches you, and hands it to you as a normal text block headed `--- filename ---`. Treat that block exactly like pasted text — it already *is* the document, nothing left to open or parse. Do not load `file-reading`, `pdf-reading`, `python-docx` or `python-pptx`, and do not run code_execution to read a file — there is no file object here to read, only text you already have. The one exception: a scanned PDF with no real text layer arrives instead as a native PDF attachment (the app's code detects this and falls back automatically) — if that happens, just read it the normal way any attached document is read; no special step needed on your side either way.

## Before writing anything

1. Load `brand-lens` (`/mnt/skills/user/brand-lens/SKILL.md`). The *scripts* speak for the client's content, not for F.Learning — but the *thinking* (Understanding Failure → Design Principle) and the voice of the Reason / Best-when copy are F's. That copy is where F's expertise becomes visible to the prospect.
2. Read these references now — they are the craft, not optional detail:
   - `references/script-craft.md` — how a magnetic script is built, line by line
   - `references/narrative-styles.md` — the style library and how to pick a contrasting pair
   - `references/icp-lenses.md` — per-ICP viewer, stakes, guardrails

## The flow

### Step 1 — Diagnose the doc (internal, then summarized in output)

This step is what separates F's engine from "summarize this into a video". Answer each, grounded in the doc's actual text:

- **Viewer**: who will watch, in what moment (e.g. a patient at home three days after discharge, phone in hand, family nearby).
- **The one job**: the single behavior the viewer must be able to *do* after watching. If the doc has several, list them and pick the one with the highest cost of getting wrong. More than two jobs that each deserve airtime → series signal.
- **Buried gold**: the 2–4 facts in the doc that matter most and are currently hard to find (usually page 3, paragraph 4, inside a sentence with three clauses). Quote or paraphrase with location.
- **Likely understanding failure**: pick ONE of False Certainty / Cognitive Overload / Concept Fragmentation / Transfer Failure (definitions in brand-lens). Say what the misunderstanding would look like in real behavior ("weighs daily but doesn't know a 2 lb jump means call today").
- **Mechanism to reveal**: the "why" the doc states or implies that makes the rule stick (e.g. extra weight is fluid the heart can't move). If the doc gives no mechanism, note that — do not invent one beyond what's safely standard and uncontroversial; flag it instead.
- **Doc facts that must stay exact**: numbers, thresholds, dosing language, legal wording, "call X when Y" lines. These stay exact in both versions.

### Step 2 — Recommend platform, format, duration

Match the recommended platform to where the viewer needs the knowledge:

- YouTube long-form (16:9): sought-out explainer; roughly 1.5–8 minutes.
- Shorts/Reels/TikTok (9:16): scrolling viewer; roughly 20–60 seconds and one job.
- LinkedIn feed: work context, captions first; roughly 45–90 seconds.
- Internal LMS: assigned learning; roughly 1–5 minutes per module.
- Clinic screen or QR on leaflet: distracted viewer, sound optional; roughly 1–3 minutes.

Typical starting points by ICP: healthcare → unlisted YouTube/QR or clinic screen; corporate L&D → LMS or unlisted video; publishing → YouTube explainer with optional short cutdowns; NGO → short awareness video or a 2–3 minute partner/donor explainer. Override these defaults when the document's audience and viewing moment point elsewhere.

Use the selected duration from the app for both scripts. In Recommended setup, name the platform and explain whether the chosen duration fits the diagnosis; if it is too short for several critical jobs, flag the tradeoff while still delivering the requested duration. A short script holds one job, one mechanism and one action; 2–4 minutes can carry a multi-step mechanism or two linked jobs. Long educational explainers can take 4–8 minutes when the model itself needs explaining. Choose by the viewer's job, not the document's length. For one job or two tightly linked jobs, recommend a one-off. For three or more separable jobs, or a reference manual used for lookup, recommend a series.

If series is recommended: give an episode map (3–6 rows: episode, the one job, working title) and write the scripts for **episode 1 only**, saying so. Episode 1 is the job with the highest cost of getting wrong, not necessarily the doc's first section.

### Step 3 — Choose the two versions

Two versions must differ on a real axis — POV, structure, or where the tension comes from — not just wording. Use the pairing guidance in `references/narrative-styles.md`.

Use the exact narrative style the app assigns to each version. The app chooses a contrasting pair using prior A/B picks for the relevant ICP. Keep the versions distinct and name the styles in their headings.

Both versions use the **same duration**. The versions change angle.

### Step 4 — Write the scripts

Follow `references/script-craft.md`. Non-negotiables:

- Word count fits duration — the request includes a pre-computed `vo_word_budget` JSON block for the selected duration. Use it directly for both versions. It reserves about 10% of the runtime for pauses and visual beats (around 150 words/minute for long-form, 160–170 for short-form).
- Hook = first 15 seconds, written as its own block. It must work alone — it is the free preview before the email gate.
- Every locked fact from Step 1 appears correctly. No invented statistics, studies, quotes, or case stories. If a number would help and the doc doesn't have one, write `[ADD SOURCED STAT]` rather than making one up.
- The script reveals the mechanism, not just the rule (this is the anti–False Certainty move, and the thing that makes F's work different).
- Close on one observable action the viewer can take today.

### Step 5 — Quality gate (do this honestly before output)

Run the checklist in `references/script-craft.md` → "Quality gate". Fix failures in the script itself: locked facts, mechanism, hook and observable action all require judgment.

Check timing from the finished timestamp rows in **each** version:

- Hook rows cover 0:00–0:15 and total roughly 30–40 voiceover words.
- Each timestamp range has a positive duration. Aim for 1.5–3.0 spoken words per second: above 3.0 will feel rushed; below 1.5 needs a deliberate pause or visual reveal described in On screen.
- Total voiceover words fit the app's `vo_word_budget` for the selected duration. The last row ends within that duration; leave time for visual-only beats.
- Exclude bracketed production notes such as `[ADD SOURCED STAT]` when estimating spoken words. Check A and B separately. Revise crowded or thin rows before output.

These are writing checks in the skill; no Python timing script is loaded or run. The app computes the target budget, while a deterministic post-generation timing validator would require separate server code.

### Step 6 — Output

Write plain text in this **exact** markdown structure — no JSON or text before or after it. The app parses the fixed Version headings to build its output fields, so preserve their wording and nesting. Write in English unless the input explicitly requests another language.

```
# [Working title] — Magnetic Script

**ICP read:** [inferred ICP]

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
- Assumptions made from ambiguous document content or ICP
- Flags (missing mechanism, [ADD SOURCED STAT] placeholders, doc claims that need client/clinical check)
```

Timestamps are ranges (`0:00–0:05`). Hook rows cover exactly 0:00–0:15; the Script table continues from 0:15. "On screen" says what the viewer sees that does explanatory work — not decoration (see script-craft).

The calling app already knows the duration it asked for (it came from its own UI) — you don't need to make it machine-parseable in the markdown.
