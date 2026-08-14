# Agent Foundry Workflow

## Goal

Turn a product conversation into reviewed code without requiring the human owner to manually implement features, while keeping planning challenge, implementation, review, QA, repair, physical validation, and release as separate roles.

```text
Human + ChatGPT
  brainstorm / clarify behavior
          ↓
ChatGPT creates/updates durable GitHub proposal
          ↓
trusted /challenge comment
          ↓
Disagreer challenges plan / architecture
          ↓
Human + ChatGPT reconcile useful feedback
          ↓
Human approves ticket
          ↓
trusted /build comment
          ↓
Cursor Developer Cloud Agent
          ↓
Pull Request
          ↓
Independent review + QA
          ↓
repairs if required
          ↓
Human Android/device validation where required
          ↓
Human reviews / merges
```

## GitHub is the source of truth

Chat is for exploration. Before implementation, important decisions must exist in `docs/product/*`, the GitHub issue, a linked spec under `docs/specs/`, or a recorded decision. An implementation agent must not require the original brainstorming conversation to understand approved behavior.

Agent behavior is also source-controlled. `automation-prompts/*.md` contains the authoritative role instructions for Red Light RNG.

Cursor itself should contain only small reusable bootstrap prompts. One Cursor automation per role can serve many repositories; each run loads the repository-specific role prompt from a trusted branch.

## Trusted automation instructions

Automation prompts are security-sensitive.

- Issue-triggered roles load their role file from the repository default branch.
- PR-triggered roles load their role file from the PR base branch.
- Never use the PR head/source branch as the authority for Reviewer, QA, or Fixer instructions.

This allows a PR to propose changing automation behavior without letting unmerged code weaken the gate reviewing that same PR.

## Ticket lifecycle

### Proposal

A ticket should include, where relevant: problem/outcome, user-visible behavior, acceptance criteria, edge cases, explicit non-goals, constraints, and links to relevant product docs.

### Disagreement pass

Cursor currently has no issue-created automation trigger, so the disagreement pass is explicitly dispatched with a trusted issue comment:

```text
/challenge
```

The Disagreer looks for material architecture/product problems, hidden assumptions, unnecessary complexity, platform risks, missing acceptance criteria, simpler alternatives, and risky coupling.

For Red Light RNG it should specifically challenge Android/iOS boundary violations and claims about background location that are not backed by physical-device evidence.

Its feedback is advisory. It may return `DISAGREER PASS`; disagreement for disagreement's sake is undesirable.

Human + ChatGPT reconcile useful findings into the durable issue before approval.

### Human approval

The owner reviews the durable ticket after the disagreement pass. The default dispatch command is an exact issue comment:

```text
/build
```

`agent:build` can be used as semantic state as well.

### Implementation

Developer reads docs + issue/spec, implements the whole approved scope, validates it, and opens an autonomous PR. It never merges.

### Review and QA

Independent agents verify the result from fresh context. Review is code/spec/architecture-oriented. QA is behavior-oriented and should exercise the running product when practical.

Reviewer and QA run on draft PR creation, normal PR creation, and subsequent pushes so repair commits are automatically re-checked.

Cloud agents must distinguish between what they actually validated and what still needs real hardware.

### Repair

Repairs require an explicit trusted `/fix` dispatch. They are bounded to two autonomous rounds. If the PR still cannot pass, stop and request human judgment.

### Physical validation

Real Android locked-screen/background GPS criteria remain human-owned unless an agent genuinely has an appropriate physical device.

iOS remains unvalidated until an iPhone is available. A successful bundle/build/emulator run is not evidence that background GPS works on real iOS hardware.

### Human merge

The owner is the final release gate.

## Working with ChatGPT

Convenient conversational commands:

- `ticket this` → create/update the GitHub proposal and dispatch `/challenge`.
- `challenge #12` → dispatch/re-run the Disagreer on a proposal.
- `update #12 with ...` → edit the durable ticket.
- `reconcile #12` → incorporate useful Disagreer feedback into the proposal.
- `approve #12` → record approval and dispatch `/build`.
- `fix PR #34` → dispatch a trusted repair after reviewing findings.
- `review PR #34` → independently inspect the PR/diff/discussion before merge.
