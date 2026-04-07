import fs from "node:fs";
import path from "node:path";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readCurrentVersion(repoRoot = process.cwd()) {
  const packageJson = readJson(path.join(repoRoot, "package.json"));
  if (!packageJson?.version || typeof packageJson.version !== "string") {
    throw new Error("package.json is missing a string version field.");
  }
  return packageJson.version;
}

export function readChangelog(repoRoot = process.cwd()) {
  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) {
    throw new Error("CHANGELOG.md does not exist.");
  }
  return fs.readFileSync(changelogPath, "utf8");
}

export function findVersionSection(version, changelogText) {
  const normalized = String(changelogText ?? "");
  const headingPattern = new RegExp(`^##\\s+v?${version.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*$`, "m");
  const headingMatch = headingPattern.exec(normalized);
  if (!headingMatch) {
    return null;
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const remainder = normalized.slice(sectionStart);
  const nextHeadingMatch = /^\s*##\s+/m.exec(remainder);
  const sectionBody = nextHeadingMatch
    ? remainder.slice(0, nextHeadingMatch.index)
    : remainder;

  return {
    heading: headingMatch[0],
    body: sectionBody,
  };
}

export function assertChangelogIncludesVersion(repoRoot = process.cwd()) {
  const version = readCurrentVersion(repoRoot);
  const changelog = readChangelog(repoRoot);
  const section = findVersionSection(version, changelog);
  if (!section) {
    throw new Error(
      `CHANGELOG.md is missing a section for v${version}. Add a heading like \`## v${version}\` before releasing.`
    );
  }

  const meaningfulLines = section.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const hasBullet = meaningfulLines.some((line) => /^[-*]\s+\S+/.test(line));
  if (!hasBullet) {
    throw new Error(
      `CHANGELOG.md section for v${version} exists but has no bullet items. Add at least one release note bullet before releasing.`
    );
  }

  return version;
}
