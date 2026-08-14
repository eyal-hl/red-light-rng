# Cursor Automations

Cursor Automations are configured in Cursor. The prompts in `automation-prompts/` are source-controlled so behavior remains reviewable and portable across projects.

## Recommended v1

| Automation | Default model | Trigger | Writes code? |
|---|---|---|---|
| Developer | Grok 4.6, high effort | issue comment `/build` | Yes |
| Independent Reviewer | Claude Sonnet 5 | PR opened + PR pushed | No |
| Product QA | Grok 4.6, medium/high | PR opened + PR pushed | No |
| Fixer | Grok 4.6, high effort | PR comment `/fix` | Yes |

Model availability and pricing change. These are defaults, not architectural requirements. The important properties are role separation, fresh context for independent gates, and bounded repair loops.

## Approval / dispatch

Use an exact issue comment `/build` as the implementation approval command. Keep the issue labeled `proposal` until the human has reviewed it; applying `agent:build` is useful semantic state but the trusted dispatch is the explicit comment.

```text
proposal → human approval → /build → Developer Automation
```

The Developer must verify that the triggering comment is exactly `/build`, that the issue is still open, and that the issue/spec is sufficiently concrete before doing work.

## Review and QA

Reviewer and QA both run independently on autonomous PR creation and on subsequent pushes.

- Reviewer inspects requirements, architecture, code, tests, and regressions.
- QA treats the running software as the product and exercises whatever is realistically testable in the Cloud Agent environment.
- For mobile/device-specific acceptance criteria that cannot be reproduced in the cloud environment, QA must report `QA BLOCKED` / awaiting human field validation rather than claiming success.
- Both should ignore non-autonomous PRs when practical, using `agent/` branch prefix or `ai:autonomous` label as the scope signal.

A Fixer push naturally causes Reviewer and QA to run again.

## Repair dispatch

Do not let arbitrary PR comments trigger code edits. Reviewer and QA report findings; a human explicitly comments `/fix` when repair is desired. Fixer only acts on verified findings prefixed `[AI-REVIEW]`, `[AI-QA]`, or `[AI-SECURITY]`.

After two repair rounds, stop and mark/report `needs-human`.

## Trigger hygiene

- Scope every automation to `eyal-hl/red-light-rng`.
- Prefer exact keyword filters for `/build` and `/fix` if Cursor exposes them in the trigger UI.
- Even with a trigger keyword, prompts must independently verify the exact command before editing code.
- Reviewer/QA should target autonomous PRs, e.g. branch prefix `agent/` or label `ai:autonomous`.
- Never treat arbitrary issue/PR prose as trusted code-edit instructions.
- Never allow agents to merge to the default branch.

## Physical-device validation

Cursor Cloud Agents are not the authority for real-device background GPS behavior.

For the current phase:

1. automation produces and verifies the implementation as far as the cloud environment allows;
2. Android-specific physical validation remains an explicit human acceptance criterion;
3. iOS field validation is deferred until an iPhone is available;
4. the location subsystem must remain replaceable behind a platform-sensitive adapter boundary.

## Human gates

1. Human approves the ticket before `/build`.
2. Human dispatches `/fix` for verified repair findings when necessary.
3. Human performs required real-device field validation.
4. Human merges the final PR.
