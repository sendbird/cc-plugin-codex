/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createReviewIsolation,
  createReviewWorktree,
  pruneStaleReviewWorktrees,
  resolveBaseRef,
} from "../scripts/lib/review-worktree.mjs";

let repoRoot;
let previousCodexHome;
let previousHome;
let previousUserProfile;
let tempHome;

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr ?? result.stdout ?? "unknown"}`
    );
  }
  return result;
}

before(() => {
  // Sandbox the plugin runtime root so we don't touch the real ~/.codex.
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-worktree-home-"));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.CODEX_HOME = path.join(tempHome, ".codex");

  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-worktree-repo-"));
  git(repoRoot, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repoRoot, "file.txt"), "content\n");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "initial"]);
});

after(() => {
  if (previousHome == null) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile == null) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousCodexHome == null) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("resolveBaseRef", () => {
  it("returns a 40-char SHA for HEAD", () => {
    const sha = resolveBaseRef(repoRoot, "HEAD");
    assert.match(sha, /^[a-f0-9]{40}$/);
  });

  it("falls back to HEAD when the requested ref contains forbidden chars", () => {
    const sha = resolveBaseRef(repoRoot, "HEAD; rm -rf /");
    assert.match(sha, /^[a-f0-9]{40}$/);
  });

  it("throws when the ref does not exist", () => {
    assert.throws(
      () => resolveBaseRef(repoRoot, "nonexistent-ref-xyz"),
      /git rev-parse/
    );
  });
});

describe("createReviewWorktree", () => {
  it("creates a worktree at HEAD with checked-out files", () => {
    const wt = createReviewWorktree(repoRoot, { label: "unit" });
    try {
      assert.ok(fs.existsSync(wt.path));
      assert.ok(fs.existsSync(path.join(wt.path, "file.txt")));
      assert.match(wt.commit, /^[a-f0-9]{40}$/);
    } finally {
      wt.cleanup();
    }
  });

  it("cleanup removes the worktree directory", () => {
    const wt = createReviewWorktree(repoRoot);
    assert.ok(fs.existsSync(wt.path));
    wt.cleanup();
    assert.equal(fs.existsSync(wt.path), false);
  });

  it("cleanup is idempotent", () => {
    const wt = createReviewWorktree(repoRoot);
    wt.cleanup();
    wt.cleanup(); // should not throw
    assert.equal(fs.existsSync(wt.path), false);
  });

  it("uses a sanitized slug derived from the label", () => {
    const wt = createReviewWorktree(repoRoot, { label: "review" });
    try {
      assert.match(path.basename(wt.path), /^review-/);
    } finally {
      wt.cleanup();
    }
  });

  it("falls back to a safe slug when label contains illegal characters", () => {
    const wt = createReviewWorktree(repoRoot, { label: "rev iew/../bad" });
    try {
      assert.match(path.basename(wt.path), /^review-/);
    } finally {
      wt.cleanup();
    }
  });

  it("each invocation creates a unique path", () => {
    const a = createReviewWorktree(repoRoot, { label: "a" });
    const b = createReviewWorktree(repoRoot, { label: "a" });
    try {
      assert.notEqual(a.path, b.path);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

describe("createReviewIsolation", () => {
  it("returns the original repoRoot for working-tree mode (no worktree)", () => {
    const iso = createReviewIsolation(repoRoot, { mode: "working-tree", label: "wt" });
    try {
      assert.equal(iso.cwd, repoRoot);
      assert.equal(iso.gitRoot, repoRoot);
      assert.equal(iso.isolated, false);
      assert.equal(iso.settingSources, undefined);
    } finally {
      iso.cleanup();
    }
  });

  it("does not create a worktree directory for working-tree mode", () => {
    const root = path.join(
      process.env.CODEX_HOME,
      "plugins", "data", "cc", "runtime", "review-worktrees"
    );
    const countEntries = () => {
      try {
        return fs.readdirSync(root, { withFileTypes: true }).length;
      } catch {
        return 0;
      }
    };
    const before = countEntries();
    const iso = createReviewIsolation(repoRoot, { mode: "working-tree" });
    const after = countEntries();
    assert.equal(after, before);
    iso.cleanup();
  });

  it("creates and cleans up an ephemeral worktree for branch mode", () => {
    const iso = createReviewIsolation(repoRoot, { mode: "branch" }, { label: "iso-branch" });
    try {
      assert.notEqual(iso.cwd, repoRoot);
      assert.equal(iso.gitRoot, iso.cwd);
      assert.equal(iso.isolated, true);
      assert.equal(iso.settingSources, "user");
      assert.ok(fs.existsSync(iso.cwd));
    } finally {
      iso.cleanup();
      assert.equal(fs.existsSync(iso.cwd), false);
    }
  });
});

describe("pruneStaleReviewWorktrees", () => {
  it("removes worktree dirs older than the threshold", () => {
    const wt = createReviewWorktree(repoRoot, { label: "stale" });
    // Don't call wt.cleanup() — simulate a crashed run.
    // Force the directory's mtime backward by 7 hours.
    const oldTime = (Date.now() - 7 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(wt.path, oldTime, oldTime);
    assert.ok(fs.existsSync(wt.path));
    pruneStaleReviewWorktrees(repoRoot, { maxAgeMs: 6 * 60 * 60 * 1000 });
    assert.equal(fs.existsSync(wt.path), false);
  });

  it("leaves fresh worktree dirs alone", () => {
    const wt = createReviewWorktree(repoRoot, { label: "fresh" });
    try {
      pruneStaleReviewWorktrees(repoRoot, { maxAgeMs: 6 * 60 * 60 * 1000 });
      assert.ok(fs.existsSync(wt.path));
    } finally {
      wt.cleanup();
    }
  });
});
