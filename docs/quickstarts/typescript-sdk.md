# Claspt from TypeScript

```bash
npm install @claspt/sdk
claspt tokens create "my-agent" --secrets --namespaces my-app   # prints the token once
```

```ts
import { ClasptClient, tools } from "@claspt/sdk";

const vault = new ClasptClient({ token: process.env.CLASPT_API_TOKEN! });
await vault.memoryUpsert("decisions", "# Decisions", { namespace: "my-app", kind: "semantic" });
const { hits } = await vault.memorySearch("database", { namespaces: ["my-app", "global"] });

const [hit] = await vault.findSecrets("stripe");
const { value } = await vault.readSecretByReference(hit.reference_prefix + "api_key");

// Framework-neutral tool definitions (name, description, JSON schema, handler)
const defs = tools(vault, "my-app");
```

## What the agent can do now

- **Memory**: `memory_guide` first, then `memory_read`, `memory_upsert`, `memory_append`, `memory_search`, `memory_verify`, `memory_compact`. Memory is namespaced by project (the folder name, or a `.claspt` marker; `claspt namespace init` pins it). What an agent writes is unreviewed until you mark it reviewed in Settings > Agent Memory; agents see that mark.
- **Secrets**: `find_secrets` returns names and a `reference_prefix`, never values. `read_secret` decrypts after you approve in the app (Settings > Integrations > Secret access: "approve"). Agents are told to put `claspt://secret/...` references, not values, into files, and to run programs with `claspt run`.
- **Browser**: `browser_login` logs you in on a site through the extension without handing the agent the password.

Everything is logged: Settings > Integrations > Activity, or `claspt log`.

## Tokens and scopes

`claspt mcp install` mints a named client token for the client it configures. `--secrets` gives it the Secrets scope (can decrypt, with approval); without it, Notes scope (secrets redacted). `--project` restricts its memory to this project's namespace plus `global`. Revoke in Settings > Integrations > Clients, or `claspt tokens revoke <id>`.
