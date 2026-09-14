// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Write docs/mcp/reference.md from the MCP server itself, so the reference
 * cannot drift from the code: the binary answers tools/list, prompts/list and
 * resources/templates/list and this renders the answers.
 *
 *   node scripts/gen-mcp-reference.mjs [path/to/claspt]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.argv[2] ?? resolve(root, "target/debug/claspt");

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "prompts/list" },
  { jsonrpc: "2.0", id: 4, method: "resources/templates/list" },
];
// A token makes the server list the vault tools; nothing is called.
const run = spawnSync(binary, ["--mcp"], {
  input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
  env: { ...process.env, CLASPT_API_TOKEN: "clss_reference_only" },
  encoding: "utf8",
});
if (run.status !== 0) {
  console.error(run.stderr);
  process.exit(1);
}
const replies = new Map(
  run.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((r) => [r.id, r.result]),
);
const init = replies.get(1);
const tools = replies.get(2).tools;
const prompts = replies.get(3).prompts;
const templates = replies.get(4).resourceTemplates;

function schemaTable(schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const names = Object.keys(props);
  if (names.length === 0) return "_No arguments._\n";
  const rows = names.map((n) => {
    const p = props[n];
    const type = p.type + (p.enum ? ` (${p.enum.join(" \\| ")})` : "");
    return `| \`${n}\` | ${type} | ${required.has(n) ? "yes" : "no"} | ${(p.description ?? "").replace(/\|/g, "\\|")} |`;
  });
  return (
    ["| Argument | Type | Required | Description |", "|---|---|---|---|", ...rows].join(
      "\n",
    ) + "\n"
  );
}

let md = `# Claspt MCP reference

Generated from the server by \`node scripts/gen-mcp-reference.mjs\`; do not edit by hand.

Server: \`${init.serverInfo.name}\`, protocol ${init.protocolVersion} (also 2025-03-26 and 2024-11-05).
Start it with \`claspt --mcp\`; \`claspt mcp install <client>\` writes the client configuration. \`CLASPT_API_TOKEN\` names the client; the token's scope (Notes or Secrets) and namespaces decide what the tools may do.

## Tools

`;
for (const t of tools) {
  md += `### \`${t.name}\`\n\n${t.description}\n\n${schemaTable(t.inputSchema)}\n`;
}
md += `## Prompts\n\n`;
for (const p of prompts) {
  md += `### \`${p.name}\`\n\n${p.description}\n\n`;
  if (p.arguments?.length) {
    md +=
      [
        "| Argument | Required | Description |",
        "|---|---|---|",
        ...p.arguments.map(
          (a) => `| \`${a.name}\` | ${a.required ? "yes" : "no"} | ${a.description} |`,
        ),
      ].join("\n") + "\n\n";
  }
}
md += `## Resources\n\n\`claspt://memory-guide\` is the memory guide. Every memory page the token may read is listed as a resource:\n\n`;
for (const r of templates) {
  md += `- \`${r.uriTemplate}\`: ${r.description}\n`;
}
md += `\nA resource's \`_meta\` carries \`stale\`, \`reviewed\` and \`etag\`.\n`;
writeFileSync(resolve(root, "docs/mcp/reference.md"), md);
console.log(
  `wrote docs/mcp/reference.md: ${tools.length} tools, ${prompts.length} prompts, ${templates.length} resource templates`,
);
