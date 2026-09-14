# Ticket to Physical QA

Use this workflow whenever the owner says to **work on**, **start**, **take**, or otherwise actively progress a GitHub ticket.

## Goal

Drive the ticket autonomously until it is **ready for physical QA**.

Do **not** consider the task complete merely because a spec exists, a PR exists, tests pass, or an APK exists.

Do **not** merge automatically. Physical QA and the owner's explicit merge approval are separate gates.

## Workflow

### 1. Inspect and normalize the ticket

- Read the current issue body, comments, labels, related PRs, and relevant current `main` state.
- Improve/reconcile the ticket spec when necessary before implementation.
- Keep the ticket's requirements concrete enough for deterministic challenge/review/QA.

### 2. Challenge loop

- Trigger `/challenge`.
- Wait for the Disagreer result.
- If the Disagreer does not return `DISAGREER PASS`, reconcile every material finding into the issue/spec.
- Trigger `/challenge` again.
- Repeat until the **current reconciled spec receives `DISAGREER PASS`**.

Do not dispatch implementation before this gate passes unless the owner explicitly overrides the workflow for that ticket.

### 3. Build

After `DISAGREER PASS`:

- Dispatch `/build`.
- Ensure the implementation PR is **Ready for review**, not Draft.
- Track the PR created for the ticket.

### 4. Review / QA / fix loop

Continuously inspect the current PR HEAD, reviewer feedback, QA feedback, CI, and Android APK workflow.

If either Reviewer or QA reports a blocker/failure:

- preserve the failure as trusted evidence on the PR/issue when appropriate;
- dispatch `/fix` with the exact failure and acceptance requirements;
- wait for a new PR HEAD;
- ensure review and QA run again against that new HEAD;
- repeat as many times as required.

A PASS from an older commit does **not** count for a newer HEAD when the change could affect that evidence.

### 5. Ready-for-physical-QA gate

The workflow goal is reached only when all of the following are true for the current PR HEAD:

- the issue's latest reconciled spec has `DISAGREER PASS`;
- implementation exists in an open PR that is Ready for review;
- there are no unresolved blocking reviewer findings;
- the independent Reviewer reports PASS for the current relevant HEAD;
- Product QA reports PASS for the current relevant HEAD for everything executable in its environment;
- required lint/typecheck/tests/build checks are green;
- the Android PR APK workflow has succeeded for the current relevant HEAD/merge commit;
- a current signed APK artifact exists for physical-device testing;
- any required human/device-only checks are explicitly listed rather than falsely claimed as tested.

At that point, tell the owner the ticket is **READY FOR PHYSICAL QA**, provide the latest APK/workflow reference and a concise physical-QA checklist.

## Monitoring behavior

When the owner tells you to work on a ticket, start an ongoing condition monitor for that ticket in addition to taking the immediate next action.

The monitor should periodically inspect the issue/PR state and autonomously advance safe workflow steps:

- rerun/reconcile challenge until PASS;
- dispatch build after challenge PASS;
- dispatch fixes for Reviewer/QA blockers;
- verify new HEADs receive fresh Reviewer/QA/CI evidence;
- stop advancing once the ready-for-physical-QA gate is reached and notify the owner.

Do not spam the owner when nothing meaningful changed.

## Owner status requests

If the owner asks `status`, inspect live GitHub state and report the exact current gate, what is blocking it, and what action is already in progress. Do not rely on stale conversation memory for live status.

## Merge boundary

Never infer merge approval merely from reaching the physical-QA gate. Merge only after the owner explicitly approves it (for example, `works, merge this`).
