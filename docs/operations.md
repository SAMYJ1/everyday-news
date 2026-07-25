# Everyday News Operations

Run every command from the repository root unless the command says otherwise.
Use Node.js 22, and never paste secret values into a command line, a URL, a
checked-in file, or a log.

## 1. Local verification

Install exactly the locked dependencies and run the fixture-backed checks:

```sh
npm ci
npm run test -w @everyday-news/worker -- reddit-client.spec.ts reddit-parser.spec.ts
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
  --header 'Accept: application/json' \
  --output /tmp/everyday-news-reddit-probe.json \
  --write-out 'HTTP %{http_code}; content-type %{content_type}\n' \
  'https://www.reddit.com/r/todayilearned/top.json?t=day&limit=1&raw_json=1'
node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync("/tmp/everyday-news-reddit-probe.json","utf8"));if(value?.kind!=="Listing"||!Array.isArray(value?.data?.children))process.exit(1);console.log("Valid Reddit Listing")'
unset REDDIT_USER_AGENT
```

This is exactly one request. Stop on `401`, `403`, `429`, HTML, a challenge
page, or invalid JSON. Do not retry through proxies or alternate identities.
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

Set the two owner-provided secrets interactively. Wrangler reads each value
from the terminal; do not pipe it from shell history:

```sh
npx wrangler secret put ADMIN_KEY --config apps/worker/wrangler.jsonc
npx wrangler secret put REDDIT_USER_AGENT --config apps/worker/wrangler.jsonc
```

`ADMIN_KEY` must be a new high-entropy value used only for this service.
`REDDIT_USER_AGENT` must be the owner-approved descriptive user agent. Neither
has a repository default.

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

The status must be `401`. Then start exactly one manual run:

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

## 6. Browser acceptance

Open the production Pages URL and verify:

1. A missing or wrong key cannot load runs or cards.
2. The correct key shows the latest run.
3. Drafts show the Reddit post, external source, participating comment links,
   and all structured Chinese sections.
4. Approve, reject, and regenerate each work once.
5. A second manual start on the same Shanghai date does not create a duplicate.
6. Typed run failures are readable.
7. No collected content appears before authentication.

The key must remain in session storage only. Inspect the built files and
request URLs if there is any suspicion that it was included in the frontend.

## 7. Cron verification

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

## 8. OAuth adapter replacement prerequisites

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
