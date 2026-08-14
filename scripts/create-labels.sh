#!/usr/bin/env bash
set -euo pipefail

# Requires GitHub CLI (`gh`) authenticated for the target repository.

gh label create "proposal" --description "Product work not yet approved for implementation" --color "D4C5F9" --force
gh label create "agent:build" --description "Human-approved for autonomous implementation" --color "0E8A16" --force
gh label create "ai:autonomous" --description "PR belongs to the autonomous engineering workflow" --color "1D76DB" --force
gh label create "ai:ready" --description "Automated gates passed; ready for human merge decision" --color "2CBE4E" --force
gh label create "needs-human" --description "Automation stopped and requires human judgment" --color "D93F0B" --force
gh label create "security-review" --description "Request an additional security-focused review" --color "B60205" --force
