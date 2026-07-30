# Public Knowledge Site and Run Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover Queue runs to a terminal state after exhausted or stale deliveries and add a public publish-before-review knowledge feed at `/` while retaining the private dashboard at `/admin`.

**Architecture:** D1 stores multiple attempts per Shanghai local date with a partial unique index permitting only one active attempt. The Worker owns retry exhaustion and stale-run reconciliation, exposes a narrow public read model, and keeps all management routes authenticated. One React build selects a public or admin shell from the pathname without adding a router dependency.

**Tech Stack:** Cloudflare Workers, Queues, D1, Workers Observability, TypeScript, React 19, Vite, Vitest, Cloudflare Vitest pool.

## Global Constraints

- Public visibility is exactly `draft` plus `approved`; `rejected`, `failed`, `source_deleted`, and deleted sources are excluded.
- `/` is public, `/admin` retains the administrator-key gate, and unknown paths render a not-found view.
- A run is stale after ten minutes in `queued` or `running`.
- Queue `max_retries` is `2`; delivery attempt `3` is terminalized rather than retried.
- Public responses contain no model name, prompt version, input hash, review history, run error, delivery claim, setting, or credential.
- No administrator key, authorization header, Reddit response body, or card content may be logged.
- Preserve the untracked `.wrangler/` directory and all unrelated user changes.

---

### Task 1: Allow recoverable same-day run attempts

**Files:**
- Create: `apps/worker/migrations/0004_run_attempts.sql`
- Modify: `apps/worker/test/apply-migrations.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Test: `apps/worker/test/repository.spec.ts`
- Test: `apps/worker/test/migrations.spec.ts`

**Interfaces:**
- Produces: `Repository.reconcileStaleRuns(staleBefore: string, finishedAt: string): Promise<number>`
- Preserves: `Repository.getRunByLocalDate(localDate): Promise<FetchRun | null>`, now returning the newest attempt.
- Preserves: `Repository.createOrGetRun(input)`, now reusing only an active attempt and creating a new attempt after terminal status.

- [ ] **Step 1: Write failing migration and repository tests**

Add tests that:

```ts
it("retains a failed same-day attempt and creates one fresh active attempt", async () => {
  const first = await repository.createOrGetRun({
    localDate: "2026-07-23",
    startedAt: "2026-07-23T00:00:00.000Z",
  });
  await repository.markRunFailed(first.run.id, "run_timed_out", "Run timed out", "2026-07-23T00:11:00.000Z");

  const second = await repository.createOrGetRun({
    localDate: "2026-07-23",
    startedAt: "2026-07-23T00:12:00.000Z",
  });

  expect(second.created).toBe(true);
  expect(second.run.id).not.toBe(first.run.id);
  expect((await repository.listRuns("2026-07-23")).map(({ id }) => id))
    .toEqual([second.run.id, first.run.id]);
});

it("reconciles only stale active runs", async () => {
  const stale = await repository.createRun({
    id: "stale",
    localDate: "2026-07-23",
    startedAt: "2026-07-23T00:00:00.000Z",
  });
  await repository.markRunRunning(stale.id);
  await repository.createRun({
    id: "fresh",
    localDate: "2026-07-24",
    startedAt: "2026-07-24T00:09:01.000Z",
  });

  expect(await repository.reconcileStaleRuns(
    "2026-07-24T00:00:00.000Z",
    "2026-07-24T00:10:00.000Z",
  )).toBe(1);
  expect(await repository.getRunStatus("stale")).toBe("failed");
  expect(await repository.getRunStatus("fresh")).toBe("queued");
});
```

Also replace the old “prevents two runs for the same local date” assertion
with a concurrency contract: two active attempts for one date are rejected or
deduplicated, while a terminal attempt does not block a replacement.

In `migrations.spec.ts`, apply migrations only through `0003`, seed a source,
candidate, summary, regeneration request, and review action, apply `0004`, then
assert all five records and their foreign-key relationships still exist.
Refactor `apply-migrations.ts` to export the migration descriptors and accept
an optional inclusive migration name so the test exercises the real migration
sequence rather than copied SQL.

- [ ] **Step 2: Run repository tests and verify RED**

Run:

```sh
npm test -w @everyday-news/worker -- repository.spec.ts migrations.spec.ts
```

Expected: failure because the schema still has `UNIQUE(local_date)` and `reconcileStaleRuns` does not exist.

- [ ] **Step 3: Add the run-attempt migration**

`0004_run_attempts.sql` must rebuild `fetch_runs` without the table-level
local-date uniqueness while preserving every existing column and row.
Because D1 continues executing `ON DELETE CASCADE` while foreign-key checks
are deferred, the migration must also copy and rebuild the complete dependent
graph instead of dropping the parent in isolation:

1. `PRAGMA defer_foreign_keys = ON`.
2. Create `new_fetch_runs`, `new_candidates`, `new_summaries`,
   `new_review_actions`, and `new_regeneration_requests` with their final
   schemas.
3. Copy all rows into the new tables in parent-to-child order.
4. Drop old tables in child-to-parent order: `review_actions`,
   `regeneration_requests`, `summaries`, `candidates`, `fetch_runs`.
5. Rename new tables in parent-to-child order.
6. Recreate every index and the `record_summary_review_action` trigger defined
   for those tables.
7. Run `PRAGMA foreign_key_check`, then
   `PRAGMA defer_foreign_keys = OFF`.

Add:

```sql
CREATE INDEX idx_fetch_runs_local_date_started
  ON fetch_runs(local_date, started_at DESC);

CREATE UNIQUE INDEX idx_fetch_runs_one_active_local_date
  ON fetch_runs(local_date)
  WHERE status IN ('queued', 'running');
```

Add this migration to `applyMigrations`.

- [ ] **Step 4: Implement attempt selection and stale reconciliation**

Change run reads to order by `started_at DESC, id DESC`. Change
`createOrGetRun` to:

1. insert a queued run with `ON CONFLICT DO NOTHING`;
2. select the newest active run for the local date;
3. return the inserted run when created, otherwise the concurrently existing
   active run.

Implement stale reconciliation as one bounded update:

```sql
UPDATE fetch_runs
SET status = 'failed',
    error_code = 'run_timed_out',
    error_message = 'Collection run exceeded the ten-minute execution limit',
    finished_at = ?
WHERE status IN ('queued', 'running')
  AND unixepoch(started_at) <= unixepoch(?)
```

- [ ] **Step 5: Run migration and repository tests and verify GREEN**

Run:

```sh
npm test -w @everyday-news/worker -- repository.spec.ts migrations.spec.ts
```

Expected: all repository tests pass and both same-date attempts remain in history.

- [ ] **Step 6: Commit Task 1**

```sh
git add apps/worker/migrations/0004_run_attempts.sql apps/worker/test/apply-migrations.ts apps/worker/src/db/repository.ts apps/worker/test/repository.spec.ts apps/worker/test/migrations.spec.ts
git commit -m "fix(worker): recover stale run attempts"
```

### Task 2: Terminalize exhausted Queue deliveries

**Files:**
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/http/router.ts`
- Modify: `apps/worker/wrangler.jsonc`
- Test: `apps/worker/test/orchestration.spec.ts`
- Test: `apps/worker/test/http-api.spec.ts`
- Test: `apps/worker/test/config.spec.ts`

**Interfaces:**
- Produces: `PIPELINE_MAX_RETRIES = 2` and `RUN_STALE_AFTER_MS = 600_000`.
- Consumes: `Repository.reconcileStaleRuns`.

- [ ] **Step 1: Write failing retry-exhaustion tests**

Add an orchestration test using a real run and a Reddit adapter that throws
`RedditTemporaryFailure`:

```ts
it("marks the run failed instead of retrying after the final delivery", async () => {
  const { run } = await repository.createOrGetRun({
    localDate: "2026-07-24",
    startedAt: now.toISOString(),
  });
  const queued = message({ stage: "discover", runId: run.id }, 3);
  const worker = createWorker({
    reddit: reddit({ listTopPosts: async () => { throw new RedditTemporaryFailure("Reddit unavailable"); } }),
    now: () => now,
  });

  await worker.queue?.(
    { messages: [queued] } as MessageBatch<never>,
    environment(queue()) as never,
    {} as ExecutionContext,
  );

  expect(queued.retry).not.toHaveBeenCalled();
  expect(queued.ack).toHaveBeenCalledOnce();
  expect(await repository.getRunByLocalDate("2026-07-24")).toMatchObject({
    status: "failed",
    errorCode: "pipeline_discover_retries_exhausted",
    finishedAt: now.toISOString(),
  });
});
```

Add a separate test proving attempts `1` and `2` still call `retry` with 30
and 60 second delays. Add a recovery-boundary test proving an unexpected
exception escaping `processMessage` calls `message.retry()` rather than
`ack()`.

Create `config.spec.ts` to parse `wrangler.jsonc` and assert the configured
consumer `max_retries` equals the exported retry constant. This is a boundary
contract between application attempt handling and Cloudflare delivery.

Add an HTTP test with fake time proving `GET /api/runs/latest` turns an
eleven-minute active run into `failed/run_timed_out`, while a nine-minute run
remains active.

- [ ] **Step 2: Run orchestration/config tests and verify RED**

Run:

```sh
npm test -w @everyday-news/worker -- orchestration.spec.ts http-api.spec.ts config.spec.ts
```

Expected: attempt `3` still requests another retry or leaves the run active,
and the shared retry constant is absent.

- [ ] **Step 3: Implement final-attempt terminalization**

For retryable errors:

```ts
if (message.attempts > PIPELINE_MAX_RETRIES) {
  await repository.markRunFailed(
    message.body.runId,
    `pipeline_${message.body.stage}_retries_exhausted`,
    "Collection stage exhausted its delivery retries",
    current.toISOString(),
  );
  message.ack();
  return;
}
```

Keep the existing delay calculation for earlier attempts. In the outer Queue
boundary, replace unconditional acknowledgment of an escaped exception with
`message.retry()` so recovery-write failures cannot silently lose work.

Before `startRun` creates or reuses a run, reconcile records older than
`RUN_STALE_AFTER_MS`. Perform the same reconciliation immediately before
serving authenticated `GET /api/runs/latest`, using the router's injected
clock so tests stay deterministic.

- [ ] **Step 4: Enable safe observability**

Add to `wrangler.jsonc`:

```jsonc
"observability": {
  "enabled": true,
  "logs": {
    "enabled": true,
    "head_sampling_rate": 1,
    "invocation_logs": true
  }
}
```

Emit structured objects only at retry/terminal decisions through a typed
helper:

```ts
function logPipelineDecision(input: {
  runId: string;
  stage: PipelineMessage["stage"];
  attempt: number;
  decision: "retry" | "failed";
  category: string;
}): void {
  console.error({
    event: "pipeline_delivery_failed",
    ...input,
  });
}
```

Do not include raw error causes, headers, payload bodies, or card data.

- [ ] **Step 5: Run Task 2 tests and verify GREEN**

Run:

```sh
npm test -w @everyday-news/worker -- orchestration.spec.ts http-api.spec.ts config.spec.ts
```

Expected: all selected tests pass with attempt `3` terminal and earlier
attempts retrying.

- [ ] **Step 6: Commit Task 2**

```sh
git add apps/worker/src/index.ts apps/worker/src/http/router.ts apps/worker/wrangler.jsonc apps/worker/test/orchestration.spec.ts apps/worker/test/http-api.spec.ts apps/worker/test/config.spec.ts
git commit -m "fix(worker): terminalize exhausted deliveries"
```

### Task 3: Add the public read model and API

**Files:**
- Modify: `apps/worker/src/domain.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/http/router.ts`
- Test: `apps/worker/test/repository.spec.ts`
- Test: `apps/worker/test/http-api.spec.ts`

**Interfaces:**
- Produces: `PublicKnowledgeCard`.
- Produces: `Repository.listPublicDates(): Promise<string[]>`.
- Produces: `Repository.listPublicCards(date?: string): Promise<PublicKnowledgeCard[]>`.
- Produces: `GET /api/public/dates` and `GET /api/public/cards[?date=YYYY-MM-DD]`.

- [ ] **Step 1: Write failing public visibility tests**

Seed cards in all five summary states, plus a card whose source is deleted.
Assert:

```ts
expect((await repository.listPublicCards()).map(({ id }) => id))
  .toEqual(["draft-card", "approved-card"]);
expect(await repository.listPublicDates()).toEqual(["2026-07-24"]);
```

Add HTTP tests proving the two public endpoints return `200` without
authorization, reject invalid dates with `400`, omit privileged fields, and
preserve `401` for `/api/cards`, `/api/runs`, and settings routes.

- [ ] **Step 2: Run repository and API tests and verify RED**

Run:

```sh
npm test -w @everyday-news/worker -- repository.spec.ts http-api.spec.ts
```

Expected: public repository methods and routes do not exist.

- [ ] **Step 3: Implement the narrow public domain type**

Add:

```ts
export interface PublicKnowledgeCard {
  id: string;
  status: Extract<SummaryStatus, "draft" | "approved">;
  titleZh: string;
  oneLineFact: string;
  whyInteresting: string;
  commentInsights: string[];
  caveats: string[];
  confidenceNote: string;
  generatedAt: string;
  titleEn: string | null;
  redditUrl: string;
  sourceUrl: string | null;
  runLocalDate: string;
}
```

Repository SQL must join summaries → candidates → source_items → fetch_runs,
filter `summaries.status IN ('draft','approved')` and
`source_items.deleted_at IS NULL`, and select the newest content date when no
date is supplied.

- [ ] **Step 4: Add unauthenticated read-only routes**

Handle public GET routes after health and before the authorization gate.
Reuse the existing strict date validator. Return:

```json
{ "dates": ["2026-07-24"] }
```

and:

```json
{ "date": "2026-07-24", "cards": [] }
```

When no public date exists, return:

```json
{ "date": null, "cards": [] }
```

Use the existing CORS helper so the production Pages origin can call the
Worker. Do not make any private route public.

- [ ] **Step 5: Run Task 3 tests and verify GREEN**

Run:

```sh
npm test -w @everyday-news/worker -- repository.spec.ts http-api.spec.ts
```

Expected: public filtering and authentication-boundary tests pass.

- [ ] **Step 6: Commit Task 3**

```sh
git add apps/worker/src/domain.ts apps/worker/src/db/repository.ts apps/worker/src/http/router.ts apps/worker/test/repository.spec.ts apps/worker/test/http-api.spec.ts
git commit -m "feat(worker): expose public knowledge feed"
```

### Task 4: Add public and admin application entries

**Files:**
- Create: `apps/web/src/PublicApp.tsx`
- Create: `apps/web/src/components/PublicCard.tsx`
- Create: `apps/web/src/RouteApp.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/test/PublicApp.spec.tsx`
- Test: `apps/web/src/test/RouteApp.spec.tsx`
- Test: `apps/web/src/test/client.spec.ts`

**Interfaces:**
- Produces: `createPublicApiClient(baseUrl)`.
- Produces: `PublicApp({ apiBaseUrl? })`.
- Produces: `RouteApp({ pathname? })`.
- Preserves: existing `App` as the admin dashboard.

- [ ] **Step 1: Write failing public client and route tests**

Add tests proving:

```ts
render(<RouteApp pathname="/" />);
expect(screen.getByRole("heading", { name: "每天一点新知识" })).toBeInTheDocument();

render(<RouteApp pathname="/admin" />);
expect(screen.getByRole("heading", { name: "今天，挑出值得留下的知识。" })).toBeInTheDocument();

render(<RouteApp pathname="/missing" />);
expect(screen.getByRole("heading", { name: "页面不存在" })).toBeInTheDocument();
```

Public client tests must verify there is no `Authorization` header and the
date parameter is encoded.

- [ ] **Step 2: Run route/client tests and verify RED**

Run:

```sh
npm test -w @everyday-news/web -- RouteApp.spec.tsx client.spec.ts
```

Expected: public client and route shell are missing.

- [ ] **Step 3: Implement the route shell and public client**

`RouteApp` selects exact normalized paths:

```tsx
if (pathname === "/") return <PublicApp />;
if (pathname === "/admin" || pathname === "/admin/") return <App />;
return <NotFound />;
```

The public client uses the same response/error handling as the private client
but never creates an Authorization header.

- [ ] **Step 4: Write failing public-feed behavior tests**

Test independently hand-authored API responses for:

- newest date and its cards load on mount;
- choosing an older date replaces the card list;
- zero dates renders the empty state;
- request failure renders an alert;
- `javascript:`, malformed, and non-HTTP(S) URLs are plain text, not links.

- [ ] **Step 5: Run public-feed tests and verify RED**

Run:

```sh
npm test -w @everyday-news/web -- PublicApp.spec.tsx
```

Expected: `PublicApp` and `PublicCard` behavior are absent.

- [ ] **Step 6: Implement the public feed and responsive presentation**

`PublicApp` loads dates, selects the first date, then loads that date's cards.
Use an AbortController and request sequence guard matching the existing admin
async-safety pattern. `PublicCard` displays only public fields and uses the
same safe HTTP(S) URL validation as admin cards.

Add an unobtrusive `/admin` link in the public footer and a `/` link in the
admin header. Add public layout classes to `styles.css`, with one column below
640px and two restrained columns above it.

- [ ] **Step 7: Run Task 4 tests and verify GREEN**

Run:

```sh
npm test -w @everyday-news/web -- PublicApp.spec.tsx RouteApp.spec.tsx client.spec.ts
```

Expected: public route, admin route, date switching, empty/error states, and
safe links pass.

- [ ] **Step 8: Commit Task 4**

```sh
git add apps/web/src/PublicApp.tsx apps/web/src/components/PublicCard.tsx apps/web/src/RouteApp.tsx apps/web/src/App.tsx apps/web/src/api/client.ts apps/web/src/main.tsx apps/web/src/styles.css apps/web/src/test/PublicApp.spec.tsx apps/web/src/test/RouteApp.spec.tsx apps/web/src/test/client.spec.ts
git commit -m "feat(web): add public knowledge feed"
```

### Task 5: Present stale admin runs safely

**Files:**
- Modify: `apps/web/src/components/RunStatus.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/test/App.spec.tsx`

**Interfaces:**
- Produces: stale run presentation after ten minutes.
- Consumes: existing `FetchRun.startedAt`, status, and polling behavior.

- [ ] **Step 1: Write the failing stale-run UI test**

Use fake time and a run started eleven minutes earlier. Assert the heading
contains `运行已超时`, the warning explains that the server is reconciling the
run, and the component does not present it as healthy `运行中`.

- [ ] **Step 2: Run the focused UI test and verify RED**

Run:

```sh
npm test -w @everyday-news/web -- App.spec.tsx
```

Expected: the current component labels the stale record `运行中`.

- [ ] **Step 3: Implement stale presentation**

Centralize:

```ts
const RUN_STALE_AFTER_MS = 10 * 60 * 1000;
```

Derive stale state from active status plus `startedAt`. Stop client polling
after the existing maximum and display the timeout warning. Keep the manual
button disabled until the API has reconciled the record to terminal; the UI
must not invent server state.

- [ ] **Step 4: Run the focused UI test and verify GREEN**

Run:

```sh
npm test -w @everyday-news/web -- App.spec.tsx
```

Expected: stale presentation passes and existing polling tests remain green.

- [ ] **Step 5: Commit Task 5**

```sh
git add apps/web/src/components/RunStatus.tsx apps/web/src/App.tsx apps/web/src/test/App.spec.tsx
git commit -m "fix(web): surface stale collection runs"
```

### Task 6: Full verification, publish, and production recovery

**Files:**
- Modify if commands changed: `docs/operations.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces a deployed Worker, Pages build, reconciled stale run, empty DLQ, and
  one observed fresh run.

- [ ] **Step 1: Run complete local verification**

Run:

```sh
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits `0`, with no failed tests or TypeScript errors.

- [ ] **Step 2: Inspect the complete diff and security boundary**

Run:

```sh
git diff origin/main...HEAD --check
git status --short
rg -n "ADMIN_KEY|Authorization|console\\.(log|error)" apps/web apps/worker/src
```

Confirm `.wrangler/` remains untracked and is not staged. Confirm public
responses and logs contain none of the prohibited fields or secrets.

- [ ] **Step 3: Push and open a pull request**

```sh
git push -u origin codex/public-site-run-recovery
gh pr create \
  --base main \
  --head codex/public-site-run-recovery \
  --title "Add public knowledge feed and recover stalled runs" \
  --body "Adds the public publish-before-review feed, terminalizes exhausted Queue deliveries, reconciles stale runs, and enables safe Workers observability. Includes D1 migration preservation, Worker API, and React route tests."
```

Wait for CI and review its full output. Merge only after required checks pass.

- [ ] **Step 4: Verify the production deployment**

After the `main` deployment workflow succeeds:

```sh
curl --fail --show-error https://everyday-news-api.mayijian07.workers.dev/api/health
curl --fail --show-error https://everyday-news.pages.dev/
curl --fail --show-error https://everyday-news.pages.dev/admin
```

Use the configured proxy if local DNS resolution fails. Verify `/` is public
and `/admin` displays the key gate.

- [ ] **Step 5: Reconcile only the known stale production run**

First query by exact run ID:

```sql
SELECT id, local_date, status, started_at, finished_at
FROM fetch_runs
WHERE id = 'af652e04-7b0a-4624-a59c-62b2dd4ff2b4';
```

If deployment-time reconciliation has not already made it terminal, update
only that row:

```sql
UPDATE fetch_runs
SET status = 'failed',
    error_code = 'run_timed_out',
    error_message = 'Collection run exceeded the ten-minute execution limit',
    finished_at = CURRENT_TIMESTAMP
WHERE id = 'af652e04-7b0a-4624-a59c-62b2dd4ff2b4'
  AND status IN ('queued', 'running');
```

Read it again and confirm it is `failed`.

- [ ] **Step 6: Remove only the matching DLQ message**

List the dead-letter queue and verify the body is exactly:

```json
{"stage":"discover","runId":"af652e04-7b0a-4624-a59c-62b2dd4ff2b4"}
```

Acknowledge/delete that single message. Do not purge the queue.

- [ ] **Step 7: Start and observe one fresh current-date run**

Use the authenticated `/admin` action without exposing the key. Confirm a new
run ID is created for the Shanghai date, then poll D1 until it reaches
`completed`, `partial`, or `failed`. If it fails, confirm the terminal error is
visible and the run does not remain stale.

- [ ] **Step 8: Verify the public visibility contract in production**

Call `/api/public/dates` and `/api/public/cards` without authorization. Confirm
only draft/approved cards appear, rejected/source-deleted cards do not, and
the public page renders the same results.

- [ ] **Step 9: Record operational changes and final evidence**

If recovery or observability introduced operator commands not already covered,
update `docs/operations.md`, run `git diff --check`, commit the documentation,
and push. Report exact CI run, deployment URL, terminal run status, and DLQ
backlog without exposing credentials.
