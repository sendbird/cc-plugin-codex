import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertChangelogIncludesVersion,
  findVersionSection,
  readCurrentVersion,
} from "../scripts/lib/changelog.mjs";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createTempRepo({ version, changelog }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-changelog-"));
  writeJson(path.join(dir, "package.json"), {
    name: "cc-plugin-codex",
    version,
  });
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), changelog, "utf8");
  return dir;
}

describe("changelog gate", () => {
  it("asserts the live repo changelog contains the current version", () => {
    assert.equal(assertChangelogIncludesVersion(), readCurrentVersion());
  });

  it("finds a matching version section", () => {
    const section = findVersionSection(
      "1.2.3",
      "# Changelog\n\n## v1.2.3\n\n- hello\n\n## v1.2.2\n\n- older\n"
    );
    assert.equal(section?.heading.trim(), "## v1.2.3");
    assert.match(section?.body ?? "", /- hello/);
  });

  it("rejects a missing version section", () => {
    const dir = createTempRepo({
      version: "1.2.3",
      changelog: "# Changelog\n\n## v1.2.2\n\n- older\n",
    });
    try {
      assert.throws(
        () => assertChangelogIncludesVersion(dir),
        /CHANGELOG\.md is missing a section for v1\.2\.3/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty version section", () => {
    const dir = createTempRepo({
      version: "1.2.3",
      changelog: "# Changelog\n\n## v1.2.3\n\nNo bullets here\n",
    });
    try {
      assert.throws(
        () => assertChangelogIncludesVersion(dir),
        /has no bullet items/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
