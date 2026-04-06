# cc-plugin-codex

Use Claude Code from inside Codex for code reviews and delegated tasks.

This repository is maintained by Sendbird and follows the overall shape of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), but in the opposite direction: Codex hosts the plugin and delegates work to Claude Code.

## What You Get

- `$cc:review` for a normal read-only Claude Code review
- `$cc:adversarial-review` for a steerable challenge review
- `$cc:rescue`, `$cc:status`, `$cc:result`, and `$cc:cancel` to delegate work and manage tracked jobs
- `$cc:setup` to verify Claude Code readiness, hook installation, rescue-agent wiring, and review-gate state

## How This Differs From Upstream

The goal is to stay close to the upstream OpenAI plugin's UX, but Claude Code and Codex expose different runtime surfaces.

| Topic | `openai/codex-plugin-cc` | This repository |
| --- | --- | --- |
| Host app | Claude Code hosts the plugin | Codex hosts the plugin |
| User command surface | Claude slash commands such as `/codex:review` | Codex skills such as `$cc:review` |
| Delegated runtime | Codex app-server + broker | Fresh `claude -p` subprocess per invocation |
| Review gate subject | Reviews the previous Claude response before Claude stops | Reviews the previous Codex response before Codex stops |
| Rescue agent | Plugin-local Codex rescue agent inside Claude | Global `cc-rescue` agent in `~/.codex/agents` |
| Model / effort flags | Codex model names and Codex effort controls | Claude model names and Claude effort values: `low`, `medium`, `high`, `max` |

## Where This Goes Further

In addition to mirroring the upstream command surface, this repository adds a few implementation-focused optimizations:

- The stop-time review gate computes a turn baseline and skips Claude review entirely when the most recent Codex turn made no net edits, which helps avoid unnecessary token spend.
- Nested helper sessions suppress stop-time review and unread-result prompts, so the review gate stays attached to the user-facing Codex thread instead of recursive child runs.
- Background Claude jobs track unread/viewed state and session ownership, which makes `$cc:status`, `$cc:result`, and follow-up rescue flows safer for concurrent work.
- The installer is idempotent and manages the personal marketplace entry, hooks, and global `cc-rescue` registration together, so install and reinstall are a single step.

## Requirements

- Codex with hook support
- Node.js 18 or later
- Claude Code CLI installed and authenticated
  - `claude auth login`, or
  - `ANTHROPIC_API_KEY` set in the environment

## Install

Choose either install path below. Both install the plugin into `~/.codex/plugins/cc`, create or update `~/.agents/plugins/marketplace.json`, install Codex-native `cc-*` wrappers into `~/.codex/skills` and `~/.codex/prompts`, enable `cc@local-plugins` in `~/.codex/config.toml`, enable `codex_hooks = true`, and install Codex hooks plus the global `cc-rescue` agent.

### npx

```bash
npx cc-plugin-codex install
```

### Shell Script

```bash
curl -fsSL "https://raw.githubusercontent.com/sendbird/cc-plugin-codex/main/scripts/install.sh" | bash
```

### Update

Rerun either install command. The installer is safe to run again and will refresh the installed copy in place.

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

If Claude Code is not installed yet:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

Then run:

```text
$cc:setup
```

After install, you should see:

- the `$cc:*` skills listed in Codex
- the global `cc-rescue` agent installed under `~/.codex/agents/cc-rescue.toml`

One simple first run is:

```text
$cc:review --background
$cc:status
$cc:result
```

## Usage

### `$cc:review`

Runs a normal Claude Code review on your current work.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

It supports `--base <ref>`, `--scope <auto|working-tree|branch>`, `--wait`, `--background`, and `--model <model>`.

Examples:

```text
$cc:review
$cc:review --base main
$cc:review --background
```

This command is read-only. When run in the background, use `$cc:status` to check progress and `$cc:cancel` to stop it.

### `$cc:adversarial-review`

Runs a steerable review that questions the chosen implementation and design.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

It uses the same target selection as `$cc:review`, including `--base <ref>`, and also accepts extra focus text after the flags.

Examples:

```text
$cc:adversarial-review
$cc:adversarial-review --base main challenge whether this was the right caching and retry design
$cc:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `$cc:rescue`

Hands a task to Claude Code through the global `cc-rescue` agent.

Use it when you want Claude Code to:

- investigate a bug
- try a fix
- continue a previous Claude task
- take a cheaper or faster pass with a smaller Claude model

It supports `--background`, `--wait`, `--resume`, `--resume-last`, `--fresh`, `--write`, `--model <model>`, `--effort <low|medium|high|max>`, and `--prompt-file <path>`.

Examples:

```text
$cc:rescue investigate why the tests started failing
$cc:rescue fix the failing test with the smallest safe patch
$cc:rescue --resume apply the top fix from the last run
$cc:rescue --model sonnet --effort medium investigate the flaky integration test
$cc:rescue --background investigate the regression
```

### `$cc:status`

Shows running and recent Claude Code jobs for the current repository.

Examples:

```text
$cc:status
$cc:status task-abc123
```

### `$cc:result`

Shows the final stored Claude Code output for a finished job.

When available, it also includes the Claude session ID so you can reopen that run directly with:

```bash
claude --resume <session-id>
```

Examples:

```text
$cc:result
$cc:result task-abc123
```

### `$cc:cancel`

Cancels an active background Claude Code job.

Examples:

```text
$cc:cancel
$cc:cancel task-abc123
```

### `$cc:setup`

Checks whether Claude Code is installed and authenticated.

It also verifies:

- hook installation
- global `cc-rescue` registration
- current review-gate state for this workspace

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
