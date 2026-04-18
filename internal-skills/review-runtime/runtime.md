# Claude Code Review Runtime Reference

Use this document only when the main Codex thread or a built-in forwarding child is executing a Claude Code `review` or `adversarial-review` command.
This is an internal runtime reference, not a public skill. It captures the exact companion-command contract and the foreground/background execution boundary.
The public skill already resolved the installed plugin root. Reuse that installed copy path here. Do not derive a new runtime path from this document, any cache directory, or the current working tree.

Primary helper:
- `node "<installed-plugin-root>/scripts/claude-companion.mjs" review ...`
- `node "<installed-plugin-root>/scripts/claude-companion.mjs" adversarial-review ...`

Execution boundary:
- Foreground review stays on the main Codex thread. Do not satisfy foreground review through a review subagent, a generic review-runner role, or any background worker abstraction.
- Background review uses exactly one built-in forwarding child through `spawn_agent`.
- Never satisfy either mode with raw `claude`, `claude-code`, `claude review`, hand-rolled `bash -lc ...claude...`, or detached companion shell backgrounding.
- If the installed companion command fails, surface that failure instead of improvising a different executor.

Foreground contract:
- Strip `--wait` and `--background` before building the companion command.
- Foreground command:
  - `review --view-state on-success ...`
  - `adversarial-review --view-state on-success ...`
- Return companion stdout faithfully and do not add review execution commentary around it.

Background contract:
- Use `background-routing-context --kind review --json` before spawning the forwarding child.
- Preserve `--job-id` only when reserved by the parent helper.
- Preserve `--owner-session-id` only when the parent helper returned a non-empty owner session id.
- Preserve the parent notification path only when the helper returned a non-empty parent thread id.
- Never emit an empty routing placeholder such as `--owner-session-id  --job-id`.
- The built-in child runs exactly one shell command:
  - `review --view-state defer ...`
  - `adversarial-review --view-state defer ...`
- The child must be a pure forwarder:
  - return stdout only
  - ignore stderr progress chatter such as `[cc] ...`
  - do not inspect the repo or perform the review itself
  - use at most one `send_input` completion notification on success
  - mention the tool name `send_input` literally in the child instructions
  - use the exact tool shape `send_input({ target: <parent-thread-id>, message: <steering-message> })`
  - do not silently drop the completion notification path when the parent provided a non-empty parent thread id

Spawn-agent defaults:
- `agent_type: "default"`
- `fork_context: false`
- `model: "gpt-5.4-mini"`
- `reasoning_effort: "medium"`
- If that model is explicitly unavailable, retry once with `model: "gpt-5.4"` and the same effort.

Completion steering:
- When a reserved review job id exists, steer to:
  - `Background Claude Code review finished. Open it with $cc:result <reserved-job-id>.`
  - `Background Claude Code adversarial review finished. Open it with $cc:result <reserved-job-id>.`
- Otherwise steer to `$cc:status` first, then `$cc:result`.
- Use that same steering message as the child's own final assistant message for background mode.
- Never inline raw review text in the notification or in the child's final assistant message for background mode.
