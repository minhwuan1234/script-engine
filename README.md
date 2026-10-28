# script-engine

## Production writing flow

The default `SKILL_SOURCE=original` runs the original magnetic-script-engine skill
from `skill-deploy/magnetic-script-engine-original/`. Its eight archived files are
preserved unchanged. `original-skill.js` adds runtime guidance for the web app and
also loads `skill-deploy/magnetic-script-engine/references/example-guidance.md` for
storytelling technique. The uploaded document remains the only factual source.

The original skill infers the ICP and chooses two contrasting styles itself. It
does not call the Luna ICP classifier or record A/B preference votes. The first
successful PDF download does not train or select a style in this mode. The
original skill may choose First-person Journey. Both versions use the same Crazy
level; with the unchanged production UI, no level is sent and the default is
Medium. The runtime guidance requires each hook's spoken lines to identify the
subject and viewer problem within 15 seconds. It removes the archived guide's
15-word-per-line suggestion, leaving spoken pacing and the 15-second hook limit.

Set `SKILL_SOURCE=repository` to use the previous repository writing flow. That
mode classifies ICP with GPT-5.6 Luna, selects styles using the 60/40 preference
policy, records one A/B vote from the first successful PDF download, keeps Crazy
level fixed at High and excludes the retired Journey style. Its instructions are
loaded by `writing-instructions.js` from `skill-deploy/magnetic-script-engine/`.

The browser UI is the same in both modes. It requests `/api/generate` as NDJSON,
shows Version A when complete, then Version B, and offers a PDF download for each.
It displays labeled plain text and does not show token/cost usage. The original
skill writes Markdown internally; `server.js` converts its tables and headings
to the existing plain-text result format. The server still records usage in a
JSONL log and exposes aggregate usage through the protected admin endpoint.
Clients without NDJSON support receive one JSON result.

## Local setup

Run `npm ci` and `npm start`. The default `WRITING_PROVIDER=openai` uses
`OPENAI_API_KEY` and writes with GPT-6 Sol. Railway's existing `OPEN_AI_API`
variable is accepted as a legacy alias; `OPENAI_API_KEY` takes priority if both
are set. Set `WRITING_PROVIDER=anthropic` to use `CLAUDE_API` (or
`ANTHROPIC_API_KEY`) and Sonnet 5.5.
Original mode requires only the chosen writing provider's key. Repository mode
also requires `OPENAI_API_KEY` for Luna ICP classification. `/api/health` reports
the active skill source, provider, model and key readiness. `SKILL_ID` is unused.

Scanned PDFs that cannot be extracted locally are sent as PDF inputs. No provider
fallback is attempted on an API error. To retain usage and preference logs on
Railway, mount a volume and set `USAGE_LOG` and `PREFERENCE_LOG` to paths on it.
Never commit keys or those logs.

Run tests with `node --test original-skill.test.js original-mode.integration.test.js openai-writer.test.js preference-store.test.js`.
