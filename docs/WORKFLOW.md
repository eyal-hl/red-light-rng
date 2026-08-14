# Agent Foundry Workflow

## Goal

Turn a product conversation into reviewed code without requiring the human owner to manually implement features.

```text
Human + ChatGPT
  brainstorm / clarify behavior
          ↓
ChatGPT creates/updates durable GitHub issue
          ↓
Human reviews ticket
          ↓
Human approves implementation
          ↓
Cursor Developer Cloud Agent
          ↓
Pull Request
          ↓
Independent review + QA
          ↓
repairs if required
          ↓
Human reviews / merges
```

## GitHub is the source of truth

Chat is for exploration. Before implementation, important decisions must exist in `docs/product/*`, the GitHub issue, a linked spec under `docs/specs/`, or a recorded decision. An implementation agent must not require the original brainstorming conversation to understand approved behavior.

## Ticket lifecycle

### Proposal

A ticket should include, where relevant: problem/outcome, user-visible behavior, acceptance criteria, edge cases, explicit non-goals, constraints, and links to relevant product docs.

### Human approval

The owner reviews the durable ticket before implementation. The default dispatch command is an exact issue comment:

```text
/build
```

`agent:build` can be used as semantic state as well.

### Implementation

Developer reads docs + issue/spec, implements the whole approved scope, validates it, and opens a PR. It never merges.

### Review and QA

Independent agents verify the result from fresh context. Review is code/spec-oriented. QA is behavior-oriented and should exercise the running product when practical.

### Repair

Repairs are bounded to two autonomous rounds. If the PR still cannot pass, stop and request human judgment.

### Human merge

The owner is the final release gate.

## Working with ChatGPT

Convenient conversational commands:

- `ticket this` → create/update the GitHub issue from the current brainstorm.
- `update #12 with ...` → edit the durable ticket.
- `approve #12` → record approval and dispatch `/build`.
- `fix PR #34` → dispatch a trusted repair after reviewing findings.
- `review PR #34` → independently inspect the PR/diff/discussion before merge.
