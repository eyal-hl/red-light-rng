# Agent Foundry

Reusable base repository for side projects developed primarily through autonomous coding agents.

The intended workflow is:

**brainstorm with ChatGPT → durable GitHub ticket → human approval → Cursor Cloud Agent implementation → independent review/QA → human merge**

This repository contains no product-specific code. Create a new repository from it for each app idea, then fill in the product documentation and Cloud Agent environment for that project.

## Principles

- Product direction stays human-owned.
- ChatGPT can act as the product/specification layer and write structured GitHub issues directly.
- GitHub is the durable source of truth for approved work.
- Cursor Cloud Agents implement approved tickets and open PRs.
- Review and QA are independent from the implementing agent.
- Autonomous agents never merge to the default branch.
- Every project created from this base should remain understandable without access to the chat where it was designed.

## Repository layout

```text
AGENTS.md                  Global instructions for all coding agents
AUTOMATIONS.md             Cursor Automation setup and trigger design
CLOUD_ENVIRONMENT.md       Cloud Agent environment checklist

docs/
  WORKFLOW.md              End-to-end product → engineering workflow
  PROJECT_SETUP.md         Checklist for creating a project from this base
  product/
    VISION.md              What the product is and is not
    ARCHITECTURE.md        Technical boundaries and project conventions
    DECISIONS.md           Durable product/architecture decisions
  specs/
    README.md              Guidance for feature specifications

.cursor/
  agents/                  Reusable specialist agents
  rules/                   Always-on engineering rules

automation-prompts/        Source-controlled prompts copied into Cursor Automations
.github/                   Issue and PR templates
scripts/create-labels.sh   Optional GitHub label bootstrap
```

## Start a new project

1. Create a new repository from this template/base.
2. Fill in `docs/product/VISION.md`, `ARCHITECTURE.md`, and `DECISIONS.md`.
3. Replace every `TODO_*` placeholder in `AGENTS.md`.
4. Configure and verify the Cursor Cloud Agent environment.
5. Create the Cursor Automations described in `AUTOMATIONS.md`.
6. Use a tiny first ticket as an end-to-end dry run before trusting the flow with large changes.

See `docs/PROJECT_SETUP.md` for the full checklist.

## Human gates

The default workflow intentionally keeps two human decisions:

1. **Approve implementation** — after reviewing a GitHub ticket/spec.
2. **Merge the PR** — after implementation, review, and QA.

Everything between those gates can become increasingly autonomous as the project proves reliable.
