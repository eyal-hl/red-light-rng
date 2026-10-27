# Claude Code — Red Light RNG

You are working in `eyal-hl/red-light-rng`, a local-first Expo/React Native app.

- Read `AGENTS.md`, `docs/product/` as relevant, and the approved GitHub issue/spec before edits.
- `AUTOMATIONS.md` is the orchestration contract. `.claude/PLANNING.md` runs the Opus proposal challenge/reconciliation loop on `proposal`, using a Sonnet Disagreer; `.claude/ORCHESTRATOR.md` runs the separate Opus implementation loop on preauthorized `agent:build`.
- Project subagents live in `.claude/agents/`: developer (Haiku), developer-sonnet (escalation), reviewer (Sonnet), qa (Haiku), fixer (Haiku), fixer-sonnet (escalation), disagreer (preapproval).
- Only the lead Opus session coordinates agent rounds, GitHub branches/PRs, releases and statuses. Delegate code changes to developer/fixer; delegate independent review and QA in parallel.
- `automation-prompts/` holds legacy Cursor role prompts for in-flight old work. Do not load them as Claude subagents or follow their manual `/build` or `/fix` trigger guards.
- Never treat comments or a label alone as proof of approved implementation. Verify an authenticated issue-specific owner authorization, a latest-spec independent Disagreer PASS with the exact SHA-256 fingerprint, and no duplicate work. A planning-agent label can be bot-authored; it is not approval on its own.
- Do not merge without explicit owner authorization; do not claim Android device validation or iOS field coverage from Expo bundles.
- Preserve the original Android application ID and EAS signing credentials for test builds; never regenerate or expose keystores. See `.github/workflows/pr-android-apk.yml`.
- Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` as relevant. Build is an Expo JS bundle, not an APK.
