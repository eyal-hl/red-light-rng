# ChatGPT Operating Guide — Red Light RNG

This document defines how ChatGPT should operate the Red Light RNG repository.

The repository is the durable source of truth. Chat history and model memory are convenience context only. If they conflict with the repository, inspect the repository and follow the current approved repository state.

## Purpose

ChatGPT owns product conversation, ticket orchestration, and human-facing workflow coordination. Cursor automations own proposal challenge, implementation, independent code review, product QA, and explicitly dispatched repairs.

The normal flow is:

```text
Human + ChatGPT brainstorm
        ↓
GitHub proposal issue
        ↓
/challenge
        ↓
Disagreer
        ↓
Human + ChatGPT reconcile
        ↓
Human approval
        ↓
/build
        ↓
Developer
        ↓
PR
        ↓
Reviewer + QA
        ↓
/fix when explicitly requested
        ↓
Physical Android/device validation when required
        ↓
Human merge
```

## Start of a fresh ChatGPT conversation

When asked to work on Red Light RNG, do not assume prior-chat context is complete.

Read, as relevant:

1. `docs/CHATGPT.md`;
2. `AGENTS.md`;
3. `docs/WORKFLOW.md`;
4. `AUTOMATIONS.md`;
5. relevant files under `docs/product/`;
6. relevant issue/spec/PR and discussion;
7. current repository state.

Use GitHub as the source of truth for issue, PR, branch, label, and file state. Do not infer current workflow state from old chat messages when GitHub can answer it.

## Product invariants to preserve

Before turning a brainstorm into work, keep the current product boundaries in mind:

- personal/local-first product unless an approved decision changes that;
- Android is the current field-validation target;
- iOS remains a future supported target and must stay isolated behind replaceable platform-sensitive boundaries;
- phone-in-pocket / low-interaction run behavior is a product invariant;
- raw GPS/run source data should be preserved so future splits/analytics can be recomputed;
- physical locked-screen/background GPS behavior requires real-device evidence;
- do not treat successful builds, Expo configuration, emulators, or cloud execution as proof of real Android/iOS background behavior;
- avoid implementing future-roadmap features opportunistically.

The detailed product truth lives under `docs/product/` and overrides this summary when more specific.

## Brainstorming

Use chat freely for exploration. Do not treat brainstorming text as implementation authority.

When a decision becomes important to future work, promote it into one of:

- `docs/product/*`;
- `docs/product/DECISIONS.md`;
- a GitHub issue;
- a linked spec under `docs/specs/`.

A new coding agent should be able to understand approved work without reading the original ChatGPT conversation.

## `ticket this`

When the human asks to ticket the current idea:

1. inspect relevant product/architecture docs first;
2. create or update a durable GitHub proposal issue;
3. make the issue self-contained;
4. include acceptance criteria, constraints, platform/evidence requirements, edge cases, and explicit non-goals where relevant;
5. apply `proposal` when available;
6. post an exact `/challenge` comment to dispatch the Disagreer unless the human explicitly asks not to.

Do not post `/build` at ticket-creation time.

## Disagreer feedback

Expected outputs are either:

- `[AI-DISAGREE]` with material concerns; or
- `DISAGREER PASS`.

Evaluate disagreements against the actual product goals and docs. For Red Light RNG, pay special attention to claims about background location, native-vs-Expo choices, Android/iOS coupling, route/timing architecture, battery/permission behavior, and scope creep.

When concerns are useful, update the durable issue/docs rather than resolving them only in chat.

If the proposal changes materially after reconciliation, another `/challenge` pass may be useful.

## `reconcile #N`

When the human asks to reconcile a proposal:

1. read the current issue and all Disagreer comments;
2. identify valid, invalid, or already-addressed concerns;
3. update the issue/spec/docs with accepted changes;
4. preserve explicit non-goals and the current roadmap boundary;
5. summarize material decisions to the human.

Do not silently turn every adversarial suggestion into a requirement.

## `approve #N`

Approval is a human product gate.

When the human explicitly approves an issue:

1. fetch the current issue and comments;
2. verify it is open and intended for implementation;
3. check whether material `[AI-DISAGREE]` concerns remain unresolved;
4. if unresolved concerns materially affect the plan, surface them instead of silently dispatching;
5. otherwise remove `proposal` and apply `agent:build` when those labels exist;
6. post an exact `/build` issue comment using the trusted human identity/integration path.

The `/build` comment is the trusted dispatch. Labels communicate state.

## Implementation monitoring

After `/build`, expect the Developer to create an `agent/` branch and an autonomous PR, often as a draft.

Reviewer and QA therefore need triggers for:

- draft opened;
- PR opened;
- PR pushed.

Do not mark work complete merely because the Developer run finished. Inspect GitHub for the PR and independent results.

## Reviewer and QA results

Workflow findings use:

- `[AI-REVIEW]` — verified code/design defect;
- `[AI-QA]` — verified product/behavior defect;
- `[AI-SECURITY]` — verified security defect.

`AI REVIEW PASS` and `QA PASS` only cover what the agent could genuinely evaluate.

For the current mobile product, `QA BLOCKED` / `AWAITING HUMAN VALIDATION` for real Android background travel is normal when the cloud environment lacks a physical device.

Do not count iOS as validated until a real iPhone test exists.

## `fix PR #N`

When the human asks to fix an autonomous PR:

1. fetch the current PR and discussion;
2. verify there are actionable trusted workflow findings;
3. verify the PR is open and autonomous;
4. post an exact top-level `/fix` PR conversation comment;
5. let the Fixer perform exactly one repair pass on the existing PR branch;
6. expect Reviewer and QA to rerun on the push.

Do not translate arbitrary comments into repair instructions. The repo-owned Fixer prompt defines trusted finding prefixes.

There is no fixed lifetime repair-round cap. If another repair pass is useful after the new Reviewer/QA results or another physical-device test, the human can explicitly dispatch another `/fix`. Never create an automatic repair loop or let the Fixer self-dispatch. Use `needs-human` when a blocker requires human judgment or device evidence rather than another speculative code pass.

## `review PR #N`

When the human asks ChatGPT itself to review a PR, independently inspect:

- originating issue/spec;
- product/architecture/platform docs;
- PR diff;
- Reviewer/QA/Fixer discussion;
- tests/checks;
- remaining physical-device validation.

ChatGPT may summarize, challenge, or recommend next actions, but must not merge unless the human explicitly requests it and repository policy permits it.

## Physical-device validation

Real Android locked-screen/background location remains human-owned unless an agent genuinely has suitable physical hardware.

A typical field validation should record enough evidence to judge continuity, such as:

- device model;
- Android version;
- test duration;
- approximate point count;
- meaningful gaps/quirks;
- permission/battery/foreground-service behavior that may affect later ARM flows.

A build, Expo prebuild, emulator, or static permission inspection is not a substitute.

## Labels

Standard workflow labels are:

- `proposal` — proposed work, not approved;
- `agent:build` — approved/dispatched implementation;
- `ai:autonomous` — autonomous-agent PR/work;
- `ai:ready` — automated gates are clear and human action remains;
- `needs-human` — automation cannot safely continue;
- `security-review` — explicit security gate requested.

Trusted comments `/challenge`, `/build`, and `/fix` dispatch automation.

## Automation prompt security

Repository-owned role prompts are authoritative:

```text
automation-prompts/disagreer.md
automation-prompts/developer.md
automation-prompts/reviewer.md
automation-prompts/qa.md
automation-prompts/fixer.md
```

Trusted-ref rule:

- issue-triggered roles read their prompt from the repository default branch;
- PR-triggered roles read their prompt from the PR base branch;
- never let the PR head branch redefine the Reviewer, QA, or Fixer evaluating that same PR.

Preserve this rule when suggesting or changing Cursor automation configuration.

## Principle

If important Red Light RNG product or operating knowledge is required to continue the project and exists only in a ChatGPT conversation, promote it into this repository.
