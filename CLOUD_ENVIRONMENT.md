# Cursor Cloud Agent Environment

Each project created from Agent Foundry should have a reproducible Cloud Agent environment before autonomous implementation is trusted.

## Required capabilities

The environment should allow an agent to:

1. clone/open the repository;
2. install dependencies;
3. run lint/typecheck/tests/build;
4. start the application and required local services;
5. exercise user-facing behavior when applicable;
6. access only non-production secrets needed for testing.

## Setup checklist

- [ ] Fill all `TODO_*` commands in `AGENTS.md`.
- [ ] Verify the install command from a clean environment.
- [ ] Verify lint/typecheck/test/build independently.
- [ ] Verify the app can start without manual intervention.
- [ ] Document required ports and local URLs.
- [ ] Provide deterministic test data/accounts when needed.
- [ ] Keep production credentials out of the environment.
- [ ] Commit a verified `.cursor/environment.json` when appropriate for the project.

The first project ticket should be a small reversible dry run that proves the environment and automations end to end.
