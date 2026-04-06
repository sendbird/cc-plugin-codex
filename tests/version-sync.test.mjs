import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertVersionsMatch,
  readVersionPair,
  syncPluginVersionFromPackage,
} from "../scripts/lib/version-sync.mjs";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createTempRepo({ packageVersion, pluginVersion }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-version-sync-"));
  writeJson(path.join(dir, "package.json"), {
    name: "cc-plugin-codex",
    version: packageVersion,
  });
  writeJson(path.join(dir, ".codex-plugin", "plugin.json"), {
    name: "cc",
    version: pluginVersion,
  });
  return dir;
}

describe("version sync", () => {
  it("asserts the live repo versions match", () => {
    const { packageVersion } = readVersionPair();
    assert.equal(assertVersionsMatch(), packageVersion);
  });

  it("detects mismatched versions", () => {
    const dir = createTempRepo({
      packageVersion: "1.2.3",
      pluginVersion: "1.2.2",
    });
    try {
      assert.throws(
        () => assertVersionsMatch(dir),
        /Version mismatch: package\.json is 1\.2\.3 but \.codex-plugin\/plugin\.json is 1\.2\.2\./
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncs plugin.json from package.json", () => {
    const dir = createTempRepo({
      packageVersion: "2.0.0",
      pluginVersion: "1.0.0",
    });
    try {
      const result = syncPluginVersionFromPackage(dir);
      assert.deepEqual(result, { changed: true, version: "2.0.0" });
      const { packageVersion, pluginVersion } = readVersionPair(dir);
      assert.equal(packageVersion, "2.0.0");
      assert.equal(pluginVersion, "2.0.0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing when versions already match", () => {
    const dir = createTempRepo({
      packageVersion: "3.1.4",
      pluginVersion: "3.1.4",
    });
    try {
      const result = syncPluginVersionFromPackage(dir);
      assert.deepEqual(result, { changed: false, version: "3.1.4" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
