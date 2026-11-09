# script-engine

## Submission archive and reporting

Optional PostgreSQL + private S3 storage + one-way Google Sheets reporting is
available behind feature switches (off by default). See [SUBMISSION-REPORTS.md](SUBMISSION-REPORTS.md)
for provisioning, credentials, report behavior and acceptance checks. Original text
and uploaded files are archived before calling AI when enabled; existing deployments
remain unchanged until configured.

## Production writing flow

The default `SKILL_SOURCE=original` runs the original magnetic-script-engine skill
from `skill-deploy/magnetic-script-engine-original/`. Its eight archived files are
preserved unchanged. `original-skill.js` adds runtime guidance for the web app and
also loads `skill-deploy/magnetic-script-engine/references/example-guidance.md` for
storytelling technique. The uploaded document remains the only factual source.

The original skill infers the ICP and chooses two contrasting styles itself. It
does not call the Luna ICP classifier or record A/B preference votes. The first
successful PDF download does not train or select a style in this mode. The
original skill may choose First-person Journey. The UI's Crazy Dial offers
Low: Classic Explainer, Medium: Playful Edutainment, and High: Cinematic
Storytelling; both versions use the same chosen level. Requests
without a level default to Medium. The runtime guidance requires each hook's
spoken lines to identify the subject and viewer problem within 15 seconds. It
removes the archived guide's 15-word-per-line suggestion, leaving spoken pacing
and the 15-second hook limit.

Set `SKILL_SOURCE=repository` to use the previous repository writing flow. That
mode classifies ICP with GPT-5.6 Luna, selects styles using the 60/40 preference
policy, records one A/B vote from the first successful PDF download, keeps Crazy
level fixed at High and excludes the retired Journey style. Its instructions are
loaded by `writing-instructions.js` from `skill-deploy/magnetic-script-engine/`.

The browser requests `/api/generate` as NDJSON,
shows Version A when complete, then Version B, and offers a PDF download for each.
The Crazy Dial control is shown only in original mode, where the selected level
is passed to the writing skill and shown in each result card.
During generation, the F.Learning facts rotate every eight seconds. A separate
estimated script progress bar advances with the request, stays below 100% until
the first version arrives, and replaces the old circular spinner.
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

## AI Agent Lab monitoring

`GET /internal/monitoring?days=1..30` feeds the Performance → Status tab of AI Agent Lab
(protocol `app-monitoring-v1` with `profile-v1`, see `lab-monitoring.js`). It is disabled (404)
until `LAB_MONITORING_TOKEN` is set to a random secret of at least 32 characters. The Lab sends it
as a bearer token (401 otherwise). Responses are `Cache-Control: private, no-store`.

The report is built from the usage records the server already keeps for each `/api/generate`
request:

- **Main Job:** `Tạo 2 phiên bản script`, one run per request. Its workload is, for example,
  `1 tài liệu · DOCX + text · video 2–3 phút · Medium` (file extensions only, never file names,
  text or scripts).
- **Sub-jobs**, from the request's timing offsets:
  - Đọc tài liệu
  - Phân loại ICP (repository mode only)
  - Viết Version A
  - Viết Version B
  - Hoàn thiện & lưu kết quả

  Non-streaming clients have no version marks, so their writing is a single `Viết kịch bản (A + B)` step.
- **Outcomes:** `ok` is success and other statuses fail the run. Rate-limited and bad requests are not runs.
- **Tốc độ phản hồi:** the server-side P95 from the request to Version A being sent.
- **Độ nhạy thao tác:** a browser-measured P95 from the Generate click until the generating screen is painted.
  - The page posts `{metric: "clickLatency", ms}` to `POST /api/monitoring/ui-sample`. The server checks each sample (0–60 s, body of 200 bytes at most) and allows 60 per IP per hour.
  - Only the duration and time are stored, in `ui-samples.jsonl` next to `USAGE_LOG` (or at `UI_SAMPLE_LOG`).

History lasts as long as the usage log. Set `USAGE_LOG` on a mounted volume (for example
`/data/usage.jsonl`); otherwise it restarts on each redeploy. Test with `node --test lab-monitoring.test.js`.

