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

## Load the selected references once

The app supplies the ICP key and both style keys. Before analyzing the document or
drafting either version, use one code execution call to run this script from the
directory containing this SKILL.md:

`python3 scripts/load_references.py <icp_key> <version_a_style_key> <version_b_style_key>`

Replace the bracketed arguments with the exact keys supplied by the app. Read the
complete output in order. The loader opens the factual boundary, materials guide,
only the selected ICP and two assigned styles, then script craft, final review and
output format. Do not open other ICP or style files. If the loader fails, resolve
the error and run it again before writing. Apply the loaded rules in the workflow
below; loading them together does not merge or skip any step.

## Workflow

### Step 1 — Establish the factual boundary

Apply `references/source-accuracy.md` before extracting, ranking or rewriting any
fact. Its rules cover titles, hooks, questions, voiceover and on-screen direction.

### Step 2 — Build the internal materials sheet

Apply `references/materials-analysis.md`. Analyze the supplied document and privately
build the job, locked facts, source-stated mechanism, understanding need, cut list
and audience fit. Do not draft either script yet.

### Step 3 — Apply exactly one ICP lens

Apply the selected ICP reference loaded above as an editorial lens, never as
evidence about the source or audience. If the document clearly conflicts with the
selected ICP, set the editorial lens to `unclear`, rely on the source-only rules and
state the mismatch in `Engine notes`.

### Step 4 — Load only the two assigned styles

Apply the loaded Version A and Version B style references exactly. Do not swap or
replace them. Style changes structure and presentation only, never facts.

### Step 5 — Prepare the shared plan and output rules

Apply `references/script-craft.md`, `references/final-review.md` and
`references/output-format.md` before composing viewer-facing text. Use the exact
timing and word budget supplied by the app; do not recompute it and do not open a
separate duration guide. Privately plan the shared locked facts and two distinct
routes through them. Do not draft Version B before Version A has been released.
For healthcare, apply the duration-specific shape in `references/script-craft.md`
and checks in `references/icp-healthcare.md`. The assigned style still determines
each version's form; the understanding need informs its opening and order.

### Step 6 — Write, verify and release Version A

Draft Version A in its assigned style. Build a private source ledger for its title,
hook, voiceover and visuals; remove or repair every unsupported statement and apply
the relevant checks in `references/final-review.md`. Only after Version A passes,
start the response with the working title and the complete Version A section in
the exact `references/output-format.md` structure. Do not release an unreviewed or
incomplete Version A.

### Step 7 — Write, verify and release Version B

Draft Version B using the same locked facts and its own assigned style. Review its
claims against the source, then check that both versions retain the same locked
facts and differ structurally. Repair Version B before releasing it. Continue the
same response with the complete Version B section and `Engine notes` in the exact
output format. Return nothing else before, between or after these sections.

## Non-negotiable final rules

- Never use outside knowledge to complete, clarify or improve the source.
- Never invent facts, beliefs, audience behavior, scenarios, causes, mechanisms,
  outcomes, symptoms, urgency, definitions, recommendations, settings or visuals.
- Never weaken or detach a number, unit, condition, qualifier, negation, population,
  sequence, timeframe or exception.
- Never resolve ambiguity or contradiction on behalf of the source owner.
- Never put placeholders inside a viewer-facing script.
- Never print which references were read or describe this workflow in the output.
