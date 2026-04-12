---
name: result
description: 'Show the stored final output for a finished Claude Code job in this repository. Args: [job-id]. Use when the user already has, or needs, a tracked job id.'
---

# Claude Code Result

Use this skill when the user wants the stored final output for a finished Claude Code job.

Do not derive the companion path from this skill file or any cache directory. Always run the installed copy:
`node "<installed-plugin-root>/scripts/claude-companion.mjs" result $ARGUMENTS`

Supported arguments: `[job-id]`

Output:
- Present the full companion stdout exactly as returned.
- Do not summarize or condense it.
