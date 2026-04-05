import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function resolveVersionSyncPaths(rootDir = ROOT_DIR) {
  return {
    rootDir,
    packageJsonPath: path.join(rootDir, "package.json"),
    pluginJsonPath: path.join(rootDir, ".codex-plugin", "plugin.json"),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readVersionPair(rootDir = ROOT_DIR) {
  const { packageJsonPath, pluginJsonPath } = resolveVersionSyncPaths(rootDir);
  const packageJson = readJson(packageJsonPath);
  const pluginJson = readJson(pluginJsonPath);
  return {
    packageJson,
    pluginJson,
    packageVersion: String(packageJson.version ?? ""),
    pluginVersion: String(pluginJson.version ?? ""),
  };
}

export function assertVersionsMatch(rootDir = ROOT_DIR) {
  const { packageVersion, pluginVersion } = readVersionPair(rootDir);
  if (!packageVersion || !pluginVersion) {
    throw new Error(
      "Both package.json and .codex-plugin/plugin.json must declare a version."
    );
  }
  if (packageVersion !== pluginVersion) {
    throw new Error(
      `Version mismatch: package.json is ${packageVersion} but .codex-plugin/plugin.json is ${pluginVersion}.`
    );
  }
  return packageVersion;
}

export function syncPluginVersionFromPackage(rootDir = ROOT_DIR) {
  const { pluginJsonPath } = resolveVersionSyncPaths(rootDir);
  const { packageJson, pluginJson, packageVersion, pluginVersion } =
    readVersionPair(rootDir);

  if (!packageVersion) {
    throw new Error("package.json is missing a version.");
  }

  if (packageVersion === pluginVersion) {
    return { changed: false, version: packageVersion };
  }

  const nextPluginJson = {
    ...pluginJson,
    version: packageJson.version,
  };
  writeJson(pluginJsonPath, nextPluginJson);
  return { changed: true, version: packageVersion };
}
