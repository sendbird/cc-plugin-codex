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
  assert.match(review, /Launch the same companion review command in a Codex background command or session/i);
  assert.match(review, /review --view-state on-success/i);
  assert.match(review, /use `--view-state defer` on the companion command/i);
  assert.doesNotMatch(review, /claude-companion\.mjs" review --background/i);
  assert.doesNotMatch(review, /claude-companion\.mjs" review \$ARGUMENTS/i);

  assert.match(adversarial, /Treat `--wait` and `--background` as Codex-side execution controls only/i);
  assert.match(adversarial, /Strip them before calling the companion command/i);
  assert.match(adversarial, /The companion review process itself always runs in the foreground/i);
  assert.match(adversarial, /Launch the same companion adversarial-review command in a Codex background command or session/i);
  assert.match(adversarial, /adversarial-review --view-state on-success/i);
  assert.match(adversarial, /use `--view-state defer` on the companion command/i);
  assert.doesNotMatch(adversarial, /claude-companion\.mjs" adversarial-review --background/i);
  assert.doesNotMatch(adversarial, /claude-companion\.mjs" adversarial-review \$ARGUMENTS/i);
});

test("rescue skill keeps --background and --wait as host-side controls only", () => {
  const rescue = read("skills/rescue/SKILL.md");

  assert.match(rescue, /`--background` and `--wait` are Codex-side execution controls only/i);
  assert.match(rescue, /Never forward either flag to `claude-companion\.mjs task`/i);
  assert.match(rescue, /The main Codex thread owns that execution-mode choice/i);
  assert.match(rescue, /If the user explicitly passed `--background`, run the `cc-rescue` subagent in the background/i);
  assert.match(rescue, /If neither flag is present and the rescue request is small, clearly bounded, or likely to finish quickly, prefer foreground/i);
  assert.match(rescue, /If neither flag is present and the request looks complicated, open-ended, multi-step, or likely to keep Claude Code running for a while, prefer background execution for the subagent/i);
  assert.match(rescue, /This size-and-scope heuristic belongs to the main Codex thread/i);
  assert.match(rescue, /If the user task text itself begins with a slash command such as `\/simplify`/i);
  assert.match(rescue, /Remove `--background` and `--wait` before spawning the subagent/i);
  assert.match(rescue, /If the free-text task begins with `\/`, preserve it verbatim/i);
  assert.match(rescue, /--quiet-progress/i);
  assert.match(rescue, /--owner-session-id <parent-session-id>/i);
  assert.match(rescue, /Foreground rescue must add `--view-state on-success`/i);
  assert.match(rescue, /Background rescue must add `--view-state defer`/i);
  assert.match(rescue, /Background: spawn the `cc-rescue` subagent without waiting for it in this turn/i);
  assert.match(rescue, /The subagent still runs the companion `task` command in the foreground/i);
  assert.match(rescue, /tell the user `Claude Code rescue started in the background\. Check \$cc:status for progress\.`/i);
});

test("rescue forwarder contracts forbid task --background", () => {
  const agent = read("agents/cc-rescue.toml");
  const runtimeSkill = read("internal-skills/cli-runtime/SKILL.md");

  assert.match(agent, /Treat --background and --wait as parent-side execution controls only/i);
  assert.match(agent, /They describe whether the main Codex thread waits for you/i);
  assert.match(agent, /Never forward either flag to the companion task command/i);
  assert.match(agent, /The companion task command always runs in the foreground/i);
  assert.match(agent, /Do not reinterpret the parent thread's background or foreground choice as task --background or task --wait/i);
  assert.match(agent, /Trust the parent rescue skill to choose foreground vs background for you based on request scope/i);
  assert.match(agent, /If the raw task text begins with `\/`, treat it as literal Claude Code task text/i);
  assert.match(agent, /If the parent includes --quiet-progress, preserve it/i);
  assert.match(agent, /If the parent includes --owner-session-id <session-id>, preserve it/i);
  assert.match(agent, /Forward that to the companion task command as --view-state on-success or --view-state defer/i);

  assert.match(runtimeSkill, /`--background` and `--wait` are parent-side execution controls only/i);
  assert.match(runtimeSkill, /Strip both before building the `task` command/i);
  assert.match(runtimeSkill, /Never call `task --background` or invent `task --wait`\./i);
  assert.match(runtimeSkill, /The companion task command always runs in the foreground/i);
  assert.match(runtimeSkill, /`--owner-session-id` as routing controls/i);
  assert.match(runtimeSkill, /Treat `--quiet-progress` as an internal routing control/i);
  assert.match(runtimeSkill, /If the free-text task begins with `\/`, treat that slash command as literal Claude Code task text/i);
  assert.match(runtimeSkill, /`--quiet-progress` suppresses companion stderr progress output/i);
  assert.match(runtimeSkill, /It does not change the companion command you build/i);
  assert.match(runtimeSkill, /`--view-state on-success` means the user will see this companion result in the current turn/i);
  assert.match(runtimeSkill, /`--view-state defer` means the parent is not waiting/i);
  assert.match(runtimeSkill, /`--owner-session-id <session-id>` is an internal parent-session routing control/i);
});

test("rescue parent skill owns resume-candidate exploration", () => {
  const rescue = read("skills/rescue/SKILL.md");
  const agent = read("agents/cc-rescue.toml");
  const runtimeSkill = read("internal-skills/cli-runtime/SKILL.md");

  assert.match(rescue, /task-resume-candidate --json/i);
  assert.match(rescue, /Continue current Claude Code thread/i);
  assert.match(rescue, /Start a new Claude Code thread/i);

  assert.doesNotMatch(agent, /task-resume-candidate --json/i);
  assert.doesNotMatch(agent, /Continue current Claude Code thread/i);
  assert.doesNotMatch(agent, /Start a new Claude Code thread/i);
  assert.match(agent, /The parent rescue skill owns that decision/i);

  assert.doesNotMatch(runtimeSkill, /task-resume-candidate --json/i);
  assert.doesNotMatch(runtimeSkill, /Continue current Claude Code thread/i);
  assert.doesNotMatch(runtimeSkill, /Start a new Claude Code thread/i);
  assert.match(runtimeSkill, /The parent rescue skill already owns that choice/i);
});
