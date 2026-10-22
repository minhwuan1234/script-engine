# script-engine

## A/B picks

Downloading a version also selects it. The first successful PDF download for a generation records one A/B preference; repeat downloads do not add votes, and both PDFs remain downloadable. If a version is downloaded during streaming, its choice is queued until the final preference token arrives. Failed PDF requests do not record a choice. Preference-saving errors do not block the download. Before calling the writing model, the server classifies the document's ICP and selects two contrasting narrative styles. The selected style IDs are stored with a random generation ID; the visitor's pick is saved as one win/loss comparison. Later requests use smoothed global and ICP-specific win rates to select styles. This is preference learning in the application, **not** training the model.

The browser requests `/api/generate` as NDJSON. The server streams Version A as soon as its complete section is available, then Version B, then final metadata. Token/cost information and the Usage panel are hidden from the public UI; server usage logs and the protected admin endpoint remain available. The skill reviews each version before releasing it. Clients that do not request NDJSON keep the original single-JSON response.

The skill returns plain text with labeled time, voiceover and on-screen lines. The UI shows this text without Markdown syntax. Each completed Version has its own Download PDF button; `/api/download-pdf` creates the file from that Version's visible text on demand and does not save it on the server. The parser also accepts older Markdown responses while the deployed skill updates.

The backend reads writing instructions directly from `skill-deploy/magnetic-script-engine/` using `writing-instructions.js`. Shared rules form a stable cached system-prompt prefix; only the selected ICP and two styles are appended. No Anthropic custom skill, `SKILL_ID`, code execution tool, or skill upload is required. Restart/redeploy after editing the instruction files. The old Python publishing/loader scripts are legacy utilities and are not used by the app. Automatic skill publishing has been removed.

For local use: run `npm ci`, set `OPENAI_API_KEY` for ICP and `CLAUDE_API` (or `ANTHROPIC_API_KEY`) for Anthropic writing, then run `npm start`. The default writing model is Sonnet 5.5 with medium effort; ICP classification uses GPT-5.6 Luna with reasoning disabled.

Set `PREFERENCE_LOG=/data/preferences.jsonl` and mount a persistent Railway Volume at `/data` to retain picks across redeploys. Otherwise the default file `./preferences.jsonl` is ephemeral on Railway. Do not commit this file. The log contains only ICP, style IDs, timestamps, opaque generation IDs, hashed bearer tokens and the A/B choice; it stores no uploaded documents or generated scripts.

Deploy the complete repository, including `writing-instructions.js` and `skill-deploy/magnetic-script-engine/`. The API keys for the configured stages are required; existing `SKILL_ID` environment variables are ignored.

## Try GPT-6 Sol for writing

Set these environment variables, then restart the server:

```dotenv
WRITING_PROVIDER=openai
OPENAI_MODEL=gpt-6-sol
OPENAI_API_KEY=your-key
```

ICP classification uses `gpt-5.6-luna` through OpenAI Responses with reasoning disabled, a 600-token cap, and a 15-second timeout. Set `ICP_MODEL=gpt-5.6-luna` if overriding an older deployment value. With OpenAI writing selected, both stages use `OPENAI_API_KEY`; no Anthropic key is needed. Writing uses medium reasoning effort. The same repository instructions, PDF extraction, incremental A/B display, and PDF downloads are used. Scanned PDFs that cannot be extracted locally are sent as PDF inputs. There is no automatic provider fallback on errors.

The default provider remains `anthropic` for existing deployments. `/api/health` reports the active writing provider/model and whether the required keys are configured. Never commit keys. Run adapter tests with `node --test openai-writer.test.js`.

OpenAI cost estimates use standard GPT-6 Sol rates: $2/M input, $0.20/M cached reads, $2.50/M cache writes (30 minutes), and $10/M output including reasoning. Above 272K prompt tokens, input/cache rates double and output is 1.5x. Override `OPENAI_PRICE_IN_PER_M` and `OPENAI_PRICE_OUT_PER_M` if applicable rates change. ICP classification is excluded from these estimates. Sources: [model documentation](https://developers.openai.com/api/docs/models/gpt-6-sol), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Writing examples

`skill-deploy/magnetic-script-engine/examples/` preserves the three supplied A/B
reference pairs (HOPES, colonoscopy, cirrhosis). `writing-instructions.js` loads one
complete pair per request, selected by narrative-style weights, not by medical topic.
All examples are read at startup; restart after edits. `references/example-guidance.md`
explains how to transfer narrative progression and visual motifs while excluding
sample facts, Markdown formatting and fixed durations. The samples are not medical
source documents. The current upload remains the factual basis for each script.

## F.Learning tone of voice

`skill-deploy/magnetic-script-engine/references/tone-of-voice.md` is the shared voice
reference for all writing requests. It replaces `flearning-voice.md` and covers
personality, spoken rhythm, appropriate wit, emotional register and concrete
before/after examples. It is editorial guidance for the tool, informed by the user
and supplied references, rather than an official brand manual. The loader includes
it once in the shared system prefix; ICP and narrative styles adapt the context
without adding separate competing brand voices. Restart after editing it.
