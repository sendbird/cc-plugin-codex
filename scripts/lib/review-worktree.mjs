/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Ephemeral git worktree lifecycle for review/adversarial-review runs.
 *
 * A review is run inside a throwaway `git worktree` so that any side effect that
 * slips past the allowlist (a stray `Bash` injection, a tool that writes outside
 * `/tmp`, etc.) is contained and disappears on cleanup. The worktree shares the
 * primary repo's object database, so creating one is cheap.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePluginRuntimeRoot } from "./codex-paths.mjs";

const WORKTREE_DIR_NAME = "review-worktrees";

function runGit(cwd, args, options = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      // Use git's own no-op editor so review never spawns a real editor.
      // `:` is a builtin in both POSIX shells and git's exec resolution.
      GIT_EDITOR: ":",
    },
    ...options,
  });
}

function resolveWorktreesRoot() {
  const root = path.join(resolvePluginRuntimeRoot(), WORKTREE_DIR_NAME);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function makeWorktreePath(label) {
  const slug = label && /^[A-Za-z0-9._-]+$/.test(label) ? label : "review";
  return path.join(
    resolveWorktreesRoot(),
    `${slug}-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`
  );
}

/**
 * Resolve the canonical git ref to materialize for a review. We default to HEAD
 * (the branch tip); callers may pass a specific ref (branch review) or "HEAD" to
 * be explicit.
 */
export function resolveBaseRef(repoRoot, requestedRef = "HEAD") {
  const ref = requestedRef && /^[A-Za-z0-9._/\-~^@]+$/.test(requestedRef)
    ? requestedRef
    : "HEAD";
  const result = runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (result.status !== 0) {
    throw new Error(
      `git rev-parse ${ref} failed: ${(result.stderr ?? "").trim() || "unknown error"}`
    );
  }
  return result.stdout.trim();
}

/**
 * Create an ephemeral worktree at the resolved ref. Returns `{ path, cleanup }`.
 * The caller MUST invoke `cleanup()` (typically in a `finally` block) so that
 * the worktree is removed even if the review fails.
 */
export function createReviewWorktree(repoRoot, { label = "review", ref = "HEAD" } = {}) {
  const commit = resolveBaseRef(repoRoot, ref);
  const worktreePath = makeWorktreePath(label);

  // `git worktree add --detach <path> <commit>` performs the checkout in one step;
  // splitting it into add+checkout is unnecessary and slower.
  const created = runGit(repoRoot, [
    "worktree",
    "add",
    "--detach",
    worktreePath,
    commit,
  ]);
  if (created.status !== 0) {
    // `git worktree add` may have partially registered a `.git/worktrees/<name>`
    // bookkeeping entry before failing on checkout or ENOSPC. Remove the
    // filesystem directory and then prune so the partial entry is reclaimed.
    cleanupWorktreeDir(worktreePath);
    runGit(repoRoot, ["worktree", "prune"]);
    throw new Error(
      `git worktree add failed: ${(created.stderr ?? "").trim() || "unknown error"}`
    );
  }

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    safeRemoveWorktree(repoRoot, worktreePath);
  };

  return { path: worktreePath, commit, cleanup };
}

function safeRemoveWorktree(repoRoot, worktreePath) {
  // Best-effort: ask git to remove, then ensure the directory is gone.
  runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  cleanupWorktreeDir(worktreePath);
  // `git worktree prune` cleans up the bookkeeping under .git/worktrees so that
  // a future cleanup pass does not see a dangling entry pointing at a deleted dir.
  runGit(repoRoot, ["worktree", "prune"]);
}

function cleanupWorktreeDir(worktreePath) {
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Last resort — leave on disk rather than crash the review pipeline.
  }
}

/**
 * Choose how to expose the repository to a review run.
 *
 * For branch reviews we run inside an ephemeral worktree checked out at the
 * branch tip: that gives us mutation isolation without losing any of the
 * commits Claude needs to inspect.
 *
 * For working-tree reviews we deliberately *do not* create a worktree. A
 * worktree-from-HEAD would hide the very staged/unstaged/untracked changes
 * that the reviewer is supposed to inspect — `git status` would report clean,
 * `git diff` would show nothing, and the MCP server pointed at the worktree
 * would mislead Claude into thinking the repo is unchanged. Instead we run in
 * the original repo with the Bash-free allowlist. That allowlist limits the
 * model's tools; it does not stop the repo's project settings from loading.
 *
 * Returns `{ cwd, gitRoot, cleanup, isolated }`, plus `settingSources` for a
 * worktree. `gitRoot` is the path the MCP git server should be rooted at;
 * `cwd` is what the Claude CLI should treat as the working directory.
 *
 * `settingSources` is the Claude `--setting-sources` value. The worktree checks
 * out the commit under review, which may come from anyone, and a print-mode
 * child does not ask for trust. Its project settings would otherwise load:
 * hooks would run, `env` would reach the processes the child starts, and
 * `CLAUDE.md` and rules would reach the model. With `user`, project and local
 * settings do not load; user settings, managed settings and the `--settings`
 * file still do. A working-tree review runs in the user's own repository and
 * loads its project settings without a trust prompt: the plugin treats that
 * repository as trusted.
 */
export function createReviewIsolation(repoRoot, target, { label = "review" } = {}) {
  if (target?.mode === "working-tree") {
    return {
      cwd: repoRoot,
      gitRoot: repoRoot,
      cleanup: () => {},
      isolated: false,
    };
  }
  const worktree = createReviewWorktree(repoRoot, { label });
  return {
    cwd: worktree.path,
    gitRoot: worktree.path,
    cleanup: () => worktree.cleanup(),
    isolated: true,
    settingSources: "user",
  };
}

/**
 * Sweep stale worktrees left behind by crashes. Called on every review start
 * so that long-running plugin installs do not accumulate dead worktrees.
 */
export function pruneStaleReviewWorktrees(repoRoot, { maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const root = resolveWorktreesRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < maxAgeMs) continue;
    safeRemoveWorktree(repoRoot, full);
  }
}
