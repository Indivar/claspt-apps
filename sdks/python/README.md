# claspt (Python)

A small client for the Claspt local API: the encrypted secrets and project
memory a running Claspt desktop app (or `claspt serve`) holds on this machine.
No dependencies beyond the standard library.

```python
from claspt import Claspt

vault = Claspt()                      # token from CLASPT_API_TOKEN, port 9315
vault.status()["mode"]                # "desktop" or "headless"

# Memory
vault.memory_guide()
vault.memory_upsert("decisions", "# Decisions\n\n- Use Postgres", kind="semantic")
vault.memory_read("decisions")["content"]
vault.memory_search("database")["hits"]

# Secrets: prefer references over values
hit = vault.find_secrets("stripe")[0]
ref = hit["reference_prefix"] + "api_key"   # claspt://secret/<page>?block=<label>#api_key
vault.read_secret(reference=ref)["value"]   # the owner may be asked to approve
```

Tokens come from the desktop (Settings > Integrations, or `claspt tokens create`).
Set `CLASPT_API_TOKEN` in the environment rather than passing it in code.

Adapters, each an optional extra:

```python
from claspt.adapters.langchain import tools        # pip install claspt[langchain]
from claspt.adapters.openai_agents import tools    # pip install claspt[openai-agents]
from claspt.adapters.crewai import tools           # pip install claspt[crewai]
```

Each returns the same set of tools (`memory_read`, `memory_upsert`,
`memory_search`, `find_secrets`, `read_secret`, `store_secret`) built for that
framework from one definition in `claspt.tools`.

Source-available under the PolyForm Shield License 1.0.0; see LICENSE.
