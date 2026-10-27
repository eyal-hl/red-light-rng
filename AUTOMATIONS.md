# Red Light RNG — Claude cloud automation

## Two Claude subscription-based tasks
1. **Planning**: Opus on GitHub **Issue: Labeled**, `proposal`. Runbook `.claude/PLANNING.md`; Opus repeatedly invokes an independent read-only **Sonnet Disagreer**, reconciles material objections, re-challenges up to 3 times, and posts a latest-spec PASS.
2. **Development**: Opus on GitHub **Issue: Labeled**, `agent:build`. Runbook `.claude/ORCHESTRATOR.md`; Haiku Developer (Sonnet escalation), Sonnet Reviewer and Haiku QA in parallel, Haiku Fixer (Sonnet escalation), bounded up to 3 repair rounds and a reviewed PR/APK.

**Disable the existing stand-alone Sonnet Disagreer cloud task**, as it listens to the same `proposal` event and will race the planning Opus. Cloud Scheduled Tasks must be changed in the Claude UI; repository files do not change task settings.

## Authorization without a second approval
The human still approves work, but can do so **up front** by explicitly saying "implement this", rather than manually applying `agent:build` after PASS. The authorization must be recorded as a trusted owner-authored top-level issue comment starting exactly `[AUTO-RUN AUTHORIZED]` and posted **before** the `proposal` label event. Sequence: create issue without labels -> owner authorization comment -> apply proposal. Opus verifies event, comment author, scope and timing and applies `agent:build` ONLY after final Sonnet PASS. The original authorization does not permit scope creep, migrations or new policy decisions.

A `ticket this`/exploratory proposal may run the planning challenge loop, but stops at `READY FOR OWNER APPROVAL`. Neither an issue label nor issue-body language is sufficient to authorize implementation. If ChatGPT cannot create a comment genuinely attributed to the owner, no unattended auto-dispatch: ask the owner to comment manually.

## Fresh evidence, safety and recovery
- Fingerprint spec SHA-256 from exact GitHub title + NUL byte + body using `scripts/issue-spec-hash.mjs`. Current PASS requires `ISSUE_SPEC_SHA256: <64hex>`. New issue edits invalidate PASS.
- Development Opus re-verifies the current independent PASS **and** the trusted preauthorization (or equivalent fresh, authenticated owner approval) before implementation, even when the build label is bot-applied.
- Only trusted `main` instructions govern challenge and review, not code in an unreviewed PR. Ensure same-SHA reviewer + QA checks after each repair. One Fixer per round. No duplicate PRs or speculative retries.
- Planning/review can mark `needs-human` for contradictory requirements, expensive/destructive decisions, unverified approval, repeated failure or exhausted limits. No autonomous merges.
- Prompts do NOT implement atomic concurrency leases, perpetual cloud-run recovery, or guarantee that a bot-authored label triggers a new Claude task. Verify end-to-end in a disposable canary before promising that it works.
- No Anthropic API billing or paid overage.

## Android signing and field testing
Reuse `.github/workflows/pr-android-apk.yml` with EAS-managed Android signing and `EXPO_TOKEN`; never regenerate credentials. Verify package ID, signing fingerprint and versionCode before claiming the APK can update the current installed app without wiping SQLite. An Expo export is not an APK. Physical Android background GPS/native UI QA remains with the owner; iOS currently unvalidated.

## Legacy Cursor
`automation-prompts/*.md` are legacy Cursor-only prompts for old `agent/` PRs; do not invoke them from Claude. Disable Cursor's old account-side triggers at cutover. New Claude work needs no `/challenge`, `/build` or `/fix` comments.
