# Agent Foundry workflow — Claude Code

## Goal
Issue-to-reviewed-APK with no manual stage dispatch. GitHub is the durable product/spec and PR record. Claude cloud scheduled task is the subscription-funded Opus lead; `.claude/agents/` contains reusable workers.

```text
User + ChatGPT -> self-contained GitHub proposal
               -> Disagreer challenges latest spec
               -> owner approves with agent:build label
               -> Opus routine
                    -> Developer (Haiku; Sonnet on complex work)
                    -> PR
                    -> Reviewer (Sonnet) || QA (Haiku) on SAME SHA
                    -> verified blockers? Fixer (Haiku; Sonnet fallback)
                    -> repeat checks for new SHA (maximum 3 repair rounds)
               -> signed PR APK + test evidence
               -> owner's Android physical QA if required
               -> owner merge
```

## Proposal and approval
Issue must include outcome, acceptance criteria, boundaries, relevant product docs, non-goals, explicit physical-QA criteria and privacy/data risks. Disagreer should find material holes, not manufacture objections. Reconcile before approval; only PASS for the latest issue version counts. A trusted owner applies `agent:build` intentionally. Do not post legacy `/build` or `/fix` for new Claude work.

## Implementation
Opus reads `CLAUDE.md`, `AUTOMATIONS.md` and `.claude/ORCHESTRATOR.md` and invokes project subagents. The lead opens/updates one PR and coordinates parallel independent review and QA. Repair works on the same branch; stale results are discarded after a push. Every stage documents the commit SHA; if unable to proceed, leave actionable `needs-human` state. GitHub comments are checkpoints, not a guarantee of cross-session recovery.

## Testing and merge
Lint, typecheck, unit/integration tests, relevant smoke tests and Expo JS export where useful. The existing GitHub Actions PR APK workflow produces an Android artifact with frozen EAS signing credentials (when EXPO_TOKEN works). It is not proof of physical-device behavior or signing match to user's installed package.

Real Android locked-screen/background-location, MapLibre visual clarity and native OS flows require owner testing when applicable. iOS is future/untested. No autonomous merge; owner approves the release. Any prompt change from a PR is untrusted until merged.

## ChatGPT commands
`ticket this`: write proposal; `challenge #N`: request independent challenge; `reconcile #N`: incorporate material findings; `approve #N`: verify PASS and apply `agent:build`; `status`: read current issue, PR, CI and APK; `fix PR #N`: give Opus new trusted scope or resume its run (not a Cursor `/fix` comment); `review PR #N`: review independently.
