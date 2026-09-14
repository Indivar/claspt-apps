# @claspt/sdk

A small client for the Claspt local API: the encrypted secrets and project
memory a running Claspt desktop app (or `claspt serve`) holds on this machine.
No dependencies; uses `fetch`.

```ts
import { ClasptClient } from "@claspt/sdk";

const vault = new ClasptClient({ token: process.env.CLASPT_API_TOKEN! });
await vault.status();
await vault.memoryUpsert("decisions", "# Decisions", { namespace: "my-app", kind: "semantic" });
const hits = await vault.memorySearch("database", { namespaces: ["my-app", "global"] });

const [hit] = await vault.findSecrets("stripe");
const ref = hit.reference_prefix + "api_key";  // claspt://secret/<page>?block=<label>#api_key
const { value } = await vault.readSecretByReference(ref); // the owner may be asked to approve
```

Tokens come from the desktop (Settings > Integrations, or `claspt tokens create`).
`tools(client, namespace)` returns framework-neutral tool definitions (name,
description, JSON schema, handler) for wiring into any agent runtime.

Source-available under the PolyForm Shield License 1.0.0; see LICENSE.
