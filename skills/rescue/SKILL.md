---
name: rescue
description: 'Delegate a substantial diagnosis, implementation, or follow-up task to Claude Code through the tracked-job runtime. Args: --background, --wait, --resume, --resume-last, --fresh, --write, --model <model>, --effort <low|medium|high|max>, --prompt-file <path>, [task text]. Use for deeper work, not for standard review or quick local questions.'
---

# Claude Code Rescue

Always hand this skill off through the globally registered `cc-rescue` subagent.
Do not answer the request inline in the main Codex thread.
Spawn exactly one `cc-rescue` subagent whose only job is to run one companion `task` command and return that stdout unchanged.
Foreground rescue responses must be that subagent's output verbatim.

Use this skill when the user wants Claude Code to investigate, implement, or continue substantial work in this repository.
The global `cc-rescue` agent is installed by `node "<plugin-root>/scripts/install-hooks.mjs"` and registered in `~/.codex/config.toml`.

Resolve `<plugin-root>` as two directories above this skill file. The companion entrypoint is:
`node "<plugin-root>/scripts/claude-companion.mjs" task ...`

Raw slash-command arguments:
`$ARGUMENTS`

Supported arguments: `--background`, `--wait`, `--resume`, `--resume-last`, `--fresh`, `--write`, `--model <model>`, `--effort <low|medium|high|max>`, `--prompt-file <path>`, plus free-text task text

Main-thread routing rules:
- If the user explicitly invoked `$cc:rescue` or `Claude Code Rescue`, do not keep the work in the main Codex thread. Delegate it.
- If the user did not supply a task, ask what Claude Code should investigate or fix.
- Treat `--background` and `--wait` as execution controls, not task text.
- `--background` and `--wait` are Codex-side execution controls only. Never forward either flag to `claude-companion.mjs task`.
- The main Codex thread owns that execution-mode choice. It decides whether to wait for the subagent. The child subagent must never reinterpret those flags as companion flags.
- Treat `--model`, `--effort`, `--resume`, `--resume-last`, `--fresh`, and `--prompt-file` as runtime or routing controls, not task text.
- If the user task text itself begins with a slash command such as `/simplify`, `/fix`, or `/review`, treat that slash command as literal Claude Code task text to be forwarded unchanged. Do not execute or reinterpret it in the parent Codex thread.
- `--model` selects the Claude model for the companion `task` command only. It does not select the Codex subagent model.
- If the user explicitly passed `--background`, run the `cc-rescue` subagent in the background.
- If the user explicitly passed `--wait`, run in the foreground.
- If neither flag is present and the rescue request is small, clearly bounded, or likely to finish quickly, prefer foreground.
- If neither flag is present and the request looks complicated, open-ended, multi-step, or likely to keep Claude Code running for a while, prefer background execution for the subagent.
- This size-and-scope heuristic belongs to the main Codex thread. The child subagent does not get to override it.
- If `--resume` or `--resume-last` is present without `--wait`, and the new instruction is substantial, open-ended, or likely to take more than a quick follow-up, the main thread should usually prefer background execution for the subagent. Keep that as a parent-side choice only. Do not inject `--background` into the child request or the companion command.
- Default to `--write` unless the user explicitly wants read-only behavior or only review, diagnosis, or research without edits.
- If `--resume` or `--resume-last` is present, continue the latest tracked Claude Code task. If `--fresh` is present, start a new task.
- If none of `--resume`, `--resume-last`, or `--fresh` is present, first run:
  `node "<plugin-root>/scripts/claude-companion.mjs" task-resume-candidate --json`
- If that helper reports `available: true`, ask the user once whether to continue the current Claude Code thread or start a new one.
- Use exactly these two choices:
  - `Continue current Claude Code thread`
  - `Start a new Claude Code thread`
- If the user's wording is clearly a follow-up such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", recommend `Continue current Claude Code thread` first.
- Otherwise recommend `Start a new Claude Code thread` first.
- If the user chooses continue, add `--resume` before spawning the subagent.
- If the user chooses a new thread, add `--fresh` before spawning the subagent.
- If the helper reports `available: false`, do not ask. Delegate normally.
- Do not inspect the repo, do the task yourself, poll job status, or summarize the result in the same turn.

Subagent launch:
- Use Codex's `spawn_agent` tool with `agent_type: "cc-rescue"`.
- Do not silently substitute the built-in `worker` role. If `cc-rescue` is unavailable, stop and direct the user to `$cc:setup` or `node "<plugin-root>/scripts/install-hooks.mjs"`.
- Remove `--background` and `--wait` before spawning the subagent. Those flags control only whether the main thread waits on the subagent.
- Pass only the routing and task arguments that actually belong to `claude-companion.mjs task`.
- If the free-text task begins with `/`, preserve it verbatim in the spawned subagent request. Do not strip the slash or rewrite it into a local Codex command.
- Add the internal `--quiet-progress` flag for foreground rescue forwarding so the child subagent sees only the final companion stdout instead of streaming progress chatter.
- Add an internal `--owner-session-id <parent-session-id>` routing flag when spawning the subagent so tracked Claude Code jobs stay attached to the user-facing parent session for `$cc:status` / `$cc:result`.
- Add an internal companion routing flag that reflects whether the user will see this result in the current turn:
  - Foreground rescue must add `--view-state on-success`
  - Background rescue must add `--view-state defer`
- Any user-supplied `--model` flag is for the Claude companion only and must be forwarded unchanged to `task`.

Execution:
- Foreground: spawn the `cc-rescue` subagent, wait for it to finish, and return its stdout.
- Background: spawn the `cc-rescue` subagent without waiting for it in this turn. The subagent still runs the companion `task` command in the foreground inside its own thread. Background here describes only the parent thread's wait behavior.

Output:
- Foreground: return the subagent's companion stdout exactly as-is. Do not paraphrase, summarize, or add commentary before or after it.
- Background: do not wait for the subagent output. After launching it, tell the user `Claude Code rescue started in the background. Check $cc:status for progress.` You may also mention `$cc:result` once a job finishes.
- If the companion reports missing setup or authentication, direct the user to `$cc:setup`.
