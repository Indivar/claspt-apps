# Claspt with Claude Code

1. Install Claspt, open your vault, and enable the local API (Settings > Integrations > Local API).
2. In your project directory:

   ```bash
   claspt mcp install claude-code --secrets --project
   ```

   This writes the MCP server entry into Claude Code's config with a token minted for it, and prints what it wrote (`--print` shows it without writing).
3. Start Claude Code in the project. The first thing to run is the `start-session` prompt (or ask it to call `memory_guide`); if `memory_list` is empty, `bootstrap_project` seeds the guide, conventions, decisions and session-log pages plus the shared `global` namespace.
4. Keep the instruction block for agents in your `CLAUDE.md` (Claspt's help page "AI Integration" has it), so every session loads memory first and stores credentials with `store_secret` rather than in files.

## What the agent can do now

- **Memory**: `memory_guide` first, then `memory_read`, `memory_upsert`, `memory_append`, `memory_search`, `memory_verify`, `memory_compact`. Memory is namespaced by project (the folder name, or a `.claspt` marker; `claspt namespace init` pins it, and a marker that came with a clone counts only after `claspt namespace trust`). What an agent writes is unreviewed until you mark it reviewed in Settings > Agent Memory; agents see that mark.
- **Secrets**: `find_secrets` returns names and a `reference_prefix`, never values. `read_secret` decrypts after you approve in the app (Settings > Integrations > Secret access: "approve"). Agents are told to put `claspt://secret/...` references, not values, into files, and to run programs with `claspt run`.
- **Browser**: `browser_login` logs you in on a site through the extension without handing the agent the password.

Everything is logged: Settings > Integrations > Activity, or `claspt log`.

## Tokens and scopes

`claspt mcp install` registers a token in the vault the app has open. Without `--project` or `--separate` it is the one token every AI tool on the machine shares, refreshed in every config that carried the previous one; `claspt mcp doctor` shows which config holds a token the vault does not know. With `--project` the client it configures gets a token of its own. `--secrets` gives it the Secrets scope (can decrypt, with approval); without it, Notes scope (secrets redacted). `--project` restricts its memory to this project's namespace plus `global`. Revoke in Settings > Integrations > Clients, or `claspt tokens revoke <id>`.
