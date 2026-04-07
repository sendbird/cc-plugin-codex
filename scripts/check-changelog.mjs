#!/usr/bin/env node

import { assertChangelogIncludesVersion } from "./lib/changelog.mjs";

try {
  const version = assertChangelogIncludesVersion();
  process.stdout.write(
    `Changelog OK: CHANGELOG.md contains a non-empty section for v${version}.\n`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
