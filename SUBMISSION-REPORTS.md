# Submission archive and Google Sheets report

## What ships

Railway continues serving the app and calling the writing provider. PostgreSQL is
the source of truth for the original text, metadata and generation outcome. A
private S3-compatible bucket stores exact uploaded file bytes. A background worker
projects submissions into one dedicated Google Sheets tab every 60 seconds.

Nothing is enabled until `SUBMISSION_ARCHIVE_ENABLED=true`. Missing configuration
then fails at startup instead of silently losing input. Sheets syncing additionally
requires `REPORT_SHEETS_ENABLED=true`. No historical inputs can be recovered from
before archiving was enabled. The feature captures **Submit**, not unsent typing.

## 1. Create PostgreSQL in Railway

In the same project/environment as the app, add a PostgreSQL database service.
In the app service Variables, reference that database's `DATABASE_URL` using the
Railway variable-reference picker. Keep this value secret. Use the private database
connection within Railway. For external databases, configure verified TLS according
to the provider; the code does not disable certificate verification.

On the first enabled startup, the app applies `migrations/001-submissions.sql` under
a transaction and advisory lock. This creates `submissions` and `submission_files`.
Pending sync state is stored durably on each submission (`revision`,
`synced_revision`, retry count and next retry time), not in server memory.

## 2. Create private object storage

Add a Railway Storage Bucket, or use another private S3-compatible bucket. A
bucket is separate from a `/data` volume. Copy the endpoint, region, bucket name,
access key and secret key from the provider's credentials screen into the app
variables listed in `.env.example`. Do not make the bucket public. Railway uses
virtual-hosted addressing: leave `S3_FORCE_PATH_STYLE=false`.

Files use `submissions/YYYY-MM-DD/<submission UUID>/<file UUID>` object keys.
Original filenames are metadata only; they never form a filesystem path or key.
Each file record contains its size and SHA-256 checksum. Uploads are limited to
3 files and 25 MiB total request bytes, including multipart overhead. Accepted:
PDF, DOCX, PPTX, TXT and MD. This is not a malware-scanning service.

## 3. Create a new Google spreadsheet and authorize the writer

Create a new, blank spreadsheet in the intended owner's Google Drive, named
`F.Learning — User Input Report`. Keep sharing restricted to the staff who need
the input data. Copy the spreadsheet ID from `/spreadsheets/d/<ID>/edit`.

In Google Cloud:

1. Create/select a project and enable **Google Sheets API**.
2. Create a service account for report syncing.
3. If your organization permits service-account keys, create its JSON credential.
   Paste the JSON into Railway's secret variable `GOOGLE_SERVICE_ACCOUNT_JSON`.
   Never send this credential through chat, commit it, or put it in Elementor.
4. Share only the intended spreadsheet with the credential's `client_email`, as
   Editor. A service account is separate from your Google login.
5. Set `GOOGLE_SHEET_ID` to the spreadsheet ID and `GOOGLE_SHEET_TAB=Submissions`.

The worker creates the `Submissions` tab automatically on the first pending sync,
adds a frozen orange header, wraps cells and writes these columns:

| Submit ID | Created at (UTC) | Input text | Document upload | Status | Duration | Level | File count | Submission details | Updated at (UTC) | Email |
|---|---|---|---|---|---|---|---|---|---|---|

All user-controlled cells use `RAW` mode, never formulas. Original text is complete
in PostgreSQL; text above 40,000 characters is shortened in the report and linked
to the full admin view. Multiple uploaded documents appear as separate lines in
the same report cell. The Sheet contains names and admin links, not file bytes.

## 4. Enable and deploy

Use `.env.example` for the variable names. Do not overwrite the existing AI keys.
Set a strong random `ADMIN_TOKEN` and the HTTPS origin `PUBLIC_APP_URL`.
Finally set both feature switches to `true` and redeploy the app. Do not enable
the archive without storage credentials: accepted input must be archived before
the AI call starts. A storage error returns 503 without calling the writing model.

Choose and document your retention period before accepting production data. This version
does not automatically delete submissions, storage objects or report rows.

## 5. Verify using synthetic input

Submit a harmless sample text and a small TXT file. Check:

1. The final generate response includes `submissionId`.
2. PostgreSQL has that ID and exact text, and the bucket has the file bytes.
3. The Sheet receives one row within roughly a minute after processing begins.
4. The same row changes to `completed` after AI succeeds (or an error status).
5. Open its `Submission details` link, enter the admin token and download the file.
6. Anonymous API requests must return 401. Retrying sync must not duplicate rows.

`GET /api/admin/archive-status` with `Authorization: Bearer <ADMIN_TOKEN>` reports
submission count, pending sync count, sync error count and incomplete submissions.
Never put the token in a URL. This API is deliberately not exposed to anonymous
users or the public Elementor page.

## Email-gated PDF downloads

After both scripts have completed and are committed, the response provides a signed
owner capability scoped to that submission. The browser shows one shared email form
and keeps both PDF buttons hidden. `POST /api/unlock-download` requires the owner
capability and a syntactically valid email address. The server saves the first email
and collection timestamp, increments the report revision and issues a one-hour PDF
grant. The report's new `Email` column is K; existing A:J columns keep their positions.

The same grant unlocks A and B. `POST /api/download-pdf` requires that grant in the
Authorization header and the matching submission ID. It reads the script from
PostgreSQL and ignores any client-provided title/text/email. Grants from another
submission, expired tokens, owner tokens used as PDF grants, missing stored emails
and disabled archive storage all fail closed. No ungated legacy PDF endpoint exists.
The HMAC signing secret is the existing `ADMIN_TOKEN`; neither owner nor PDF
capabilities expose the admin credential. Rotating it invalidates old capabilities.

The form checks email syntax, not ownership or mailbox existence. It does not send
marketing messages or an email verification code. People can still copy or print
script text already shown on screen; this feature gates the app's PDF endpoint.
Owner capabilities last 24 hours, remain in page memory only, and are not stored in
the archived result, report or logs. A new generation requires a new email confirmation.
Without archiving enabled, scripts can still generate but PDF downloads are unavailable.

## Admin links and report behavior

Links point to `/admin/submissions/<ID>`. This page requires the admin token to
load content; it keeps the token in memory for the current view, not localStorage
or URLs. Files stream through an authenticated endpoint with download headers.
There is no public user history or WordPress identity integration in this release.

PostgreSQL allocates each submission a permanent Sheet row starting at row 2.
Retries overwrite that same row, so a lost HTTP response cannot cause duplicate
append. PostgreSQL advisory locking serializes workers across app replicas.
If the submission changes during a sync, its newer revision stays pending.

**Reserve this tab for automated writes. Do not insert/delete/reorder rows or use
ordinary in-place sort. Use Google Sheets filter views, or reference the raw tab
from a separate presentation/report tab.** Do not copy another database into this
same tab: row allocation belongs to one database. Gaps in row numbers are normal.
The report is one-way; spreadsheet edits never change PostgreSQL.

Failures retry with backoff. If Sheets metadata/header setup fails, the same durable retry/backoff state
keeps all affected rows pending. Partial uploads remain recorded and are marked `archive_failed`;
after a process crash, stale `storing`/`processing` records become `interrupted`
after one hour. No partial object is downloadable unless its metadata says stored.

To rebuild the report after changing the Sheet/tab or repairing manual edits, run
`npm run reports:resync` in the app environment. This queues every stored submission.
It does not erase unrelated old rows: use a fresh report tab after database resets.

## Tests

`npm ci && npm test` runs existing generation tests plus archive/report tests.
Archive tests use PGlite's PostgreSQL engine for actual schema, transaction and
revision queries. Only session advisory locks and external S3/Sheets operations
are mocked. Production network credentials and provider integration still require
the synthetic acceptance check above.

## References

- Railway Buckets: https://docs.railway.com/storage-buckets
- Google Sheets values: https://developers.google.com/workspace/sheets/api/guides/values
- Google service accounts: https://developers.google.com/identity/protocols/oauth2/service-account
