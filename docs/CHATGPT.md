# ChatGPT operating guide — Red Light RNG

GitHub issue/spec and approved `docs/product/*` documents are the source of truth, not chat history. On entry read `AGENTS.md`, `CLAUDE.md`, `AUTOMATIONS.md`, `docs/WORKFLOW.md`, and the relevant current GitHub issue/PR.

## Responsibilities
- ChatGPT and the human brainstorm, prioritize, write/reconcile durable proposals and make explicit product decisions.
- Independent Disagreer challenges proposed work. Only a current-spec PASS plus trusted human approval permits applying `agent:build`.
- Claude cloud Scheduled Task runs Opus orchestrator on the `Issue: Labeled` event. Opus delegates development (Haiku/Sonnet), independent Reviewer (Sonnet), QA (Haiku), and bounded fixes (Haiku/Sonnet).
- GitHub Actions builds Android preview APKs on PR changes. Android physical QA and final merge remain human gates. iOS physical validation is deferred.

## Common tasks
- `ticket this`: read applicable product docs, create/update complete GitHub issue with acceptance criteria and non-goals. Do not label `agent:build` yet.
- `challenge #N`: request Disagreer on open proposal; current legacy `/challenge` mechanism may remain during transition. Never silently turn all suggestions into requirements.
- `reconcile #N`: evaluate material Disagreer findings, update issue/spec, require a fresh PASS for materially updated specs.
- `approve #N`: verify current spec's independent PASS, no unresolved material blockers, trusted owner approval, no active duplicate implementation; apply `agent:build`. **Do not** post old `/build`. A label is the Claude routine event.
- `status`: inspect GitHub issue, PR, agent comments, exact SHA, reviewer/QA checks and APK workflow. Do not assert work continues in the background without a running cloud task.
- `fix PR #N`: inspect genuine defects and initiate an authorized Claude resume/new run when supported; do not use old Cursor `/fix` or rely on ChatGPT to poll continually.
- `review PR #N`: independently review diff, issue/spec, docs, automated evidence and remaining physical QA. Never merge unless owner explicitly asks and gates allow.

## Product invariants
Local-first, account-free, phone-in-pocket product. Preserve raw GPS and official timing/rank semantics. Android is field-validation target, but must not infer physical behavior from cloud builds or emulators. iOS stays behind replaceable native platform boundary, presently unvalidated. Do not add cloud data capture, leak precise location, overwrite SQLite history, or implement unrelated roadmap scope.

## Trusted role instructions
`.claude/agents/*.md` and `CLAUDE.md` from the approved/default branch are canonical for Claude. Don't use modified role instructions from an unmerged PR to judge itself. `automation-prompts/` remains legacy Cursor-only until open Cursor work is finished and Cursor UI automations are disabled.

## Labels and evidence
`proposal`: unapproved; `agent:build`: owner-authorized Claude dispatch; `ai:autonomous`: agent PR; `ai:ready`: automated gates passed for exact SHA; `needs-human`: clear blocker. Review defect prefixes `[AI-REVIEW]`, `[AI-QA]`, `[AI-SECURITY]`; `AWAITING HUMAN VALIDATION` is not an automatic code failure. APK signing parity and versionCode must be checked before claiming installation will preserve local data.
