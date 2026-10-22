# script-engine

## A/B picks

The UI lets a visitor pick Version A or B after a successful generation. Before calling Claude, the server classifies the document's ICP and selects two contrasting narrative styles. The selected style IDs are stored with a random generation ID; the visitor's pick is saved as one win/loss comparison. Later requests use smoothed global and ICP-specific win rates to select styles. This is preference learning in the application, **not** training the Claude model.

The browser requests `/api/generate` as NDJSON. The server streams Version A as soon as its complete section is available, then Version B, then final usage and A/B preference metadata. The skill reviews each version before releasing it. Clients that do not request NDJSON keep the original single-JSON response.

The skill returns plain text with labeled time, voiceover and on-screen lines. The UI shows this text without Markdown syntax. Each completed Version has its own Download PDF button; `/api/download-pdf` creates the file from that Version's visible text on demand and does not save it on the server. The parser also accepts older Markdown responses while the deployed skill updates.

The backend reads writing instructions directly from `skill-deploy/magnetic-script-engine/` using `writing-instructions.js`. Shared rules form a stable cached system-prompt prefix; only the selected ICP and two styles are appended. No Anthropic custom skill, `SKILL_ID`, code execution tool, or skill upload is required. Restart/redeploy after editing the instruction files. The old Python publishing/loader scripts are legacy utilities and are not used by the app. Automatic skill publishing has been removed.

For local use: run `npm ci`, set `CLAUDE_API` (or `ANTHROPIC_API_KEY`), then run `npm start`. The default writing model is Sonnet 5.5 with medium effort; ICP classification uses Haiku 4.5.

Set `PREFERENCE_LOG=/data/preferences.jsonl` and mount a persistent Railway Volume at `/data` to retain picks across redeploys. Otherwise the default file `./preferences.jsonl` is ephemeral on Railway. Do not commit this file. The log contains only ICP, style IDs, timestamps, opaque generation IDs, hashed bearer tokens and the A/B choice; it stores no uploaded documents or generated scripts.

Deploy the complete repository, including `writing-instructions.js` and `skill-deploy/magnetic-script-engine/`. Only the API key is required; existing `SKILL_ID` environment variables are ignored.
