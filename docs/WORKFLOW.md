# Agent Foundry workflow — Claude Code

```text
Explicit implement request -> issue without proposal label
    -> trusted owner [AUTO-RUN AUTHORIZED] comment
    -> proposal label
    -> Opus Planning task
        -> Sonnet Disagreer
        -> Opus reconciles objections -> re-challenge (up to 3 rounds)
        -> PASS for exact latest spec fingerprint
        -> automatically add agent:build (already preauthorized)
    -> Opus Development task
        -> Haiku/Sonnet Developer -> single PR
        -> Sonnet Reviewer + Haiku QA in parallel for same SHA
        -> Haiku/Sonnet Fixer as needed, max 3 rounds
    -> signed Android PR APK -> required device QA -> owner merge
```

The user's **original explicit implementation request** is the authorization for the bounded workflow. It must be recorded on GitHub as a genuine owner-authored `[AUTO-RUN AUTHORIZED]` comment **before** `proposal` is applied. If an owner attribution cannot be established, or the issue is "ticket only", the planner may challenge/reconcile but stops at `READY FOR OWNER APPROVAL`. Existing DEC-009 human approval and merge gates still apply; there is no unnecessary second approval for an upfront-authorized request.

Planning is described in `.claude/PLANNING.md`. Its independent Sonnet Disagreer rechecks the latest title/body, versioned using `scripts/issue-spec-hash.mjs`. It escalates genuine product choices and scope changes rather than silently approving them. Development is in `.claude/ORCHESTRATOR.md` and only starts after independent current-spec PASS and authenticated authorization.

Existing `.github/workflows/pr-android-apk.yml` uses frozen EAS signing credentials. Real-device Android QA remains human-owned when needed and iOS is unvalidated. No auto-merge. This design does not provide durable crash recovery or prove GitHub label events will chain cloud tasks: run a real canary before enabling broadly.

**Claude UI cutover:** replace the old *Sonnet Disagreer* cloud task (on `proposal`) with **Opus Planning** (same event/label, this runbook). Keep the existing **Opus Development** task on `agent:build`. Only one planning task should listen to each proposal event.

**ChatGPT**: `ticket this` -> proposal without authorization; `implement this` -> issue, verified authorization comment, then proposal label. `status` -> inspect GitHub, cloud runs and APK. `approve #N` -> owner manually authorizes a ticket-only issue.
