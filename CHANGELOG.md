# Changelog

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
