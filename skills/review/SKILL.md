---
name: review
description: 'Run a standard Claude Code review of local git changes in this repository. Args: --wait, --background, --base <ref>, --scope <auto|working-tree|branch>, --model <model>. Use for normal diff review requests, not staged-only review or custom focus text.'
---

# Claude Code Review

Use this skill when the user wants Claude Code to review the current working tree or a branch diff in this repository.

Resolve `<plugin-root>` as two directories above this skill file. The companion entrypoint is:
`node "<plugin-root>/scripts/claude-companion.mjs" review ...`

Supported arguments: `--wait`, `--background`, `--base <ref>`, `--scope auto|working-tree|branch`, `--model <model>`

Raw slash-command arguments:
`$ARGUMENTS`

Rules:
- This skill is review-only. Do not fix issues, apply patches, or suggest that you are about to make changes.
- Before launching the review, stay in read-only inspection mode: inspect git status and diff stats only, then ask at most one user question about whether to wait or run in background.
- Preserve the user's review scope flags exactly.
- Do not accept staged-only or unstaged-only review modes.
- Do not add extra review instructions or focus text. Route those requests to `$cc:adversarial-review`.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in background through the built-in review subagent path.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Treat `--wait` and `--background` as Codex-side execution controls only. Strip them before calling the companion command.
- `$cc:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `$cc:adversarial-review`.
- The companion review process itself always runs in the foreground. Background mode only changes how Codex launches that command.

Foreground flow:
- Run:
  `node "<plugin-root>/scripts/claude-companion.mjs" review --view-state on-success <arguments with --wait/--background removed>`
- Present the companion stdout faithfully.
- Do not fix anything mentioned in the review output.

Background flow:
- For background review, use Codex's built-in `default` subagent instead of a detached background shell command.
- Before spawning the built-in child, reserve a review job id by running:
  `node "<plugin-root>/scripts/claude-companion.mjs" review-reserve-job --json`
- If that helper returns a non-empty `jobId`, pass it into the companion command as an internal `--job-id <reserved-job-id>` routing flag.
- Add an internal `--owner-session-id <parent-session-id>` routing flag when spawning the built-in child so the tracked review job stays visible in the parent Codex session's plain `$cc:status`.
- If the built-in review is running in background, the parent should first capture its own thread id by running:
  `node -e "process.stdout.write(process.env.CODEX_THREAD_ID || '')"`
- If that command returns a non-empty thread id, pass it into the child prompt as the parent thread id for one-shot completion notification.
- Spawn exactly one transient forwarding child through `spawn_agent` with:
  - `agent_type: "default"`
  - `fork_context: false`
  - `model: "gpt-5.4-mini"`
  - `reasoning_effort: "medium"`
- Prefer a self-contained child message over inheriting parent history. The built-in review child should not rely on full parent thread replay for normal operation.
- Only consider `fork_context: true` as a last resort for a short follow-up where essential context truly cannot be summarized. Avoid it for large or long-lived threads because it can exhaust the child context window.
- Before spawning the built-in child, emit one short commentary update that records the attempted subagent model selection. Default text should clearly say the parent is starting the built-in review child with `gpt-5.4-mini` at `medium` effort.
- If `spawn_agent` rejects `gpt-5.4-mini` with an explicit model-unavailable error such as `Unknown model`, `model unavailable`, or equivalent "not in list / unavailable" wording, retry once with `model: "gpt-5.4"` and the same `reasoning_effort: "medium"`.
- If that fallback happens, emit one short commentary update that clearly says `gpt-5.4-mini` was unavailable and the parent is retrying with `gpt-5.4`.
- Do not use that fallback for arbitrary failures.
- The built-in child must be a pure forwarder. It should:
  - run exactly one shell command
  - execute:
    `node "<plugin-root>/scripts/claude-companion.mjs" review --view-state defer <arguments with --wait/--background removed>`
  - include `--owner-session-id <parent-session-id>` so background review jobs stay attached to the parent session
  - include `--job-id <reserved-job-id>` when the parent reserved one
  - return only that command's stdout exactly, with no added commentary
  - ignore stderr progress chatter such as `[cc] ...` lines and preserve only the final stdout-equivalent result text
  - not inspect the repo or perform the review itself
  - if a parent thread id is available, allow one extra `send_input` call after a successful shell result and before finishing
  - that `send_input` call must target the provided parent thread id, must happen at most once, and must not run on failure paths
  - if the parent provided a non-empty parent thread id, do not silently drop the completion notification path from the child prompt
  - if a reserved review job id is available, use this exact notification message:
    `Background Claude Code review finished. Open it with $cc:result <reserved-job-id>.`
  - otherwise fall back to:
    `Background Claude Code review finished. Inspect it with $cc:status first, then use $cc:result for the finished job you want to open.`
  - that `send_input` message should use one of those exact steering messages instead of inlining the raw review result
  - use these steering messages instead of embedding the raw review result in the notification
  - do not embed the raw Claude result inside the notification message
  - do not include any other prose in that notification message
  - use that same steering message as the child's own final assistant message instead of echoing the raw review result
- Do not wait for completion in this turn.
- After launching, tell the user: `Claude Code review started in the background. Check the subagent session or $cc:status for progress, and once it's done, we will let you know to see the results.`
- Do not fix anything mentioned in the review output.
