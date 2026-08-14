# Agent Foundry — Project Agent Instructions

This repository is designed for projects maintained primarily by autonomous coding agents. Humans own product direction and final merge approval. Agents own implementation and verification inside approved boundaries.

## Required read order

Before modifying code, read:

1. `AGENTS.md`
2. `docs/product/VISION.md`
3. `docs/product/ARCHITECTURE.md`
4. `docs/product/DECISIONS.md`
5. the originating GitHub issue and any linked spec under `docs/specs/`
6. relevant existing code and tests

If sources conflict, prefer the most specific approved source and surface the conflict instead of inventing product behavior.

## Engineering principles

- Implement the smallest complete solution satisfying the approved ticket.
- Reuse existing patterns before introducing abstractions.
- Avoid unrelated refactors in feature PRs.
- Never weaken or delete tests merely to make CI pass.
- Never hide incomplete functionality behind stubs, fake data, or dead paths unless explicitly required.
- Preserve backwards compatibility unless the ticket explicitly allows a break.
- Prefer boring, maintainable solutions over clever ones.
- Treat lint, typecheck, tests, and build failures as defects.
- For user-facing changes, verify actual behavior in the running application when practical.

## Completion checklist

Before presenting implementation as complete:

1. Map every acceptance criterion to implemented behavior.
2. Add or update meaningful automated tests.
3. Run the repository validation commands below.
4. Start relevant application/services when practical.
5. Exercise primary user-facing flows for UI changes.
6. Inspect runtime/browser errors where applicable.
7. Explicitly report anything incomplete, blocked, or uncertain.
8. Ask the `verifier` subagent for an independent final check before opening/updating the PR.

## Project commands

Replace these in every project created from Agent Foundry:

- Install: `TODO_INSTALL_COMMAND`
- Lint: `TODO_LINT_COMMAND`
- Typecheck: `TODO_TYPECHECK_COMMAND`
- Test: `TODO_TEST_COMMAND`
- Build: `TODO_BUILD_COMMAND`
- Start: `TODO_START_COMMAND`
- Local app URL: `TODO_APP_URL`
- Test account/data setup: `TODO_TEST_SETUP`

If a command does not apply, replace it with `N/A`.

## Safety boundaries

Unless an approved ticket explicitly requires it and a safe non-production environment exists, agents MUST NOT:

- modify production data;
- deploy to production;
- rotate or expose credentials;
- loosen authentication, authorization, or security controls;
- modify billing/payment configuration;
- alter repository security or branch protection;
- merge their own PR.

Never print secrets into logs, comments, screenshots, artifacts, or PR descriptions.

## Pull requests

Implementation PRs should reference the originating issue, describe user-visible behavior, summarize important technical decisions, list validation performed, include visual evidence for meaningful UI changes when available, and call out migrations, security impact, compatibility risks, and known limitations.

## Review protocol

Use these prefixes only for verified actionable findings:

- `[AI-REVIEW]` — correctness/design defect
- `[AI-QA]` — observed product/behavior defect
- `[AI-SECURITY]` — security defect

Style preferences and optional refactors should not block a PR.

## Autonomous repair budget

Default maximum: **2 autonomous repair rounds per PR**. If further repair is required, stop automation and report `needs-human` with a concise blocker summary.
