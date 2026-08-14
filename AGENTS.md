# Agent Foundry — Project Agent Instructions

This repository is designed for projects maintained primarily by autonomous coding agents. Humans own product direction and final merge approval. Agents own implementation and verification inside approved boundaries.

## ChatGPT / orchestration entrypoint

For product brainstorming, GitHub ticket orchestration, `/challenge`, `/build`, `/fix`, workflow-state interpretation, or continuing Red Light RNG from a fresh ChatGPT conversation, read `docs/CHATGPT.md` first, then `docs/WORKFLOW.md` and `AUTOMATIONS.md` as relevant.

The repository and current GitHub state are authoritative. Do not rely on old chat context when the repository can answer the question.

## Required read order

Before modifying code, read:

1. `AGENTS.md`
2. `docs/product/VISION.md`
3. `docs/product/CONCEPTS.md`
4. `docs/product/USER_FLOW.md`
5. `docs/product/RUN_ANALYSIS.md`
6. `docs/product/ROADMAP.md`
7. `docs/product/ARCHITECTURE.md`
8. `docs/product/PLATFORM_SUPPORT.md`
9. `docs/product/DECISIONS.md`
10. the originating GitHub issue and any linked spec under `docs/specs/`
11. relevant existing code and tests

The product docs are canonical context, but the approved issue defines the scope of the current implementation. Do not opportunistically implement future-roadmap features merely because they are documented.

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
- Preserve raw run/location source data when changing derived analytics unless an approved decision explicitly changes that policy.
- Do not introduce accounts, cloud services, social features, or a backend unless an approved ticket explicitly changes the local-first product boundary.
- Do not turn the active-run experience into an interaction-heavy UI; phone-in-pocket behavior is a product invariant.
- Keep platform-sensitive background location behind the boundary defined in `docs/product/PLATFORM_SUPPORT.md`; do not leak Android-specific assumptions into shared route/timing/analytics code.
- Do not claim iOS background tracking is validated until a real iPhone field test has been performed.

## Completion checklist

Before presenting implementation as complete:

1. Map every acceptance criterion to implemented behavior.
2. Add or update meaningful automated tests.
3. Run the repository validation commands below.
4. Start relevant application/services when practical.
5. Exercise primary user-facing flows for UI changes.
6. Inspect runtime/device errors where applicable.
7. Explicitly report anything incomplete, blocked, or uncertain.
8. Ask the `verifier` subagent for an independent final check before opening/updating the PR.

## Project commands

These remain intentionally unresolved until the first mobile implementation initializes the project tooling:

- Install: `TODO_INSTALL_COMMAND`
- Lint: `TODO_LINT_COMMAND`
- Typecheck: `TODO_TYPECHECK_COMMAND`
- Test: `TODO_TEST_COMMAND`
- Build: `TODO_BUILD_COMMAND`
- Start: `TODO_START_COMMAND`
- Local app URL: `TODO_APP_URL`
- Test account/data setup: `N/A` for the current account-free product unless this changes later

The first setup/implementation ticket must replace every applicable `TODO_*` value. If a command does not apply, replace it with `N/A` and explain why.

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
