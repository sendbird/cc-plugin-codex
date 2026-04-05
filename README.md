# cc-plugin-codex

Claude Code Plugin for Codex by Sendbird.

Use Claude Code from inside Codex for code reviews, adversarial reviews, and tracked rescue-task delegation through the `$cc:*` skill surface.

This repository is maintained by Sendbird and is inspired by [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). The upstream project lets Claude Code call Codex. This repository mirrors that shape in the opposite direction so Codex can call Claude Code. It is not an official OpenAI or Anthropic repository.

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
| Read-only enforcement | Codex server + OS sandbox | Claude tool allowlists plus temporary settings files |
| Rescue agent | Plugin-local Codex rescue agent inside Claude | Globally registered `cc-rescue` agent in `~/.codex/agents` |
| Model / effort flags | Codex model names and Codex effort controls | Claude model names and Claude effort values: `low`, `medium`, `high`, `max` |

The biggest structural difference is runtime shape: Codex exposes a persistent app-server model, while Claude Code is a CLI. Because of that, this plugin wraps Claude Code through `scripts/claude-companion.mjs` and `scripts/lib/claude-cli.mjs`, and each review or task launches a fresh Claude subprocess instead of talking to a long-lived server. In the current implementation that subprocess is `claude -p`, not `claude -p --bare`, because `--bare` breaks Claude Code OAuth authentication.

## Requirements

- Codex with hook support
- Node.js 18 or later
- Claude Code CLI installed and authenticated
  - `claude auth login`, or
  - `ANTHROPIC_API_KEY` set in the environment
- either the hosted Sendbird Codex marketplace or a local plugin registration in Codex

## Install

### Hosted marketplace install

Install from the dedicated marketplace repository:

```text
https://github.com/sendbird/codex-plugins
```

In Codex:

1. Add the GitHub repository above as a repo marketplace.
2. Install the plugin as:

```text
cc@sendbird-codex
```

The plugin source repository for development and release work lives at:

```text
https://github.com/sendbird/cc-plugin-codex
```

### Local development install

Clone this repository and `cd` into it:

```bash
git clone https://github.com/sendbird/cc-plugin-codex.git
cd cc-plugin-codex
```

Add this plugin to your local Codex marketplace file at:

```text
~/.agents/plugins/marketplace.json
```

Example entry:

```json
{
  "name": "sendbird-local",
  "interface": {
    "displayName": "Sendbird Local Plugins"
  },
  "plugins": [
    {
      "name": "cc",
      "source": {
        "source": "local",
        "path": "/absolute/path/to/cc-plugin-codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_USE"
      },
      "category": "Coding"
    }
  ]
}
```

Install the hooks and the global `cc-rescue` agent:

```bash
node scripts/install-hooks.mjs
```

Enable Codex hooks in `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
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

The sections below intentionally mirror the upstream plugin's command layout. The main difference is the command surface: in Codex you invoke these as `$cc:*` skills instead of Claude slash commands.

### `$cc:review`

Runs a normal Claude Code review on your current work.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch such as `main` or `master`

It supports `--base <ref>`, `--scope <auto|working-tree|branch>`, `--wait`, `--background`, and `--model <model>`.

Examples:

```text
$cc:review
$cc:review --base main
$cc:review --background
```

This command is read-only and will not edit code. When run in the background, use `$cc:status` to check progress and `$cc:cancel` to stop it.

### `$cc:adversarial-review`

Runs a steerable review that questions the chosen implementation and design.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas such as auth, data loss, rollback, race conditions, or reliability

It uses the same target selection as `$cc:review`, including `--base <ref>`, and also accepts extra focus text after the flags.

Examples:

```text
$cc:adversarial-review
$cc:adversarial-review --base main challenge whether this was the right caching and retry design
$cc:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `$cc:rescue`

Hands a task to Claude Code through the globally registered `cc-rescue` agent and the tracked-job runtime.

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

Notes:

- `--model` and `--effort` target the Claude runtime, not the Codex subagent.
- If you omit `--resume`, `--resume-last`, and `--fresh`, the plugin can offer to continue the latest Claude task for the current session.
- `--background` and `--wait` are Codex-side execution controls. The inner companion task still runs in the foreground inside its own subagent thread.

### `$cc:status`

Shows running and recent Claude Code jobs for the current repository.

Examples:

```text
$cc:status
$cc:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

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

If Claude Code is missing and `npm` is available, the setup flow can direct you to install it.

#### Enabling the review gate

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

### Challenge a Design Choice

```text
$cc:adversarial-review --background question the retry, rollback, and caching strategy
```

### Hand a Problem to Claude Code

```text
$cc:rescue fix the failing test with the smallest safe patch
```

### Continue a Previous Claude Task

```text
$cc:rescue --resume apply the top fix from the last run
```

## Claude Code Integration

This plugin mirrors the upstream OpenAI plugin's command set and stop-review-gate semantics as closely as Claude Code allows, but the implementation has to match Claude's CLI-oriented runtime:

- `scripts/claude-companion.mjs` owns setup, review launches, tracked jobs, status/result/cancel, and stop-gate integration.
- `scripts/lib/claude-cli.mjs` wraps `claude -p` and parses `stream-json` output.
- `hooks/hooks.json` installs `SessionStart`, `SessionEnd`, `Stop`, and `UserPromptSubmit` hooks into Codex.
- Read-only reviews are enforced through Claude tool allowlists and temporary settings files, because Claude Code does not expose Codex's OS-level sandbox model.
- Nested rescue subagent sessions suppress interactive hooks so unread-result prompts and stop-time reviews stay attached to the user-facing Codex session instead of child helper sessions.

At a high level, the runtime looks like this:

```text
Codex (host)
  └── Claude Code plugin
        ├── skills/*
        ├── hooks/*
        ├── agents/cc-rescue.toml (template)
        └── scripts/claude-companion.mjs
              └── scripts/lib/claude-cli.mjs
                    └── claude -p
```

## Development

Run the local test suite with:

```bash
npm test
npm run test:integration
npm run test:e2e
```

If you change hooks, skills, or the installed rescue agent contract, rerun:

```bash
node scripts/install-hooks.mjs
```

To enable local Git hooks for lint and typecheck before each commit, run:

```bash
npm run setup:git-hooks
```

## Acknowledgements

- Inspired by [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
- Built as a reverse Codex-to-Claude companion for users who prefer to stay inside Codex

## License

Apache-2.0
