# Todo

## 2026-07-17 v1.3.0: review the full backlog and publish

- [x] Inventory every GitHub issue and pull request since `v1.2.1`, with historical closed/merged cross-check
- [x] Classify each open item as merge after amendment, merge as-is, defer, close, or no-op against current source
- [x] Confirm maintainer-edit access and dependency order for every open contributor PR
- [x] Reconcile the existing uncommitted `v1.2.2` preparation as `v1.3.0` without overwriting user changes
- [x] Write the final implementation spec and release scope before editing product code
- [x] Fix issue #49 by forwarding the routing helper's existing `workspaceRoot` as child `--cwd` in all three background skills
- [x] Amend and merge PR #73 with its Draft-07 review schema regression
- [x] Amend and merge PR #67 with the current `codex plugin marketplace` install commands
- [x] Amend and merge PR #68 with stdin prompt transport, native Windows lookup, and a real >32,767-byte regression
- [x] Amend and merge PR #57 with Stop-review git MCP hardening and an exact no-mutation allowlist assertion
- [x] Amend and merge PR #58 with only its turn-end/Codex-turn wording; exclude speculative Claude settings detection
- [x] Fix the existing Stop-hook inline-reason limit/test mismatch
- [x] Repair current Codex 0.144.5 E2E tool-schema drift without weakening the tested forwarding contract
- [x] Amend and merge safe maintenance PRs #59/#62/#69/#71 and TypeScript 7 (#70)
- [x] Fix #52 at the shared plugin-data boundary now that the EPERM path is reproduced; keep it independent from #57
- [x] Amend and merge #39 and reduce #65 to its two independently verified root-cause fixes
- [x] Run targeted regressions, full `npm run check`, package validation, and public pack/install smoke checks
- [x] Review the final diff independently and resolve every actionable finding
- [x] Update all release metadata/changelog to `1.3.0`, commit, push, tag, publish GitHub/npm release, and verify marketplace propagation
- [x] Close or respond to every reviewed issue and pull request with the release outcome

Review:

- Baseline preservation: the original dirty `main` workspace at `fd9379c` was not reset or overwritten. Final release work was isolated in `/tmp/cc-plugin-release-130`.
- Backlog outcome: contributor PRs #39, #57, #58, #59, #62, #65, #67, #68 (through successor #74 with original commits/authorship), #69, #70, #71, and #73 were amended as needed and merged.
- Issue outcome: #72 closed through #73; #49 and #52 closed through final release PR #75. GitHub now reports 0 open issues and 0 open PRs.
- #49: reserved rescue/review/adversarial-review child commands now preserve the routing helper's originating `workspaceRoot` via explicit `--cwd`, with contract regressions.
- #52: marketplace installs resolve `cc@sendbird` state to `plugins/data/cc-sendbird`, safely migrate `cc`/`claude-code`, update Codex writable roots with optimistic concurrency and effective-config verification, verify actual state access, and revoke plugin-specific roots on uninstall.
- Review outcome: repeated whole-diff OpenCodeReview passes found config races, identity trust, sandbox migration, lifecycle, uninstall, portability, and test-isolation gaps; every actionable finding was fixed before release.
- Verification: local `npm run check` passed unit 505, integration 41, and E2E 22; PR #75 passed Windows, macOS, Ubuntu, Hawkman, and Semgrep checks; production dependency audit reported 0 vulnerabilities; the published npm tarball shasum/integrity matched the local dry-run package.
- Release: PR #75 merged as `84340bb6`; GitHub release `v1.3.0`, npm `cc-plugin-codex@1.3.0`, and marketplace PR #6 are published. A clean temporary HOME/CODEX_HOME public install loaded cache version `1.3.0`, trusted 3 native hooks, and wrote state only under `plugins/data/cc-sendbird`.

## 2026-05-12 Release 1.2.2: upstream hook alignment

- [x] Remove the dead `SessionEnd` native hook and keep session-start behavior intact
- [x] Add safe UserPromptSubmit stale-job reaping without killing live jobs
- [x] Bound Stop-review hook decision output while preserving full review snapshots
- [x] Bump package/plugin metadata and changelog to `1.2.2`
- [x] Run targeted and full verification, then record results

Review:

- Removed `SessionEnd` from `hooks/hooks.json` and simplified `hooks/session-lifecycle-hook.mjs` to SessionStart-only behavior. Added a regression test that plugin hook event keys remain within upstream Codex `HOOK_EVENT_NAMES`.
- Added a safe `UserPromptSubmit` stale-job sweep by invoking the existing PID-reuse-safe `listJobs()` reaper from `hooks/unread-result-hook.mjs`; this reaps dead PIDs without killing live jobs during active sessions.
- Bounded Stop-review block reasons before emitting hook decisions while preserving full `rawOutput` and unbounded snapshot data for diagnostics.
- Bumped package, lockfile, and plugin manifest versions to `1.2.2`; added the `v1.2.2` changelog entry.
- Verification passed: targeted `node --test tests/hooks.test.mjs tests/state.test.mjs tests/integration/claude-companion.test.mjs`; full `npm run lint && npm run typecheck && npm run check:version-sync && npm run check:changelog && npm run test && npm run test:integration && npm run test:e2e`; `git diff --check`.

## 2026-05-12 Upstream Codex recent release deep analysis

- [x] Identify the latest upstream `openai/codex` release/tag and recent release window from primary sources
- [x] Compare recent upstream changes against `cc-plugin-codex` runtime, skills, hooks, background job, result/status, and marketplace install behavior
- [x] Rank applicable adoption opportunities by impact, risk, and implementation cost
- [x] Call out non-applicable upstream changes with reasons so we avoid cargo-culting
- [x] Recommend concrete next patches or follow-up investigations for this plugin

Review:

- Scope: upstream `openai/codex` main `ed5944ba1db98f0ef13572bfee1452d4e52f80a1` (2026-05-12), latest tag `rust-v0.131.0-alpha.6` (`bf88daa199`, 2026-05-11). Prior stable `rust-v0.128.0` (`e4310be51f`, 2026-04-30). Window analyzed covers 0.128.0 → HEAD, using local checkout at `/Users/jinku/codex` plus `git log`/`git show` on plugin/hook paths (`codex-rs/core-plugins`, `codex-rs/hooks`, `codex-rs/app-server*`, `codex-rs/features`, `codex-rs/protocol`).

- P0 (adopt now): remove the `SessionEnd` block from `hooks/hooks.json`. Upstream `HOOK_EVENT_NAMES` (`codex-rs/hooks/src/lib.rs:18`) and `HookEventName` (`codex-rs/protocol/src/protocol.rs:1453`) both only cover `PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, UserPromptSubmit, Stop`; a repo-wide `rg SessionEnd codex-rs/` returns zero matches. That means the current `SessionEnd` entry is never dispatched, but it still shows up in `hooks/list`, consumes a trust slot on every install, and pollutes setup/trust comparisons. Smallest patch: drop the `SessionEnd` block from `hooks/hooks.json`, move the `handleSessionEnd()` logic in `hooks/session-lifecycle-hook.mjs` into either `unread-result-hook.mjs` (UserPromptSubmit) as a stale-job sweep or into a dedicated companion-side reaper invoked on `$cc:status`. Verification: `$cc:setup --json` should report three trusted native hooks instead of four, and `tests/state.test.mjs`/`tests/integration/claude-companion.test.mjs` still pass.

- P1 (plan soon): bound the Stop-review decision payload against the upstream 2_500-token hook-output spill (`codex-rs/hooks/src/output_spill.rs:12`, landed in #21069 on 2026-05-05). `hooks/stop-review-gate-hook.mjs` currently emits `reason` strings that can embed long Claude review output verbatim, and large `reason` values on `Stop` fall under the 2_500-token cap. Once spilled, users see only a preview plus a spilled-path reference, which defeats the "show the reviewer verdict inline" UX. Smallest patch: cap the review output inlined into `reason` at ~1_500 chars with a "run `$cc:result <job-id>` for full review" suffix, and attach the full text to the stored stop-review snapshot (`writeStopReviewSnapshot`). Verification: integration test asserting bounded length; manual run with an intentionally large review body confirming Codex does not surface the spill notice.

- P2 (watch, defer unless we see the need): (a) Compact lifecycle hooks `PreCompact`/`PostCompact` (#19905 2026-05-06) — could surface job-status reminders around compaction, but no user signal has asked for it and the existing UserPromptSubmit path already handles unread steering. (b) Windows hook command override `command_windows`/`commandWindows` (#22159 2026-05-11) — plugin already quotes `node "$PLUGIN_ROOT/..."` and `tests/installer-cli.test.mjs` plus `scripts/lib/process.mjs:71` cover Windows; revisit only on a concrete Windows regression. (c) `marketplace/upgrade` (#20478 2026-05-01) — could be exposed as an optional action inside `$cc:setup` when a stale marketplace is detected, but the Sendbird marketplace already auto-syncs via the update-marketplace workflow. (d) `plugin/read` `PluginHookSummary` (#21447 2026-05-07) — `hooks/list` already gives this plugin everything it needs for trust; skip. (e) Hook trust flow in TUI (#21755 2026-05-09) — UX only; `$cc:setup` already auto-trusts, so nothing to change. (f) "Read cached metadata for installed Git plugins" (#20825 2026-05-10) — good for us because `plugin.json` already ships the `interface` block; no change needed. (g) `PreToolUse.additionalContext` (#20692 2026-05-05) and "Remove legacy after tool use hooks" (#21805 2026-05-08) — plugin does not use either path.

- Not applicable: plugin share/discoverability APIs (#21419, #21495, #21637, #21867) target remote workspace sharing; this plugin distributes through a Git marketplace only. Extension registry work (#21737, #21738, #22140) is internal to Codex core. Goal workflow updates (#21860, #21954, #21981, #22045) are end-user features, not plugin integration surface. Exec-server/daemon changes (#21843, #22218, #0c8d42525e) do not affect how this plugin launches.

- Upstream gap still present — plugin keeps its workaround: (1) `plugin_hooks` feature remains `Stage::UnderDevelopment` with `default_enabled: false` (`codex-rs/features/src/lib.rs:973-978`, HEAD unchanged vs `rust-v0.131.0-alpha.6`), so `scripts/lib/codex-config.mjs`'s `REQUIRED_NATIVE_HOOK_FEATURES = ["hooks", "plugin_hooks"]` must keep forcing both `[features]` keys. (2) No plugin install/update lifecycle surface in `PluginInstallResponse` or `marketplace/upgrade`, so `$cc:setup`-driven hook trust and stale-root repair must stay. (3) No `SessionEnd` dispatch upstream, so whichever session-end cleanup the plugin still wants has to live outside the hook schema (UserPromptSubmit sweep or companion-side reaper).

- Verification plan for the next implementation step (P0 + P1): `npm run lint`, `npm run typecheck`, `npm run check:version-sync`, `npm run check:changelog`, `npm run test`, `npm run test:integration`, plus `node --test tests/state.test.mjs tests/integration/claude-companion.test.mjs tests/hooks.test.mjs` specifically for session-lifecycle and stop-review path changes. On a temporary marketplace install, run `$cc:setup --json` and confirm `hookTrust.found` matches the reduced hook count and `hooks.state` has no leftover `SessionEnd` entry. Add one regression test that asserts `hooks/hooks.json` event keys are a subset of upstream `HOOK_EVENT_NAMES`.

- `tasks/todo.md` update: this review section was updated in place with the findings above; no other files were changed.

## 2026-05-12 Native plugin_hooks migration and 1.2.1 release

- [x] Record the migration plan and current constraints
- [x] Switch setup/install config repair from managed global hooks to native `hooks` + `plugin_hooks`
- [x] Remove the local checkout/stable-root install path from user-facing docs and skill contracts
- [x] Update tests for plugin-cache-root skill execution and native hook feature gates
- [x] Bump package/plugin versions and changelog to `1.2.1`
- [x] Install the updated package locally and verify `$cc:setup`
- [x] Add `$cc:setup` automation for trusting native plugin hook hashes
- [x] Verify trusted plugin hooks and prepare the release

Review:

- Switched the plugin to native Codex plugin hooks via `hooks/hooks.json` in the active plugin cache. Setup/install now enable `[features].hooks = true` and `[features].plugin_hooks = true`, and legacy global hook wiring is cleaned up instead of refreshed.
- Removed the supported local checkout/stable-root install flow from docs and helpers. The remaining installer path uses `marketplace/add` + `plugin/install`; direct local checkout installation now fails with marketplace guidance.
- Updated public skills and internal runtime references to resolve `<plugin-root>` from each active `SKILL.md`, so installed cache copies invoke their matching `scripts/claude-companion.mjs`.
- Bumped package and plugin metadata to `1.2.1` and added the `v1.2.1` changelog.
- Verification passed: `npm run lint`, `npm run typecheck`, `npm run check:version-sync`, `npm run check:changelog`, `npm run test`, `npm run test:integration`, `npm run test:e2e`, and `npm pack --dry-run`.
- Installed the updated checkout into real `~/.codex` through a temporary `sendbird-local-121` marketplace. Verified `cc-plugin-codex@1.2.1`, manifest hooks path `./hooks/hooks.json`, native hook events `SessionStart,SessionEnd,Stop,UserPromptSubmit`, no managed global `hooks.json` entries, and `$cc:setup --json` returned `ready: true` with `hooks.detail = "native Codex plugin hooks enabled"`.
- Follow-up requested: `$cc:setup` should also trust this plugin's native hooks by reading Codex `hooks/list` metadata and writing `hooks.state.<key>.trusted_hash`.
- Implemented the follow-up in `$cc:setup`: installed-cache runs now call `hooks/list`, filter current `cc@...` plugin hooks under the active plugin root, and write current hashes through `config/batchWrite` into `hooks.state`.
- Verification passed after the trust change: `npm run lint`, `npm run typecheck`, `npm run check:version-sync`, `npm run check:changelog`, `npm run test`, full `tests/integration/claude-companion.test.mjs`, setup-related E2E subset, full `npm run test:e2e`, `npm pack --dry-run`, and `git diff --check`.
- Refreshed the real `sendbird-local-121` temporary marketplace install from this checkout and ran the installed cache `$cc:setup --json`; it returned `ready: true`, `hookTrust.ready: true`, `found: 3`, and `native plugin hooks already trusted (3)`.
- Merged PR #46, published GitHub release `v1.2.1`, verified `npm view cc-plugin-codex version` returns `1.2.1`, and merged marketplace PR #5 after required checks passed.

## 2026-05-11 Latest Codex plugin hook/update source check

- [x] Update `/Users/jinku/codex` to the latest upstream `main`
- [x] Re-check latest Codex plugin install/update cache behavior
- [x] Re-check latest plugin-bundled hook support and `$PLUGIN_ROOT` handling
- [x] Re-check whether plugin install/update can run plugin-owned lifecycle scripts
- [x] Record conclusion for `cc` migration path

Review:

- `/Users/jinku/codex` was fast-forwarded to `ed5944ba1db98f0ef13572bfee1452d4e52f80a1` (`Simplify MCP tool handler plumbing (#21595)`).
- Latest Codex still installs and refreshes plugins through `plugins/cache` via `PluginStore`; `upgrade_configured_marketplaces_for_config()` force-refreshes configured non-curated plugin cache entries after Git marketplace upgrades.
- Latest Codex has plugin-bundled hooks: `hooks/hooks.json` is the default, manifest `hooks` entries are also supported, and runtime hook discovery injects `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA`, and `CLAUDE_PLUGIN_DATA`.
- `plugin_hooks` is still an under-development feature and defaults to false, so native plugin hooks require that feature to be enabled.
- This machine currently has `[features].hooks = true`, but not `[features].plugin_hooks = true`, so global hooks run while native plugin-bundled hooks would not be loaded yet.
- No plugin install/update lifecycle script surface was found in the latest manifest, app-server protocol, or install/update manager path. `PluginInstallResponse` only returns auth/app-auth information.
- Migration conclusion: use Codex native plugin cache plus plugin-bundled hooks for marketplace installs; do not pin global hooks to a versioned cache path. Keep any update-time repair as an idempotent setup/self-heal path until upstream provides install/update lifecycle hooks.

## 2026-05-11 Codex plugin update stale active install investigation

- [x] Confirm the active `cc` runtime path and version after `codex plugin update`
- [x] Compare active install, marketplace cache, local cache, and source checkout versions
- [x] Trace Codex/plugin installer code paths that decide whether `~/.codex/plugins/cc` is replaced
- [x] Identify the root cause and the smallest safe repair path
- [x] Record verification and outcome

Review:

- `cc@sendbird` is enabled and the Sendbird marketplace was refreshed to revision `15395b5d94ca2a93d385a77e248b3789cd0fb1a5` at `2026-05-12T00:37:58Z`.
- Codex-managed plugin cache is updated to `~/.codex/plugins/cache/sendbird/cc/1.2.0`, but the stable runtime root `~/.codex/plugins/cc` is still `1.1.0`.
- Global Codex hooks still call `~/.codex/plugins/cc/hooks/*.mjs`, so hook/runtime behavior remains on the stale stable root even after the marketplace cache update.
- Upstream Codex `marketplace/upgrade` refreshes configured marketplace roots and reinstalls configured non-curated plugin cache entries; it does not run plugin-owned setup scripts, rewrite `~/.codex/plugins/cc`, or rewrite plugin-managed global hooks.
- `$cc:setup` does not currently detect this drift because `checkHooksStatus()` only checks whether the three hook filenames appear in `hooks.json`, not whether they point at the expected or latest plugin root.
- Smallest immediate repair for this machine: run the plugin's installer/update path from the current checkout or `npx` package so `~/.codex/plugins/cc` becomes `1.2.0`; then verify package version and setup output. Product fix should make setup/install detect and repair stale stable-root/cache drift.

## 2026-04-17 1.1.0 local land and install

- [x] Inspect the current working tree and patch version-bearing files to `1.1.0`
- [x] Verify the repo, commit the change set, and land it on `main` without releasing
- [x] Reinstall the local plugin from the current checkout and verify the installed usable version/state

Review:

- Bumped [package.json](/Users/jinku/cc-plugin-codex/package.json) and [.codex-plugin/plugin.json](/Users/jinku/cc-plugin-codex/.codex-plugin/plugin.json) to `1.1.0`, and added a new top changelog section in [CHANGELOG.md](/Users/jinku/cc-plugin-codex/CHANGELOG.md) covering the internal-reference restructuring and absolute-link cleanup.
- Re-verified the change set with:
  - `npm run check:version-sync`
  - `npm run check:changelog`
  - `node --test tests/skills-contracts.test.mjs`
  - `npm run lint`
  - `npm run test:e2e`
- Committed locally on `main` as `e20845c chore: prepare 1.1.0 skill runtime docs`.
- Direct push to `origin/main` was blocked by the repository rule requiring the `Hawkman: Find and verify secrets` status check, so the same commit was pushed to `jin/prepare-1-1-0-skill-runtime-docs` and a PR was opened at [#35](https://github.com/sendbird/cc-plugin-codex/pull/35).
- Reinstalled the plugin locally from the current checkout with `node scripts/installer-cli.mjs install`. The local installed root is now [~/.codex/plugins/cc](/Users/jinku/.codex/plugins/cc) at `1.1.0`, the managed cache entry is [~/.codex/plugins/cache/local-plugins/cc/1.1.0](/Users/jinku/.codex/plugins/cache/local-plugins/cc/1.1.0), `codex_hooks = true` is still present in [~/.codex/config.toml](/Users/jinku/.codex/config.toml), and [~/.codex/hooks.json](/Users/jinku/.codex/hooks.json) exists again.

## 2026-04-17 Local marketplace reinstall

- [ ] Inspect the current local `cc` plugin install state and the available marketplace install path
- [ ] Replace the current direct-installed local copy with a marketplace-installed `cc`
- [ ] Run setup/verification and record the resulting local installed source/version

Review:

- Pending.

## 2026-04-17 Claude simplify pass

- [x] Run a foreground Claude `/simplify` pass on the current uncommitted skill-doc changes
- [x] Review the resulting edits locally and keep only behavior-preserving simplifications
- [x] Re-run contract/lint/E2E verification and record the outcome

Review:

- Ran a foreground Claude `/simplify` pass against the current working-tree diff with explicit constraints: keep public skills self-sufficient, keep internal references support-only, preserve proven invocation-regression guards, and avoid touching `tasks/`.
- Claude did not apply any additional simplification. Its own follow-up review agents concluded the current diff was already at the conservative boundary: the remaining repetition in prompt-shaping and the repeated `installedRootPattern` declarations were not worth touching because they would either weaken nuance or expand the diff outside the active scope.
- Re-verified the unchanged diff locally:
  - `node --test tests/skills-contracts.test.mjs`
  - `npm run lint`
  - `npm run test:e2e`

## 2026-04-17 E2E realism review

- [x] Inspect the current Codex E2E harness, fake Claude binary, and direct-skill provider flow
- [x] Identify where the current E2E tests are still more synthetic than the production path
- [x] Propose conservative upgrades ordered by signal-to-flake ratio

Review:

- The current E2E harness is already valuable because it runs the real `codex` CLI, injects real public skill bodies, and exercises `spawn_agent`/tool-call routing against a mock provider. The main synthetic shortcuts are the fake Claude binary, the simplified stream shape, and the fact that some assertions stop at command construction instead of validating richer runtime behavior.
- The highest-signal realism gap is the fake Claude stream model. It currently emits one `text_delta` followed by one terminal `result`, so E2E does not cover the stream shapes that previously caused regressions: retries, `thinking_delta`, `tool_use`, empty terminal text with structured output, delayed session/thread propagation, or mixed stdout/result tails.
- Another realism gap is that E2E still often builds prompts from the source-tree skill files instead of proving the installed or cached copy that Codex would actually use after install or marketplace flow. That leaves room for installed-copy drift regressions to hide behind source-only tests.
- The most conservative upgrade path is:
  - enrich the fake Claude binary to emit multi-event stream-json transcripts that match the integration tests more closely
  - add one install-origin E2E that runs against the installed/cache copy instead of only the source-tree prompt body
  - add stderr-progress assertions for direct foreground companion review/adversarial-review paths so stream visibility regressions are caught end-to-end
  - add one marketplace-install E2E that proves `marketplace/add` + `plugin/install` + `$cc:setup` instead of only the installer path
  - keep more detailed parser edge cases in integration tests rather than pushing all of them into Codex E2E, to avoid turning the E2E suite flaky

## 2026-04-16 Skill invocation history audit

- [x] Gather the historical skill-invocation fixes from git history and prior release commits
- [x] Check whether each past regression guard still exists in the current public/internal skill docs
- [x] Patch any missing invocation safeguard in the current docs or contract tests
- [x] Run targeted verification and record the final audit result

Review:

- Audited the main invocation-regression commits that actually changed skill semantics: `6bb9023` (built-in rescue forwarder and prompt-shaping), `38b619e` (slash-command preservation and parent-session routing), `c8d1e6f` (review owner-session propagation), `d8fc4a6` (background notification steering instead of raw result text), `318cdba` (installed-root routing plus background-routing-context and empty-placeholder guards), `75a53eb` (review vs adversarial vs rescue routing), and `9399304` (review as the default path plus focus-text gating).
- Public `review`, `adversarial-review`, and `rescue` skills still carried those regressions guards. The actual gap was in the new internal runtime references: after the recent cleanup, `internal-skills/review-runtime/runtime.md` and `internal-skills/cli-runtime/runtime.md` had become too compressed and no longer restated some child-execution invariants that earlier fixes had added.
- Restored the missing invariants conservatively in those internal runtime docs: installed-root reuse, no cache-relative path derivation, no empty `--owner-session-id  --job-id` placeholders, exact `send_input` tool-shape guidance, and background steering messages instead of raw result text.
- Fixed a follow-up doc bug from Claude review: the new internal-reference mentions had been written with `/Users/jinku/...` absolute link targets. Those are now plain relative reference paths instead, so source trees, installed copies, and marketplace snapshots do not depend on this workstation path.
- Added a new `skills-contracts` regression test that locks those internal runtime invariants so the next cleanup pass cannot silently remove them.
- Verification:
  - `node --test tests/skills-contracts.test.mjs`
  - `npm run lint`
  - `git diff --check`

## 2026-04-16 Review runtime reference alignment

- [x] Add a shared internal runtime reference for `review` and `adversarial-review`
- [x] Update both public review skills to point to that reference while keeping their public invariants inline
- [x] Update contract tests for the new reference structure
- [x] Run targeted verification and record the result

Review:

- Added [`internal-skills/review-runtime/runtime.md`](/Users/jinku/cc-plugin-codex/internal-skills/review-runtime/runtime.md) as the shared internal runtime reference for foreground/background review execution syntax.
- [`skills/review/SKILL.md`](/Users/jinku/cc-plugin-codex/skills/review/SKILL.md) and [`skills/adversarial-review/SKILL.md`](/Users/jinku/cc-plugin-codex/skills/adversarial-review/SKILL.md) now explicitly point to that runtime reference while still keeping their public invariants inline.
- [`tests/skills-contracts.test.mjs`](/Users/jinku/cc-plugin-codex/tests/skills-contracts.test.mjs) now locks in those references so review/adversarial match the same public-plus-reference structure as rescue.
- Verification:
  - `node --test tests/skills-contracts.test.mjs`
  - `npm run lint`

## 2026-04-16 Internal prompt-shaping reference cleanup

- [x] Stop presenting `task-prompt-shaping` as a hidden first-class skill
- [x] Convert it into an internal prompt-shaping reference document
- [x] Keep the must-have shaping rules inline in `rescue` while pointing to the reference doc for detail
- [x] Update contract tests and record the result

Review:

- `internal-skills/task-prompt-shaping/SKILL.md` has been replaced by [`internal-skills/task-prompt-shaping/prompt-shaping.md`](/Users/jinku/cc-plugin-codex/internal-skills/task-prompt-shaping/prompt-shaping.md), which keeps the shaping guidance but no longer pretends to be a hidden first-class skill.
- [`skills/rescue/SKILL.md`](/Users/jinku/cc-plugin-codex/skills/rescue/SKILL.md) now keeps the must-have shaping rules inline and points to the prompt-shaping reference for deeper heuristics, explicitly calling it an internal reference document rather than a public skill.
- [`internal-skills/cli-runtime/runtime.md`](/Users/jinku/cc-plugin-codex/internal-skills/cli-runtime/runtime.md) now refers to the prompt-shaping reference doc instead of a hidden `task-prompt-shaping` skill.
- Verification:
  - `node --test tests/skills-contracts.test.mjs`
  - `npm run lint`

## 2026-04-16 Internal runtime reference cleanup

- [x] Stop presenting `cli-runtime` as a hidden first-class skill
- [x] Convert it into an internal runtime reference document outside public skill semantics
- [x] Make `rescue` explicitly reference that internal runtime document
- [x] Update contract tests and record the result

Review:

- `internal-skills/cli-runtime/SKILL.md` has been replaced by [`internal-skills/cli-runtime/runtime.md`](/Users/jinku/cc-plugin-codex/internal-skills/cli-runtime/runtime.md), which keeps the execution contract but no longer pretends to be a first-class hidden skill.
- [`skills/rescue/SKILL.md`](/Users/jinku/cc-plugin-codex/skills/rescue/SKILL.md) now explicitly points the forwarding worker at that internal runtime reference and says it is an internal document, not a public skill to invoke.
- [`tests/skills-contracts.test.mjs`](/Users/jinku/cc-plugin-codex/tests/skills-contracts.test.mjs) now reads the runtime reference document from its new path and locks in the explicit rescue-to-runtime reference.
- Verification:
  - `node --test tests/skills-contracts.test.mjs`
  - `npm run lint`

## 2026-04-16 Review skill foreground/background syntax hardening

- [x] Tighten the `review` skill so foreground execution must use the installed companion command directly
- [x] Mirror the same execution-boundary rules in `adversarial-review`
- [x] Add contract tests that forbid generic review-runner or raw Claude CLI fallback in both modes
- [x] Run targeted verification and record the outcome

Review:

- `review` and `adversarial-review` now explicitly distinguish the execution boundary: foreground review must stay on the main Codex thread and run the installed `claude-companion.mjs` command exactly, while background review must go through the built-in forwarding child only.
- Both skills now forbid generic review-runner roles and raw Claude CLI fallbacks such as `claude`, `claude-code`, or ad hoc `bash -lc ...claude...` wrappers. If the installed companion command fails, the parent should surface that failure instead of improvising a different syntax.
- `tests/skills-contracts.test.mjs` now locks in those foreground/background rules so the contract does not regress back to ambiguous wording.
- Verification:
  - `node --test tests/skills-contracts.test.mjs`
  - `npm run lint`

## 2026-04-16 Status-viewed unread fix

- [x] Confirm where finished-job status responses currently surface stored result content without updating `resultViewedAt`
- [x] Mark finished jobs as viewed when `status --json` surfaces their stored result payload
- [x] Add regression coverage for the status-views-result path so unread reminders do not repeat
- [x] Re-run targeted verification and record the outcome

Review:

- Root cause was a semantic mismatch: `status --json` returned finished jobs with their stored `result` payload intact, but only `$cc:result` updated `resultViewedAt`. That let users and agents consume the result through `status` and still get unread reminders later.
- `claude-companion.mjs` now marks terminal jobs as viewed when `status --json` surfaces their stored result payload. This applies both to explicit single-job status and to status overview JSON rows that include completed jobs.
- Regression coverage now proves that a background job stays unread until completion, then `status --json` marks it viewed before `$cc:result` is called.
- Verification:
  - `node --test tests/integration/claude-companion.test.mjs tests/unread-result-hook.test.mjs`
  - `npm run lint`

## 2026-04-16 Marketplace review refresh

- [x] Capture the current working-tree scope for the marketplace/path/hook changes
- [x] Launch a new Claude Code background review on the same diff
- [x] Perform a fresh local review of the same diff and apply worthwhile fixes
- [x] Re-run targeted verification and record the combined outcome

Review:

- Local review found one real correctness issue after the earlier hook/path fixes: managed hook cleanup still only matched the install root path, so uninstall could leave stale hooks behind when they pointed at a versioned marketplace cache root such as `plugins/cache/sendbird/cc/1.0.9`. `removeManagedHooks()` now removes commands targeting both the install root and every managed cache root, and a regression test covers uninstalling versioned-hook installs.
- Claude background review job `review-mo165656-bqzcpy` reported two actionable follow-ups. First, `update-marketplace.yml` could fail on rerun if a PR already existed for the same branch; the workflow now checks for an existing PR and exits cleanly instead of failing. Second, `plugin-identity.mjs` fixed `CODEX_HOME` at module-load time, which made explicit in-process test overrides impossible; the helper now resolves `codexHome` per call and supports explicit `codexHome` injection for tests and future callers.
- Lower-signal Claude notes were intentionally left alone: the `removeMarketplaceEntry()` behavior change is already an intentional migration cleanup, the snapshot file list duplication between workflow and installer is real but not worth a larger refactor in this patch, and style-only concerns were skipped.
- Verification:
  - `node --test tests/plugin-identity.test.mjs tests/install-hooks.test.mjs tests/installer-cli.test.mjs`
  - `npm run lint`
  - `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/update-marketplace.yml"); puts "yaml-ok"'`

## 2026-04-16 Marketplace path + hook enablement fix

- [x] Remove remaining `/local`-only assumptions from managed plugin path detection so marketplace installs with versioned cache roots are recognized
- [x] Make hook installation auto-enable `codex_hooks = true` when hooks are missing or hooks are being installed
- [x] Add regression tests for versioned marketplace cache detection and automatic hook enablement
- [x] Re-run the real marketplace install experiment and verify plugin install plus hook readiness end to end

Review:

- `listManagedPluginCacheEntries()` now scans every directory under `plugins/cache/<marketplace>/cc/`, so official marketplace installs that land in versioned cache roots such as `sendbird/cc/1.0.9` are detected and cleaned up just like the legacy `local` cache.
- `install-hooks.mjs` now shares the same `codex_hooks = true` normalization logic as `local-plugin-install.mjs`, so running the installed cache copy directly installs hooks and enables lifecycle execution in one step instead of only printing guidance.
- Regression coverage was added for versioned cache detection, versioned cache uninstall cleanup, installing hooks into an empty Codex home, and upgrading an existing `codex_hooks = false` setting to `true`.
- Verification:
  - `node --test tests/plugin-identity.test.mjs tests/install-hooks.test.mjs tests/installer-cli.test.mjs`
  - `npm run lint`
  - real official marketplace flow against `sendbird/codex-marketplace` on Codex `0.121.0` confirmed `plugin/install` still works and installs to a versioned cache root
  - real official marketplace flow against a local marketplace snapshot built from the current working tree on Codex `0.121.0` confirmed `plugin/install` plus `scripts/install-hooks.mjs` yields `hooks.json` and `[features]\ncodex_hooks = true`

## 2026-04-16 Marketplace install experiment

- [ ] Create a throwaway Codex home and home directory for the experiment
- [ ] Run the official `codex marketplace add` flow against `sendbird/codex-marketplace`
- [ ] Run `plugin/install` in that temporary environment and inspect the installed state
- [ ] Check whether hooks are present before and after `$cc:setup`
- [ ] Record the outcome and keep the user's real Codex home untouched

Review:

- Pending.

## 2026-04-16 Marketplace/release-prep review refresh

- [x] Capture the current working-tree scope for the marketplace/release-prep changes
- [x] Perform a fresh local review of the current diff
- [x] Run a new Claude Code background review on the same diff
- [x] Aggregate findings and apply only worthwhile fixes
- [x] Re-run targeted verification and record the outcome

Review:

- Local review found one real installer bug: fresh `npx cc-plugin-codex install` was starting to prefer the Sendbird marketplace snapshot by default, which could install the marketplace copy instead of the current package contents. The installer now only uses the marketplace path when `CC_PLUGIN_CODEX_MARKETPLACE_SOURCE` is explicitly provided.
- Claude review agreed there were no blockers left, but pointed at three worthwhile follow-ups: remove stale dead code, make marketplace update branches generic instead of user-specific, and add a regression test for the `marketplace/add` method-not-found fallback path. Those were all applied.
- Claude also flagged uninstall cleanup semantics across marketplace migrations. That path now removes all managed `cc@*` config sections and all `cc` entries from the personal marketplace file instead of only cleaning the currently selected marketplace name.
- The marketplace sync workflow snapshot list now includes `agents` so it matches the package/installer distribution surface more closely.
- Verification: `node --test tests/installer-cli.test.mjs tests/plugin-identity.test.mjs tests/install-hooks.test.mjs tests/unread-result-hook.test.mjs`, `npm run lint`, and `git diff --check` (via `rtk proxy git diff --check` on the changed files).

## 2026-04-15 Marketplace-aware install foundation

- [x] Audit every runtime and installer path that assumes `cc@local-plugins` or `plugins/cache/local-plugins/...`
- [x] Generalize plugin identity detection so setup/hooks/runtime work for `cc@<marketplace>` installs, not just `local-plugins`
- [x] Add a 0.121-aware installer path that prefers official Codex marketplace/app-server flows where possible, while keeping legacy fallback behavior
- [x] Update README to state that marketplace installs still require plugin-managed hook setup/repair
- [x] Add regression tests for non-`local-plugins` marketplace installs and record verification

Review:

- Added `scripts/lib/plugin-identity.mjs` so managed plugin detection no longer assumes `cc@local-plugins`; runtime cleanup and hook guards now understand any `cc@<marketplace>` config section plus any `plugins/cache/<marketplace>/cc/local` cache root.
- `scripts/local-plugin-install.mjs` now supports an official 0.121+ path: if `CC_PLUGIN_CODEX_MARKETPLACE_SOURCE` is configured, it calls `marketplace/add`, installs from the returned marketplace root, and only falls back to mutating the personal marketplace file when app-server support is unavailable. Legacy fallback behavior remains intact.
- Fixed a real product bug in the new official path: `plugin/install` must use the directory of the chosen marketplace manifest as its app-server cwd, not always the personal marketplace directory. Without that fix, marketplace installs could fail before `plugin/install` even started.
- `scripts/installer-cli.mjs` now removes managed plugin cache entries across marketplace names instead of hardcoding `local-plugins`.
- README now states explicitly that marketplace/plugin install does not install global hooks; `$cc:setup` remains the repair/install path for hooks after marketplace install.
- Verification: `node --test tests/plugin-identity.test.mjs tests/installer-cli.test.mjs tests/install-hooks.test.mjs tests/unread-result-hook.test.mjs`, `npm run lint`, and `git diff --check`.

## 2026-04-08 Final pre-release review

- [x] Launch a final background Claude Code adversarial review on the current working tree
- [x] Perform a local release-minded review of the same diff
- [x] Compare the Claude findings with local findings and apply any final fixes
- [x] Re-run targeted verification and summarize release readiness

Review:

- Local review found two concrete release blockers: large review diffs still buffered full patch text before omission logic kicked in, and background review jobs could disappear from plain `$cc:status` because they were owned by the child session instead of the parent session.
- The Claude background adversarial review auto-reaped before delivering a final result, but its live log pointed at the same reservation-lifecycle and session-ownership areas, which aligned with the local findings.
- Fixed review session ownership by passing `--owner-session-id` through the review runtime and built-in review skills, and made `status --all` truly bypass the current-session filter for the workspace.
- Fixed large-diff ENOBUFS exposure by switching review diff collection to bounded reads with explicit large-diff omission and by changing working-tree fingerprinting to avoid buffering full diff text in hook paths.
- Verification: `node --test tests/job-control.test.mjs`, `node --test tests/integration/claude-companion.test.mjs`, `node --test tests/skills-contracts.test.mjs`, `node --test tests/git.test.mjs`, `node --test tests/hooks.test.mjs`, targeted rescue E2E checks, full `npm run test`, full `npm run test:e2e`, and `git diff --check`.

## 2026-04-08 Reservation enforcement follow-up

- [x] Enforce that explicit reserved job ids are actually reserved before use
- [x] Add regression tests for reserved task/review ids on invalid or conflicting paths
- [x] Re-evaluate the loosened rescue E2E response-count assertion and tighten it if justified
- [x] Run targeted verification and record the outcome

Review:

- Tightened `resolveExplicitJobId` so explicit `--job-id` values must correspond to an existing `.reserve` marker instead of accepting arbitrary ids.
- Wrapped explicit reservation release in `try/finally` for both review and task flows, and made stale reservation cleanup tolerant of per-entry filesystem errors.
- Added regression coverage for failed background runs releasing reserved ids and for rejecting unreserved explicit task/review ids.
- Re-ran the built-in rescue E2E that uses the loosened POST-count assertion. It still passes, but the current harness does not expose enough detail to prove that `3` is invalid, so that assertion was left unchanged for now instead of tightening it blindly.
- Verification: `node --test tests/integration/claude-companion.test.mjs`, `node --test tests/state.test.mjs`, `node --test --test-name-pattern "routes \\$cc:rescue through the built-in rescue subagent, the companion task runtime, and the fake Claude CLI" tests/e2e/codex-skills-e2e.test.mjs`, and `git diff --check`.

## 2026-04-08 Background result surfacing policy

- [x] Choose a single policy for background completion surfacing
- [x] Make review/adversarial skill contracts explicit that notifications must steer to `$cc:result`
- [x] Add contract coverage for the no-inline-result rule

Review:

- Chose a single policy: background completion messages should only steer the user to `$cc:result <job-id>` instead of embedding raw result text.
- Tightened `review` and `adversarial-review` skill contracts so their built-in child notification rules now explicitly forbid embedding raw Claude output or any extra prose.
- Tightened `rescue` so background built-in children now use the same steering message as their own final completion text instead of returning raw result text.
- Added matching `skills-contracts` assertions and a rescue E2E that proves a background built-in rescue completes with a `$cc:result <job-id>` steering message rather than the raw child result.

## 2026-04-11 Stable installed-root bootstrap

- [x] Reproduce the malformed background review command and confirm why `--owner-session-id` disappeared
- [x] Make argument parsing fail fast when a value flag is followed by another recognized option
- [x] Stop skill contracts from deriving the companion path from stale cache skill paths
- [x] Verify installer wrapper rewriting still emits working commands and record the outcome

Review:

- Root cause was two-part: the review/adversarial/rescue background contracts had no explicit owner-session lookup step, and the parser silently consumed `--job-id` as the owner-session value when the placeholder was left empty.
- Tightened `parseArgs`, `resolveOwnerSessionId`, and `resolveExplicitJobId` so malformed routing flags fail fast instead of being misparsed.
- Added `session-routing-context` for routing-only data (`ownerSessionId`, `parentThreadId`), but kept bootstrap path resolution out of that helper. The first companion command now comes from the stable installed root expression `${CODEX_HOME:-$HOME/.codex}/plugins/cc/...`, not from the skill file path or any cache path.
- Updated the installer wrapper rewrite path so fallback skill wrappers still resolve to the managed installed copy, and verified with `tests/args.test.mjs`, `tests/integration/claude-companion.test.mjs`, `tests/skills-contracts.test.mjs`, `tests/installer-cli.test.mjs`, and `git diff --check`.

## 2026-04-11 Windows/Linux CI coverage

- [x] Inspect the current CI workflow and identify which tests are safe on Windows as well as Linux
- [x] Add a cross-platform-safe npm test script for Windows and Linux runners
- [x] Remove obvious POSIX-only runtime assumptions from skill bootstrap paths and temp-dir handling
- [x] Update GitHub Actions so Ubuntu keeps the full suite while Windows runs the portable core suite
- [x] Run local validation for the new workflow and test script

Review:

- The existing CI only ran on Ubuntu and executed the full suite, which includes bash wrappers, fake POSIX executables, symlink cases, and signal/process-group behavior that are not reliable on Windows.
- Added `npm run test:cross-platform` as an explicit portable subset containing pure-JS tests that do not depend on bash, git repos, fake executable shims, symlinks, or Unix-only process semantics.
- Replaced POSIX shell env expansion in skill commands with an `<installed-plugin-root>` placeholder and taught the installer to materialize the concrete installed path into installed/cache skill copies. That keeps bootstrap commands stable on both POSIX shells and Windows PowerShell/cmd because the runtime prompt no longer depends on shell-specific expansion.
- Changed sandbox temp-dir settings from hardcoded `/tmp` to `os.tmpdir()` so the runtime sandbox config stays valid on Windows as well as Linux/macOS.
- Split CI into `core-cross-platform` on `ubuntu-latest` and `windows-latest`, plus `linux-full` on `ubuntu-latest` for the full test, integration, and E2E coverage.
- Local verification: `node --test tests/skills-contracts.test.mjs`, `node --test tests/installer-cli.test.mjs`, `npm run test:cross-platform`, and `git diff --check`.

## 2026-04-11 Cross-platform follow-up review

- [x] Run a fresh local review of the current Windows/Linux portability diff
- [x] Run a background Claude review of the same diff
- [x] Apply any remaining concrete fixes from the combined review
- [x] Re-run the relevant verification

Review:

- Local review found one real gap after the first Windows/Linux pass: direct local-checkout installs using `node scripts/local-plugin-install.mjs install --plugin-root ~/.codex/plugins/cc` still left `<installed-plugin-root>` placeholders in the installed skill files because only `installer-cli` staged installs rewrote them.
- Fixed that by teaching `local-plugin-install.mjs` to materialize installed skill paths in place when `pluginRoot` is already the managed installed root.
- Claude's background review agreed that the remaining issue set was low-signal. The only worthwhile code change it suggested was renaming the `rewriteInstalledSkillBodies` parameters for clarity, which was applied. Its parser concern about unknown `--` tokens was treated as an intentional compatibility choice and locked in with a unit test instead of changing behavior.
- Verification: `node --test tests/installer-cli.test.mjs`, `node --test tests/args.test.mjs`, `npm run test:cross-platform`, `node scripts/claude-companion.mjs status review-mnuzhv42-6vybyy --wait --timeout-ms 10000 --json`, and `git diff --check`.

## 2026-04-11 Final reuse/quality/efficiency pass

- [x] Capture the current diff and launch parallel reuse/quality/efficiency review agents with full context
- [x] Launch a parallel Claude `/simplify` rescue run on the same working tree changes
- [x] Aggregate local review plus all delegated findings and apply any worthwhile fixes
- [x] Re-run targeted verification and record the final result

Review:

- Parallel review sources agreed on four worthwhile follow-ups: make path equality Windows-safe, validate `parentThreadId`, stop exposing `logFile` on user/model-facing surfaces, and make background routing metadata a single helper instead of two separate companion startups.
- Reuse review also identified duplicated installer helpers. Those were consolidated by moving `samePath()` into `codex-paths.mjs` and `materializeInstalledSkillPaths()` into a shared helper used by both installers.
- Claude `/simplify` mostly agreed with the same themes. Its only extra actionable point was that direct local-checkout installs also needed installed-path materialization; that path is now covered and tested.
- Verification: `node --test tests/args.test.mjs tests/fs.test.mjs tests/skills-contracts.test.mjs tests/installer-cli.test.mjs tests/integration/claude-companion.test.mjs`, targeted background review/adversarial E2E, `npm run test:cross-platform`, and `git diff --check`.

## 2026-04-12 Release 1.0.7

- [x] Bump package and plugin versions to 1.0.7
- [x] Update CHANGELOG and README for the 1.0.7 release
- [x] Expand GitHub CI coverage to Windows, macOS, and Linux
- [x] Run release verification
- [ ] Create release branch, PR, merge, tag, GitHub release, and npm publish

Review:

- Version metadata is now aligned at `1.0.7` across `package.json` and `.codex-plugin/plugin.json`, and the changelog gate confirms a non-empty `v1.0.7` section.
- README now documents the cross-platform install/runtime story more clearly, and the CI workflow now exercises `windows-latest`, `macos-latest`, and `ubuntu-latest`.
- Local release verification passed with `npm run lint`, `npm run typecheck`, `npm run test`, `npm run test:integration`, `npm run test:e2e`, `npm run test:cross-platform`, `npm pack --dry-run`, and `git diff --check`.

## 2026-04-12 Post-release CI follow-up

- [x] Inspect PR #26 comments and identify any actionable follow-up
- [x] Swap GitHub Actions so macOS runs the full suite and Linux runs the core suite
- [x] Re-run local verification for the updated workflow
- [ ] Open a follow-up PR if changes are needed

Review:

- PR #26 had one actionable inline comment: `local-plugin-install.mjs` could silently accept an unsupported checkout-root `--plugin-root` and leave `<installed-plugin-root>` placeholders unresolved. Instead of mutating arbitrary source checkouts, the installer now fails fast with a clear message pointing users to the supported local-checkout flow or `npx cc-plugin-codex install`.
- The CI workflow now runs core checks on Windows and Ubuntu, while macOS owns the full test, integration, and E2E suite. That keeps Linux coverage for the portable subset while adding a real full-stack Darwin signal.
- Verification: `node --test tests/installer-cli.test.mjs`, `npm run test:cross-platform`, and `npm run lint`.

## 2026-04-13 Skill selection clarity

- [x] Inspect the current `review`, `adversarial-review`, and `rescue` skill wording for ambiguous routing guidance
- [x] Tighten the skill contracts so the intended use cases are explicit
- [x] Add or update contract tests so the guidance does not regress
- [x] Run targeted verification and record the result

Review:

- `review` now says it is only for straightforward correctness-oriented diff review, and explicitly routes custom focus, design challenge, rollout risk, config/template mismatch removal, and implementation follow-through to the other two skills.
- `adversarial-review` now explicitly claims risky config/infrastructure/template/migration changes, even when the user did not provide extra focus text, so the default router has a clearer home for "did this actually eliminate the risk?" reviews.
- `rescue` now says it is for investigation, validation-by-editing/testing, and actual implementation/fix follow-through rather than findings-only review.
- Verification: `node --test tests/skills-contracts.test.mjs`, `npm run lint`, and `git diff --check`.
