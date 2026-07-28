# Public Knowledge Site and Run Recovery Design

**Date:** 2026-07-28
**Status:** Awaiting written-spec review

## Goal

Turn the existing private review dashboard into a two-entry application:

- `/` is a public, no-login knowledge feed.
- `/admin` retains the private review and collection controls.

The first public release uses a publish-before-review policy: successfully
generated `draft` and `approved` cards are visible immediately, while
`rejected`, `failed`, and `source_deleted` cards are never public.

At the same time, close the production failure mode in which a Queue message
exhausts its retries and moves to the dead-letter queue while its D1
`fetch_runs` record remains `running` forever.

## Current State

The Pages deployment contains a single React application whose root renders
only the private review dashboard. Every Worker API except `/api/health`
requires the administrator bearer key.

The first production scheduled run created
`af652e04-7b0a-4624-a59c-62b2dd4ff2b4`, marked it `running`, and then failed
three Queue deliveries during the `discover` stage. Cloudflare moved the
message to `everyday-news-dead-letter`, but no code reconciled the D1 run to a
terminal status. The UI therefore reports a live run indefinitely and disables
manual collection.

## Architecture

### One Pages application, two stable entries

Keep one Vite/React build and one Pages project. Select the application shell
from `window.location.pathname` without adding a routing dependency:

- `/` renders the public knowledge feed.
- `/admin` renders the existing private dashboard.
- Unknown paths render a small not-found view with a link to `/`.

The admin page includes a link back to the public site. Direct navigation and
browser refresh must work for both routes through the existing Pages SPA
fallback.

### Public read API

Add two unauthenticated, read-only Worker endpoints before the private-route
authentication gate:

- `GET /api/public/dates`
  - Returns dates that contain at least one public card, newest first.
- `GET /api/public/cards`
  - Without `date`, returns cards for the newest date that contains public
    content.
  - With `date=YYYY-MM-DD`, returns public cards for that date.

Public cards are summaries whose status is `draft` or `approved`, whose source
item has not been deleted, and whose summary has not been source-deleted.
Results preserve the existing stable card order. The public response contains
only fields required for reading and source attribution; it contains no run
errors, review history, internal delivery claims, administrator state, or
credentials.

Existing admin APIs and their bearer-key requirement remain unchanged.

## Public Experience

The public page is optimized for quick reading:

- A short site introduction and the selected content date appear at the top.
- The newest date with content is selected automatically.
- A date selector allows browsing older public content.
- Cards show the Chinese title, one-line fact, why it is interesting, comment
  insights, caveats, confidence note, and safe HTTP(S) source links.
- An empty state is shown when no public content exists.
- Mobile uses one column. Wider screens use a restrained two-column layout
  with readable line lengths.

The initial release intentionally has no pagination, search, accounts, likes,
or sharing workflow.

## Publish-Before-Review Rules

The public visibility matrix is:

| Summary status | Public |
| --- | --- |
| `draft` | Yes |
| `approved` | Yes |
| `rejected` | No |
| `failed` | No |
| `source_deleted` | No |

Rejecting a card removes it from subsequent public API responses immediately.
Approving a draft preserves its public visibility. Source deletion always
overrides review status and removes the card from public responses.

The private review entry remains available at `/admin`; it is not linked as a
prominent visitor action from the public feed.

## Queue Failure Recovery

### Terminalize the final delivery

Keep exponential retry behavior for temporary Reddit and infrastructure
failures while another configured delivery remains. On the final available
delivery, persist a terminal run result instead of requesting another retry:

- `status = 'failed'`
- a stable, non-sensitive error code identifying the failed pipeline stage
- a safe error message
- `finished_at` set to the current time

The retry limit used by code and `wrangler.jsonc` must come from one documented
shared value or be covered by a configuration-contract test so the two cannot
silently drift.

Unknown recovery-write failures must not be silently acknowledged. They must
remain observable and retryable unless the run has already reached a terminal
state.

### Reconcile stale runs

A run is stale when it remains `queued` or `running` for more than ten minutes.
Before returning the latest run to the admin dashboard and before starting a
same-day scheduled or manual run, reconcile stale runs to:

- `status = 'failed'`
- `error_code = 'run_timed_out'`
- a safe operator-facing message
- `finished_at` set to reconciliation time

After reconciliation, a manual start for the same local date must be able to
create a fresh run. This requires removing the current one-row-per-date
assumption from run identity while retaining idempotency for concurrent starts.
Only one non-terminal run per local date may exist at a time.

Run history must retain the timed-out attempt and the later replacement
attempt.

### Admin UI behavior

The Worker owns terminal-state truth. The admin UI additionally treats a
non-terminal run older than ten minutes as visibly stale while waiting for API
reconciliation:

- show an explicit timeout warning rather than a healthy “running” label;
- do not poll indefinitely;
- allow the operator to request a new run once the API reports the stale run
  as terminal.

## Observability

Enable Workers Observability in `wrangler.jsonc` with full sampling for the MVP.
Emit structured JSON events at stage boundaries and failure decisions with:

- `runId`
- `stage`
- delivery attempt
- normalized error category
- terminal or retry decision

Never log administrator keys, authorization headers, secret values, complete
Reddit response bodies, or generated card contents.

## Production Recovery Order

Production recovery is performed only after the new code is deployed and
verified:

1. Confirm Worker health and the deployed version.
2. Reconcile the existing stale D1 run to `failed`.
3. Verify that the admin page no longer reports it as active.
4. Remove or acknowledge the matching dead-letter message so it cannot be
   replayed through old assumptions.
5. Start one fresh run for the current Shanghai local date.
6. Observe it through a terminal state and verify public API output.

Each production mutation must target the exact known run or message. Do not
purge the entire queue or delete run history.

## Testing

Implementation follows test-driven development.

Worker coverage must prove:

- temporary failures retry before the final delivery;
- the final temporary failure writes a terminal run and does not remain
  `running`;
- stale runs reconcile after ten minutes but fresh active runs do not;
- a reconciled same-day run can be followed by one fresh run without allowing
  concurrent duplicates;
- public dates and cards expose `draft` and `approved`;
- public queries hide `rejected`, `failed`, `source_deleted`, and deleted
  sources;
- public routes need no bearer key, while every existing private route still
  rejects missing or invalid credentials.

Web coverage must prove:

- `/` renders public content without an administrator key;
- `/admin` retains the access-key gate;
- the newest public date loads by default;
- selecting a historical date replaces the visible cards;
- empty, loading, and API-error states are understandable;
- malformed or non-HTTP(S) source URLs never become clickable links;
- a stale active run is not presented as a healthy live run.

Before deployment, run the complete Worker and Web test suites, typechecks, and
production builds. After deployment, verify the public page, private admin
entry, public API filtering, D1 run state, and Queue/DLQ state.

## Security and Compatibility

- The administrator key remains only in Worker secrets and admin
  `sessionStorage`.
- Public endpoints are GET-only and return no privileged fields.
- Existing CORS restrictions remain for private browser APIs; public endpoints
  allow the production Pages origin and ordinary same-origin/server requests.
- No new runtime dependency is required for routing.
- Existing approved and draft summaries become public under the visibility
  rules immediately after deployment.
