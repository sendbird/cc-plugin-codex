---
name: cli-runtime
description: Internal execution contract for forwarding one tracked Claude Code rescue task through claude-companion.mjs.
user-invocable: false
---

# Claude Code Runtime

Use this skill only inside the rescue forwarding worker spawned by `$cc:rescue`.
This skill owns execution and routing. It does not own prompt rewriting beyond deciding when to call `task-prompt-shaping`.

Primary helper:
- `node "<plugin-root>/scripts/claude-companion.mjs" task ...`

Execution rules:
- The rescue subagent is a forwarder, not an operator. Launch exactly one `task` command and return that stdout unchanged.
- Prefer the helper over hand-rolled Bash, direct Claude Code CLI strings, or any other orchestration path.
- Never call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from the rescue forwarder.
- You may call `task-prompt-shaping` to rewrite the user's request into a tighter Claude Code prompt before the single `task` call.
- That prompt shaping is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis.

Command selection:
- Treat `--background` and `--wait` as execution controls.
- `--background` and `--wait` are parent-side execution controls only. They describe whether the main Codex thread waits for this subagent.
- Strip both before building the `task` command.
- Never call `task --background` or invent `task --wait`.
- The companion task command always runs in the foreground.
- The caller's background or foreground choice changes only subagent execution. It does not change the companion command you build.

Routing controls:
- Treat `--model`, `--effort`, `--resume`, `--resume-last`, `--fresh`, `--prompt-file`, `--view-state`, and `--owner-session-id` as routing controls, not task text.
- Treat `--quiet-progress` as an internal routing control, not task text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- `--view-state on-success` means the user will see this companion result in the current turn, so the companion may mark it viewed on success.
- `--view-state defer` means the parent is not waiting, so the companion must leave the result unread until the user explicitly checks it.
- `--owner-session-id <session-id>` is an internal parent-session routing control. Preserve it when present so tracked jobs remain visible to the parent session's `$cc:status` / `$cc:result`.
- `--quiet-progress` suppresses companion stderr progress output so the rescue forwarder can return only the final stdout in foreground mode. Preserve it when present.
- If the free-text task begins with `/`, treat that slash command as literal Claude Code task text to forward unchanged. Do not execute it as a local Codex slash command or answer it inline.
- If the forwarded request includes `--resume` or `--resume-last`, continue the latest tracked Claude Code task.
- If the forwarded request includes `--fresh`, start a new task.
- If none of `--resume`, `--resume-last`, or `--fresh` is present, do not explore resumable sessions yourself. The parent rescue skill already owns that choice.
- If none of those routing flags is present and the user's wording is clearly a follow-up, prefer resuming earlier Claude Code work. Otherwise start fresh.
- Never call `task-resume-candidate` from the rescue forwarder.

Task defaults:
- Default to `--write` unless the user explicitly wants read-only behavior or only review, diagnosis, or research without edits.
- Preserve the user's task text apart from stripping routing flags.
- Return the stdout of the `task` command exactly as-is.
- Do not poll status, fetch results, cancel jobs, or add commentary after the companion output.
- If the companion reports missing setup or authentication, tell the user to run `$cc:setup`.
