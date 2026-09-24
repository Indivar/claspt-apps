# Claspt headless: claspt serve

`claspt serve` runs the local API without the desktop app, on a build box, a CI runner or a home server. It unlocks from a key file and decides every request from a policy file; there is no prompt, so what the policy does not allow is refused.

On a machine where you can type the vault password:

```bash
CLASPT_SERVE_PASSPHRASE='a long passphrase for the server' \
  claspt serve init-key --vault ~/Claspt --out serve.key
```

Copy `serve.key` and the vault to the server (the vault password stays with you). Write a policy, starting from [docs/examples/policy.toml](../examples/policy.toml): a rule names a client (from `claspt tokens list`), the actions it may take, and the pages or namespaces it may touch. Then:

```bash
CLASPT_SERVE_PASSPHRASE='a long passphrase for the server' \
  claspt serve run --vault /srv/vault --key-file /etc/claspt/serve.key --policy /etc/claspt/policy.toml --ssh-agent
```

Clients use the same tokens, the same rate limit and the same access log as on the desktop; `/api/status` reports `"mode": "headless"`. Point MCP clients and SDKs at the port as usual.

## What the agent can do now

- **Memory**: `memory_guide` first, then `memory_read`, `memory_upsert`, `memory_append`, `memory_search`, `memory_verify`, `memory_compact`. Memory is namespaced by project (the folder name, or a `.claspt` marker; `claspt namespace init` pins it, and a marker that came with a clone counts only after `claspt namespace trust`). What an agent writes is unreviewed until you mark it reviewed in Settings > Agent Memory; agents see that mark.
- **Secrets**: `find_secrets` returns names and a `reference_prefix`, never values. `read_secret` decrypts after you approve in the app (Settings > Integrations > Secret access: "approve"). Agents are told to put `claspt://secret/...` references, not values, into files, and to run programs with `claspt run`.
- **Browser**: `browser_login` logs you in on a site through the extension without handing the agent the password.

Everything is logged: Settings > Integrations > Activity, or `claspt log`.

## Tokens and scopes

`claspt mcp install` registers a token in the vault the app has open. Without `--project` or `--separate` it is the one token every AI tool on the machine shares, refreshed in every config that carried the previous one; `claspt mcp doctor` shows which config holds a token the vault does not know. With `--project` the client it configures gets a token of its own. `--secrets` gives it the Secrets scope (can decrypt, with approval); without it, Notes scope (secrets redacted). `--project` restricts its memory to this project's namespace plus `global`. Revoke in Settings > Integrations > Clients, or `claspt tokens revoke <id>`.
