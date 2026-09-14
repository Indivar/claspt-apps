# Claspt with Cursor

1. Install Claspt, open your vault, and enable the local API (Settings > Integrations > Local API).
2. In your project directory:

   ```bash
   claspt mcp install cursor --secrets --project
   ```

   This writes `.cursor/mcp.json` (or the global Cursor config, without `--project`) with a token minted for Cursor.
3. Open the project in Cursor; the Claspt tools appear in the MCP panel. Run the `start-session` prompt or call `memory_guide` at the start of a task.
4. Bring your rules with you: `claspt memory import --from cursor-rules .cursor/rules` turns each `.mdc` into a procedural memory page.

## What the agent can do now

- **Memory**: `memory_guide` first, then `memory_read`, `memory_upsert`, `memory_append`, `memory_search`, `memory_verify`, `memory_compact`. Memory is namespaced by project (the folder name, or a `.claspt` marker; `claspt namespace init` pins it). What an agent writes is unreviewed until you mark it reviewed in Settings > Agent Memory; agents see that mark.
- **Secrets**: `find_secrets` returns names and a `reference_prefix`, never values. `read_secret` decrypts after you approve in the app (Settings > Integrations > Secret access: "approve"). Agents are told to put `claspt://secret/...` references, not values, into files, and to run programs with `claspt run`.
- **Browser**: `browser_login` logs you in on a site through the extension without handing the agent the password.

Everything is logged: Settings > Integrations > Activity, or `claspt log`.

## Tokens and scopes

`claspt mcp install` mints a named client token for the client it configures. `--secrets` gives it the Secrets scope (can decrypt, with approval); without it, Notes scope (secrets redacted). `--project` restricts its memory to this project's namespace plus `global`. Revoke in Settings > Integrations > Clients, or `claspt tokens revoke <id>`.
