# Claude Code plugin for Codex

Use Claude Code from inside Codex for reviews, delegated implementation work, and tracked background jobs.

This repository is maintained by Sendbird and follows the overall shape of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), but in the opposite direction: Codex hosts the plugin and delegates work to Claude Code.

## What You Get

- `$cc:review` for a normal read-only Claude Code review
- `$cc:adversarial-review` for a steerable challenge review
- `$cc:rescue`, `$cc:status`, `$cc:result`, and `$cc:cancel` for delegated Claude Code work and tracked jobs
- `$cc:setup` to verify Claude Code readiness, auto-install hooks when missing, and manage the review gate
- Optional stop-time review gating through Codex hooks
- One-shot unread background-result nudges on the next user prompt when a same-session background Claude job finished but has not been viewed yet

## How This Differs From Upstream

The goal is to stay close to the upstream OpenAI plugin's UX, but Claude Code and Codex expose different runtime surfaces.

| Topic | `openai/codex-plugin-cc` | This repository |
| --- | --- | --- |
| Host app | Claude Code hosts the plugin | Codex hosts the plugin |
| User command surface | Claude slash commands such as `/codex:review` | Codex skills such as `$cc:review` |
| Install lifecycle | Installed inside Claude's plugin flow | Installed through Codex's personal marketplace plus `plugin/install` / `plugin/uninstall` when available |
| Managed global state | Plugin-local runtime pieces inside Claude | Managed Codex hooks only; no global rescue agent |
| Delegated runtime | Codex app-server + broker | Fresh `claude -p` subprocess per invocation |
| Review gate subject | Reviews the previous Claude response before Claude stops | Reviews the previous Codex response before Codex stops |
| Rescue path | Plugin-local Codex rescue agent inside Claude | Built-in Codex forwarding subagent plus tracked Claude jobs |
| Model / effort flags | Codex model names and Codex effort controls | Claude model names and Claude effort values: `low`, `medium`, `high`, `max` |

## Where This Goes Further

- The stop-time review gate computes a turn baseline and skips Claude review entirely when the latest Codex turn made no net edits, which reduces unnecessary token spend.
- Nested helper sessions suppress stop-time review and unread-result prompts, so user-facing hooks stay attached to the top-level Codex thread instead of recursive child runs.
- Background Claude jobs track unread/viewed state and session ownership, which makes `$cc:status`, `$cc:result`, and follow-up rescue flows safer for concurrent work.
- Because Codex and Claude Code background jobs cannot proactively create a new foreground user turn, the `UserPromptSubmit` hook injects a one-shot nudge on the next prompt when an unread same-session background result is waiting.
- The installer is idempotent and manages the personal marketplace entry, Codex hook installation, and Codex app-server install/uninstall path together.

## Requirements

- Codex with hook support
- Node.js 18 or later
- Claude Code CLI installed and authenticated
  - `claude auth login`, or
  - `ANTHROPIC_API_KEY` set in the environment

## Install

Choose either install path below.

Both install flows:

- stage the plugin under `~/.codex/plugins/cc`
- create or update `~/.agents/plugins/marketplace.json`
- enable `codex_hooks = true`
- install the managed Codex hooks used for review gate, session lifecycle, and unread background-result nudges
- ask Codex app-server to run `plugin/install` when that API is available
- fall back to config-based activation on older or unsupported Codex builds

When Codex's official `plugin/install` API is unavailable, the installer also writes fallback `cc-*` wrappers into `~/.codex/skills` and `~/.codex/prompts` so `$cc:*` commands remain discoverable.

Outside the plugin directory, the managed state is the hook entries in `~/.codex/hooks.json`, plus fallback `cc-*` wrappers in `~/.codex/skills` and `~/.codex/prompts` when the installer has to use the older compatibility path. This plugin no longer installs a global rescue agent under `~/.codex/agents`.

### npx

```bash
npx cc-plugin-codex install
```

### Shell Script

```bash
curl -fsSL "https://raw.githubusercontent.com/sendbird/cc-plugin-codex/main/scripts/install.sh" | bash
```

### Update

Rerun either install command. The installer refreshes the staged plugin copy in place and keeps the marketplace entry and managed hooks consistent.

```bash
npx cc-plugin-codex update
curl -fsSL "https://raw.githubusercontent.com/sendbird/cc-plugin-codex/main/scripts/install.sh" | bash
```

### Uninstall

```bash
npx cc-plugin-codex uninstall
curl -fsSL "https://raw.githubusercontent.com/sendbird/cc-plugin-codex/main/scripts/uninstall.sh" | bash
```

### Manual Install

If you want to work from a local checkout instead of the one-shot installer:

```bash
mkdir -p ~/.codex/plugins
git clone https://github.com/sendbird/cc-plugin-codex.git ~/.codex/plugins/cc
cd ~/.codex/plugins/cc
node scripts/local-plugin-install.mjs install --plugin-root ~/.codex/plugins/cc
```

## First Run

If Claude Code is not installed yet:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

Then run:

```text
$cc:setup
```

`$cc:setup` is recommended, not required as an unlock step.

If Claude Code is already installed and authenticated, the other `$cc:*` skills should work immediately after install. `$cc:setup` is useful when you want to:

- verify Claude Code readiness
- auto-install missing hooks
- diagnose missing auth
- enable or disable the review gate

If the plugin was installed through another marketplace path or copied into Codex without running this installer, run `$cc:setup` once so it can install the managed hooks.

After install, you should see:

- the `$cc:*` skills listed in Codex
- managed hook entries in `~/.codex/hooks.json`

## Background Results And Nudges

Background Claude jobs can finish while the foreground Codex thread is idle. Neither Codex background jobs nor Claude Code background work can proactively initiate a new foreground turn on their own.

Because of that limitation, this plugin keeps background results in an unread state until the user views them. On the next `UserPromptSubmit` event in the same session, the unread-result hook injects a one-shot nudge if there is a finished unread Claude Code background job waiting.

That nudge points the user back to:

- `$cc:status` to inspect current and recent jobs
- `$cc:result` to view the stored result and mark it as read

This is why unread background-result handling is implemented as a Codex hook instead of trying to push a foreground message directly from a background worker.

## Usage

### `$cc:review`

Runs a standard read-only Claude Code review on the current working tree or a branch diff.

Examples:

```text
$cc:review
$cc:review --base main
$cc:review --background
```

### `$cc:adversarial-review`

Runs a more skeptical review that challenges design choices, assumptions, and tradeoffs.

Examples:

```text
$cc:adversarial-review
$cc:adversarial-review --base main question the retry and rollback strategy
$cc:adversarial-review --background focus on race conditions
```

### `$cc:rescue`

Delegates substantial work to Claude Code through the built-in Codex forwarding subagent and tracked-job runtime.

Examples:

```text
$cc:rescue investigate why the tests started failing
$cc:rescue fix the failing test with the smallest safe patch
$cc:rescue --resume apply the top fix from the last run
$cc:rescue --background investigate the regression
```

### `$cc:status`

Shows running and recent Claude Code jobs for the current repository.

```text
$cc:status
$cc:status task-abc123
```

### `$cc:result`

Shows the stored final output for a finished Claude Code job. When available, it also includes the Claude session ID so you can reopen that run directly.

```text
$cc:result
$cc:result task-abc123
```

### `$cc:cancel`

Cancels an active background Claude Code job.

```text
$cc:cancel
$cc:cancel task-abc123
```

### `$cc:setup`

Recommended readiness check. It does not unlock the plugin.

It verifies:

- Claude Code availability and authentication
- hook installation
- current review-gate state for this workspace

If hooks are missing, `$cc:setup` installs them and reruns the final readiness check automatically.

#### Enabling Review Gate

```text
$cc:setup --enable-review-gate
$cc:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Claude Code review based on Codex's previous response. If that review finds issues, the stop is blocked so Codex can address them first.

> [!WARNING]
> The review gate can create a long-running Codex/Claude loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```text
$cc:review --background
$cc:status
$cc:result
```

### Challenge A Design Choice

```text
$cc:adversarial-review --background question the retry, rollback, and caching strategy
```

### Hand A Problem To Claude Code

```text
$cc:rescue fix the failing test with the smallest safe patch
```

### Continue A Previous Claude Task

```text
$cc:rescue --resume apply the top fix from the last run
```

## License

Apache-2.0
