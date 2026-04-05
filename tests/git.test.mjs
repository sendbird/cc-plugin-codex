/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { collectReviewContext } from "../scripts/lib/git.mjs";

const tempRepos = [];

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-git-test-"));
  tempRepos.push(dir);
  runGit(dir, ["init", "--initial-branch=main"]);
  runGit(dir, ["config", "user.name", "Codex Test"]);
  runGit(dir, ["config", "user.email", "codex@example.com"]);
  return dir;
}

afterEach(() => {
  while (tempRepos.length > 0) {
    fs.rmSync(tempRepos.pop(), { recursive: true, force: true });
  }
});

describe("collectReviewContext", () => {
  it("avoids embedding full binary patches for working-tree diffs", () => {
    const repo = createRepo();
    const binaryPath = path.join(repo, "asset.bin");

    fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));
    runGit(repo, ["add", "asset.bin"]);
    runGit(repo, ["commit", "-m", "initial"]);

    fs.writeFileSync(binaryPath, Buffer.from([4, 5, 6, 7, 8, 9]));

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.ok(context.content.includes("asset.bin"));
    assert.ok(!context.content.includes("GIT binary patch"));
  });

  it("avoids embedding full binary patches for branch diffs", () => {
    const repo = createRepo();
    const binaryPath = path.join(repo, "asset.bin");

    fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]));
    runGit(repo, ["add", "asset.bin"]);
    runGit(repo, ["commit", "-m", "initial"]);
    runGit(repo, ["checkout", "-b", "feature"]);

    fs.writeFileSync(binaryPath, Buffer.from([7, 8, 9, 10, 11]));
    runGit(repo, ["add", "asset.bin"]);
    runGit(repo, ["commit", "-m", "update binary"]);

    const context = collectReviewContext(repo, {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true,
    });

    assert.ok(context.content.includes("asset.bin"));
    assert.ok(!context.content.includes("GIT binary patch"));
  });
});
