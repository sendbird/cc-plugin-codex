#!/usr/bin/env node

import { syncPluginVersionFromPackage } from "./lib/version-sync.mjs";

try {
  const result = syncPluginVersionFromPackage();
  process.stdout.write(
    result.changed
      ? `Updated .codex-plugin/plugin.json to version ${result.version}.\n`
      : `.codex-plugin/plugin.json already matches package.json at ${result.version}.\n`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
