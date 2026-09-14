# Claspt from Python

```bash
pip install claspt
claspt tokens create "my-agent" --secrets --namespaces my-app   # in a terminal; prints the token once
export CLASPT_API_TOKEN=clss_...
```

```python
from claspt import Claspt

vault = Claspt()
print(vault.memory_guide())
vault.memory_upsert("decisions", "# Decisions\n\n- Postgres, not SQLite", "my-app", kind="semantic")
for hit in vault.memory_search("database", ["my-app", "global"])["hits"]:
    print(hit["title"], hit["namespace"], hit["stale"])

hit = vault.find_secrets("stripe")[0]
ref = hit["reference_prefix"] + "api_key"
print(vault.read_secret(reference=ref)["value"])   # you approve in the app
```

Framework tools, one definition each way:

```python
from claspt.adapters.langchain import tools        # pip install "claspt[langchain]"
agent_tools = tools(vault, namespace="my-app")
```

`claspt.adapters.openai_agents` and `claspt.adapters.crewai` do the same for those frameworks. Every refusal is a `ClasptError` with the HTTP status (403 when you declined, 429 when the rate limit was hit).

## What the agent can do now

- **Memory**: `memory_guide` first, then `memory_read`, `memory_upsert`, `memory_append`, `memory_search`, `memory_verify`, `memory_compact`. Memory is namespaced by project (the folder name, or a `.claspt` marker; `claspt namespace init` pins it). What an agent writes is unreviewed until you mark it reviewed in Settings > Agent Memory; agents see that mark.
- **Secrets**: `find_secrets` returns names and a `reference_prefix`, never values. `read_secret` decrypts after you approve in the app (Settings > Integrations > Secret access: "approve"). Agents are told to put `claspt://secret/...` references, not values, into files, and to run programs with `claspt run`.
- **Browser**: `browser_login` logs you in on a site through the extension without handing the agent the password.

Everything is logged: Settings > Integrations > Activity, or `claspt log`.

## Tokens and scopes

`claspt mcp install` mints a named client token for the client it configures. `--secrets` gives it the Secrets scope (can decrypt, with approval); without it, Notes scope (secrets redacted). `--project` restricts its memory to this project's namespace plus `global`. Revoke in Settings > Integrations > Clients, or `claspt tokens revoke <id>`.
