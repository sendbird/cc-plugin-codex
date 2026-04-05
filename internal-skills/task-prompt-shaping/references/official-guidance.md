# Official Guidance Digest

This file summarizes the current Anthropic official guidance that is most relevant to rescue prompt shaping.

Primary sources:
- Prompting best practices: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- Claude Code common workflows: https://code.claude.com/docs/en/common-workflows
- Agent Skills best practices: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices

Key takeaways to preserve in rescue prompt shaping:
- Be clear and direct. Claude responds best when the task, output, and constraints are explicit.
- Use examples only when they materially improve format or behavior.
- Use XML tags to separate instructions, context, examples, and inputs.
- For long context, place long evidence blocks high in the prompt and keep the final ask near the end.
- Add roles or output contracts only when they sharpen the behavior.
- Let subagents orchestrate naturally when the work is truly separable, but avoid over-delegating simple tasks.
- Keep skills concise and use progressive disclosure for larger references.
- Prefer deterministic scripts or helpers for deterministic operations instead of asking Claude to improvise them.

Implications for this repo:
- The rescue subagent may tighten the forwarded prompt.
- The rescue subagent should not inspect the repository just to make the prompt nicer.
- The rescue subagent should preserve user intent, add only already-known context, and keep the prompt contract compact.
