---
name: "magnetic-script-engine"
description: "Engine behind F.Learning's \"text-wall nightmare → magnetic YouTube video script\" lead-magnet tool. Takes a dense document (PDF, Word, PPT, ebook, or pasted text) and optional picks (narrative style, platform, series vs one-off, duration); diagnoses where viewers will misunderstand the material, recommends platform + duration with reasons, and returns TWO timestamped scripts with a separated 15s hook, what differs, a reason and a \"best when\" for each. Use WHENEVER F or the team wants to turn a document into a video script, test the engine — e.g. \"chạy engine\", \"test magnetic script\", \"doc → script\", \"làm 2 version script từ tài liệu này\", \"turn this doc into a YouTube script\". Also use when someone pastes a leaflet, manual, policy, textbook chapter or NGO report and asks for a video script from it. Works across ICPs (healthcare, L&D, publishing, NGO)."
---

# Magnetic Script Engine

This skill is the engine of a lead magnet. A prospect uploads a document they're drowning in, and the tool hands back a script that makes them think "these people can actually write." The script *is* the sales pitch. A competent-but-bland script kills the concept, so quality is the whole job — everything below serves that.

The engine is the same for every ICP. Only the framing (who the viewer is, what's at stake, which guardrails apply) changes. See `references/icp-lenses.md`.

This skill's job stops at writing good markdown. The calling app (not this skill) turns that markdown into JSON and runs the timing/pacing/duration checks in its own code — see "On JSON / machine-readable output" and Step 5 below. Nothing here should try to redo that in a code_execution call. `scripts/check_timing.py` is kept in this folder only as a reference copy of the original logic (now ported into the app's `server.js`); it is not run as part of this skill — do not invoke it.

**How this skill is actually invoked.** In production this runs behind an API call from the app's server, not a chat: the app sends one request with the document plus the visitor's duration and the narrative pair chosen by the app, and you return one finished response. There is no back-and-forth — you cannot pause mid-run and wait for a reply, because there is no one on the other end of a chat to answer. Anywhere below that used to say "ask", read it as "note the gap and keep going" or, for the one case where the run truly cannot proceed (no document at all), "say so plainly in your one response instead of the normal output."

**The document arrives as plain text already — you never extract it yourself.** The app converts any uploaded PDF/DOCX/PPTX to plain text in its own code (deterministic parsing, not a model call) before it ever reaches you, and hands it to you as a normal text block headed `--- filename ---`. Treat that block exactly like pasted text — it already *is* the document, nothing left to open or parse. Do not load `file-reading`, `pdf-reading`, `python-docx` or `python-pptx`, and do not run code_execution to read a file — there is no file object here to read, only text you already have. The one exception: a scanned PDF with no real text layer arrives instead as a native PDF attachment (the app's code detects this and falls back automatically) — if that happens, just read it the normal way any attached document is read; no special step needed on your side either way.

## Inputs

| Input | Required | If missing |
|---|---|---|
| Document / text | Yes | Nothing to run the engine on — there's no one to ask, so say plainly in your response that no document/text came through, and stop there instead of producing a diagnosis. |
| Narrative style | No | Engine picks two contrasting styles |
| Platform | No | Engine recommends, with reason |
| Series vs one-off | No | Engine recommends, with reason |
| Duration | No | Engine recommends, with reason |
| ICP | No | Infer from the doc; state the inference |

Never stop mid-run to ask about an optional input — there's no channel back to a person to answer, and the tool's promise is "drop your doc, get a script" in one pass. Infer, state the assumption in one line, move on. The only input worth flagging as blocking is a genuinely missing/unreadable document, and even then you don't "ask" — you just say so in your single response, since that's the only message you get to send.

## Before writing anything

1. Load `brand-lens` (`/mnt/skills/user/brand-lens/SKILL.md`). The *scripts* speak for the client's content, not for F.Learning — but the *thinking* (Understanding Failure → Design Principle) and the voice of the Reason / Best-when copy are F's. That copy is where F's expertise becomes visible to the prospect.
2. Read these references now — they are the craft, not optional detail:
   - `references/script-craft.md` — how a magnetic script is built, line by line
   - `references/narrative-styles.md` — the style library and how to pick a contrasting pair
   - `references/platform-duration.md` — recommendation rules + word budgets
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

Use `references/platform-duration.md`. Always show the recommendation with a one-line reason tied to the diagnosis (viewer's moment, number of jobs, attention context). If the incoming request already specified something (platform, duration, etc.), respect it — and if the pick fights the content (e.g. 30s Short for a doc with four critical jobs), say so in one sentence and still deliver on that pick.

If series is recommended: give an episode map (3–6 rows: episode, the one job, working title) and write the scripts for **episode 1 only**, saying so. Episode 1 is the job with the highest cost of getting wrong, not the doc's first section — if that breaks the doc's order (or the usual order for this topic), say why in one line. That reordering is often the most visible piece of expertise in the whole output.

### Step 3 — Choose the two versions

Two versions must differ on a real axis — POV, structure, or where the tension comes from — not just wording. Use the pairing guidance in `references/narrative-styles.md`.

- If the calling app specifies narrative styles for both Version A and Version B, use those exact styles in those exact version slots. The app chooses a contrasting pair using prior A/B picks for the relevant ICP. Keep the versions distinct, and name the styles in their headings. Do not infer a different style pair from the document in this case.
- If only one style is specified, Version A uses it. Version B is the engine's best contrasting pick.
- No pick → choose the two styles that best fit the diagnosis and contrast most usefully.

Both versions use the **same duration**. The versions change angle.

### Step 4 — Write the scripts

Follow `references/script-craft.md`. Non-negotiables:

- Word count fits duration — the request you received includes a pre-computed `vo_word_budget` JSON block (min/max words for the picked duration, at both long-form and short-form pace, plus the hook's 30–40 word target). Use those numbers directly — they're already the `references/platform-duration.md` formula run for you, so there's no wpm × seconds math left for you to do. You do not need to run anything to verify this yourself — the calling app checks actual pacing after you're done and logs any mismatch; your job is to write to the budget, not to prove you hit it.
- Hook = first 15 seconds, written as its own block. It must work alone — it is the free preview before the email gate.
- Every locked fact from Step 1 appears correctly. No invented statistics, studies, quotes, or case stories. If a number would help and the doc doesn't have one, write `[ADD SOURCED STAT]` rather than making one up.
- The script reveals the mechanism, not just the rule (this is the anti–False Certainty move, and the thing that makes F's work different).
- Close on one observable action the viewer can take today.

### Step 5 — Quality gate (do this honestly before output)

Run the checklist in `references/script-craft.md` → "Quality gate". If any item fails, fix the script, don't just note it — this part stays yours, because it's judgment (locked facts present and correct, no invented claims, mechanism actually revealed, hook works standalone), not something a word-count script could catch.

Do **not** run a timing/pacing script yourself, and do not open or read `scripts/check_timing.py` — it is legacy reference only. That check now lives in the calling app's own code and runs automatically on your finished markdown after you deliver it — it costs no extra step here, and re-doing it yourself would just spend a code_execution call re-deriving something the app already computes for free.

### Step 6 — Output

Write plain text in this **exact** markdown structure — do not summarize it, do not wrap it in JSON, do not add narration before or after it. This is the one and only message you send back for this run, so it has to be complete and self-contained; the calling app parses these fixed headings with code on its side to build its own data structure (a JSON "output gateway") and to run the timing check, so the heading wording and nesting below must match exactly, every time — that reliability is code's job, not something you need to think about beyond following the template. Language: English (the tool is client-facing), unless the request says otherwise.

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
- Assumptions made (inputs inferred)
- Flags (missing mechanism, [ADD SOURCED STAT] placeholders, doc claims that need client/clinical check)
```

Timestamps are ranges (`0:00–0:05`). Hook rows cover exactly 0:00–0:15; the Script table continues from 0:15. "On screen" says what the viewer sees that does explanatory work — not decoration (see script-craft).

The calling app already knows the duration it asked for (it came from its own UI) — you don't need to make it machine-parseable in the markdown.

## On JSON / machine-readable output

Never produce JSON yourself, even if the request asks for "machine-readable output" or "JSON for the UI." Say that the calling app builds its JSON from this same markdown by parsing the fixed headings above with code — there is nothing extra for you to generate, and writing JSON by hand only adds risk of malformed output for no benefit.
