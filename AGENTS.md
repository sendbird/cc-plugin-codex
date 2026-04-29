# AGENTS.md

This file is the source of truth for coding-agent instructions in this repository.

## General Agent Guidance

- Follow existing repository instructions first.
- Preserve existing `AGENTS.md`, `CLAUDE.md`, README, CI, release, and owner guidance.
- Do not overwrite repository-specific conventions with generic defaults.

## Safety Rules

- Do not make destructive or irreversible changes without explicit approval.
- Do not bypass branch protection, required checks, required reviewers, scanners, or tests.
- Do not force-push to protected branches or someone else's branch.
- Do not commit secrets, tokens, credentials, customer data, or private keys.
- Do not weaken authentication, authorization, IAM/RBAC, TLS, crypto, network exposure, or data-access controls without explicit approval.
- Do not disable TLS verification except in clearly dev-only code with a written rationale.
- Do not log secrets, auth headers, cookies, payment data, or customer PII.
- Use synthetic test data; do not add real customer data to tests, fixtures, or seed files.

## Review And Escalation

Stop and ask before changing:

- production data, infra, deploy, or config
- secrets, auth, IAM, network exposure, or crypto
- public APIs or compatibility-sensitive behavior
- dependency/security scanner configuration
- anything destructive or hard to roll back

<!-- Add repository-specific coding-agent instructions below this line. -->