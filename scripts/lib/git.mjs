/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_INLINE_REVIEW_DIFF_BYTES = 64 * 1024;
const REVIEW_DIFF_READ_MAX_BUFFER = MAX_INLINE_REVIEW_DIFF_BYTES + 8 * 1024;
const HASH_OBJECT_BATCH_SIZE = 128;

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
  const stagedDiffHash = gitChecked(repoRoot, ["write-tree"]).stdout.trim();
  const unstaged = gitChecked(repoRoot, [
    "diff",
    "--name-only",
    "--no-ext-diff",
    "-z",
  ]).stdout
    .split("\0")
    .filter(Boolean)
    .sort();
  const untracked = gitChecked(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();

  const unstagedDiffHash = hashWorkingTreePaths(repoRoot, unstaged);
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

function hashWorkingTreePaths(repoRoot, relativePaths) {
  const hash = createHash("sha256");
  const regularPaths = [];

  for (const relativePath of relativePaths) {
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");

    const absolutePath = path.join(repoRoot, relativePath);
    try {
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) {
        hash.update("directory", "utf8");
        hash.update("\0", "utf8");
        hash.update(String(Math.trunc(stat.mtimeMs)), "utf8");
        hash.update("\0", "utf8");
        continue;
      }

      if (stat.isSymbolicLink()) {
        hash.update("symlink", "utf8");
        hash.update("\0", "utf8");
        hash.update(fs.readlinkSync(absolutePath), "utf8");
        hash.update("\0", "utf8");
        continue;
      }

      regularPaths.push(relativePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        hash.update("deleted", "utf8");
      } else {
        throw error;
      }
    }
    hash.update("\0", "utf8");
  }

  const blobHashes = readBlobHashes(repoRoot, regularPaths);
  for (const relativePath of regularPaths) {
    hash.update(blobHashes.get(relativePath), "utf8");
    hash.update("\0", "utf8");
  }

  return hash.digest("hex");
}

function readBlobHashes(repoRoot, relativePaths) {
  const hashes = new Map();
  for (let index = 0; index < relativePaths.length; index += HASH_OBJECT_BATCH_SIZE) {
    const batch = relativePaths.slice(index, index + HASH_OBJECT_BATCH_SIZE);
    const stdout = gitChecked(repoRoot, ["hash-object", "--no-filters", "--", ...batch]).stdout;
    const digestLines = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (digestLines.length !== batch.length) {
      throw new Error(
        `git hash-object returned ${digestLines.length} hashes for ${batch.length} path(s).`
      );
    }
    batch.forEach((relativePath, batchIndex) => {
      hashes.set(relativePath, digestLines[batchIndex]);
    });
  }
  return hashes;
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
    const stat = fs.lstatSync(absolutePath);
    if (stat.isDirectory()) {
      return `### ${relativePath}\n(skipped: untracked directory)`;
    }
    if (stat.isSymbolicLink()) {
      return `### ${relativePath}\n(skipped: symlink)`;
    }
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
    if (error?.code === "EISDIR") {
      return `### ${relativePath}\n(skipped: untracked directory)`;
    }
    throw error;
  }
}

function shouldInlineReviewDiff(...sections) {
  let totalBytes = 0;
  for (const section of sections) {
    totalBytes += Buffer.byteLength(String(section ?? ""), "utf8");
    if (totalBytes > MAX_INLINE_REVIEW_DIFF_BYTES) {
      return false;
    }
  }
  return true;
}

function readBoundedGitDiff(cwd, args) {
  const result = git(cwd, args, { maxBuffer: REVIEW_DIFF_READ_MAX_BUFFER });
  if (result.error) {
    if (result.error.code === "ENOBUFS") {
      return { text: "", tooLarge: true };
    }
    throw new Error(
      `${result.command} ${result.args.join(" ")}: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return { text: result.stdout, tooLarge: false };
}

function collectWorkingTreeContext(cwd, state) {
  const status = gitChecked(cwd, ["status", "--short"]).stdout.trim();
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
  const stagedDiff = readBoundedGitDiff(cwd, ["diff", "--cached", "--no-ext-diff", "--submodule=diff"]);
  const unstagedDiff = readBoundedGitDiff(cwd, ["diff", "--no-ext-diff", "--submodule=diff"]);
  const inlineDiffs =
    !stagedDiff.tooLarge &&
    !unstagedDiff.tooLarge &&
    shouldInlineReviewDiff(status, stagedDiff.text, unstagedDiff.text, untrackedBody);

  const parts = [
    formatSection("Git Status", status),
    formatSection(
      "Staged Diff",
      inlineDiffs
        ? stagedDiff.text
        : "Large diff omitted. Inspect staged changes directly with read-only git commands such as `git diff --cached --no-ext-diff --submodule=diff`."
    ),
    formatSection(
      "Unstaged Diff",
      inlineDiffs
        ? unstagedDiff.text
        : "Large diff omitted. Inspect unstaged changes directly with read-only git commands such as `git diff --no-ext-diff --submodule=diff`."
    ),
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
  const diff = readBoundedGitDiff(cwd, ["diff", "--no-ext-diff", "--submodule=diff", commitRange]);
  const inlineDiff =
    !diff.tooLarge &&
    shouldInlineReviewDiff(logOutput, diffStat, diff.text);

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection(
        "Branch Diff",
        inlineDiff
          ? diff.text
          : `Large diff omitted. Inspect the branch diff directly with read-only git commands such as \`git diff --no-ext-diff --submodule=diff ${commitRange}\`.`
      )
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
