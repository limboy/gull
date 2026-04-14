# Agent Guide

## Purpose

This file is the minimal operating guide for agents working in this repo.  
Detailed project knowledge lives in `docs/`.

## Read First

1. Run `node scripts/docs-list.js` before changing any code to view doc summaries.
2. Read the relevant files in `docs/` for the task.

## Documentation Policy

- If code changes can make docs obsolete, update related files in `docs/` in the same change.

## Commit Guidelines

Follow [Conventional Commits](https://www.conventionalcommits.org/) so `npm run changelog` can group entries correctly.

Format: `type(scope)!: subject`

- **type** (required, lowercase): `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `test`, `build`, `ci`, `chore`
- **scope** (optional): area of the codebase, e.g. `epub`, `main`, `ui`
- **!** (optional): marks a breaking change; or add `BREAKING CHANGE:` in the body
- **subject**: imperative, concise, no trailing period

Rules:

- One logical change per commit. Don't mix `feat` and `refactor` in one commit.
- Keep subjects ≤ 72 chars and readable on their own — they become changelog bullets.
- Use `fix` only for user-visible bug fixes; internal cleanups are `refactor` or `chore`.
- Unknown types are dropped from the changelog, so stick to the list above.

Examples:

- `feat(epub): support encrypted fonts`
- `fix(main): prevent crash when opening empty library`
- `refactor!: drop Node 18 support`
