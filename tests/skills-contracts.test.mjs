/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("../", import.meta.url))
);

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8");
}

test("review skills keep background execution outside the companion command", () => {
  const review = read("skills/review/SKILL.md");
  const adversarial = read("skills/adversarial-review/SKILL.md");

  assert.match(review, /Treat `--wait` and `--background` as Codex-side execution controls only/i);
  assert.match(review, /Strip them before calling the companion command/i);
  assert.match(review, /The companion review process itself always runs in the foreground/i);
  assert.match(review, /review --view-state on-success/i);
  assert.match(review, /For background review, use Codex's built-in `default` subagent/i);
  assert.match(review, /review-reserve-job --json/i);
  assert.match(review, /internal `--job-id <reserved-job-id>` routing flag/i);
  assert.match(review, /internal `--owner-session-id <parent-session-id>` routing flag/i);
  assert.match(review, /spawn_agent/i);
  assert.match(review, /`fork_context: false`/i);
  assert.match(review, /`model: "gpt-5\.4-mini"`/i);
  assert.match(review, /`reasoning_effort: "medium"`/i);
  assert.match(review, /Prefer a self-contained child message over inheriting parent history/i);
  assert.match(review, /Only consider `fork_context: true` as a last resort/i);
  assert.match(review, /retry once with `model: "gpt-5\.4"`/i);
  assert.match(review, /review --view-state defer/i);
  assert.match(review, /include `--owner-session-id <parent-session-id>` so background review jobs stay attached to the parent session/i);
  assert.match(review, /Background Claude Code review finished\. Open it with \$cc:result <reserved-job-id>\./i);
  assert.match(review, /use these steering messages instead of embedding the raw review result in the notification/i);
  assert.match(review, /do not embed the raw Claude result inside the notification message/i);
  assert.match(review, /do not include any other prose in that notification message/i);
  assert.match(review, /use that same steering message as the child's own final assistant message instead of echoing the raw review result/i);
  assert.match(review, /Check the subagent session or \$cc:status for progress, and once it's done, we will let you know to see the results\./i);
  assert.doesNotMatch(review, /claude-companion\.mjs" review --background/i);
  assert.doesNotMatch(review, /claude-companion\.mjs" review \$ARGUMENTS/i);

  assert.match(adversarial, /Treat `--wait` and `--background` as Codex-side execution controls only/i);
  assert.match(adversarial, /Strip them before calling the companion command/i);
  assert.match(adversarial, /The companion review process itself always runs in the foreground/i);
  assert.match(adversarial, /adversarial-review --view-state on-success/i);
  assert.match(adversarial, /For background adversarial review, use Codex's built-in `default` subagent/i);
  assert.match(adversarial, /review-reserve-job --json/i);
  assert.match(adversarial, /internal `--job-id <reserved-job-id>` routing flag/i);
  assert.match(adversarial, /internal `--owner-session-id <parent-session-id>` routing flag/i);
  assert.match(adversarial, /spawn_agent/i);
  assert.match(adversarial, /`fork_context: false`/i);
  assert.match(adversarial, /`model: "gpt-5\.4-mini"`/i);
  assert.match(adversarial, /`reasoning_effort: "medium"`/i);
  assert.match(adversarial, /Prefer a self-contained child message over inheriting parent history/i);
  assert.match(adversarial, /Only consider `fork_context: true` as a last resort/i);
  assert.match(adversarial, /retry once with `model: "gpt-5\.4"`/i);
  assert.match(adversarial, /adversarial-review --view-state defer/i);
  assert.match(adversarial, /include `--owner-session-id <parent-session-id>` so background review jobs stay attached to the parent session/i);
  assert.match(adversarial, /Background Claude Code adversarial review finished\. Open it with \$cc:result <reserved-job-id>\./i);
  assert.match(adversarial, /use these steering messages instead of embedding the raw review result in the notification/i);
  assert.match(adversarial, /do not embed the raw Claude result inside the notification message/i);
  assert.match(adversarial, /do not include any other prose in that notification message/i);
  assert.match(adversarial, /use that same steering message as the child's own final assistant message instead of echoing the raw review result/i);
  assert.match(adversarial, /Check the subagent session or \$cc:status for progress, and once it's done, we will let you know to see the results\./i);
  assert.doesNotMatch(adversarial, /claude-companion\.mjs" adversarial-review --background/i);
  assert.doesNotMatch(adversarial, /claude-companion\.mjs" adversarial-review \$ARGUMENTS/i);
});

test("rescue skill keeps --background and --wait as host-side controls only", () => {
  const rescue = read("skills/rescue/SKILL.md");

  assert.match(rescue, /`--background` and `--wait` are Codex-side execution controls only/i);
  assert.match(rescue, /Never forward either flag to `claude-companion\.mjs task`/i);
  assert.match(rescue, /The main Codex thread owns that execution-mode choice/i);
  assert.match(rescue, /If the user explicitly passed `--background`, run the rescue subagent in the background/i);
  assert.match(rescue, /If neither flag is present and the rescue request is small, clearly bounded, or likely to finish quickly, prefer foreground/i);
  assert.match(rescue, /If neither flag is present and the request looks complicated, open-ended, multi-step, or likely to keep Claude Code running for a while, prefer background execution for the subagent/i);
  assert.match(rescue, /This size-and-scope heuristic belongs to the main Codex thread/i);
  assert.match(rescue, /If the user task text itself begins with a slash command such as `\/simplify`/i);
  assert.match(rescue, /Remove `--background` and `--wait` before spawning the subagent/i);
  assert.match(rescue, /If the free-text task begins with `\/`, preserve it verbatim/i);
  assert.match(rescue, /--owner-session-id <parent-session-id>/i);
  assert.match(rescue, /task-reserve-job --json/i);
  assert.match(rescue, /internal `--job-id <reserved-job-id>` routing flag/i);
  assert.match(rescue, /Foreground rescue must add `--view-state on-success`/i);
  assert.match(rescue, /Background rescue must add `--view-state defer`/i);
  assert.match(rescue, /Background: spawn the rescue subagent without waiting for it in this turn/i);
  assert.match(rescue, /The subagent still runs the companion `task` command in the foreground/i);
  assert.match(rescue, /tell the user `Claude Code rescue started in the background\. Check the subagent session or \$cc:status for progress, and once it's done, we will let you know to see the results\.`/i);
});

test("rescue skill documents the experimental built-in-agent forwarding path", () => {
  const rescue = read("skills/rescue/SKILL.md");
  const rescueAgentMeta = read("skills/rescue/agents/openai.yaml");
  const frontmatter = rescue.split("---")[1] ?? "";
  const supportedArgumentsLine =
    rescue
      .split("\n")
      .find((line) => line.startsWith("Supported arguments:")) ?? "";

  assert.doesNotMatch(frontmatter, /--builtin-agent/i);
  assert.doesNotMatch(supportedArgumentsLine, /--builtin-agent/i);
  assert.doesNotMatch(rescueAgentMeta, /--builtin-agent/i);
  assert.doesNotMatch(frontmatter, /--notify-parent-on-complete/i);
  assert.doesNotMatch(supportedArgumentsLine, /--notify-parent-on-complete/i);
  assert.doesNotMatch(rescueAgentMeta, /--notify-parent-on-complete/i);
  assert.match(rescue, /By default, hand this skill off through Codex's built-in `default` subagent/i);
  assert.match(rescue, /legacy request still includes `--builtin-agent`/i);
  assert.match(rescue, /legacy request still includes `--notify-parent-on-complete`/i);
  assert.match(rescue, /compatibility alias for the default built-in path/i);
  assert.match(rescue, /Prefer `fork_context: false` for the built-in rescue child/i);
  assert.match(rescue, /Only consider `fork_context: true` as a last resort/i);
  assert.match(rescue, /must set `model: "gpt-5\.4-mini"` and `reasoning_effort: "medium"` on `spawn_agent`/i);
  assert.match(rescue, /emit one short commentary update that records the attempted subagent model selection/i);
  assert.match(rescue, /Prefer `gpt-5\.4-mini`/i);
  assert.match(rescue, /retry once with `model: "gpt-5\.4"` and the same `reasoning_effort: "medium"`/i);
  assert.match(rescue, /clearly says `gpt-5\.4-mini` was unavailable and the parent is retrying with `gpt-5\.4`/i);
  assert.match(rescue, /Do not use that fallback for arbitrary failures/i);
  assert.match(rescue, /capture its own thread id by running:/i);
  assert.match(rescue, /process\.env\.CODEX_THREAD_ID/i);
  assert.match(rescue, /pass it into the child prompt as the parent thread id/i);
  assert.match(rescue, /allow one extra `send_input` call after a successful shell result/i);
  assert.match(rescue, /must target the provided parent thread id/i);
  assert.match(rescue, /do not silently drop the completion notification path from the child prompt/i);
  assert.match(rescue, /short user-facing template that steers the parent toward explicit result retrieval instead of inlining the raw result/i);
  assert.match(rescue, /Background Claude Code rescue finished\. Open it with \$cc:result <reserved-job-id>\./i);
  assert.match(rescue, /fall back to:/i);
  assert.match(rescue, /Background Claude Code rescue finished\. Inspect it with \$cc:status first, then use \$cc:result for the finished job you want to open\./i);
  assert.match(rescue, /prefer these steering messages over embedding the raw result text/i);
  assert.match(rescue, /do not embed the raw Claude result inside the notification message/i);
  assert.match(rescue, /do not include any other prose in that notification message/i);
  assert.match(rescue, /for background rescue, use that same steering message as the child's own final assistant message instead of echoing the raw companion result/i);
  assert.match(rescue, /background built-in rescue now attempts parent wake-up by default/i);
  assert.match(rescue, /default for background built-in rescue on persistent Codex\/Desktop threads/i);
  assert.match(rescue, /silently degrade on one-shot `codex exec` runs/i);
  assert.match(rescue, /the parent thread owns prompt shaping/i);
  assert.match(rescue, /If the built-in rescue request is vague, chatty, or a follow-up, the parent may tighten only the task text/i);
  assert.match(rescue, /Prefer passing a small structured `<parent_context>` block instead of forked thread history/i);
  assert.match(rescue, /Use the `task-prompt-shaping` internal rules as guidance/i);
  assert.match(rescue, /If the request is already concrete, keep it literal/i);
  assert.match(rescue, /If the request names a concrete file, path, or artifact such as `README\.md`/i);
  assert.match(rescue, /Do not compress it into a shorter delta/i);
  assert.match(rescue, /materialize it into a temporary prompt file first and use `--prompt-file` instead of embedding the task directly/i);
  assert.match(rescue, /multi-line task text/i);
  assert.match(rescue, /single quotes, backticks, or XML-style blocks/i);
  assert.match(rescue, /absolute `--prompt-file` path/i);
  assert.match(rescue, /temporary path outside the repository checkout/i);
  assert.match(rescue, /normal file-write tool or other structured write path/i);
  assert.match(rescue, /rewrite it into a short delta that names the next thing Claude Code should change or inspect/i);
  assert.match(rescue, /preserve the language mix and only tighten the execution intent/i);
  assert.match(rescue, /make that output contract explicit instead of broadening the task/i);
  assert.match(rescue, /For `--resume`, `--resume-last`, vague follow-ups, or ambiguous continuation requests, prefer adding a compact `<parent_context>` block/i);
  assert.match(rescue, /Keep `<parent_context>` small and structured/i);
  assert.match(rescue, /`mode` \(`fresh` or `resume`\)/i);
  assert.match(rescue, /`job_id` when the parent reserved one/i);
  assert.match(rescue, /`claude_session` when a resumable Claude session is already known/i);
  assert.match(rescue, /`next_delta` for the exact next objective/i);
  assert.match(rescue, /Do not use `<parent_context>` for already-clear fresh tasks unless it adds real value/i);
  assert.match(rescue, /Do not turn it into a free-form summary of the whole parent thread/i);
  assert.match(rescue, /prefer a short delta instruction for resume follow-ups/i);
  assert.match(rescue, /The child must not do an additional interpretation pass/i);
  assert.match(rescue, /prefer `--resume` or `--resume-last` with a short delta instruction/i);
  assert.match(rescue, /compact strict forwarding message/i);
  assert.match(rescue, /transient forwarding worker for Claude Code rescue/i);
  assert.match(rescue, /include exactly one shell command to run/i);
  assert.match(rescue, /ignore stderr progress chatter such as `\[cc\] \.\.\.` lines/i);
  assert.match(rescue, /not to inspect the repository, read files, grep, or do the task directly/i);
  assert.match(rescue, /for foreground rescue only, tell the child to return that command's stdout text exactly/i);
  assert.match(rescue, /copy the resolved rescue task text byte-for-byte/i);
  assert.match(rescue, /forbid appending terminal punctuation, adding quotes, dropping prefixes such as `completed:`/i);
  assert.match(rescue, /completed:\/simplify make the output compact/i);
});

test("rescue runtime guidance forbids task --background", () => {
  const runtimeSkill = read("internal-skills/cli-runtime/SKILL.md");

  assert.match(runtimeSkill, /`--background` and `--wait` are parent-side execution controls only/i);
  assert.match(runtimeSkill, /Strip both before building the `task` command/i);
  assert.match(runtimeSkill, /Never call `task --background` or invent `task --wait`\./i);
  assert.match(runtimeSkill, /The companion task command always runs in the foreground/i);
  assert.match(runtimeSkill, /`--owner-session-id`, and `--job-id` as routing controls/i);
  assert.match(runtimeSkill, /If the free-text task begins with `\/`, treat that slash command as literal Claude Code task text/i);
  assert.match(runtimeSkill, /Do not add `--quiet-progress` by default for built-in rescue forwarding/i);
  assert.match(runtimeSkill, /Let companion stderr progress remain available in the spawned agent thread/i);
  assert.match(runtimeSkill, /prefer staging it in a temporary prompt file and pass it through `--prompt-file` instead of inlining it in one shell string/i);
  assert.match(runtimeSkill, /prefer a temporary path outside the repository checkout/i);
  assert.match(runtimeSkill, /Use a structured file-write path to create that prompt file/i);
  assert.match(runtimeSkill, /ignore the progress chatter and preserve only the final stdout-equivalent result text/i);
  assert.match(runtimeSkill, /It does not change the companion command you build/i);
  assert.match(runtimeSkill, /`--view-state on-success` means the user will see this companion result in the current turn/i);
  assert.match(runtimeSkill, /`--view-state defer` means the parent is not waiting/i);
  assert.match(runtimeSkill, /`--owner-session-id <session-id>` is an internal parent-session routing control/i);
});

test("rescue parent skill owns resume-candidate exploration", () => {
  const rescue = read("skills/rescue/SKILL.md");
  const runtimeSkill = read("internal-skills/cli-runtime/SKILL.md");

  assert.match(rescue, /task-resume-candidate --json/i);
  assert.match(rescue, /Continue current Claude Code thread/i);
  assert.match(rescue, /Start a new Claude Code thread/i);

  assert.doesNotMatch(runtimeSkill, /task-resume-candidate --json/i);
  assert.doesNotMatch(runtimeSkill, /Continue current Claude Code thread/i);
  assert.doesNotMatch(runtimeSkill, /Start a new Claude Code thread/i);
  assert.match(runtimeSkill, /The parent rescue skill already owns that choice/i);
});

test("setup skill auto-installs missing hooks before the final setup report", () => {
  const setup = read("skills/setup/SKILL.md");

  assert.match(setup, /setup --json/i);
  assert.match(setup, /If setup reports missing hooks, run:/i);
  assert.match(setup, /node "<plugin-root>\/scripts\/install-hooks\.mjs"/i);
  assert.match(setup, /rerun the final setup command so the user sees the repaired state immediately/i);
});
