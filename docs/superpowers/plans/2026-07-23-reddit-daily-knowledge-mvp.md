# Reddit Daily Knowledge MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private Cloudflare-hosted review dashboard that collects up to 20 daily `r/todayilearned` posts through Reddit’s experimental anonymous `.json` endpoints, selects up to 5 candidates, summarizes limited top comments in Chinese with Workers AI, and supports manual approval.

**Architecture:** A React/Vite single-page app is deployed to Cloudflare Pages. A separate ES-module Worker owns the HTTP API, daily Cron handler, Queue consumer, D1 persistence, Reddit source adapter, and Workers AI integration. Source access is isolated behind `RedditSourceAdapter`, so an approved OAuth implementation can replace anonymous JSON without changing the pipeline or UI.

**Tech Stack:** Node.js 22, npm workspaces, TypeScript, React 19, Vite, Cloudflare Pages, Workers, D1, Queues, Workers AI, Zod, Vitest 4.1+, Cloudflare Workers Vitest integration, Testing Library.

## Global Constraints

- The only enabled source is `r/todayilearned`.
- Discover at most 20 posts per daily run and generate at most 5 cards.
- Default schedule is 00:00 UTC / 08:00 Asia/Shanghai.
- The dashboard is single-admin and private; no public content feed is included.
- The MVP uses anonymous `www.reddit.com/...json` access only.
- Never rotate proxies, spoof a browser, or bypass `401`, `403`, `429`, challenge pages, or other access controls.
- Stop the daily Reddit run on `401` or `403`; retry `429` at most once using `Retry-After`.
- Send a descriptive owner-configured `REDDIT_USER_AGENT`; never ship an invented Reddit username.
- After three consecutive access-control failures, disable anonymous collection until the administrator explicitly re-enables it.
- Do not fetch or parse external article bodies in this phase.
- AI output must distinguish the Reddit post’s claim, comment additions, and comment caveats; it is not fact-checking.
- Keep the English title, Reddit permalink, external source URL, fetch time, model, prompt version, and input hash.
- Source deletion must unpublish dependent summaries and clear stored source/author text.
- OAuth approval and credentials are a replacement path, not part of this implementation.

---

## Planned File Structure

```text
.
├── package.json
├── package-lock.json
├── tsconfig.base.json
├── .gitignore
├── apps/
│   ├── worker/
│   │   ├── package.json
│   │   ├── wrangler.jsonc
│   │   ├── vitest.config.ts
│   │   ├── migrations/0001_initial.sql
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── env.ts
│   │   │   ├── domain.ts
│   │   │   ├── db/repository.ts
│   │   │   ├── reddit/adapter.ts
│   │   │   ├── reddit/anonymous-json.ts
│   │   │   ├── reddit/parser.ts
│   │   │   ├── ranking/score.ts
│   │   │   ├── pipeline/discover.ts
│   │   │   ├── pipeline/comments.ts
│   │   │   ├── pipeline/summarize.ts
│   │   │   ├── pipeline/cleanup.ts
│   │   │   ├── ai/card-schema.ts
│   │   │   ├── ai/workers-ai.ts
│   │   │   ├── http/auth.ts
│   │   │   └── http/router.ts
│   │   └── test/
│   │       ├── apply-migrations.ts
│   │       ├── fixtures/
│   │       │   ├── reddit-top.json
│   │       │   ├── reddit-comments.json
│   │       │   └── reddit-deleted.json
│   │       └── *.spec.ts
│   └── web/
│       ├── package.json
│       ├── index.html
│       ├── vite.config.ts
│       ├── tsconfig.json
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── styles.css
│           ├── api/client.ts
│           ├── components/CardDetail.tsx
│           ├── components/DraftCard.tsx
│           ├── components/RunStatus.tsx
│           └── test/App.spec.tsx
└── docs/
    ├── operations.md
    └── superpowers/...
```

The Worker files are split by business responsibility. `domain.ts` owns shared internal types; `repository.ts` is the only D1 access layer; `RedditSourceAdapter` is the source seam; pipeline files coordinate one processing stage each; the HTTP router contains no collection logic.

---

### Task 1: Scaffold the Two-App Workspace and Health Checks

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `apps/worker/package.json`
- Create: `apps/worker/wrangler.jsonc`
- Create: `apps/worker/vitest.config.ts`
- Create: `apps/worker/src/env.ts`
- Create: `apps/worker/src/index.ts`
- Create: `apps/worker/test/health.spec.ts`
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`

**Interfaces:**
- Produces: `Env` binding type and Worker default export with `fetch`, `scheduled`, and `queue` handlers.
- Produces: root commands `npm test`, `npm run typecheck`, and `npm run build`.

- [ ] **Step 1: Create workspace manifests and install locked dependencies**

Use npm workspaces named `@everyday-news/worker` and `@everyday-news/web`. Root scripts must delegate to both packages:

```json
{
  "name": "everyday-news",
  "private": true,
  "engines": { "node": ">=22" },
  "workspaces": ["apps/*"],
  "scripts": {
    "test": "npm run test -w @everyday-news/worker && npm run test -w @everyday-news/web",
    "typecheck": "npm run typecheck -w @everyday-news/worker && npm run typecheck -w @everyday-news/web",
    "build": "npm run build -w @everyday-news/worker && npm run build -w @everyday-news/web"
  }
}
```

Run:

```bash
npm install -w @everyday-news/worker zod
npm install -D -w @everyday-news/worker typescript wrangler vitest@^4.1.0 @cloudflare/vitest-pool-workers
npm install -w @everyday-news/web react@19.2.8 react-dom@19.2.8
npm install -D -w @everyday-news/web typescript vite @vitejs/plugin-react vitest@^4.1.0 jsdom @testing-library/react @testing-library/jest-dom
```

Expected: npm creates one root `package-lock.json` and reports both workspaces without dependency resolution errors.

- [ ] **Step 2: Write a failing Worker health test**

```ts
import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("returns a versioned health response", async () => {
  const response = await exports.default.fetch("https://example.test/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "everyday-news-api", version: 1 });
});
```

- [ ] **Step 3: Run the focused test and verify failure**

Run:

```bash
npm run test -w @everyday-news/worker -- health.spec.ts
```

Expected: FAIL because `apps/worker/src/index.ts` does not yet export the handler.

- [ ] **Step 4: Implement the minimal Worker and binding types**

`Env` must include:

```ts
export interface Env {
  DB: D1Database;
  PIPELINE: Queue<PipelineMessage>;
  AI: Ai;
  ADMIN_KEY: string;
  APP_ORIGIN: string;
  REDDIT_USER_AGENT: string;
}

export type PipelineMessage =
  | { stage: "discover"; runId: string }
  | { stage: "comments"; runId: string; itemId: string }
  | { stage: "summarize"; runId: string; itemId: string };
```

The initial `fetch` handler returns the exact health payload and `404` elsewhere. `scheduled` and `queue` must be present but perform no work until their tasks implement them.

- [ ] **Step 5: Run validation**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all commands exit 0; the health test passes and both application builds complete.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json .gitignore apps
git commit -m "chore: scaffold Cloudflare MVP workspace"
```

---

### Task 2: Define the Domain Model, D1 Schema, and Repository

**Files:**
- Create: `apps/worker/migrations/0001_initial.sql`
- Create: `apps/worker/src/domain.ts`
- Create: `apps/worker/src/db/repository.ts`
- Create: `apps/worker/test/apply-migrations.ts`
- Create: `apps/worker/test/repository.spec.ts`
- Modify: `apps/worker/vitest.config.ts`

**Interfaces:**
- Produces: `Repository.createRun()`, `upsertSourceItem()`, `replaceComments()`, `saveCandidate()`, `saveSummary()`, `recordReview()`, `getLatestRun()`, `listCards()`, `setAnonymousEnabled()`.
- Produces: status unions `RunStatus`, `CandidateStatus`, and `SummaryStatus`.

- [ ] **Step 1: Write repository tests before the schema**

Cover these exact behaviors:

```ts
it("deduplicates by source and external id");
it("prevents two runs for the same local date");
it("moves a summary through draft, approved, and rejected states");
it("stores prompt version and input hash");
it("disables anonymous collection after the persisted failure threshold");
```

The first test inserts `reddit/t3_abc` twice and expects one row with the latest score.

- [ ] **Step 2: Run repository tests and verify failure**

Run:

```bash
npm run test -w @everyday-news/worker -- repository.spec.ts
```

Expected: FAIL because the migration and `Repository` do not exist.

- [ ] **Step 3: Create the migration**

Create tables:

```sql
CREATE TABLE fetch_runs (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','partial','completed','failed')),
  discovered_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  summarized_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT,
  author TEXT,
  reddit_url TEXT NOT NULL,
  source_url TEXT,
  score INTEGER NOT NULL,
  upvote_ratio REAL,
  comment_count INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(source, external_id)
);
```

Also create `source_comments`, `candidates`, `summaries`, `review_actions`, and `settings`; add indexes for item publication time, candidate run/status/rank, summary review status, and source recheck time.

- [ ] **Step 4: Implement the repository with prepared statements**

Use one `Repository` class:

```ts
export class Repository {
  constructor(private readonly db: D1Database) {}
  createRun(input: { id: string; localDate: string; startedAt: string }): Promise<FetchRun>;
  upsertSourceItem(item: SourceItem): Promise<void>;
  replaceComments(itemId: string, comments: SourceComment[]): Promise<void>;
  saveCandidate(candidate: Candidate): Promise<void>;
  saveSummary(summary: KnowledgeCardRecord): Promise<void>;
  recordReview(summaryId: string, action: "approve" | "reject", at: string): Promise<void>;
}
```

Every SQL write must bind values, never interpolate input.

- [ ] **Step 5: Run migration-backed tests**

Run:

```bash
npm run test -w @everyday-news/worker -- repository.spec.ts
npm run typecheck -w @everyday-news/worker
```

Expected: PASS and no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/migrations apps/worker/src/domain.ts apps/worker/src/db apps/worker/test apps/worker/vitest.config.ts
git commit -m "feat: add D1 domain repository"
```

---

### Task 3: Build the Replaceable Anonymous Reddit Adapter

**Files:**
- Create: `apps/worker/src/reddit/adapter.ts`
- Create: `apps/worker/src/reddit/parser.ts`
- Create: `apps/worker/src/reddit/anonymous-json.ts`
- Create: `apps/worker/test/fixtures/reddit-top.json`
- Create: `apps/worker/test/fixtures/reddit-comments.json`
- Create: `apps/worker/test/fixtures/reddit-deleted.json`
- Create: `apps/worker/test/reddit-parser.spec.ts`
- Create: `apps/worker/test/reddit-client.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface RedditSourceAdapter {
  listTopPosts(options: { limit: number; time: "day" }): Promise<SourceItem[]>;
  getPostWithComments(postId: string, options: { limit: number; depth: number }): Promise<{
    item: SourceItem;
    comments: SourceComment[];
  }>;
  checkItems(ids: string[]): Promise<Array<{ id: string; deleted: boolean }>>;
}
```

- Produces: typed errors `RedditAccessDenied`, `RedditRateLimited`, `RedditUnexpectedResponse`, `RedditTemporaryFailure`.

- [ ] **Step 1: Add representative first-party response fixtures**

Sanitize the already inspected Reddit JSON into small fixtures containing:

- one valid external-link post;
- one sticky post;
- one NSFW post;
- one deleted post;
- three top comments;
- one `[deleted]` comment;
- one `kind: "more"` node;
- missing optional author and upvote ratio fields.

- [ ] **Step 2: Write failing parser and client tests**

Assert that the parser:

```ts
expect(parsePostListing(fixture)).toHaveLength(4);
expect(parseCommentListing(commentFixture).map((c) => c.externalId)).toEqual(["t1_c1", "t1_c2", "t1_c3"]);
```

Assert that the client sends:

```ts
expect(request.url).toBe(
  "https://www.reddit.com/r/todayilearned/top.json?t=day&limit=20&raw_json=1"
);
expect(request.headers.get("User-Agent")).toBe("web:everyday-news:v1.0 (by /u/test_owner)");
```

Also assert mappings for `403`, `429` with `Retry-After`, `500`, `text/html`, and invalid JSON.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
npm run test -w @everyday-news/worker -- reddit-parser.spec.ts reddit-client.spec.ts
```

Expected: FAIL because the adapter modules do not exist.

- [ ] **Step 4: Implement strict parsing and response classification**

`AnonymousJsonRedditAdapter` accepts `fetcher` and `userAgent` in its constructor. Production passes `env.REDDIT_USER_AGENT`; tests pass the explicit test-only value shown above. It must:

- request only `www.reddit.com`;
- set `Accept: application/json`;
- use the fixed descriptive User-Agent;
- reject non-JSON content types before parsing;
- never follow an HTML challenge as usable content;
- expose `retryAfterSeconds` on `RedditRateLimited`;
- flatten only real `t1` comments and ignore `more`.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test -w @everyday-news/worker -- reddit
npm run typecheck -w @everyday-news/worker
```

Expected: all Reddit adapter tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/reddit apps/worker/test
git commit -m "feat: add anonymous Reddit JSON adapter"
```

---

### Task 4: Implement Deterministic Eligibility, Deduplication, and Ranking

**Files:**
- Create: `apps/worker/src/ranking/score.ts`
- Create: `apps/worker/test/ranking.spec.ts`
- Modify: `apps/worker/src/db/repository.ts`

**Interfaces:**
- Produces:

```ts
export function evaluatePost(
  item: SourceItem,
  context: { now: Date; recentUrls: Set<string>; recentTitles: string[] }
): { eligible: boolean; score: number; reasons: string[]; exclusion?: string };
```

- Produces: `Repository.getRecentSourceUrls(days)` and `getRecentTitles(days)`.

- [ ] **Step 1: Write table-driven failing tests**

Include exact cases:

```ts
[
  ["sticky", { stickied: true }, false],
  ["nsfw", { over18: true }, false],
  ["deleted", { deleted: true }, false],
  ["no external source", { sourceUrl: null }, false],
  ["duplicate URL in 30 days", {}, false],
  ["eligible high discussion", { score: 1500, commentCount: 200 }, true]
]
```

Also verify that the same input always produces the same score and ordered reason list.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
npm run test -w @everyday-news/worker -- ranking.spec.ts
```

Expected: FAIL because `evaluatePost` is missing.

- [ ] **Step 3: Implement bounded, explainable scoring**

Use:

```ts
const engagement = Math.min(40, Math.log10(Math.max(1, item.score)) * 10);
const discussion = Math.min(30, Math.log10(Math.max(1, item.commentCount)) * 10);
const freshness = Math.max(0, 20 - ageHours);
const ratio = item.upvoteRatio == null ? 0 : Math.max(0, (item.upvoteRatio - 0.5) * 20);
```

Round the total to two decimals. Exclude exact normalized source URL duplicates from the last 30 days. For title similarity, normalize lowercase alphanumeric tokens and exclude Jaccard similarity `>= 0.85`.

- [ ] **Step 4: Run ranking and repository tests**

Run:

```bash
npm run test -w @everyday-news/worker -- ranking.spec.ts repository.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/ranking apps/worker/src/db apps/worker/test/ranking.spec.ts
git commit -m "feat: add explainable candidate ranking"
```

---

### Task 5: Implement Discovery and Comment Selection Stages

**Files:**
- Create: `apps/worker/src/pipeline/discover.ts`
- Create: `apps/worker/src/pipeline/comments.ts`
- Create: `apps/worker/test/discover.spec.ts`
- Create: `apps/worker/test/comments.spec.ts`

**Interfaces:**
- Consumes: `RedditSourceAdapter`, `Repository`, `evaluatePost`.
- Produces:

```ts
export async function discoverCandidates(deps: PipelineDeps, runId: string): Promise<{
  discovered: number;
  selected: number;
  itemIds: string[];
}>;

export async function collectComments(deps: PipelineDeps, runId: string, itemId: string): Promise<{
  stored: number;
}>;
```

- [ ] **Step 1: Write failing discovery tests**

Mock 20 posts containing invalid and duplicate cases. Expect:

- all normalized source items are upserted;
- only eligible items become candidates;
- no more than 5 candidates are selected;
- ranks are contiguous from 1;
- fewer than 5 eligible items produces fewer than 5 candidates.

- [ ] **Step 2: Write failing comment-selection tests**

Provide comments containing `[deleted]`, fewer than 20 characters, bot boilerplate, duplicate bodies, and valid context. Expect at most 20 comments ordered by score, with deleted/low-information entries excluded.

- [ ] **Step 3: Verify tests fail**

Run:

```bash
npm run test -w @everyday-news/worker -- discover.spec.ts comments.spec.ts
```

Expected: FAIL because both stages are missing.

- [ ] **Step 4: Implement both stages**

Comment information rules:

```ts
const isUseful =
  !comment.deleted &&
  comment.body.trim().length >= 20 &&
  !/^(i am a bot|this action was performed automatically)/i.test(comment.body.trim());
```

Deduplicate comments by normalized body, then sort by score descending and slice to 20. Discovery must call the adapter with exactly `{ limit: 20, time: "day" }`.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm run test -w @everyday-news/worker -- discover.spec.ts comments.spec.ts
npm run typecheck -w @everyday-news/worker
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/pipeline apps/worker/test
git commit -m "feat: add discovery and comment pipeline stages"
```

---

### Task 6: Generate and Validate Structured Chinese Knowledge Cards

**Files:**
- Create: `apps/worker/src/ai/card-schema.ts`
- Create: `apps/worker/src/ai/workers-ai.ts`
- Create: `apps/worker/src/pipeline/summarize.ts`
- Create: `apps/worker/test/ai-summary.spec.ts`
- Create: `apps/worker/test/summarize.spec.ts`

**Interfaces:**
- Produces: `KnowledgeCardSchema` and `KnowledgeCard`.
- Produces:

```ts
export interface CardGenerator {
  generate(input: CardInput): Promise<KnowledgeCard>;
}

export async function summarizeCandidate(
  deps: PipelineDeps & { generator: CardGenerator },
  runId: string,
  itemId: string
): Promise<void>;
```

- [ ] **Step 1: Define failing schema tests**

The schema requires:

```ts
{
  titleZh: string;
  oneLineFact: string;
  whyInteresting: string;
  commentInsights: string[];
  caveats: string[];
  confidenceNote: string;
}
```

Limit insights and caveats to 3 items each; reject missing fields, English-only title, and arrays longer than 3.

- [ ] **Step 2: Write generator and pipeline failure tests**

Assert the prompt contains:

- “原帖声称” rather than asserting truth;
- separate labeled comment excerpts;
- prohibition on claiming external fact-checking;
- English title and URLs as immutable metadata.

Mock one malformed model response followed by one valid repair response. Expect exactly two AI calls and one saved draft. Two malformed responses must save a failed summary state.

- [ ] **Step 3: Verify tests fail**

Run:

```bash
npm run test -w @everyday-news/worker -- ai-summary.spec.ts summarize.spec.ts
```

Expected: FAIL because the schema and generator are missing.

- [ ] **Step 4: Implement Workers AI JSON mode**

Use model `@cf/meta/llama-3.1-8b-instruct-fast` and request JSON Schema output. Set temperature to `0.2`. Validate the result with Zod even when Workers AI JSON mode reports success because Cloudflare does not guarantee schema conformance.

Compute:

```ts
const inputHash = await sha256(JSON.stringify({ item, comments, promptVersion: "v1" }));
```

Before calling AI, return the existing summary if the same input hash and prompt version already succeeded.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test -w @everyday-news/worker -- ai-summary.spec.ts summarize.spec.ts
npm run typecheck -w @everyday-news/worker
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/ai apps/worker/src/pipeline/summarize.ts apps/worker/test
git commit -m "feat: generate structured knowledge cards"
```

---

### Task 7: Wire Cron, Queue Orchestration, Idempotency, and Run State

**Files:**
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/env.ts`
- Create: `apps/worker/test/orchestration.spec.ts`
- Modify: `apps/worker/wrangler.jsonc`

**Interfaces:**
- Consumes: all three pipeline stages.
- Produces: daily `scheduled()` enqueue, queue dispatch by discriminated message type, and `startRun(localDate, trigger)`.

- [ ] **Step 1: Write orchestration tests**

Assert:

- scheduled invocation creates one run for Asia/Shanghai local date;
- a repeated scheduled invocation returns the existing run;
- `discover` enqueues one comments message per selected item;
- successful comments stage enqueues one summarize message;
- already completed stage messages acknowledge without repeating writes;
- a partially failed batch marks the run `partial`, not `completed`.

- [ ] **Step 2: Verify failure**

Run:

```bash
npm run test -w @everyday-news/worker -- orchestration.spec.ts
```

Expected: FAIL because handlers still contain no orchestration.

- [ ] **Step 3: Configure bindings**

`wrangler.jsonc` must include:

```jsonc
{
  "name": "everyday-news-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-23",
  "triggers": { "crons": ["0 0 * * *"] },
  "queues": {
    "producers": [{ "binding": "PIPELINE", "queue": "everyday-news-pipeline" }],
    "consumers": [{ "queue": "everyday-news-pipeline", "max_batch_size": 5, "max_batch_timeout": 5, "max_retries": 2, "dead_letter_queue": "everyday-news-dead-letter" }]
  },
  "ai": { "binding": "AI" }
}
```

Vitest supplies the local `DB` binding through its Miniflare configuration. The
remote D1 binding is added in Task 11 immediately after Cloudflare returns the
real opaque database ID, so no invented ID enters the configuration.

- [ ] **Step 4: Implement handlers**

Process each queue message independently. Call `message.ack()` after an already-completed or newly successful stage and `message.retry()` only for typed temporary failures. Access denial must mark the run failed and acknowledge the message so the queue does not hammer Reddit.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test -w @everyday-news/worker -- orchestration.spec.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src apps/worker/test/orchestration.spec.ts apps/worker/wrangler.jsonc
git commit -m "feat: orchestrate daily collection pipeline"
```

---

### Task 8: Add Protected Admin API and Review Actions

**Files:**
- Create: `apps/worker/src/http/auth.ts`
- Create: `apps/worker/src/http/router.ts`
- Create: `apps/worker/test/http-api.spec.ts`
- Modify: `apps/worker/src/index.ts`

**Interfaces:**
- Produces HTTP endpoints:
  - `GET /api/health`
  - `GET /api/runs/latest`
  - `GET /api/cards?status=draft|approved|rejected`
  - `GET /api/cards/:id`
  - `POST /api/cards/:id/approve`
  - `POST /api/cards/:id/reject`
  - `POST /api/cards/:id/regenerate`
  - `POST /api/runs`
  - `POST /api/settings/anonymous-collection`

- [ ] **Step 1: Write failing API tests**

Verify:

- health is public;
- every other route returns `401` without `Authorization: Bearer <ADMIN_KEY>`;
- valid key returns JSON and exact CORS origin;
- approval is idempotent;
- regenerate enqueues only one summarize message;
- manual run returns `202` and the existing run ID if already started;
- anonymous re-enable requires body `{ "enabled": true }`.

- [ ] **Step 2: Verify failure**

Run:

```bash
npm run test -w @everyday-news/worker -- http-api.spec.ts
```

Expected: FAIL because admin routes do not exist.

- [ ] **Step 3: Implement auth and router**

Accept only:

```http
Authorization: Bearer <ADMIN_KEY>
Content-Type: application/json
```

Respond to preflight only when `Origin === env.APP_ORIGIN`. Never put the key in a URL, cookie, response, or log. Return `{ error: { code, message } }` consistently for non-2xx responses.

- [ ] **Step 4: Run tests**

Run:

```bash
npm run test -w @everyday-news/worker -- http-api.spec.ts
npm run typecheck -w @everyday-news/worker
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/http apps/worker/src/index.ts apps/worker/test/http-api.spec.ts
git commit -m "feat: add protected review API"
```

---

### Task 9: Build the Private React Review Dashboard

**Files:**
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/components/RunStatus.tsx`
- Create: `apps/web/src/components/DraftCard.tsx`
- Create: `apps/web/src/components/CardDetail.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/test/App.spec.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/main.tsx`

**Interfaces:**
- Consumes: protected Admin API.
- Produces: access-key gate, draft/approved/rejected views, detail view, review actions, regenerate, manual run, and anonymous collector status.

- [ ] **Step 1: Write failing UI behavior tests**

Test:

```ts
it("does not request cards before an access key is entered");
it("stores the access key in sessionStorage only");
it("shows latest run counts and failures");
it("approves a draft and removes it from the draft list");
it("shows source links and confidence note in card detail");
it("disables manual run while a run is active");
```

Mock `fetch`; do not hit a live Worker in component tests.

- [ ] **Step 2: Verify failure**

Run:

```bash
npm run test -w @everyday-news/web
```

Expected: FAIL because the dashboard components do not exist.

- [ ] **Step 3: Implement the typed API client**

`createApiClient(baseUrl, getAdminKey)` must attach the bearer header, parse the consistent error envelope, and expose:

```ts
getLatestRun();
listCards(status);
getCard(id);
approve(id);
reject(id);
regenerate(id);
startRun();
setAnonymousCollection(enabled);
```

- [ ] **Step 4: Implement the dashboard**

Use semantic HTML and keyboard-accessible native buttons. The first viewport shows the latest run and today’s drafts, not generic navigation chrome. All Reddit and AI content renders as text; links use `rel="noreferrer noopener"`.

The access key is written only to:

```ts
sessionStorage.setItem("everyday-news-admin-key", value);
```

Never use `localStorage`.

- [ ] **Step 5: Run UI and full validation**

Run:

```bash
npm run test -w @everyday-news/web
npm run typecheck
npm run build
```

Expected: tests pass, TypeScript succeeds, and `apps/web/dist` is produced.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: add private review dashboard"
```

---

### Task 10: Add Deletion Sync and Anonymous-Access Circuit Breaker

**Files:**
- Create: `apps/worker/src/pipeline/cleanup.ts`
- Create: `apps/worker/test/cleanup.spec.ts`
- Modify: `apps/worker/src/pipeline/discover.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/db/repository.ts`

**Interfaces:**
- Produces:

```ts
export async function syncSourceState(deps: PipelineDeps, now: Date): Promise<{
  checked: number;
  removed: number;
}>;

export async function recordAccessFailure(
  repository: Repository,
  code: "unauthorized" | "forbidden" | "rate_limited" | "challenge",
  at: string
): Promise<{ consecutiveFailures: number; anonymousEnabled: boolean }>;
```

- [ ] **Step 1: Write failing cleanup tests**

Verify:

- recent items are checked every day;
- older retained items are checked when seven days elapsed;
- deleted source clears title, author, and comment bodies;
- dependent summary becomes unavailable to card-list queries;
- the third consecutive access failure disables anonymous collection;
- a successful discovery resets the consecutive failure count;
- manual re-enable resets the count and records audit time.

- [ ] **Step 2: Verify failure**

Run:

```bash
npm run test -w @everyday-news/worker -- cleanup.spec.ts
```

Expected: FAIL because cleanup and circuit-breaker behavior are missing.

- [ ] **Step 3: Implement cleanup and circuit breaker**

Cleanup must run before discovery. When anonymous collection is disabled, scheduled runs record error code `anonymous_disabled` and do not make an outbound Reddit request.

Deletion transaction order:

```text
mark source item deleted
clear source item title/author/source URL
clear dependent comment body/author fields
mark dependent summaries source_deleted
remove source_deleted summaries from normal list queries
```

- [ ] **Step 4: Run all Worker tests**

Run:

```bash
npm run test -w @everyday-news/worker
npm run typecheck -w @everyday-news/worker
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src apps/worker/test/cleanup.spec.ts
git commit -m "feat: sync deletions and stop unsafe collection"
```

---

### Task 10A: Close Review Dashboard Data and Date-Filtering Gaps

**Files:**
- Modify: `apps/worker/src/domain.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/http/router.ts`
- Modify: `apps/worker/test/http-api.spec.ts`
- Modify: `apps/worker/test/repository.spec.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/RunStatus.tsx`
- Modify: `apps/web/src/components/DraftCard.tsx`
- Modify: `apps/web/src/components/CardDetail.tsx`
- Modify: `apps/web/src/test/App.spec.tsx`

**Interfaces:**
- `FetchRun` adds `failedCount: number`.
- `KnowledgeCard` adds:

```ts
candidateScore: number;
selectionReasons: string[];
commentLinks: string[];
warnings: Array<{ code: string; message: string }>;
runLocalDate: string;
```

- `GET /api/runs?date=YYYY-MM-DD` returns `{ runs: FetchRun[] }`; omit
  `date` to return the newest 30 runs.
- `GET /api/cards?status=draft|approved|rejected&date=YYYY-MM-DD` filters
  by the candidate run's Shanghai local date. The `date` query is optional
  for backward compatibility.

- [ ] **Step 1: Write failing repository and API tests**

Verify that latest/listed runs include the count of `failed` candidates,
card rows expose candidate score/reasons, retained comment Reddit links,
run warnings, and local date, and exact date filters exclude other runs.
Reject malformed dates with the standard JSON error envelope.

- [ ] **Step 2: Run Worker tests and verify failure**

Run:

```bash
npm run test -w @everyday-news/worker -- repository.spec.ts http-api.spec.ts
```

Expected: FAIL because enriched projections and date filters do not exist.

- [ ] **Step 3: Implement enriched read models**

Use SQL aggregation/subqueries rather than per-card queries. Comment links
must include only non-deleted stored comments and preserve deterministic
score/id order. A run warning is present only when both `error_code` and
`error_message` are non-null. Keep all `source_deleted`, deleted-parent,
and deleted-comment invisibility predicates from Task 10.

- [ ] **Step 4: Write failing dashboard tests**

Verify:

```ts
it("shows failed count, candidate score, and selection reasons");
it("shows participating comment links and run warnings in detail");
it("loads today drafts using the latest run local date");
it("filters approved and rejected history by the selected date");
```

Mock `fetch`; do not contact a live Worker.

- [ ] **Step 5: Implement date-aware dashboard views**

Load the latest run before the initial draft query and use its `localDate`
as the date filter. Add a native labelled `type="date"` control for
approved/rejected history and reload only the selected status/date. Render
all returned strings as React text. Comment links must use
`target="_blank"` and `rel="noreferrer noopener"`.

- [ ] **Step 6: Run full validation**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all tests pass and both production builds succeed.

- [ ] **Step 7: Commit**

```bash
git add apps/worker apps/web docs/superpowers/plans/2026-07-23-reddit-daily-knowledge-mvp.md
git commit -m "feat: enrich review dashboard data"
```

---

### Task 11: Provision, Deploy, and Verify the MVP

**Files:**
- Create: `docs/operations.md`
- Modify: `apps/worker/wrangler.jsonc`
- Create: `apps/web/.env.example`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: deployed Worker API, D1 database, Queues, Workers AI binding, Pages dashboard, operating instructions, and CI checks.

- [ ] **Step 1: Add CI before deployment**

Create a workflow running on pushes and pull requests:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
      cache: npm
  - run: npm ci
  - run: npm test
  - run: npm run typecheck
  - run: npm run build
```

- [ ] **Step 2: Write the operations guide**

Document exact commands for:

- Cloudflare login;
- D1 and Queue creation;
- migration application;
- `ADMIN_KEY` and `APP_ORIGIN` secret/config setup;
- owner-configured `REDDIT_USER_AGENT` secret setup;
- local fixture tests;
- live single-request probe;
- Worker deployment;
- Pages direct upload;
- manual run;
- anonymous collector re-enable;
- OAuth adapter replacement prerequisites.

Also state that AI calls made in local Wrangler mode count toward Workers AI usage.

- [ ] **Step 3: Run complete local verification**

Run:

```bash
npm ci
npm test
npm run typecheck
npm run build
git status --short
```

Expected: first four commands exit 0. `git status --short` lists only the Task 11 files before commit.

- [ ] **Step 4: Provision Cloudflare resources**

Run the documented non-destructive create commands once:

```bash
npx wrangler d1 create everyday-news
npx wrangler queues create everyday-news-pipeline
npx wrangler queues create everyday-news-dead-letter
```

Copy the returned opaque D1 database ID exactly into `apps/worker/wrangler.jsonc`; do not derive or invent it.
Add this binding using the returned value:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "everyday-news",
    "database_id": "the exact opaque ID printed by wrangler",
    "migrations_dir": "migrations"
  }
]
```

Before saving the file, replace the explanatory string with the actual command
output. The committed configuration must contain the real opaque ID and must
not contain the explanatory string.

- [ ] **Step 5: Apply migrations and secrets**

Run:

```bash
npx wrangler d1 migrations apply everyday-news --remote --config apps/worker/wrangler.jsonc
npx wrangler secret put ADMIN_KEY --config apps/worker/wrangler.jsonc
npx wrangler secret put REDDIT_USER_AGENT --config apps/worker/wrangler.jsonc
```

Set `APP_ORIGIN` to the final Pages origin before production validation.

- [ ] **Step 6: Deploy the Worker and perform the minimal anonymous probe**

Deploy:

```bash
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

Call public `/api/health`, then authenticated `POST /api/runs` once. Expected:

- health returns version 1;
- manual run returns `202`;
- the run either reaches `completed/partial` with real data or stops with the typed access-denial error;
- no retries occur after an access-denial error.

- [ ] **Step 7: Deploy the Pages frontend**

Set `VITE_API_BASE_URL` to the deployed Worker URL, rebuild, then run:

```bash
npx wrangler pages project create everyday-news
npx wrangler pages deploy apps/web/dist --project-name everyday-news
```

Use the returned Pages URL as `APP_ORIGIN`, redeploy the Worker if it changed, and do not create a second Pages project.

- [ ] **Step 8: Browser acceptance check**

Verify manually:

1. wrong or missing key cannot load data;
2. correct key shows latest run;
3. drafts show source links and structured Chinese sections;
4. approve/reject/regenerate work once each;
5. manual run cannot start a duplicate;
6. run errors are readable;
7. no collected content is visible without authentication.

- [ ] **Step 9: Wait for one real Cron execution**

After the next 00:00 UTC trigger, confirm a new local-date run exists and no prior item was duplicated. If the Cron fails, record the typed stage and error; do not relax access-control handling to force success.

- [ ] **Step 10: Commit the deployment setup**

```bash
git add .github apps/worker/wrangler.jsonc apps/web/.env.example docs/operations.md
git commit -m "docs: add deployment and operations workflow"
```

---

## Final Verification Checklist

- [ ] `npm ci` succeeds from a clean checkout.
- [ ] `npm test` passes for Worker and web.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run build` produces Worker and Pages artifacts.
- [ ] D1 migration applies to an empty remote database.
- [ ] The real Worker probe either collects successfully or stops safely with a typed Reddit error.
- [ ] No secret appears in git, built frontend files, request URLs, or logs.
- [ ] Duplicate scheduled and queue events are idempotent.
- [ ] AI responses are schema-validated and clearly framed as unverified Reddit claims.
- [ ] Source deletion removes dependent content from normal API results.
- [ ] Anonymous collection disables after three consecutive access-control failures.
- [ ] OAuth can replace `AnonymousJsonRedditAdapter` through `RedditSourceAdapter`.
- [ ] The deployed Pages UI remains data-empty without the administrator key.
