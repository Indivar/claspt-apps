# Listing the Claspt MCP server

Claspt's MCP server is the desktop app itself (`claspt --mcp`), a local binary
that talks to the running app; it is not an npm or PyPI package. Registries
differ in what they can list:

| Registry | What it needs | Status |
|---|---|---|
| Official MCP registry (registry.modelcontextprotocol.io) | A `server.json` naming an installable package (npm, PyPI, Docker, MCPB) or a remote URL | `mcp/server.json` is a draft naming an npm launcher `@claspt/mcp` that would exec the installed app. The launcher does not exist yet; publish it (a few lines: find the binary, spawn `claspt --mcp`) before submitting. |
| Smithery, Glama, PulseMCP, mcp.so | A repository link, README and the config snippet | Ready: point at this repository and the [MCP reference](reference.md); the snippet is what `claspt mcp install <client> --print` prints. |
| Claude Desktop / Cursor directories | The config snippet | Same. |

Wording for every listing: "source-available", never "open source"; local-only
(the server talks to the desktop app on 127.0.0.1 and nowhere else); every
secret read is approved by the user in the app.
