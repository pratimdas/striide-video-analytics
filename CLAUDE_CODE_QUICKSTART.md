# Claude Code quickstart for this build

1. Extract a fresh copy of this pack into a dedicated Claude build folder. Use another fresh copy for Cursor. Do not point both agents at the same working directory.
2. Install/sign into Claude Code if needed using its current official guide: https://code.claude.com/docs/en/quickstart. On Windows, the documented WinGet option is winget install Anthropic.ClaudeCode. Verify with claude --version.
3. Use the same native Windows or WSL environment as the Cursor experiment. Native Windows keeps the example C:/ paths valid. If using WSL, deliberately convert all paths and use the same mode for both builds.
4. Copy .env.example to .env and config.example.yaml to config.local.yaml. Enter application keys locally and choose the Claude folder's distinct Docker project/ports as described in docs/07.
5. Open a terminal in the extracted project root and run claude. Complete its own sign-in if prompted; coding-agent authentication is separate from the application's TwelveLabs/Gemini keys.
6. Paste the contents of CLAUDE_CODE_START.md, or ask: Read CLAUDE_CODE_START.md and implement the complete shared BUILD_TASK.md.

The root CLAUDE.md provides Claude Code project instructions and explicitly imports AGENTS.md. Do not overwrite it with a generated initialisation file before the comparison. Check loaded project context if the CLI is not following it. No custom plugin, MCP server or Anthropic API integration in the application is required by this pack.

Use the same implementation task, inputs and acceptance criteria as Cursor. The report UI and internal telemetry requirements apply equally. Keep coding-agent usage/time separate from the cost and latency of running the resulting video-analysis application.

Sources checked 9 November 2026:
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/quickstart
- https://code.claude.com/docs/en/setup
