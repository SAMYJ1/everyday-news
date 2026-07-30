# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: use `gh issue list` with the appropriate state and label filters
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. Resolve an ambiguous number with `gh pr view <number>` and fall back to `gh issue view <number>`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

The map is a single issue labelled `wayfinder:map`, with child issues used as tickets.

- Child labels use `wayfinder:<type>`: `research`, `prototype`, `grilling`, or `task`.
- Use GitHub sub-issues when available; otherwise use task-list links and `Part of #<map>`.
- Represent blockers using GitHub issue dependencies when available.
- Claim work by assigning the issue to the current user.
- Resolve work by commenting with the answer, closing the issue, and recording the resulting context pointer in the map.
