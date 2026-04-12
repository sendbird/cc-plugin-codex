---
name: status
description: 'Show active or recent Claude Code jobs in this repository, or detailed status for a specific job id. Args: [job-id], --wait, --timeout-ms <ms>, --poll-interval-ms <ms>, --all. Use for tracked-job inspection, not setup or result retrieval.'
---

# Claude Code Status

Use this skill when the user wants the current state of Claude Code jobs in this repository.

Do not derive the companion path from this skill file or any cache directory. Always run the installed copy:
`node "<installed-plugin-root>/scripts/claude-companion.mjs" status $ARGUMENTS`

Supported arguments: `[job-id]`, `--wait`, `--timeout-ms <ms>`, `--poll-interval-ms <ms>`, `--all`

Output:
- Present the companion stdout exactly as returned.
- Do not add extra prose or reformat it.
- By default, status overview is scoped to the current Codex session in this repository. `--all` widens that overview to all tracked jobs in the current repository workspace.
