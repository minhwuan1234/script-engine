# script-engine

## A/B picks

The UI lets a visitor pick Version A or B after a successful generation. Before calling Claude, the server classifies the document's ICP and selects two contrasting narrative styles. The selected style IDs are stored with a random generation ID; the visitor's pick is saved as one win/loss comparison. Later requests use smoothed global and ICP-specific win rates to select styles. This is preference learning in the application, **not** training the Claude model.

Set `PREFERENCE_LOG=/data/preferences.jsonl` and mount a persistent Railway Volume at `/data` to retain picks across redeploys. Otherwise the default file `./preferences.jsonl` is ephemeral on Railway. Do not commit this file. The log contains only ICP, style IDs, timestamps, opaque generation IDs, hashed bearer tokens and the A/B choice; it stores no uploaded documents or generated scripts.

Deploy both `server.js` and `preference-store.js`, plus `index.html`. Push the changed custom skill in `skill-deploy/magnetic-script-engine/SKILL.md` with the project's existing skill deploy process so the deployed skill respects both app-selected styles. Existing `SKILL_ID` and `CLAUDE_API` configuration remains required. The Crazy level is still fixed at Medium in the browser; this change adds no Crazy control.

Run `node --test tests/preference-store.test.js` for the preference-store checks.
