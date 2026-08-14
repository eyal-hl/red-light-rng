# Cursor Automations

Cursor Automations are configured in Cursor. The prompts in `automation-prompts/` are source-controlled so behavior remains reviewable and portable across projects.

## Recommended v1

| Automation | Default model | Trigger | Writes code? |
|---|---|---|---|
| Developer | Grok 4.6, high effort | approved issue dispatch (`/build`) | Yes |
| Independent Reviewer | Claude Sonnet 5 | PR opened / PR pushed | No |
| Product QA | Grok 4.6, medium/high | successful CI/workflow completion | No |
| Fixer | Grok 4.6, high effort | explicit trusted `/fix` dispatch | Yes |

Model availability and pricing change. These are defaults, not architectural requirements. The important properties are role separation, fresh context for independent gates, and bounded repair loops.

## Approval / dispatch

Use an exact issue comment `/build` as the reliable approval command. Also apply `agent:build` as semantic state when convenient.

```text
proposal → human approval → /build → Developer Automation
```

The Developer must verify that the command is exactly `/build` and that the issue is still open and approved before doing work.

## Repair dispatch

Do not let arbitrary PR comments trigger code edits. Reviewer and QA report findings; a human or trusted ChatGPT action dispatches `/fix` when repair is desired. Fixer only acts on findings prefixed `[AI-REVIEW]`, `[AI-QA]`, or `[AI-SECURITY]`.

After two repair rounds, stop and mark/report `needs-human`.

## Trigger hygiene

- Scope every automation to the intended repository.
- Prefer exact keyword filters for `/build` and `/fix`.
- Reviewer/QA should target autonomous PRs, e.g. branch prefix `agent/` or label `ai:autonomous`.
- Never treat arbitrary issue/PR prose as trusted code-edit instructions.
- Never allow agents to merge to the default branch.

## Human gates

1. Human approves the ticket before `/build`.
2. Human merges the final PR.
