# Changelog

## v1.0.6

- Restore parent-session ownership for built-in background rescue/review runs so resume candidates, plain `$cc:status`, and no-argument `$cc:result` stay aligned after nested child sessions run.
- Distinguish the owning Codex session from the actual Claude Code session in job rendering so `claude --resume ...` points at the real Claude session instead of the parent owner marker.
- Tighten the background review and adversarial-review forwarding contracts around `send_input` notification behavior and add E2E coverage for built-in notification steering in both flows.

## v1.0.5

- Keep built-in background review jobs attached to the parent Codex session so plain `$cc:status` and `$cc:result` stay intuitive after nested rescue/review flows.
- Make `$cc:status --all` show the full job history for the current repository workspace instead of staying session-scoped.
- Harden large-diff review and hook fingerprinting so oversized `git diff` output degrades cleanly instead of failing with `ENOBUFS`.
- Clarify README guidance around review visibility, large diffs, and the difference between session-scoped status and repository-wide status.

## v1.0.4

- Make background built-in rescue/review completions steer users to `$cc:result <job-id>` instead of inlining raw child output.
- Harden reserved job-id handling by requiring real reservations, sanitizing reserved-job paths, and releasing reservations across validation and job-creation failures.
- Add regression coverage for reserved job ids, background completion steering, large diff omission, and untracked directory/symlink review context handling.
- Refresh the README to be more install-first and user-friendly for Codex users trying Claude Code for the first time.

## v1.0.3

- Refresh the README opening copy and update the bundled visual assets for launch/readme presentation.
- Add a GitHub-friendly social preview asset under `assets/social-preview.{svg,png}`.
- Add a changelog release gate so `check`, `prepack`, CI, publish, and `npm version` all fail when the current package version is missing from `CHANGELOG.md`.

## v1.0.2

- Add fallback `cc-*` skill and prompt wrappers only when Codex's official `plugin/install` path is unavailable.
- Remove stale managed fallback wrappers after official install succeeds again and during uninstall/self-cleanup.
- Clarify that marketplace-style installs which bypass the installer should run `$cc:setup` once to install hooks.
- Stabilize the concurrent polling integration assertion used in release verification.

## v1.0.1

- Install and uninstall through Codex app-server when available, with safe fallback activation on unsupported builds.
- Remove the global `cc-rescue` agent and keep only managed Codex hooks outside the plugin directory.
- Switch rescue to the built-in forwarding subagent path and harden hook self-clean behavior.
- Auto-install missing hooks during `$cc:setup`.
- Clarify background unread-result nudges and the hooks-only global state model in the README.

## v1.0.0

- Initial public release of the Claude Code plugin for Codex.
- Includes tracked review, adversarial review, rescue, status, result, cancel, and setup flows.
- Includes Codex hook integration and plugin installer automation.
