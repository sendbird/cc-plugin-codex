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

import { collectReviewContext, getWorkingTreeFingerprint } from "../scripts/lib/git.mjs";

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

  it("gracefully handles untracked directory contents and symlinks in working-tree review context", () => {
    const repo = createRepo();

    fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "-m", "tracked"]);

    fs.mkdirSync(path.join(repo, "notes"), { recursive: true });
    fs.writeFileSync(path.join(repo, "notes", "todo.md"), "todo\n", "utf8");
    fs.symlinkSync("tracked.txt", path.join(repo, "tracked-link"));

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.match(context.content, /notes\/todo\.md[\s\S]*```/);
    assert.match(context.content, /tracked-link[\s\S]*skipped: symlink/);
  });

  it("omits very large working-tree diffs and tells the reviewer to inspect git directly", () => {
    const repo = createRepo();
    const largeText = `${"x".repeat(200)}\n`.repeat(500);

    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n", "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(repo, "app.js"), largeText, "utf8");

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.match(context.content, /Large diff omitted\./);
    assert.match(context.content, /git diff --cached --no-ext-diff --submodule=diff/);
    assert.match(context.content, /git diff --no-ext-diff --submodule=diff/);
  });

  it("omits very large branch diffs and tells the reviewer to inspect git directly", () => {
    const repo = createRepo();
    const largeText = `${"y".repeat(200)}\n`.repeat(500);

    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n", "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "initial"]);
    runGit(repo, ["checkout", "-b", "feature"]);

    fs.writeFileSync(path.join(repo, "app.js"), largeText, "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "large change"]);

    const context = collectReviewContext(repo, {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true,
    });

    assert.match(context.content, /Large diff omitted\./);
    assert.match(context.content, /git diff --no-ext-diff --submodule=diff/);
    assert.doesNotMatch(context.content, /@@/);
  });

  it("degrades gracefully when working-tree diff output exceeds the process buffer", () => {
    const repo = createRepo();
    const hugeText = `${"z".repeat(2048)}\n`.repeat(700);

    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n", "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(repo, "app.js"), hugeText, "utf8");

    const context = collectReviewContext(repo, {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });

    assert.match(context.content, /Large diff omitted\./);
    assert.match(context.content, /git diff --cached --no-ext-diff --submodule=diff/);
    assert.match(context.content, /git diff --no-ext-diff --submodule=diff/);
  });

  it("computes a working-tree fingerprint without buffering the full diff text", () => {
    const repo = createRepo();
    const hugeText = `${"w".repeat(2048)}\n`.repeat(700);

    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n", "utf8");
    runGit(repo, ["add", "app.js"]);
    runGit(repo, ["commit", "-m", "initial"]);

    fs.writeFileSync(path.join(repo, "app.js"), hugeText, "utf8");

    const fingerprint = getWorkingTreeFingerprint(repo);

    assert.equal(typeof fingerprint.signature, "string");
    assert.equal(fingerprint.signature.length > 0, true);
    assert.equal(typeof fingerprint.stagedDiffHash, "string");
    assert.equal(typeof fingerprint.unstagedDiffHash, "string");
  });
});
