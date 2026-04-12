---
name: cancel
description: 'Cancel an active tracked Claude Code job in this repository. Args: [job-id]. Use only when the user wants to stop a queued or running Claude Code job.'
---

# Claude Code Cancel

Use this skill when the user wants to stop an active Claude Code job in this repository.

Do not derive the companion path from this skill file or any cache directory. Always run the installed copy:
`node "<installed-plugin-root>/scripts/claude-companion.mjs" cancel $ARGUMENTS`

Supported arguments: `[job-id]`

Output:
- Present the companion stdout exactly as returned.
- Do not add extra prose unless the command itself failed before producing output.
