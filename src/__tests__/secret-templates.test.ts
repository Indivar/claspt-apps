// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The built-in templates are one list for the desktop picker and the
 * extension, and the help page describes that list. These tests keep the
 * list sound (unique ids, machine names other features look for, secrets
 * masked) and fail when the help page stops matching it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SECRET_TEMPLATES,
  fieldName,
  oneLine,
  templateById,
  wantsGenerator,
} from "@claspt/shared/secret-templates";
import { CANONICAL_TOTP_FIELD, isSensitiveField } from "@claspt/shared/credential-fields";
import { BUILT_IN_TEMPLATES, fromSaved, fromSpec } from "@/lib/template-picker";

describe("the built-in secret templates", () => {
  it("are a real set: unique ids and names, every field labelled", () => {
    expect(SECRET_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SECRET_TEMPLATES.map((t) => t.id)).size).toBe(SECRET_TEMPLATES.length);
    expect(new Set(SECRET_TEMPLATES.map((t) => t.name)).size).toBe(
      SECRET_TEMPLATES.length,
    );
    for (const t of SECRET_TEMPLATES) {
      expect(t.fields.length, t.id).toBeGreaterThanOrEqual(2);
      expect(t.tag, t.id).toMatch(/^[a-z0-9-]+$/);
      for (const f of t.fields) expect(f.label.trim(), t.id).not.toBe("");
    }
  });

  it("write the machine names other features look for", () => {
    const login = templateById("login");
    expect(login?.fields.map(fieldName)).toContain(CANONICAL_TOTP_FIELD);
    const ssh = templateById("ssh-key");
    expect(ssh?.fields.map(fieldName)).toEqual(
      expect.arrayContaining(["private_key", "passphrase", "public_key"]),
    );
    expect(ssh?.tag).toBe("ssh-key");
    // An explicit key is a machine name: lower case, underscores, nothing else.
    for (const t of SECRET_TEMPLATES) {
      for (const f of t.fields) {
        if (f.key) expect(f.key, `${t.id}/${f.label}`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it("mask every field that holds a secret, on every surface", () => {
    const secretFields: [string, string][] = [
      ["login", "Password"],
      ["login", "Authenticator Key"],
      ["login", "Backup Codes"],
      ["ssh-key", "Private Key"],
      ["ssh-key", "Passphrase"],
      ["database", "Connection String"],
      ["api-key", "API Key"],
      ["api-key", "API Secret"],
      ["licence", "Licence Key"],
      ["credit-card", "Card Number"],
      ["credit-card", "CVV"],
      ["bank", "Account Number"],
      ["wifi", "Password"],
      ["wallet", "Seed Phrase"],
    ];
    for (const [id, label] of secretFields) {
      const field = templateById(id)?.fields.find((f) => f.label === label);
      expect(field, `${id}/${label}`).toBeDefined();
      if (field) expect(isSensitiveField(fieldName(field)), `${id}/${label}`).toBe(true);
    }
    for (const label of ["URL", "Username", "Host", "SSID", "Bank", "Product"]) {
      expect(isSensitiveField(label), label).toBe(false);
    }
  });

  it("offer a generator for what a person would make up, never for what a site issued", () => {
    for (const name of [
      "Password",
      "password",
      "passphrase",
      "PIN",
      "api_key",
      "API Secret",
    ]) {
      expect(wantsGenerator(name), name).toBe(true);
    }
    for (const name of [
      "totp",
      "Backup Codes",
      "seed_phrase",
      "card_number",
      "license_key",
      "Username",
    ]) {
      expect(wantsGenerator(name), name).toBe(false);
    }
  });

  it("keep a pasted key or phrase on one line", () => {
    expect(oneLine("-----BEGIN KEY-----\nAAAA\n  BBBB \n-----END KEY-----\n")).toBe(
      "-----BEGIN KEY----- AAAA BBBB -----END KEY-----",
    );
    expect(oneLine("plain")).toBe("plain");
  });
});

describe("the picker's view of the templates", () => {
  it("shows every built-in template and Custom last", () => {
    expect(BUILT_IN_TEMPLATES.map((t) => t.id)).toEqual([
      ...SECRET_TEMPLATES.map((t) => t.id),
      "custom",
    ]);
  });

  it("writes the label unless the template names a machine key", () => {
    const login = fromSpec(templateById("login")!);
    const totp = login.fields.find((f) => f.key === "Authenticator Key");
    expect(totp?.fieldKey).toBe("totp");
    const url = login.fields.find((f) => f.key === "URL");
    expect(url?.fieldKey).toBeUndefined();
  });

  it("brings a saved template in with its own keys", () => {
    const shaped = fromSaved({
      id: "custom-1",
      name: "Registrar",
      icon: "🔐",
      fields: [
        { key: "registrar", label: "Registrar", field_type: "text", required: true },
        {
          key: "auth_code",
          label: "Transfer code",
          field_type: "password",
          required: false,
        },
      ],
      use_count: 3,
      created_at: "2026-09-23T00:00:00Z",
    });
    expect(shaped.label).toBe("Registrar");
    expect(shaped.fields.map((f) => [f.key, f.fieldKey])).toEqual([
      ["Registrar", "registrar"],
      ["Transfer code", "auth_code"],
    ]);
  });
});

describe("the help page", () => {
  const help = readFileSync(
    join(process.cwd(), "src-tauri/src/vault/help_pages.rs"),
    "utf8",
  );
  const section = help.slice(
    help.indexOf("## Secret Templates"),
    help.indexOf("## Convert Selection"),
  );

  it("lists exactly the built-in templates, in the picker's order", () => {
    const listed = [...section.matchAll(/^\| \*\*(.+?)\*\* \|/gm)].map((m) => m[1]);
    expect(listed).toEqual([...SECRET_TEMPLATES.map((t) => t.name), "Custom"]);
  });

  it("names each template's fields as the picker labels them", () => {
    for (const t of SECRET_TEMPLATES) {
      const row = section
        .split("\n")
        .find((line) => line.startsWith(`| **${t.name}** |`));
      expect(row, t.name).toBeDefined();
      const listed =
        row
          ?.split("|")[2]
          ?.split(",")
          .map((s) => s.trim()) ?? [];
      expect(listed, t.name).toEqual(t.fields.map((f) => f.label));
    }
  });

  it("tells extension users the same set is theirs", () => {
    const line = help
      .split("\n")
      .find((l) => l.includes("Choose from the same templates"));
    expect(line).toBeDefined();
    for (const t of SECRET_TEMPLATES) expect(line, t.name).toContain(t.name);
  });
});
