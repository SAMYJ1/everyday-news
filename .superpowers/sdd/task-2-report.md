# Task 2 Report: D1 Domain Model and Repository

## Status

Complete.

## Commit

- `0e554f1 feat: add D1 domain repository`
- Base commit: `04c9731 fix: add daily worker cron trigger`

## TDD Evidence

### RED

Command:

```text
PATH=/Users/eugene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run test -w @everyday-news/worker -- repository.spec.ts
```

Result: exit code `1`.

Exact failure:

```text
FAIL  test/repository.spec.ts [ test/repository.spec.ts ]
Error: Cannot find module '../src/db/repository' imported from
/Users/eugene/code/everyday-news/.worktrees/reddit-mvp/apps/worker/test/repository.spec.ts

Test Files  1 failed (1)
Tests       no tests
```

This was the intended failure: the test suite referenced the not-yet-implemented
repository.

### GREEN

Focused command:

```text
PATH=/Users/eugene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run test -w @everyday-news/worker -- repository.spec.ts
```

Result: exit code `0`.

Exact summary:

```text
Test Files  1 passed (1)
Tests       5 passed (5)
```

Fresh post-commit focused verification produced the same `1 passed` file and
`5 passed` tests.

## Required Behavior Results

- PASS: deduplicates `reddit/t3_abc` by `(source, external_id)` while retaining
  the original row ID and updating its score to the latest value.
- PASS: rejects a second fetch run for the same `local_date`.
- PASS: moves a summary from `draft` to `approved` and then to `rejected`, while
  recording each review action.
- PASS: persists `prompt_version` and `input_hash`.
- PASS: persists anonymous-access failures and disables anonymous collection at
  the third consecutive failure.

## Verification Results

### Mandated Worker typecheck

Command:

```text
PATH=/Users/eugene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run typecheck -w @everyday-news/worker
```

Result: exit code `0`; Wrangler regenerated Worker runtime types and TypeScript
reported no errors.

### Full Worker regression suite

Command:

```text
PATH=/Users/eugene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run test -w @everyday-news/worker
```

Result: exit code `0`.

Exact summary:

```text
Test Files  2 passed (2)
Tests       6 passed (6)
```

This includes the Task 1 health test.

### Direct strict compile of Task 2 source

The existing package typecheck script explicitly names only Task 1 source files,
so an additional strict TypeScript compile was run over:

- `apps/worker/src/domain.ts`
- `apps/worker/src/db/repository.ts`
- the existing Worker binding and entrypoint files

Result: exit code `0`, no output.

### Diff hygiene

- `git diff --cached --check`: exit code `0` before commit.
- Post-commit `git status --short --branch`: clean on
  `feature/reddit-mvp`.

## Files

- `apps/worker/migrations/0001_initial.sql`
- `apps/worker/src/domain.ts`
- `apps/worker/src/db/repository.ts`
- `apps/worker/test/apply-migrations.ts`
- `apps/worker/test/repository.spec.ts`
- `apps/worker/vitest.config.ts`

## Implementation Summary

- Added `RunStatus`, `CandidateStatus`, and `SummaryStatus`, plus typed run,
  source item, source comment, candidate, summary, and anonymous-collection
  records.
- Added all seven required D1 tables: `fetch_runs`, `source_items`,
  `source_comments`, `candidates`, `summaries`, `review_actions`, and `settings`.
- Added publication-time, source-recheck, candidate run/status/rank, and summary
  review-status indexes.
- Added the promised repository operations:
  `createRun`, `upsertSourceItem`, `replaceComments`, `saveCandidate`,
  `saveSummary`, `recordReview`, `getLatestRun`, `listCards`, and
  `setAnonymousEnabled`.
- Added persisted circuit-breaker helpers used by the fifth required test:
  `recordAnonymousFailure` and `getAnonymousCollection`.
- Configured the Cloudflare Vitest pool with a D1 `DB` binding and added the
  migration loader.

## Self-Review

- Compared the implementation line-by-line with the Task 2 brief.
- Confirmed all required tables and indexes are present.
- Confirmed the first upsert test preserves the canonical stored ID and updates
  mutable source fields from the latest observation.
- Confirmed every repository write uses a prepared statement and binds all
  caller-provided values; no input is interpolated into SQL.
- Confirmed review status and review audit insertion execute in one D1 batch.
- Confirmed comment replacement executes as one D1 batch.
- Confirmed normal card listing excludes the future `source_deleted` state.
- Confirmed Task 1 health behavior remains covered and passing.

## Concerns

- The pre-existing Worker `typecheck` script explicitly lists
  `src/env.ts` and `src/index.ts`, so it does not automatically include newly
  added source files. Task 2's files were therefore compiled with an additional
  strict TypeScript command and passed. Updating the package typecheck command to
  use a Worker `tsconfig.json` or include all `src/**/*.ts` files should be
  considered in a later workspace/tooling task.

## Follow-up: Worker Typecheck Coverage

The concern above was resolved before review in:

- `c2e731d chore: typecheck all worker sources`

Added `apps/worker/tsconfig.json`, extending the root TypeScript configuration,
preserving the `ES2022` and `WebWorker` runtime libraries, including
`worker-configuration.d.ts` and all current and future `src/**/*.ts` files, and
excluding tests. The Worker package command is now:

```text
wrangler types && tsc -p tsconfig.json
```

### Exact post-commit typecheck output

Command:

```text
PATH=/Users/eugene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run typecheck -w @everyday-news/worker
```

Result: exit code `0`.

```text
> typecheck
> wrangler types && tsc -p tsconfig.json


 ⛅️ wrangler 4.113.0
────────────────────
Generating project types...

interface __BaseEnv_Env {
}
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./src/index");
	}
	interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}

Generating runtime types...

Runtime types generated.


✨ Types written to worker-configuration.d.ts

📖 Read about runtime types
https://developers.cloudflare.com/workers/languages/typescript/#generate-types
📣 Remember to rerun 'wrangler types' after you change your wrangler.jsonc file.
```

### Exact post-commit test output

Command:

```text
PATH=/Users/eugene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run test -w @everyday-news/worker
```

Result: exit code `0`.

```text
> test
> vitest run


 RUN  v4.1.10 /Users/eugene/code/everyday-news/.worktrees/reddit-mvp/apps/worker


 Test Files  2 passed (2)
      Tests  6 passed (6)
   Start at  18:20:16
   Duration  294ms (transform 24ms, setup 0ms, import 43ms, tests 20ms, environment 0ms)
```

### Updated concern status

Resolved. The standard Worker typecheck command now covers the complete Worker
source tree automatically; no separate direct compile is required.

## Follow-up: Card Source Metadata

### Scope

- Implemented now: `listCards()` joins `summaries` through `candidates` to
  `source_items` and returns required `titleEn`, `redditUrl`, and `sourceUrl`
  properties on `KnowledgeCard`.
- Deferred to Task 10: source-deletion propagation / `source_deleted`
  transitions and persisted anonymous failure reason/code.
- Deferred to Task 3: restricting the Reddit adapter to `r/todayilearned`.

### RED

Command:

```text
PATH=/Users/eugene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run test -w @everyday-news/worker -- repository.spec.ts
```

Result: exit code `1`.

Exact summary:

```text
Test Files  1 failed (1)
Tests       1 failed | 5 passed (6)
```

The new `lists cards with their original title and source links` test failed as
intended because the returned card lacked `titleEn`, `redditUrl`, and
`sourceUrl`.

### GREEN

Command:

```text
PATH=/Users/eugene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run test -w @everyday-news/worker -- repository.spec.ts
```

Result: exit code `0`.

Exact summary:

```text
Test Files  1 passed (1)
Tests       6 passed (6)
```

### Worker Typecheck

Command:

```text
PATH=/Users/eugene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run typecheck -w @everyday-news/worker
```

Result: exit code `0`; Wrangler regenerated runtime types and `tsc -p
tsconfig.json` completed without TypeScript errors.

### Files Changed

- `apps/worker/src/domain.ts`
- `apps/worker/src/db/repository.ts`
- `apps/worker/test/repository.spec.ts`
- `.superpowers/sdd/task-2-report.md`
