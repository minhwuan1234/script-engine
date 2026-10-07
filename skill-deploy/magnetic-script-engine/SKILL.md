---
name: magnetic-script-engine
description: >
  Turns an approved source document into two contrasting, timestamped English video
  scripts while keeping every factual statement traceable to the source. Use for
  healthcare, corporate L&D, publishing or NGO materials when the app supplies a
  duration budget, a selected ICP and two assigned narrative styles.
---

# Magnetic Script Engine

Produce two genuinely different scripts from the same source facts. Accuracy comes
before completeness, style, vividness and duration.

## Runtime contract

- Run once: one request in, one response out. Do not ask follow-up questions.
- The app supplies the source document as text, a precomputed timing budget, one
  selected ICP key and two assigned style keys.
- Use only an explicitly supplied audience profile. Never infer a role, age, care
  setting, literacy level or stage of treatment.
- Write the deliverable entirely in English.
- Keep analysis, the materials sheet, source ledger and review private.
- Stop only when there is no usable source text. Otherwise note missing or conflicting
  information in `Engine notes` and continue without inventing it.

## Progressive loading rule

Read reference files only at the step named below. Do not preload all references.
Use code execution to open the required files from this skill directory. Finish
reading each required file before applying it.

## Workflow

### Step 1 — Establish the factual boundary

Read `references/source-accuracy.md` before extracting, ranking or rewriting any
fact. Its rules apply to titles, hooks, questions, voiceover and on-screen direction.

### Step 2 — Build the internal materials sheet

Read `references/materials-analysis.md`. Analyze the supplied document and privately
build the job, locked facts, source-stated mechanism, understanding need, cut list
and audience fit. Do not draft either script yet.

### Step 3 — Apply exactly one ICP lens

The app supplies a selected ICP key. Read only its matching file:

- `healthcare` → `references/icp-healthcare.md`
- `corporate_lnd` → `references/icp-corporate-lnd.md`
- `publishing` → `references/icp-publishing.md`
- `ngo` → `references/icp-ngo.md`
- `unclear` → `references/icp-unclear.md`

Do not read unused ICP files. Treat the selected ICP as an editorial lens, never as
evidence about the source or audience. If the document clearly conflicts with the
selected ICP, use `unclear` and state the mismatch in `Engine notes`.

### Step 4 — Load only the two assigned styles

The app supplies a Version A style key and Version B style key. Read only the two
matching files:

- `journey` → `references/style-journey.md`
- `mechanism` → `references/style-mechanism.md`
- `myth` → `references/style-myth.md`
- `before_after` → `references/style-before-after.md`
- `countdown` → `references/style-countdown.md`
- `mystery` → `references/style-mystery.md`
- `qa` → `references/style-qa.md`
- `stakes` → `references/style-stakes.md`

Do not read unused style files. Use the assigned style for each version exactly; do
not swap or replace them. Style changes structure and presentation only, never facts.

### Step 5 — Draft both versions

Read `references/script-craft.md` immediately before drafting. Use the exact timing
and word budget supplied by the app; do not recompute it and do not open a separate
duration guide. Both versions must preserve the same locked facts while differing in
structure and source of tension.

### Step 6 — Verify before output

Read `references/final-review.md` only after both drafts exist. Build a private source
ledger, remove or repair every unsupported statement, and apply every review check.
Do not merely report a failed check.

### Step 7 — Return the fixed deliverable

Read `references/output-format.md` immediately before responding. Follow it exactly.
Return only the two scripts and `Engine notes`, with nothing before or after them.

## Non-negotiable final rules

- Never use outside knowledge to complete, clarify or improve the source.
- Never invent facts, beliefs, audience behavior, scenarios, causes, mechanisms,
  outcomes, symptoms, urgency, definitions, recommendations, settings or visuals.
- Never weaken or detach a number, unit, condition, qualifier, negation, population,
  sequence, timeframe or exception.
- Never resolve ambiguity or contradiction on behalf of the source owner.
- Never put placeholders inside a viewer-facing script.
- Never print which references were read or describe this workflow in the output.
