# script-engine

## A/B picks

The UI lets a visitor pick Version A or B after a successful generation. Before calling Claude, the server classifies the document's ICP and selects two contrasting narrative styles. The selected style IDs are stored with a random generation ID; the visitor's pick is saved as one win/loss comparison. Later requests use smoothed global and ICP-specific win rates to select styles. This is preference learning in the application, **not** training the Claude model.

The browser requests `/api/generate` as NDJSON. The server streams Version A as soon as its complete section is available, then Version B, then final usage and A/B preference metadata. The skill reviews each version before releasing it. Clients that do not request NDJSON keep the original single-JSON response.

The skill returns plain text with labeled time, voiceover and on-screen lines. The UI shows this text without Markdown syntax. Each completed Version has its own Download PDF button; `/api/download-pdf` creates the file from that Version's visible text on demand and does not save it on the server. The parser also accepts older Markdown responses while the deployed skill updates.

The skill uses `scripts/load_references.py` to read the shared writing rules, one selected ICP reference and the two assigned style references in one code execution call. It still drafts and reviews Version A before Version B. Usage logs record elapsed milliseconds through extraction, ICP selection and each streamed version, plus the API-reported number of code execution requests when available; compare those fields before attributing a latency change to the loader.

Set `PREFERENCE_LOG=/data/preferences.jsonl` and mount a persistent Railway Volume at `/data` to retain picks across redeploys. Otherwise the default file `./preferences.jsonl` is ephemeral on Railway. Do not commit this file. The log contains only ICP, style IDs, timestamps, opaque generation IDs, hashed bearer tokens and the A/B choice; it stores no uploaded documents or generated scripts.

Deploy both `server.js` and `preference-store.js`, plus `index.html`. Push the changed custom skill in `skill-deploy/magnetic-script-engine/SKILL.md` with the project's existing skill deploy process so the deployed skill respects both app-selected styles. Existing `SKILL_ID` and `CLAUDE_API` configuration remains required. The Crazy level is still fixed at Medium in the browser; this change adds no Crazy control.

Run `node --test tests/preference-store.test.js` for the preference-store checks.
