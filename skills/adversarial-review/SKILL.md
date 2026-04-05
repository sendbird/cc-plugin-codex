---
name: adversarial-review
description: 'Run a design-challenging Claude Code review of local git changes in this repository. Args: --wait, --background, --base <ref>, --scope <auto|working-tree|branch>, --model <model>, [focus text]. Use when the user wants stronger scrutiny, tradeoff analysis, or custom review focus text.'
---

# Claude Code Adversarial Review

Use this skill when the user wants Claude Code to challenge the implementation approach, design choices, assumptions, or tradeoffs in this repository.

Resolve `<plugin-root>` as two directories above this skill file. The companion entrypoint is:
`node "<plugin-root>/scripts/claude-companion.mjs" adversarial-review ...`

Supported arguments: `--wait`, `--background`, `--base <ref>`, `--scope auto|working-tree|branch`, `--model <model>`, plus optional focus text after the flags

Raw slash-command arguments:
`$ARGUMENTS`

Rules:
- This skill is review-only. Do not fix issues, apply patches, or suggest that you are about to make changes.
- Before launching the review, stay in read-only inspection mode: inspect git status and diff stats only, then ask at most one user question about whether to wait or run in background.
- Preserve the user's scope flags and custom focus text exactly.
- Use the same review target selection as `$cc:review`.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Codex background command.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Treat `--wait` and `--background` as Codex-side execution controls only. Strip them before calling the companion command.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- `$cc:adversarial-review` uses the same review target selection as `$cc:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `$cc:review`, it can still take extra focus text after the flags.
- The companion review process itself always runs in the foreground. Background mode only changes how Codex launches that command.

Foreground flow:
- Run:
  `node "<plugin-root>/scripts/claude-companion.mjs" adversarial-review --view-state on-success <arguments with --wait/--background removed>`
- Present the companion stdout faithfully.
- Do not fix anything mentioned in the review output.

Background flow:
- Launch the same companion adversarial-review command in a Codex background command or session, but use `--view-state defer` on the companion command. Do not append `--background` to the companion command.
- Do not wait for completion in this turn.
- After launching, tell the user: `Claude Code adversarial review started in the background. Check $cc:status for progress.`
- Do not fix anything mentioned in the review output.
