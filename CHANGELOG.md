# Changelog

## v1.1.0

- Restructure the internal Claude runtime and prompt-shaping guidance from pseudo-hidden `SKILL.md` files into plain internal reference documents, while keeping the public `review`, `adversarial-review`, and `rescue` skills self-sufficient on their critical invocation rules.
- Add a shared internal runtime reference for review/adversarial-review and strengthen the contract tests so installed-root routing, exact `send_input` notification shape, and empty routing-placeholder guards stay locked in across future cleanup passes.
- Remove workstation-specific absolute internal-doc link targets from the public skill docs so source trees, installed copies, and marketplace snapshots all keep valid internal references.

## v1.0.9

- Add marketplace-aware install foundation for Codex 0.121+: the installer can now prefer `marketplace/add` + `plugin/install` when an official marketplace source is available, while keeping the existing legacy fallback path for unsupported builds.
- Generalize managed plugin identity handling so setup, hook cleanup, and cache detection work for `cc@<marketplace>` installs instead of assuming `cc@local-plugins`.
- Document the new canonical marketplace location at `sendbird/codex-marketplace` and make Sendbird marketplace install the first documented path, with `$cc:setup` called out as the required post-install hook repair step.

## v1.0.8

- Clarify the routing boundary between `$cc:review`, `$cc:adversarial-review`, and `$cc:rescue`, including the rule that ordinary code-review requests default to `review`, stronger scrutiny plus custom focus text belongs to `adversarial-review`, and rescue is only for Claude-owned follow-through work.
- Add E2E coverage that injects both review skills together and verifies the focus-text distinction is surfaced to the parent turn while the adversarial focus path still reaches Claude end to end.
- Refresh the macOS integration concurrency test so aggressive concurrent polling no longer flakes when some jobs finish slightly later than the initial polling window.
- Update development dependencies with the merged Dependabot patch bumps for `@types/node` and `globals`.

## v1.0.7

- Add GitHub CI coverage across Windows, macOS, and Linux, with a portable cross-platform test suite plus Linux-only full integration/E2E coverage.
- Harden background routing by validating `parentThreadId`, combining reserved-job and session-routing metadata into one helper, and making background review/rescue explicitly use built-in forwarding subagents rather than direct detached companion processes.
- Stop exposing managed job log paths through user/model-facing status and result surfaces while keeping on-disk logs for debugging.
- Make installed skill-path materialization consistent for both staged installs and direct local-checkout installs, and centralize installer path helpers for reuse.
- Switch sandbox temp-dir settings from a hardcoded `/tmp` path to the OS temp directory so the runtime configuration stays valid off Linux.

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
