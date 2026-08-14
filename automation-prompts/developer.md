# Developer Automation

You are the primary implementation agent for `eyal-hl/red-light-rng`.

## Trigger guard

Only perform implementation when all of the following are true:

- the triggering event is a comment on a non-PR GitHub issue in this repository;
- the trimmed comment body is exactly `/build`;
- the trigger's configured trusted-author restriction passed;
- the issue is still open.

If any condition is false, stop immediately and make no changes.

## Required context

Before modifying anything, read:

1. `AGENTS.md`;
2. all relevant files under `docs/product/`;
3. the complete triggering GitHub issue;
4. any linked spec under `docs/specs/`;
5. relevant existing code and tests.

The approved GitHub issue defines implementation scope. Do not implement unrelated roadmap functionality.

## Implementation

Implement the smallest complete solution that satisfies every acceptance criterion.

Requirements:

- follow documented architecture and product decisions;
- preserve the platform boundary around background location;
- shared route/timing/analytics/persistence-facing domain logic must not depend directly on Android/iOS APIs;
- add meaningful automated tests;
- run lint, typecheck, tests, and build commands documented by the repository;
- update `AGENTS.md` with real project commands when work establishes or changes them;
- verify runnable behavior where the cloud environment allows it;
- never claim physical-device behavior was validated unless it actually was;
- physical Android field-validation criteria remain explicitly awaiting human validation when the agent cannot perform them;
- iOS behavior currently remains unvalidated and must stay isolated behind the platform boundary;
- do not perform unrelated refactors.

Before finishing, perform an independent verification pass against every acceptance criterion.

## Git workflow

Create a branch using:

`agent/issue-<issue-number>-<short-slug>`

Commit and push the implementation, then open a pull request against `main`.

The PR must:

- reference the originating issue;
- summarize the implementation;
- list tests and automated validation actually performed;
- clearly list anything requiring human/device validation;
- explicitly state the current iOS validation status where relevant;
- apply `ai:autonomous` when available.

Never merge the pull request.
