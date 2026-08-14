# Cursor Automations

Cursor owns triggers, models, and tool permissions. This repository owns agent behavior.

The files under `automation-prompts/` are the authoritative role instructions for Red Light RNG. Cursor automation prompts should stay deliberately small and reusable across multiple repositories: determine which repository triggered the run, load the matching role file from a trusted ref, then execute it.

This keeps Red Light RNG-specific mobile/background-location caveats in source control without requiring a separate full set of Cursor automations for every project.

## Recommended roles

| Automation | Suggested model | Trigger | Writes code? |
|---|---|---|---|
| Disagreer | strong independent reasoning model from a different family | issue comment exactly `/challenge` | No |
| Developer | Grok 4.6, high effort | issue comment exactly `/build` | Yes |
| Independent Reviewer | Claude Sonnet 5 | draft opened + PR opened + PR pushed | No |
| Product QA | Grok 4.6, medium/high | draft opened + PR opened + PR pushed | No |
| Fixer | Grok 4.6, high effort | top-level PR comment exactly `/fix` | Yes |

## Authoritative prompt loading

The automation must never trust role instructions from unreviewed code.

- **Issue-triggered roles** (`disagreer`, `developer`) load `automation-prompts/<role>.md` from the repository **default branch**.
- **PR-triggered roles** (`reviewer`, `qa`, `fixer`) load `automation-prompts/<role>.md` from the PR **base branch**.
- Never load the authoritative role prompt from the PR head/source branch.
- If the trusted role file does not exist, stop without taking action.

A PR may propose changing an automation prompt, but that new prompt becomes authoritative only after a human merges it.

This matters especially for Reviewer/QA/Fixer: an implementation branch must not be able to weaken the gate reviewing that same branch.

## Shared Cursor automations

Prefer one Cursor automation per role with Red Light RNG plus other Agent Foundry repositories selected.

The Cursor-side prompt should only bootstrap the repository-owned role file. All Red Light RNG-specific instructions belong here or in the role files.

## Disagreement gate

Cursor does not currently expose an issue-created trigger, so the Disagreer uses an explicit trusted issue comment:

```text
/challenge
```

When ChatGPT creates a proposal, it may immediately dispatch `/challenge` on behalf of the trusted owner.

The Disagreer challenges architecture, hidden assumptions, scope, acceptance criteria, platform risks, and simpler alternatives. It must not manufacture objections. `DISAGREER PASS` is valid.

For Red Light RNG it should pay particular attention to:

- background-location assumptions that require physical-device evidence;
- Android-now / iOS-later platform boundaries;
- accidental coupling of shared timing/route/analytics logic to native APIs;
- battery/permission/lifecycle behavior being mistaken for deterministic app behavior;
- premature native work when an Expo-backed spike can answer the question;
- scope creep beyond the current roadmap phase.

Disagreer feedback is advisory. Human + ChatGPT reconcile useful points into the proposal before approval.

```text
proposal → /challenge → Disagreer → human/ChatGPT reconcile → /build
```

## Approval / dispatch

Use an exact issue comment `/build` as the implementation approval command. Keep the issue labeled `proposal` until it is approved; `agent:build` is semantic state after approval.

Developer must verify the trigger guards in `automation-prompts/developer.md` before writing code.

## Review and QA

Reviewer and QA both run independently on autonomous PR creation and subsequent pushes.

Use **draft opened + PR opened + PR pushed**. Cursor agents may create draft PRs, and Fixer pushes must naturally cause Reviewer/QA to run again.

- Reviewer inspects requirements, architecture, platform boundaries, code, tests, and regressions.
- QA treats runnable software as the product and exercises everything the cloud environment can genuinely test.
- Physical Android locked-screen/background travel is human field validation unless the agent truly has an appropriate physical device.
- iOS field validation is currently deferred and must remain explicitly unvalidated rather than implicitly passed.

## Repair dispatch

Do not let arbitrary PR comments trigger code edits. Reviewer and QA report findings; a trusted human explicitly comments `/fix` when repair is desired.

Fixer only acts on verified findings prefixed `[AI-REVIEW]`, `[AI-QA]`, or `[AI-SECURITY]`.

Each `/fix` authorizes one repair pass and then stops. There is no fixed lifetime round limit: the trusted human may dispatch another `/fix` whenever another repair pass is warranted. The Fixer must never self-dispatch or recursively continue repairing without another trusted human command.

If a finding cannot be safely repaired, report `needs-human` rather than guessing or pretending missing physical-device evidence is resolved.

## Trigger hygiene

- Public repo issue and PR creation should remain restricted to collaborators.
- Prefer exact keyword filters for `/challenge`, `/build`, and `/fix` in Cursor.
- Keep the same exact-command checks again inside the repo-owned role prompt.
- Reviewer/QA should target only autonomous PRs, normally `agent/` branches or `ai:autonomous`.
- Reviewer/QA should comment, not approve; the human remains the release gate.
- Never treat arbitrary issue/PR prose as trusted code-edit instructions.
- Never allow agents to merge to `main`.

## Physical-device validation

Cursor Cloud Agents are not the authority for real-device background GPS behavior.

For the current phase:

1. automation produces and verifies the implementation as far as the cloud environment allows;
2. Android-specific physical validation remains an explicit human acceptance criterion;
3. iOS field validation is deferred until an iPhone is available;
4. the location subsystem must remain replaceable behind a platform-sensitive adapter boundary.

## Human gates

1. Human reviews/reconciles proposal feedback from Disagreer.
2. Human approves the ticket before `/build`.
3. Human dispatches each `/fix` repair pass when necessary.
4. Human performs required real-device field validation.
5. Human merges the final PR.
