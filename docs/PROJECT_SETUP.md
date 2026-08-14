# New Project Setup

Use this checklist immediately after creating a project from Agent Foundry.

## Product context

- [ ] Replace `docs/product/VISION.md` with the project's actual vision and non-goals.
- [ ] Fill `docs/product/ARCHITECTURE.md` with the chosen stack and system boundaries.
- [ ] Record important durable decisions in `docs/product/DECISIONS.md`.

## Agent instructions

- [ ] Replace every `TODO_*` value in `AGENTS.md`.
- [ ] Add project-specific `.cursor/rules/*.mdc` only where global instructions are insufficient.
- [ ] Add specialist subagents only for recurring needs.

## GitHub

- [ ] Create workflow labels using `scripts/create-labels.sh` or manually.
- [ ] Confirm issue and PR templates render correctly.
- [ ] Decide whether branch protection is useful.

## Cursor Cloud Agents

- [ ] Connect the repository in Cursor.
- [ ] Build a reproducible Cloud Agent environment.
- [ ] Verify install/lint/typecheck/test/build/start commands.
- [ ] Add only test/non-production secrets needed by agents.
- [ ] Commit a verified `.cursor/environment.json` if appropriate.

## Cursor Automations

- [ ] Create Developer from `automation-prompts/developer.md`.
- [ ] Create Independent Reviewer from `automation-prompts/reviewer.md`.
- [ ] Create Product QA from `automation-prompts/qa.md` when the app can run in cloud.
- [ ] Add Fixer from `automation-prompts/fixer.md` after the first three are reliable.

## Dry run

Use a small reversible feature as the first end-to-end ticket. Avoid auth, payment, destructive migrations, or production integrations for the first test. Improve the environment and agent instructions before increasing autonomy.
