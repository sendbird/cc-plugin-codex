/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_PATH = path.join(REPO_ROOT, "hooks", "review-only-boundary-hook.mjs");

function runHook(input) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 5_000,
  });
}

function shellInput(command) {
  return { tool_name: "Bash", tool_input: { command } };
}

describe("review-only boundary hook", () => {
  it("blocks write-class tools", () => {
    const result = runHook({ tool_name: "Write", tool_input: { file_path: "x" } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /BLOCKED: Write is not allowed/);
  });

  it("passes the patcher read-only command matrix", () => {
    const cases = [
      ["python patcher.py --dry-run", 0],
      ["python patcher.py --status", 0],
      ["python patcher.py --verify", 0],
      ["python C:/tools/cc-patcher/patcher.py --dry-run", 0],
      ["python patcher.py --apply", 2],
      ["python patcher.py", 2],
      ["python ./notpatcher.py --dry-run", 2],
    ];

    for (const [command, expectedStatus] of cases) {
      const result = runHook(shellInput(command));
      assert.equal(result.status, expectedStatus, command);
    }
  });

  it("blocks mutating package manager and git commands", () => {
    for (const command of ["npm install", "pnpm add left-pad", "git commit -m x"]) {
      const result = runHook(shellInput(command));
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /mutating shell command is not allowed/);
    }
  });

  it("allows read-only shell commands", () => {
    for (const command of ["git diff --stat", "rg review-only", "npm view cc-plugin-codex version"]) {
      const result = runHook(shellInput(command));
      assert.equal(result.status, 0, command);
    }
  });
});
