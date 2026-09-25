#!/usr/bin/env node
// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Sync the version from package.json (single source of truth)
 * into tauri.conf.json, Cargo.toml, the MCP manifest and the OpenAPI document.
 *
 * Usage: node scripts/sync-version.js
 * Runs automatically via predev / prebuild npm scripts.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// 1. Read version from package.json
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
const version = pkg.version;

// 2. Sync tauri.conf.json
const tauriConfPath = resolve(root, "src-tauri/tauri.conf.json");
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf-8"));
if (tauriConf.version !== version) {
  tauriConf.version = version;
  writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");
  console.log(`synced tauri.conf.json → ${version}`);
} else {
  console.log(`tauri.conf.json already at ${version}`);
}

// 3. Sync the MCP registry manifest, which states the server's version
const manifestPath = resolve(root, "mcp/server.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
if (manifest.version_detail?.version !== version) {
  manifest.version_detail = { ...manifest.version_detail, version };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`synced mcp/server.json → ${version}`);
} else {
  console.log(`mcp/server.json already at ${version}`);
}

// 4. Sync Cargo.toml
const cargoPath = resolve(root, "src-tauri/Cargo.toml");
let cargo = readFileSync(cargoPath, "utf-8");
const cargoVersionRe = /^version\s*=\s*"[^"]*"/m;
const currentMatch = cargo.match(cargoVersionRe);
if (currentMatch && currentMatch[0] !== `version = "${version}"`) {
  cargo = cargo.replace(cargoVersionRe, `version = "${version}"`);
  writeFileSync(cargoPath, cargo);
  console.log(`synced Cargo.toml → ${version}`);
} else {
  console.log(`Cargo.toml already at ${version}`);
}

// 5. Sync the OpenAPI document, whose info.version names the app it describes.
// A test holds the two together, so a bump that forgets this line fails CI.
const openapiPath = resolve(root, "docs/api/openapi.yaml");
let openapi = readFileSync(openapiPath, "utf-8");
const openapiVersionRe = /^(info:\n(?:  .*\n)*?  version: )([^\n]*)$/m;
const openapiMatch = openapi.match(openapiVersionRe);
if (openapiMatch && openapiMatch[2] !== version) {
  openapi = openapi.replace(openapiVersionRe, `$1${version}`);
  writeFileSync(openapiPath, openapi);
  console.log(`synced docs/api/openapi.yaml → ${version}`);
} else if (!openapiMatch) {
  console.error("docs/api/openapi.yaml: no info.version line found");
  process.exit(1);
} else {
  console.log(`docs/api/openapi.yaml already at ${version}`);
}
