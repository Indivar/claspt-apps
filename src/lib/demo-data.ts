// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * demo-data.ts — sample content for populating a fresh/empty vault.
 *
 * {@link seedDemoData} creates a handful of illustrative pages (welcome guide,
 * markdown showcase, example credential pages with `:::secret` blocks, notes) so
 * a new user sees a working vault instead of a blank slate. The secret values in
 * these pages are obviously fake placeholders, not real credentials.
 */
import * as cmd from "@/lib/commands";

/** One seeded page: title, destination folder, and raw markdown body. */
interface DemoPage {
  title: string;
  folder: string;
  content: string;
}

const DEMO_PAGES: DemoPage[] = [
  {
    title: "Welcome to Claspt",
    folder: "general",
    content: `# Welcome to Claspt

Your **personal vault** for markdown notes with *encrypted secret storage*.

Claspt combines the simplicity of plain markdown with **AES-256-GCM encryption** for sensitive data. Your notes stay portable — they're just \`.md\` files. Your secrets stay encrypted on disk.

## How It Works

> Every note is a markdown file. Secrets are embedded using fenced blocks that get encrypted automatically when saved.

### Key Concepts

- **Pages** — Markdown files organized into folders
- **Secret Blocks** — Encrypted fields within any page
- **Folders** — Organize pages by category (e.g., \`credentials\`, \`general\`)
- **Tags** — Cross-cutting labels for filtering

### Getting Started

1. Use the **+ New** button in the sidebar to create a page
2. Write in markdown — the toolbar has formatting shortcuts
3. Add encrypted secrets with \`Cmd/Ctrl+Shift+S\`
4. Use \`Cmd/Ctrl+K\` to search across all your pages

#### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| \`Cmd/Ctrl+K\` | Search pages |
| \`Cmd/Ctrl+B\` | Toggle sidebar |
| \`Cmd/Ctrl+I\` | Inspector panel |
| \`Cmd/Ctrl+,\` | Settings |
| \`Cmd/Ctrl+Shift+S\` | Insert secret |
| \`Cmd/Ctrl+Shift+L\` | Lock vault |
| \`Cmd/Ctrl+\\\\\` | Toggle split view |
| \`Cmd/Ctrl+/\` | Toggle preview |

---

*This is a demo page. Feel free to edit or delete it.*
`,
  },
  {
    title: "Markdown Showcase",
    folder: "general",
    content: `# Markdown Showcase

This page demonstrates all the markdown elements Claspt supports.

## Text Formatting

Regular paragraph text. **Bold text**, *italic text*, ~~strikethrough~~, and \`inline code\`.

## Code Blocks

\`\`\`typescript
interface SecretBlock {
  label: string;
  value: string;
  encrypted: boolean;
}

function encrypt(block: SecretBlock): string {
  return \`enc:v1:\${btoa(block.value)}\`;
}
\`\`\`

\`\`\`bash
# Build the desktop app
cargo tauri build

# Run in development
cargo tauri dev
\`\`\`

## Tables

| Feature | Free | Pro |
|---------|------|-----|
| Local vault | Yes | Yes |
| Encryption | AES-256 | AES-256 |
| Search | Full-text | Full-text |
| Sync | — | Git-based |
| Mobile | — | iOS + Android |

## Lists

### Unordered
- First level item
  - Nested item
  - Another nested
    - Even deeper
- Back to first level

### Ordered
1. Step one
2. Step two
3. Step three

### Task List
- [x] Create vault
- [x] Add first page
- [ ] Set up sync
- [ ] Install mobile app

## Blockquotes

> "The only truly secure system is one that is powered off, cast in a block of concrete and sealed in a lead-lined room with armed guards."
> — Gene Spafford

## Links

Visit [Claspt documentation](https://claspt.app/docs) for more.

---

## Horizontal Rule

Content above and below the rule.

---

*End of markdown showcase.*
`,
  },
  {
    title: "API Credentials",
    folder: "credentials",
    content: `# API Credentials

Sensitive API keys and tokens for development services.

## GitHub

:::secret[GitHub Personal Access Token]
ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
:::

Used for repository access and CI/CD pipelines. Scope: \`repo\`, \`workflow\`, \`read:org\`.

**Expires:** 2026-12-31

## AWS

:::secret[AWS Access Keys]
Access Key ID: AKIAIOSFODNN7EXAMPLE
Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Region: us-east-1
:::

Production account credentials. Used for S3, Lambda, and DynamoDB access.

> **Reminder:** Rotate these keys quarterly.

## Database

:::secret[Production Database]
Host: db.example.com
Port: 5432
Database: claspt_prod
Username: admin
Password: super-secret-db-password-2026
:::

PostgreSQL connection details for the production database. Read replicas available on port 5433.
`,
  },
  {
    title: "Server Logins",
    folder: "credentials",
    content: `# Server Logins

Access credentials for infrastructure servers.

## Production Server

:::secret[Production SSH Access]
Host: prod.example.com
Username: deploy
SSH Key: ~/.ssh/prod_rsa
Passphrase: my-ssh-key-passphrase
:::

- **OS:** Ubuntu 24.04 LTS
- **Region:** US-East
- **Last rotated:** 2026-01-15

## Staging Server

:::secret[Staging Credentials]
URL: https://staging.example.com
Username: admin@example.com
Password: staging-pass-2026!
API Key: stg_k3y_a1b2c3d4e5f6
:::

Staging environment mirrors production. Data is refreshed weekly from anonymized production snapshots.

### Access Notes

1. VPN required for SSH access
2. 2FA enabled on web dashboard
3. Keys rotate every 90 days
`,
  },
  {
    title: "Project Notes",
    folder: "general",
    content: `# Project Notes

## Architecture Decision: State Management

After evaluating Redux, MobX, and Zustand, we chose **Zustand** for the following reasons:

- Minimal boilerplate — no providers, reducers, or action creators
- Built-in support for middleware (persist, devtools)
- TypeScript-first with excellent inference
- Tiny bundle size (~1KB)

> Zustand's philosophy of "just a hook" aligns perfectly with our component architecture.

### Store Structure

\`\`\`
stores/
  vault-store.ts   — auth state, config, lock/unlock
  pages-store.ts   — page CRUD, active page, secrets
  search-store.ts  — search query, results, scope
  ui-store.ts      — sidebar, theme, modals, panels
\`\`\`

## Encryption Key for CI

:::secret[CI Signing Key]
SIGNING_KEY=base64encodedkey123456789
SIGNING_CERT=base64encodedcert987654321
:::

Used by the CI/CD pipeline for code signing.

## Performance Benchmarks

| Operation | Time (p50) | Time (p99) |
|-----------|-----------|-----------|
| Page load | 12ms | 45ms |
| Search (1k pages) | 8ms | 22ms |
| Encrypt block | 0.3ms | 1.2ms |
| Decrypt block | 0.2ms | 0.8ms |

## Next Steps

- [ ] Add biometric unlock support
- [ ] Cross-platform build pipeline
- [x] Tantivy search with field boosts
- [x] Auto-commit with 5s batch window
`,
  },
  {
    title: "Meeting Notes",
    folder: "general",
    content: `# Meeting Notes

## Sprint Planning — Feb 20, 2026

### Attendees
- Alice (Engineering Lead)
- Bob (Backend)
- Carol (Frontend)
- Dave (Design)

### Agenda

1. **Sprint Review**
   - Completed 12 of 14 stories
   - Two stories rolled over:
     - Biometric unlock (blocked on Tauri plugin)
     - Windows .msi signing

2. **Sprint Goals**
   - Cross-platform builds
     - Windows .msi
     - Linux .AppImage and .deb
     - macOS .dmg (already working)
   - Polish pass on all screens
     - Unlock screen redesign
     - Sidebar refinements
     - Inspector panel improvements

3. **Tech Debt**
   - [ ] Migrate from \`raw-window-handle\` 0.5 to 0.6
   - [ ] Fix flaky search index test
   - [x] Add clipboard auto-clear
   - [x] Resolve ESLint strict mode warnings

### Action Items

- [ ] Alice: Set up Windows CI runner
- [ ] Bob: Research Tauri biometric plugin compatibility
- [x] Carol: Implement theme toggle persistence
- [ ] Dave: Design onboarding flow mockups

### Notes

> Carol raised a good point about using key-based component reset instead of \`setState\` in \`useEffect\`. We should adopt this pattern across all modal components.

The team agreed to maintain a weekly cadence for the remaining Phase 2 work. Target completion: **March 15, 2026**.

---

## Retrospective — Feb 13, 2026

### What went well
- Crypto engine has 89 passing tests
- Search with field boosts working great
- Git auto-commit batch window prevents thrashing

### What to improve
- Better error messages for vault operations
- Need more E2E test coverage
- Documentation for secret block syntax
`,
  },
  {
    title: "Quick Reference",
    folder: "general",
    content: `# Quick Reference

## Secret Block Syntax

Secret blocks use the \`:::secret\` fenced syntax:

\`\`\`markdown
:::secret[My Label]
sensitive value here
:::
\`\`\`

- **Labels** are stored in plaintext (for searching)
- **Values** are AES-256-GCM encrypted on disk
- Format on disk: \`enc:v1:<base64-ciphertext>\`

## Vault Directory Structure

| Path | Purpose |
|------|---------|
| \`~/Claspt/\` | Vault root |
| \`general/\` | Default folder |
| \`credentials/\` | Suggested for sensitive data |
| \`.securenotes/config.json\` | Vault configuration |
| \`.securenotes/vault.key\` | Encrypted master key |
| \`.securenotes/index/\` | Tantivy search index |
| \`.securenotes/license.token\` | License token |
| \`.git/\` | Auto-initialized for versioning |

## Frontmatter Fields

Every page has YAML frontmatter:

\`\`\`yaml
---
id: "uuid-v4"
title: "Page Title"
created_at: "2026-02-22T10:00:00Z"
updated_at: "2026-02-22T10:00:00Z"
pinned: false
archived: false
tags: ["tag1", "tag2"]
folder: "general"
---
\`\`\`

## File Naming Convention

Pages follow the pattern: \`YYYY-MM-DD-HHMMSS-title-slug.md\`

Example: \`2026-02-22-143000-quick-reference.md\`

## Search Field Boosts

| Field | Boost |
|-------|-------|
| Title | 3x |
| Tags | 2x |
| Secret labels | 2x |
| Content | 1x |

## Encryption Details

| Parameter | Value |
|-----------|-------|
| Algorithm | AES-256-GCM |
| KDF | Argon2id |
| Salt | 32 bytes random |
| Nonce | 12 bytes per block |
| Key length | 256 bits |
`,
  },
];

/** Seed the vault with demo pages. Returns the count of pages created. */
export async function seedDemoData(): Promise<number> {
  let count = 0;
  for (const page of DEMO_PAGES) {
    await cmd.createPage(page.title, page.folder, page.content);
    count++;
  }
  return count;
}
