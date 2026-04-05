/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

function hashText(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function buildUntrackedMetadataFingerprint(repoRoot, relativePaths) {
  const hash = createHash("sha256");
  const normalizedPaths = [...relativePaths].sort();

  for (const relativePath of normalizedPaths) {
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    const absolutePath = path.join(repoRoot, relativePath);
    try {
      const stat = fs.statSync(absolutePath);
      hash.update(String(stat.size), "utf8");
      hash.update("\0", "utf8");
      hash.update(String(Math.trunc(stat.mtimeMs)), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        hash.update("ENOENT", "utf8");
      } else {
        throw error;
      }
    }
    hash.update("\0", "utf8");
  }

  return hash.digest("hex");
}

export function getWorkingTreeFingerprint(cwd) {
  const repoRoot = getRepoRoot(cwd);
  const stagedDiff = gitChecked(repoRoot, [
    "diff",
    "--cached",
    "--no-ext-diff",
    "--submodule=diff",
  ]).stdout;
  const unstagedDiff = gitChecked(repoRoot, [
    "diff",
    "--no-ext-diff",
    "--submodule=diff",
  ]).stdout;
  const untracked = gitChecked(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();

  const stagedDiffHash = hashText(stagedDiff);
  const unstagedDiffHash = hashText(unstagedDiff);
  const untrackedFingerprintHash = buildUntrackedMetadataFingerprint(
    repoRoot,
    untracked
  );
  const signature = hashText(
    [
      stagedDiffHash,
      unstagedDiffHash,
      untrackedFingerprintHash,
      String(untracked.length),
    ].join("\0")
  );

  return {
    repoRoot,
    stagedDiffHash,
    unstagedDiffHash,
    untrackedFingerprintHash,
    untrackedCount: untracked.length,
    signature,
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  try {
    const stat = fs.statSync(absolutePath);
    if (stat.size > MAX_UNTRACKED_BYTES) {
      return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
    }

    const buffer = fs.readFileSync(absolutePath);
    if (!isProbablyText(buffer)) {
      return `### ${relativePath}\n(skipped: binary file)`;
    }

    return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return `### ${relativePath}\n(skipped: file disappeared before it could be read)`;
    }
    throw error;
  }
}

function collectWorkingTreeContext(cwd, state) {
  const status = gitChecked(cwd, ["status", "--short"]).stdout.trim();
  const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--no-ext-diff", "--submodule=diff"]).stdout;
  const unstagedDiff = gitChecked(cwd, ["diff", "--no-ext-diff", "--submodule=diff"]).stdout;
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");

  const parts = [
    formatSection("Git Status", status),
    formatSection("Staged Diff", stagedDiff),
    formatSection("Unstaged Diff", unstagedDiff),
    formatSection("Untracked Files", untrackedBody)
  ];

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n")
  };
}

function collectBranchContext(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();
  const diff = gitChecked(cwd, ["diff", "--no-ext-diff", "--submodule=diff", commitRange]).stdout;

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff", diff)
    ].join("\n")
  };
}

export function collectReviewContext(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const state = getWorkingTreeState(cwd);
  const currentBranch = getCurrentBranch(cwd);
  let details;

  if (target.mode === "working-tree") {
    details = collectWorkingTreeContext(repoRoot, state);
  } else {
    details = collectBranchContext(repoRoot, target.baseRef);
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    ...details
  };
}
