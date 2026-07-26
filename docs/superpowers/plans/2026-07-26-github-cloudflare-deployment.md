# GitHub Cloudflare Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the existing repository to a private GitHub repository and add a production-only GitHub Actions workflow that deploys D1 migrations, the Worker, and Pages in a controlled order.

**Architecture:** Keep the existing CI workflow responsible for branch and pull-request verification. Add a separate production workflow that runs only for `main` or a manual dispatch, authenticates with repository secrets, applies D1 migrations, deploys the Worker, rebuilds the Web app with its public API origin, deploys Pages, and performs read-only health probes.

**Tech Stack:** GitHub CLI, GitHub Actions, Node.js 22, npm workspaces, Cloudflare Wrangler 4, `cloudflare/wrangler-action` 4, Cloudflare Workers, D1, and Pages.

## Global Constraints

- GitHub repository is `SAMYJ1/everyday-news` with private visibility.
- Default and production branch is `main`; development remains on `feature/reddit-mvp`.
- Pull requests never receive production secrets or deploy production resources.
- Production deploys run only on a `main` push or `workflow_dispatch`.
- Runtime secrets `ADMIN_KEY` and `REDDIT_USER_AGENT` stay in Cloudflare and never enter the frontend build.
- The workflow does not create, replace, or delete D1 databases, Queues, Pages projects, domains, or DNS.
- Production deployment concurrency does not cancel an in-progress deployment.

---

### Task 1: Add the production deployment workflow

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `docs/operations.md`

**Interfaces:**
- Consumes: repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_NAME`, `CLOUDFLARE_PAGES_PROJECT`, `WORKER_BASE_URL`, and `PAGES_BASE_URL`.
- Produces: a GitHub Actions workflow named `Deploy` and an operations checklist for configuring its production environment.

- [ ] **Step 1: Establish the failing workflow checks**

Run before the file exists:

```sh
test -f .github/workflows/deploy.yml
```

Expected: exit status `1`.

- [ ] **Step 2: Create `.github/workflows/deploy.yml`**

Create a workflow with:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: production
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      CLOUDFLARE_D1_DATABASE_NAME: ${{ secrets.CLOUDFLARE_D1_DATABASE_NAME }}
      CLOUDFLARE_PAGES_PROJECT: ${{ secrets.CLOUDFLARE_PAGES_PROJECT }}
      WORKER_BASE_URL: ${{ secrets.WORKER_BASE_URL }}
      PAGES_BASE_URL: ${{ secrets.PAGES_BASE_URL }}
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
      - name: Validate deployment configuration
        shell: bash
        run: |
          missing=()
          for name in \
            CLOUDFLARE_API_TOKEN \
            CLOUDFLARE_ACCOUNT_ID \
            CLOUDFLARE_D1_DATABASE_NAME \
            CLOUDFLARE_PAGES_PROJECT \
            WORKER_BASE_URL \
            PAGES_BASE_URL
          do
            if [[ -z "${!name}" ]]; then
              missing+=("$name")
            fi
          done
          if (( ${#missing[@]} )); then
            printf 'Missing required deployment secrets: %s\n' "${missing[*]}" >&2
            exit 1
          fi
      - name: Apply D1 migrations
        run: >-
          npx wrangler d1 migrations apply "$CLOUDFLARE_D1_DATABASE_NAME"
          --remote
          --config apps/worker/wrangler.jsonc
      - name: Deploy Worker
        uses: cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy --config apps/worker/wrangler.jsonc
      - name: Probe Worker
        run: curl --fail-with-body --silent --show-error "$WORKER_BASE_URL/api/health"
      - name: Build Web for production
        env:
          VITE_API_BASE_URL: ${{ secrets.WORKER_BASE_URL }}
        run: npm run build -w @everyday-news/web
      - name: Check Web build output
        run: test -f apps/web/dist/index.html
      - name: Deploy Pages
        uses: cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: >-
            pages deploy apps/web/dist
            --project-name=${{ secrets.CLOUDFLARE_PAGES_PROJECT }}
            --branch=main
      - name: Probe Pages
        run: curl --fail-with-body --silent --show-error "$PAGES_BASE_URL/"
```

The immutable Wrangler Action commit is the `v4` ref resolved from the official Cloudflare repository on 2026-07-26.

- [ ] **Step 3: Document GitHub production configuration**

Append a GitHub Actions section to `docs/operations.md` that lists the six repository secrets, instructs the operator to create the `production` GitHub Environment, and states that `ADMIN_KEY`, `REDDIT_USER_AGENT`, and `APP_ORIGIN` remain Cloudflare Worker secrets.

- [ ] **Step 4: Validate the workflow locally**

Run:

```sh
test -f .github/workflows/deploy.yml
ruby -e 'require "yaml"; YAML.parse_file(".github/workflows/deploy.yml")'
rg -n 'pull_request|ADMIN_KEY|REDDIT_USER_AGENT|APP_ORIGIN' .github/workflows/deploy.yml
git diff --check
```

Expected:

- the file test and YAML parser exit `0`;
- `rg` exits `1`, proving production runtime secrets and PR triggers are absent;
- `git diff --check` exits `0`.

- [ ] **Step 5: Run project verification**

Run:

```sh
npm test
npm run typecheck
npm run build
```

Expected: all commands exit `0`; Worker and Web tests pass; Wrangler dry run and Vite build complete.

- [ ] **Step 6: Commit the workflow and operations update**

```sh
git add .github/workflows/deploy.yml docs/operations.md
git commit -m "ci: add Cloudflare production deployment"
```

### Task 2: Commit the deployment research and implementation plan

**Files:**
- Add: `docs/research/2026-07-26-github-cloudflare-deployment.md`
- Add: `docs/superpowers/plans/2026-07-26-github-cloudflare-deployment.md`

**Interfaces:**
- Consumes: the approved deployment design and official Cloudflare/GitHub documentation.
- Produces: repository-local rationale and an auditable execution plan.

- [ ] **Step 1: Check documentation for placeholders and malformed whitespace**

```sh
placeholder_pattern='T''BD|TO''DO|FIX''ME|PA''STE_'
rg -n "$placeholder_pattern" \
  docs/research/2026-07-26-github-cloudflare-deployment.md \
  docs/superpowers/plans/2026-07-26-github-cloudflare-deployment.md
git diff --check
```

Expected: `rg` exits `1`; `git diff --check` exits `0`.

- [ ] **Step 2: Commit only the two documentation artifacts**

```sh
git add \
  docs/research/2026-07-26-github-cloudflare-deployment.md \
  docs/superpowers/plans/2026-07-26-github-cloudflare-deployment.md
git commit -m "docs: record GitHub deployment plan"
```

### Task 3: Create the GitHub repository and publish the branches

**Files:**
- No repository file changes.

**Interfaces:**
- Consumes: authenticated GitHub CLI account `SAMYJ1`, local branches `main` and `feature/reddit-mvp`.
- Produces: private GitHub repository `SAMYJ1/everyday-news`, remote `origin`, pushed branches, and a draft PR into `main`.

- [ ] **Step 1: Reconfirm local and remote targets**

```sh
gh auth status
git status -sb
git remote -v
gh repo view SAMYJ1/everyday-news
```

Expected: authentication succeeds, worktree is clean, no remote exists, and repository lookup returns not found. If the repository exists, inspect it and stop before creating or overwriting anything.

- [ ] **Step 2: Create the private repository**

```sh
gh repo create SAMYJ1/everyday-news \
  --private \
  --description "Daily AI-curated science and knowledge digest" \
  --disable-wiki
git remote add origin git@github.com:SAMYJ1/everyday-news.git
```

Expected: repository creation succeeds and `origin` resolves to the new repository.

- [ ] **Step 3: Push the default branch first**

```sh
git push -u origin main
gh repo edit SAMYJ1/everyday-news --default-branch main
```

Expected: remote `main` points at local `main`, and GitHub reports `main` as the default branch.

- [ ] **Step 4: Push the feature branch**

```sh
git push -u origin feature/reddit-mvp
```

Expected: remote branch points at the locally verified feature head.

- [ ] **Step 5: Create the draft pull request**

Write the PR body to a temporary file with sections for changes, deployment behavior, checks, and remaining Cloudflare bootstrap. Then run:

```sh
gh pr create \
  --repo SAMYJ1/everyday-news \
  --base main \
  --head feature/reddit-mvp \
  --draft \
  --title "Build Reddit knowledge digest MVP" \
  --body-file "$PR_BODY_FILE"
```

Expected: GitHub returns a draft PR URL.

- [ ] **Step 6: Verify GitHub state**

```sh
gh repo view SAMYJ1/everyday-news \
  --json nameWithOwner,isPrivate,defaultBranchRef,url
gh pr view \
  --repo SAMYJ1/everyday-news \
  --json url,isDraft,baseRefName,headRefName,state
gh api \
  'repos/SAMYJ1/everyday-news/contents/.github/workflows/deploy.yml?ref=feature/reddit-mvp'
git status -sb
```

Expected:

- repository is private and default branch is `main`;
- PR is open and draft from `feature/reddit-mvp` into `main`;
- the pushed feature branch contains `deploy.yml`; GitHub will register it as a runnable production workflow after it reaches the default branch;
- local worktree is clean.
