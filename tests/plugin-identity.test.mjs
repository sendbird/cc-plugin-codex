/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getManagedPluginSignals,
  getPreferredMarketplaceName,
  listManagedPluginCacheEntries,
  parseManagedPluginSections,
  pluginConfigHeader,
  pluginIdForMarketplace,
} from "../scripts/lib/plugin-identity.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("plugin identity helpers", () => {
  it("returns no managed sections for empty or unrelated config", () => {
    assert.deepEqual(parseManagedPluginSections(""), []);
    assert.deepEqual(parseManagedPluginSections('[plugins."other@market"]\nenabled = true\n'), []);
  });

  it("parses managed plugin sections for arbitrary marketplace names", () => {
    const config = [
      pluginConfigHeader("sendbird"),
      "enabled = true",
      "",
      pluginConfigHeader("local-plugins"),
      "enabled = false",
      "",
    ].join("\n");

    assert.deepEqual(parseManagedPluginSections(config), [
      {
        pluginId: pluginIdForMarketplace("sendbird"),
        marketplaceName: "sendbird",
        enabled: true,
      },
      {
        pluginId: pluginIdForMarketplace("local-plugins"),
        marketplaceName: "local-plugins",
        enabled: false,
      },
    ]);
  });

  it("detects both legacy local and versioned marketplace cache entries", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-identity-"));
    tempDirs.push(codexHome);

    fs.mkdirSync(path.join(codexHome, "plugins", "cache", "local-plugins", "cc", "local"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(codexHome, "plugins", "cache", "sendbird", "cc", "1.0.8"), {
      recursive: true,
    });

    assert.deepEqual(
      listManagedPluginCacheEntries(codexHome).map((entry) => ({
        marketplaceName: entry.marketplaceName,
        cacheEntryName: entry.cacheEntryName,
      })),
      [
        { marketplaceName: "local-plugins", cacheEntryName: "local" },
        { marketplaceName: "sendbird", cacheEntryName: "1.0.8" },
      ]
    );
  });

  it("reads managed plugin signals from an explicit codex home", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-signals-"));
    tempDirs.push(codexHome);

    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `${pluginConfigHeader("sendbird")}\nenabled = true\n`,
      "utf8"
    );
    fs.mkdirSync(path.join(codexHome, "plugins", "cache", "sendbird", "cc", "1.0.9"), {
      recursive: true,
    });

    const signals = getManagedPluginSignals(codexHome);

    assert.equal(signals.configState, "active");
    assert.equal(signals.activeSection?.marketplaceName, "sendbird");
    assert.equal(signals.cachePresent, true);
    assert.equal(getPreferredMarketplaceName("local-plugins", codexHome), "sendbird");
  });
});
