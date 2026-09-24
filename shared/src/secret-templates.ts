// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The built-in secret templates, shared by the desktop's picker
 * (Cmd+Shift+S) and the extension's Add new form so the two cannot drift.
 *
 * A field is written into the block as `label: value`, and the reader of a
 * block lowercases every key. Where another feature looks for an exact
 * machine name, the field carries a `key` that is written instead of the
 * label: `totp` for the two-factor seed, `private_key` for the SSH agent,
 * `api_key` for automation references, and so on. Block fields are single
 * lines, so a pasted key or seed phrase is stored on one line; the SSH
 * agent accepts a PEM squashed that way.
 */
import { isSensitiveField } from "./credential-fields";

export interface TemplateFieldSpec {
  /** What the person reads beside the box. */
  label: string;
  /** The name written into the block when it must differ from the label. */
  key?: string;
  placeholder?: string;
  /** One line under the box, for a field nobody can guess the shape of. */
  hint?: string;
}

export interface SecretTemplateSpec {
  id: string;
  name: string;
  /** An icon id both surfaces know how to draw. */
  icon: string;
  /** The tag the extension puts on a page it saves from this template. */
  tag: string;
  fields: TemplateFieldSpec[];
}

const TOTP_FIELD: TemplateFieldSpec = {
  label: "Authenticator Key",
  key: "totp",
  placeholder: "otpauth://totp/... or the key the site shows",
  hint: 'For sites that ask for a 6-digit code. On the site, choose "can’t scan the code?" beside the QR image and copy what it shows.',
};

export const SECRET_TEMPLATES: readonly SecretTemplateSpec[] = [
  {
    id: "login",
    name: "Website Login",
    icon: "globe",
    tag: "login",
    fields: [
      { label: "URL", placeholder: "https://example.com" },
      { label: "Username", placeholder: "user@example.com" },
      { label: "Password" },
      TOTP_FIELD,
      {
        label: "Backup Codes",
        placeholder: "One-time codes for if you lose your device",
      },
    ],
  },
  {
    id: "email",
    name: "Email Account",
    icon: "mail",
    tag: "email",
    fields: [
      { label: "Email", placeholder: "you@example.com" },
      { label: "Password" },
      { label: "IMAP Server", placeholder: "imap.example.com:993" },
      { label: "SMTP Server", placeholder: "smtp.example.com:587" },
      TOTP_FIELD,
    ],
  },
  {
    id: "server",
    name: "Server Login",
    icon: "server",
    tag: "server",
    fields: [
      { label: "Host", placeholder: "server.example.com" },
      { label: "Port", placeholder: "22" },
      { label: "Username", placeholder: "root" },
      { label: "Password" },
      { label: "Notes", placeholder: "What runs here, who else has access" },
    ],
  },
  {
    id: "ssh-key",
    name: "SSH Key",
    icon: "terminal",
    tag: "ssh-key",
    fields: [
      { label: "Host", placeholder: "server.example.com" },
      { label: "Username", placeholder: "deploy" },
      {
        label: "Private Key",
        key: "private_key",
        placeholder: "Paste the whole key file",
        hint: "Stored on one line. Tag the page ssh-key and the SSH agent offers this key to ssh and git without it ever leaving the vault.",
      },
      { label: "Passphrase", key: "passphrase", placeholder: "If the key has one" },
      { label: "Public Key", key: "public_key", placeholder: "ssh-ed25519 AAAA..." },
    ],
  },
  {
    id: "database",
    name: "Database",
    icon: "database",
    tag: "database",
    fields: [
      { label: "Host", placeholder: "db.example.com" },
      { label: "Port", placeholder: "5432" },
      { label: "Database", placeholder: "app_production" },
      { label: "Username" },
      { label: "Password" },
      {
        label: "Connection String",
        key: "connection_string",
        placeholder: "postgres://user:pass@host:5432/db",
      },
    ],
  },
  {
    id: "api-key",
    name: "API Key",
    icon: "key",
    tag: "api-key",
    fields: [
      { label: "Service", placeholder: "GitHub, OpenAI, Anthropic, Stripe..." },
      { label: "API Key", key: "api_key" },
      {
        label: "API Secret",
        key: "api_secret",
        placeholder: "If the service gives a second value",
      },
      { label: "Endpoint", placeholder: "https://api.example.com" },
      {
        label: "Rotate Every",
        placeholder: "90 days",
        hint: "A note for you; the rotation reminder in Settings works from the secret's age.",
      },
    ],
  },
  {
    id: "env-var",
    name: "Environment Variable",
    icon: "gear",
    tag: "env",
    fields: [
      { label: "Variable", placeholder: "DATABASE_URL" },
      { label: "Value" },
      {
        label: "Used By",
        placeholder: "The program or job that reads it",
        hint: "claspt run can hand this value to a command without the value ever being printed.",
      },
    ],
  },
  {
    id: "licence",
    name: "Software Licence",
    icon: "licence",
    tag: "licence",
    fields: [
      { label: "Product", placeholder: "Name and version" },
      { label: "Licence Key", key: "license_key" },
      { label: "Registered To", placeholder: "Name or email on the licence" },
      { label: "Purchase Date", placeholder: "YYYY-MM-DD" },
      { label: "Seats", placeholder: "How many installs it allows" },
    ],
  },
  {
    id: "credit-card",
    name: "Credit Card",
    icon: "card",
    tag: "credit-card",
    fields: [
      { label: "Card Number", key: "card_number", placeholder: "4111 1111 1111 1111" },
      { label: "Cardholder", placeholder: "Name on card" },
      { label: "Expiry", placeholder: "MM/YY" },
      { label: "CVV", placeholder: "123" },
      { label: "PIN" },
    ],
  },
  {
    id: "bank",
    name: "Bank Account",
    icon: "bank",
    tag: "bank",
    fields: [
      { label: "Bank", placeholder: "Bank name" },
      { label: "Account Number", key: "account_number" },
      { label: "IFSC / SWIFT / Routing", key: "bank_code" },
      { label: "Branch" },
      { label: "Type", placeholder: "Savings / Current" },
    ],
  },
  {
    id: "wifi",
    name: "Wi-Fi Network",
    icon: "wifi",
    tag: "wifi",
    fields: [
      { label: "SSID", placeholder: "Network name" },
      { label: "Password" },
      { label: "Security", placeholder: "WPA2 / WPA3" },
    ],
  },
  {
    id: "identity-document",
    name: "Identity Document",
    icon: "id",
    tag: "identity-document",
    fields: [
      { label: "Type", placeholder: "Passport / Licence / Aadhaar" },
      { label: "Number", key: "document_number" },
      { label: "Issue Date", placeholder: "YYYY-MM-DD" },
      { label: "Expiry Date", placeholder: "YYYY-MM-DD" },
      { label: "Authority" },
    ],
  },
  {
    id: "wallet",
    name: "Crypto Wallet",
    icon: "wallet",
    tag: "wallet",
    fields: [
      { label: "Wallet", placeholder: "Which wallet or exchange" },
      { label: "Address", placeholder: "The public address" },
      {
        label: "Seed Phrase",
        key: "seed_phrase",
        placeholder: "The recovery words, in order",
        hint: "Anyone with these words owns the funds. Stored on one line, encrypted like every secret.",
      },
      { label: "Passphrase", key: "passphrase", placeholder: "If the wallet has one" },
    ],
  },
];

/** The name written into the block for a field. */
export function fieldName(field: TemplateFieldSpec): string {
  return field.key ?? field.label;
}

export function templateById(id: string): SecretTemplateSpec | undefined {
  return SECRET_TEMPLATES.find((t) => t.id === id);
}

/**
 * Whether a field deserves a Generate button: something a person would
 * otherwise make up, never a seed, a card number or a code the site issued.
 */
export function wantsGenerator(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  if (
    /(seed|mnemonic|card|account|backup|recovery|totp|otp|2fa|authenticator|licen[cs]e)/.test(
      key,
    )
  ) {
    return false;
  }
  return (
    /(password|passphrase|^pin$|cvv|secret|^key$|api[ _-]?key|token)/.test(key) ||
    isSensitiveField(key)
  );
}

/** Block fields are single lines; a pasted key or phrase is joined with spaces. */
export function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}
