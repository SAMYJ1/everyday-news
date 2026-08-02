# Everyday News Operations

Run every command from the repository root unless the command says otherwise.
Use Node.js 22, and never paste secret values into a command line, a URL, a
checked-in file, or a log.

## GitHub Actions production setup

The `Deploy` workflow is the only automated production deployment path. It
runs after a push to `main` or from a deliberate manual dispatch. Pull
requests run CI only and never receive production credentials.

Before merging the deployment workflow, create a GitHub Environment named
`production`. Add branch protection or required reviewers there if the
repository requires an approval gate, then configure these repository
secrets:

- `CLOUDFLARE_API_TOKEN`: a least-privilege token with Workers Scripts, D1,
  and Pages write access for the target account.
- `CLOUDFLARE_ACCOUNT_ID`: the exact target Cloudflare account ID.
- `CLOUDFLARE_D1_DATABASE_NAME`: `everyday-news`.
- `CLOUDFLARE_PAGES_PROJECT`: `everyday-news`.
- `WORKER_BASE_URL`: the deployed Worker origin, with no path or trailing
  slash.
- `PAGES_BASE_URL`: the production Pages origin, with no path or trailing
  slash.

`ADMIN_KEY`, `REDDIT_USER_AGENT`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`,
and `APP_ORIGIN` remain Cloudflare Worker
runtime secrets. Do not add them to the Web build or expose them as `VITE_*`
variables.

The workflow does not create Cloudflare resources. Complete the D1, Queue,
Pages, and Worker-secret bootstrap below before the first production run.

## 1. Local verification

Install exactly the locked dependencies and run the fixture-backed checks:

```sh
npm ci
npm run test -w @everyday-news/worker -- reddit-rss-client.spec.ts reddit-rss-parser.spec.ts
npm test
npm run typecheck
npm run build
git diff --check
```

`npm run build` performs a local Wrangler dry run; it does not deploy. A
Wrangler process using the remote Workers AI binding, including one started in
local development mode, can consume the account's Workers AI allowance. The
fixture tests above do not make Workers AI or Reddit requests.

To make one deliberate live Reddit request before provisioning, enter the
owner-approved user agent without echoing it:

```sh
read -rs "REDDIT_USER_AGENT?Reddit user agent: "
printf '\n'
curl --fail-with-body --silent --show-error \
  --user-agent "$REDDIT_USER_AGENT" \
  --header 'Accept: application/atom+xml, application/rss+xml;q=0.9' \
  --output /tmp/everyday-news-reddit-probe.atom \
  --write-out 'HTTP %{http_code}; content-type %{content_type}\n' \
  'https://www.reddit.com/r/todayilearned/hot.rss'
node -e 'const fs=require("node:fs");const value=fs.readFileSync("/tmp/everyday-news-reddit-probe.atom","utf8");if(!value.includes("<feed")||!value.includes("<entry>"))process.exit(1);console.log("Valid Reddit Atom feed")'
unset REDDIT_USER_AGENT
```

This is exactly one request. Stop on `401`, `403`, `429`, HTML, a challenge
page, or invalid Atom XML. Do not retry through proxies or alternate identities.
The response file is temporary and may be deleted after inspection.

## 2. Authenticate and inspect before creating anything

Authenticate interactively, then confirm the intended Cloudflare account:

```sh
npx wrangler login
npx wrangler whoami
```

List all existing resources before running a create command:

```sh
npx wrangler d1 list --json
npx wrangler queues list
npx wrangler pages project list --json
```

Inspect the complete output for these exact names:

- D1 database: `everyday-news`
- producer/consumer queue: `everyday-news-pipeline`
- dead-letter queue: `everyday-news-dead-letter`
- Pages project: `everyday-news`

If an exact name already exists, reuse it and do not run its create command.
Record the exact D1 `uuid` returned by `d1 list --json`; do not derive it from
the name. If an exact name is absent, create only that missing resource, once:

```sh
npx wrangler d1 create everyday-news
npx wrangler queues create everyday-news-pipeline
npx wrangler queues create everyday-news-dead-letter
```

After D1 exists, add the following binding to
`apps/worker/wrangler.jsonc`, replacing `PASTE_EXACT_D1_UUID_HERE` with the
opaque UUID printed by Wrangler:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "everyday-news",
    "database_id": "PASTE_EXACT_D1_UUID_HERE",
    "migrations_dir": "migrations"
  }
]
```

Do not deploy or commit while that explanatory placeholder remains. Re-run
`npx wrangler d1 list --json` and compare the committed ID with the account
output character for character.

## 3. Migrate and configure the Worker

Apply the checked-in D1 migrations to the remote database:

```sh
npx wrangler d1 migrations apply everyday-news --remote --config apps/worker/wrangler.jsonc
```

Wrangler displays the pending migrations and asks for confirmation. Review the
names before confirming. It captures a backup and rolls back a migration that
fails; make later schema corrections in a new forward migration.

Set the owner-provided secrets interactively. Wrangler reads each value
from the terminal; do not pipe it from shell history:

```sh
npx wrangler secret put ADMIN_KEY --config apps/worker/wrangler.jsonc
npx wrangler secret put REDDIT_USER_AGENT --config apps/worker/wrangler.jsonc
npx wrangler secret put REDDIT_CLIENT_ID --config apps/worker/wrangler.jsonc
npx wrangler secret put REDDIT_CLIENT_SECRET --config apps/worker/wrangler.jsonc
```

`ADMIN_KEY` must be a new high-entropy value used only for this service.
`REDDIT_USER_AGENT` must be the owner-approved descriptive user agent. Neither
has a repository default.

The Reddit client ID and secret must belong to the explicitly approved Data API
application for this service. Configure both or neither. With both configured,
the Worker uses `client_credentials` and only calls `oauth.reddit.com`; an OAuth
failure is surfaced and is never silently downgraded to RSS. Without them, the
Worker keeps the existing low-frequency RSS path as a best-effort fallback and
cannot guarantee three to five daily cards.

Deploy the Worker only after the real D1 UUID is present:

```sh
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

Copy the exact deployed Worker origin (scheme and hostname, with no path):

```sh
export WORKER_URL='https://EXACT_WORKER_HOSTNAME'
curl --fail-with-body --silent --show-error "$WORKER_URL/api/health"
```

The health response must contain `"ok":true`, service
`"everyday-news-api"`, and `"version":1`.

## 4. Build and deploy Pages

Use the exact Worker origin in a local, ignored frontend environment file:

```sh
cp apps/web/.env.example apps/web/.env
```

Edit `apps/web/.env` so it contains the deployed origin:

```dotenv
VITE_API_BASE_URL=https://EXACT_WORKER_HOSTNAME
```

Build, then list Pages projects again:

```sh
npm run build -w @everyday-news/web
npx wrangler pages project list --json
```

If and only if the exact project name `everyday-news` is absent, create it:

```sh
npx wrangler pages project create everyday-news --production-branch main
```

For an existing project, confirm its production branch is already `main` in
the `pages project list --json` output before continuing. Deploy to that one
project and explicitly classify the direct upload as a production-branch
deployment:

```sh
npx wrangler pages deploy apps/web/dist --project-name everyday-news --branch main
```

Copy the actual production alias shown by Wrangler for that deployment (or the
production custom-domain origin shown in the Pages dashboard). Do not use the
unique deployment URL or any branch-preview URL for CORS, and do not assume the
alias from the project name. Set the actual production alias/origin
interactively and redeploy the Worker so its runtime configuration and code
are current:

```sh
npx wrangler secret put APP_ORIGIN --config apps/worker/wrangler.jsonc
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

At the `APP_ORIGIN` prompt, enter only the exact production origin, such as
`https://<assigned-project-hostname>`, with no path or trailing slash.

## 5. Production probes

Read the administrator key without echoing it:

```sh
read -rs "ADMIN_KEY?Administrator key: "
printf '\n'
```

First prove that private data is not available anonymously:

```sh
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  "$WORKER_URL/api/runs/latest"
```

The status must be `401`.

Confirm the public feed is available without an administrator key:

```sh
curl --fail-with-body --silent --show-error "$WORKER_URL/api/public/dates"
curl --fail-with-body --silent --show-error "$WORKER_URL/api/public/cards"
```

Public cards may only have `draft` or `approved` status and must not include
model, prompt, input-hash, review-history, run-error, setting, or credential
fields.

Then start exactly one manual run:

```sh
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $ADMIN_KEY" \
  --header 'Content-Type: application/json' \
  --data '{}' \
  "$WORKER_URL/api/runs"
```

The response status is `202`. Do not submit a second probe run. Poll the latest
run without putting the key in the URL:

```sh
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer $ADMIN_KEY" \
  "$WORKER_URL/api/runs/latest"
```

The run may complete with real data, become partial, or fail with a typed
access-denial error. For `unauthorized`, `forbidden`, `rate_limited`, or
`challenge`, confirm the run stops and do not weaken the stop behavior.

When the anonymous circuit breaker is intentionally ready to be re-enabled,
make this explicit authenticated request once:

```sh
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $ADMIN_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"enabled":true}' \
  "$WORKER_URL/api/settings/anonymous-collection"
```

Re-enable only after the access problem has been resolved. This endpoint does
not bypass Reddit access controls.

## 6. Targeted stalled-run recovery

Ordinary stale runs are reconciled automatically when the latest-run endpoint
is read or a new run starts. For a historical incident that predates that
logic, resolve the exact run ID first and inspect it before writing:

```sh
npx wrangler d1 execute everyday-news --remote \
  --config apps/worker/wrangler.jsonc \
  --command "SELECT id, local_date, status, started_at, finished_at FROM fetch_runs WHERE id = 'EXACT_RUN_ID'"
```

Only if that exact row is still `queued` or `running`, update that one ID:

```sh
npx wrangler d1 execute everyday-news --remote \
  --config apps/worker/wrangler.jsonc \
  --command "UPDATE fetch_runs SET status = 'failed', error_code = 'run_timed_out', error_message = 'Collection run exceeded the ten-minute execution limit', finished_at = CURRENT_TIMESTAMP WHERE id = 'EXACT_RUN_ID' AND status IN ('queued', 'running')"
```

Read the row again and confirm it is terminal. If a matching dead-letter
message exists, verify its complete body and acknowledge only that message;
never purge the whole dead-letter queue as part of a single-run recovery.

## 7. Browser acceptance

Open the production Pages URL and verify:

1. `/` loads the public feed without a key and shows only draft/approved cards.
2. `/admin` shows the administrator-key gate.
3. A missing or wrong key cannot load private runs or management card data.
4. The correct key shows the latest run.
5. Drafts show the Reddit post, external source, participating comment links,
   and all structured Chinese sections.
6. Approve, reject, and regenerate each work once.
7. A second manual start while one is active does not create a duplicate.
8. A terminal same-day attempt can be followed by a fresh attempt.
9. Typed run failures and stale-run timeout warnings are readable.
10. Rejected, failed, source-deleted, and deleted-source cards do not appear
    on the public page.

The key must remain in session storage only. Inspect the built files and
request URLs if there is any suspicion that it was included in the frontend.

## 8. Cron verification

The configured trigger is `0 0 * * *` (00:00 UTC, 08:00 Asia/Shanghai).
After the next trigger, query that Shanghai local date:

```sh
export LOCAL_DATE="$(TZ=Asia/Shanghai date +%F)"
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer $ADMIN_KEY" \
  "$WORKER_URL/api/runs?date=$LOCAL_DATE"
unset LOCAL_DATE
```

Confirm one run exists for the date and that previously stored
`source + external_id` pairs were not duplicated. If Cron fails, record the
typed stage and error; do not relax authorization or Reddit access handling.

After the Cron probe (or before closing a shell in which no Cron probe will be
run), clear the values:

```sh
unset ADMIN_KEY WORKER_URL
```

## 9. OAuth adapter replacement prerequisites

Do not switch the source adapter until Reddit has approved the application and
the owner has:

- documented the daily volume, limited comment collection, AI provider,
  retention, private MVP scope, deletion handling, attribution, and backlinks;
- created the Reddit client through the approved process;
- stored the client ID, client secret, and refresh credentials only as
  Cloudflare secrets;
- implemented `listTopPosts`, `getPostWithComments`, `checkItems`, and
  `checkComments` with the same internal return types as the anonymous adapter;
- added fixture coverage for OAuth success, token refresh, `401`, `403`, `429`,
  `5xx`, malformed responses, and deletion sync;
- run the complete local suite and a single controlled production probe.

Keep anonymous collection disabled during the cutover. Never fall back to
anonymous access automatically when OAuth authentication fails.
