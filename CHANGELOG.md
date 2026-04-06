# Changelog

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
