// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Help page content for new vaults.
//!
//! Each entry is a (title, markdown_body) tuple. All pages are created in the
//! `help` folder so they're grouped together in the sidebar.

/// Returns all help pages as `(title, body)` pairs, ordered for reading.
pub fn all() -> Vec<(&'static str, &'static str)> {
    vec![
        ("01. Welcome to Claspt", WELCOME),
        ("02. Writing & Editing", WRITING_EDITING),
        ("03. Encrypted Secrets", ENCRYPTED_SECRETS),
        ("04. AI Integration", AI_INTEGRATION),
        ("05. Organizing Your Vault", ORGANIZING),
        ("06. Keyboard Shortcuts", KEYBOARD_SHORTCUTS),
        ("07. Markdown Extensions", MARKDOWN_EXTENSIONS),
        ("08. Search", SEARCH),
        ("09. Password Generator", PASSWORD_GENERATOR),
        ("10. Sharing & Export", SHARING_EXPORT),
        ("11. Security & Privacy", SECURITY),
        ("12. Sync & Version History", SYNC_HISTORY),
        ("13. Browser Extension", BROWSER_EXTENSION),
        ("14. Utilities", UTILITIES),
        ("15. Hardening Checklist", HARDENING),
    ]
}

/// Old titles (without numeric prefix) that should be cleaned up during refresh.
pub fn legacy_titles() -> Vec<&'static str> {
    vec![
        "Welcome to Claspt",
        "Writing & Editing",
        "Encrypted Secrets",
        "Organizing Your Vault",
        "Keyboard Shortcuts",
        "Markdown Extensions",
        "Search",
        "Sharing Pages & Secrets",
        "Security & Privacy",
        "Sync & Version History",
        // Old numbered titles that got renamed/split
        "08. Sharing Pages & Secrets",
        "09. Security & Privacy",
        "10. Sync & Version History",
        // Titles that shifted down when "04. AI Integration" was inserted
        "04. Organizing Your Vault",
        "05. Keyboard Shortcuts",
        "06. Markdown Extensions",
        "07. Search",
        "08. Password Generator",
        "09. Sharing & Export",
        "10. Security & Privacy",
        "11. Sync & Version History",
        "12. Browser Extension",
        "13. Utilities",
    ]
}

const WELCOME: &str = r#"Welcome to **Claspt** — your secure personal notes vault.

## What is Claspt?

Claspt combines everyday markdown note-taking with AES-256-GCM encrypted secret storage. Your notes are portable `.md` files you can open in any text editor, while sensitive data stays encrypted inline — never exposed as plaintext on disk.

## What Makes Claspt Different

- **Secrets live inside your notes.** No separate password manager — wrap any text in a `:::secret` block and it's encrypted on save.
- **A secure store for your AI.** Connect your AI assistant (Claude, Cursor, and other MCP tools) so it can securely store and read your credentials and keep persistent project memory — one encrypted, auditable source of truth. See **04. AI Integration**.
- **Portable files.** Every page is a standard `.md` file with YAML frontmatter. Move them, edit them externally, back them up however you like.
- **Full-text search.** Search titles, content, tags, and secret labels instantly — secret *values* are never indexed.
- **Git built in.** Every save is auto-committed. Browse history, view diffs, and never lose a change.
- **15 markdown extensions.** Math, diagrams, charts, kanban boards, music notation, presentations, and more.
- **Password generator.** Generate passwords, passphrases, memorable passwords, and PINs — built right in.
- **Browser extension.** Auto-fill credentials from your vault on any website.
- **Export & backup.** Export your entire vault as a password-protected zip, or export secrets as structured JSON.

## Quick Start

1. **Create a page** — click **+ New** in the sidebar
2. **Write markdown** — the editor supports headings, bold, italic, lists, tables, code blocks, and more
3. **Add a secret** — type `:::secret[My Password]` on a new line, add content, close with `:::`
4. **Search** — press `Cmd+K` / `Ctrl+K` to find any page, tag, or secret label
5. **Organize** — create folders by right-clicking the sidebar, add tags in the inspector (`Cmd+I`)
6. **Generate a password** — press `Cmd+G` / `Ctrl+G` to open the password generator
7. **Connect your AI** — set up the MCP integration so your assistant can store and read secrets and memory (see **04. AI Integration**)

## Help Pages

These help pages cover everything Claspt can do. Browse them at your own pace, and feel free to delete them when you're comfortable — they're regular pages like any other.

To get the latest help pages after an update, go to **Settings > General > Reset Help Pages**. This replaces the help folder with fresh content matching your current version.

> [!tip] Each help page focuses on a single topic. Start with **03. Encrypted Secrets** or **04. AI Integration** — the two features that make Claspt distinctive.
"#;

const WRITING_EDITING: &str = r#"Claspt uses a professional **CodeMirror 6** editor with full markdown support, syntax highlighting, and multiple editing modes.

## Editor Modes

Switch between three modes using the buttons in the toolbar or keyboard shortcuts:

| Mode | Shortcut | Description |
|------|----------|-------------|
| **Edit** | Default | Write and edit markdown with syntax highlighting |
| **Preview** | `Cmd+/` | Rendered markdown view (read-only) |
| **Split** | `Cmd+\` | Side-by-side editor and preview with synchronized scrolling |

Press `Cmd+E` to toggle between Edit and Preview.

## Markdown Basics

Claspt supports **GitHub-Flavored Markdown (GFM)** with 50+ language syntax highlighting:

```markdown
# Heading 1
## Heading 2
### Heading 3

**Bold text** and *italic text* and ~~strikethrough~~

- Bullet list
- Another item
  - Nested item

1. Numbered list
2. Second item

> Blockquote for callouts

`inline code` and fenced code blocks:
```

### Links and Images

```markdown
[Link text](https://example.com)
![Image alt text](path/to/image.png)
```

You can also paste images directly from your clipboard — Claspt saves them alongside your note.

### Tables

Create tables with pipes and dashes:

```markdown
| Name    | Role      | Status  |
|---------|-----------|---------|
| Alice   | Engineer  | Active  |
| Bob     | Designer  | Away    |
```

### Task Lists

```markdown
- [x] Completed task
- [ ] Pending task
- [ ] Another todo
```

## Auto-Save

Your work is saved automatically every 5 seconds (configurable in Settings > Editor). Press `Cmd+S` to force an immediate save. Every save creates a Git commit, so you can always go back to any previous version.

## Editor Settings

Customize your editing experience in **Settings** (`Cmd+,`):

- **Font family** — choose from 7 monospace fonts (JetBrains Mono, Fira Code, SF Mono, Monaco, Cascadia Code, Source Code Pro, Inconsolata)
- **Font size** — adjustable from 10px to 24px
- **UI scale** — global interface scaling from 80% to 140%
- **Auto-save delay** — how long to wait before saving (default 5 seconds)

## Callouts

Use callout blocks to highlight important information:

```markdown
> [!tip] Helpful suggestion for the reader.

> [!warning] Something to be careful about.

> [!note] Additional context or background.

> [!danger] Critical warning — potential data loss or security risk.

> [!info] Neutral informational note.
```

> [!tip] Callouts render with distinctive colors and icons in preview mode. Try switching to Preview (`Cmd+/`) to see how they look!
"#;

const ENCRYPTED_SECRETS: &str = r#"Claspt's defining feature is **inline encrypted secrets** — sensitive data that lives right inside your markdown notes, encrypted at rest with AES-256-GCM.

## How Secret Blocks Work

A secret block has three parts:

1. **Opening fence** — a line starting with `:::secret[` followed by a label and `]`
2. **Secret content** — one or more lines of sensitive data (key-value pairs, passwords, etc.)
3. **Closing fence** — a line with just `:::`

For example, to store an AWS key, you'd write the opening fence with the label "AWS Access Key", then the key value on the next line, then the closing fence. When you save, Claspt encrypts the value on disk — the label stays readable but the value becomes an encrypted blob.

**Key principle:** Labels are searchable and visible. Values are encrypted — never stored as plaintext, never indexed, never exposed in Git diffs.

## Interacting with Secrets

In the editor, secret blocks appear with an amber background and a lock icon in the gutter. In preview mode:

- **Click a secret card** to reveal its decrypted value
- **Click a field value** to copy it to the clipboard (auto-clears after 30 seconds)
- **Secrets auto-hide** after a configurable timeout (default 30 seconds)

## Secret Templates

Press `Cmd+Shift+S` to open the secret template picker. Templates insert pre-structured secret blocks:

| Template | Fields |
|----------|--------|
| **Website Login** | URL, Username, Password, Authenticator Key, Backup Codes |
| **Email Account** | Email, Password, IMAP Server, SMTP Server, Authenticator Key |
| **Server Login** | Host, Port, Username, Password, Notes |
| **SSH Key** | Host, Username, Private Key, Passphrase, Public Key |
| **Database** | Host, Port, Database, Username, Password, Connection String |
| **API Key** | Service, API Key, API Secret, Endpoint, Rotate Every |
| **Environment Variable** | Variable, Value, Used By |
| **Software Licence** | Product, Licence Key, Registered To, Purchase Date, Seats |
| **Credit Card** | Card Number, Cardholder, Expiry, CVV, PIN |
| **Bank Account** | Bank, Account Number, IFSC / SWIFT / Routing, Branch, Type |
| **Wi-Fi Network** | SSID, Password, Security |
| **Identity Document** | Type, Number, Issue Date, Expiry Date, Authority |
| **Crypto Wallet** | Wallet, Address, Seed Phrase, Passphrase |
| **Custom** | Free-form key-value pairs |

The same templates are in the browser extension's **Add new** form, and any template you save under Settings › Automation › Templates joins the picker. The Authenticator Key field shows the live code as you paste, and the SSH Key template stores the key so the SSH agent can offer it once the page is tagged `ssh-key`.

## Convert Selection to Secret(s)

Already have credentials in plain text? Select them and convert:

1. Select the text containing credentials in the editor
2. Right-click and choose **Convert to Secret(s)**
3. Claspt auto-detects key-value pairs from:
   - ASCII and markdown tables
   - `Key: Value` lines
   - `KEY=value` env vars
   - `email / password` patterns
4. Choose **One Secret** (all in a single block) or **Separate Secrets** (one block per credential)
5. Preview the output, uncheck items to exclude, and confirm

This is perfect for converting existing notes, imported documents, or pasted credentials into encrypted secret blocks.

## Full-Page Encryption

Beyond individual secret blocks, you can encrypt an entire page. Toggle encryption with the lock button in the editor toolbar. Encrypted pages have three display modes (configurable in Settings > Security):

- **Lock overlay** — shows a lock screen, click to unlock
- **Auto reveal** — decrypts automatically when you open the page
- **Require password** — prompts for your master password each time

## Multiple Secrets Per Page

A single page can contain any number of secret blocks mixed with regular markdown — headings, paragraphs, lists, tables, and more. For example, a "Server Credentials" page might have two secret blocks (one for the database host, one for the password) separated by regular markdown notes about deployment.

This makes Claspt ideal for project documentation that includes credentials, infrastructure notes with embedded secrets, or personal records that mix public and private information.

> [!warning] Always store your **recovery key** in a safe place. If you forget your master password, the recovery key is the only way to access your encrypted data.
"#;

const ORGANIZING: &str = r#"Keep your vault tidy with folders, tags, pinning, archiving, and bulk operations.

## Folders

Folders appear in the sidebar as collapsible groups. Every vault starts with a few starter folders: `general` (everyday notes), `credentials` (logins and API keys), `identities` (personal info and documents), `personal` (private notes), and `shared`. There's also this `help` folder, and an `ai` folder where AI-agent data lives (see **04. AI Integration**). Feel free to rename, delete, or add folders to suit your workflow.

### Creating Folders

- Right-click in the sidebar → **New Folder**
- Or click the **+** button next to "Folders" in the sidebar header

### Moving Pages

- Right-click a page → **Move to Folder** → select destination
- Or drag and drop pages between folders in the sidebar
- **Bulk move:** Select multiple pages (see below) and move them all at once

### Renaming & Deleting Folders

- Right-click a folder name → **Rename** or **Delete**
- When deleting a folder, you can choose to move its pages to `general` or to trash

### Folder Nesting

Folders can be nested to organize related pages. Use the folder tree in the sidebar to navigate.

## Multi-Select & Bulk Operations

Select multiple pages for bulk actions:

1. **Cmd+Click** (macOS) or **Ctrl+Click** (Windows/Linux) to select individual pages
2. A count badge shows how many pages are selected
3. A **bulk action bar** appears at the bottom of the sidebar with:
   - **Move to Folder** — move all selected pages to a folder
   - **Delete** — delete all selected pages at once
4. Click anywhere in the sidebar to clear the selection

> [!tip] Bulk delete is instant — selected pages are removed immediately without the slow trash animation.

## Tags

Tags let you categorize pages across folders. A page can have multiple tags.

### Adding Tags

1. Open the **Inspector** panel with `Cmd+I`
2. Click the **+** button in the Tags section
3. Type a tag name — existing tags appear as autocomplete suggestions

### Filtering by Tag

- Click any tag in the Inspector or sidebar to filter pages by that tag
- Use `Cmd+K` search with `tag:` prefix to search within a specific tag

## Pinning Pages

Pin important pages so they always appear at the top of their folder:

- Right-click a page → **Pin** (or unpin)
- Pinned pages show a pin icon in the sidebar

## Archiving Pages

Archive pages you don't need day-to-day but want to keep:

- Right-click a page → **Archive**
- Archived pages are hidden from the sidebar by default but remain searchable
- Toggle archive visibility in the sidebar filter options

## Sidebar Views

Switch between two sidebar layouts:

- **List view** — flat list of all pages, sorted by last modified
- **Folder view** — hierarchical tree grouped by folder

Toggle with the view switcher at the top of the sidebar.

## Sidebar Density

Switch between **compact** and **detailed** sidebar modes. Detailed mode shows page excerpts and metadata alongside titles.

> [!tip] Use a combination of folders for broad categories (e.g., "Work", "Personal", "Projects") and tags for cross-cutting themes (e.g., "urgent", "reference", "credentials").
"#;

const KEYBOARD_SHORTCUTS: &str = r#"Complete keyboard shortcut reference. On macOS, `Cmd` is used; on Windows/Linux, substitute `Ctrl`.

## Navigation

| Shortcut | Action |
|----------|--------|
| `Cmd+K` | Open search |
| `Cmd+B` | Toggle sidebar |
| `Cmd+I` | Toggle inspector panel |
| `Cmd+G` | Open password generator |
| `Cmd+,` | Open settings |

## Pages

| Shortcut | Action |
|----------|--------|
| `Cmd+S` | Force save now |
| `Cmd+Shift+L` | Lock vault |

Create a new page with the **+ New** button in the sidebar.

## Editor

| Shortcut | Action |
|----------|--------|
| `Cmd+E` | Toggle edit / preview |
| `Cmd+\` | Toggle split view |
| `Cmd+/` | Toggle preview |
| `Cmd+Shift+/` | Markdown help reference |
| `Tab` | Indent |

Bold, italic, and inline code are applied with the **toolbar buttons** above the
editor (there are no dedicated formatting shortcuts).

## Secrets & Sharing

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+S` | Insert secret template |
| `Cmd+Shift+E` | Open share modal |

## Tips

- On **macOS**, use `Cmd`. On **Windows/Linux**, use `Ctrl`.
- Shortcuts are displayed in menus and tooltips throughout the app.
"#;

const MARKDOWN_EXTENSIONS: &str = r#"Claspt includes **15 markdown extensions** that go beyond standard GFM. Enable or disable each extension in **Settings > Extensions**.

The live examples below will render when the corresponding extension is enabled.

## Core Extensions (Enabled by Default)

### Math (KaTeX)

Render mathematical formulas with LaTeX syntax. Use `$...$` for inline and `$$...$$` for block math.

**Inline:** The equation $E = mc^2$ is rendered inline in this sentence.

**Block math:**

$$
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
$$

### Mermaid Diagrams

Create flowcharts, sequence diagrams, Gantt charts using fenced code blocks with `mermaid` language.

```mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
```

### Callouts

Styled alert blocks using `> [!type]` syntax. Available types: note, tip, warning, danger, info, success, question.

> [!tip] This is a tip callout — great for helpful suggestions.

> [!warning] This is a warning callout — use for things to be careful about.

> [!note] This is a note callout — for additional context or background.

### Wikilinks

Link between pages in your vault using `[[Page Title]]` syntax:

See [[01. Welcome to Claspt]] for an introduction to the app.

Custom display text: [[01. Welcome to Claspt|click here to see the welcome page]]

### Footnotes

Add reference-style footnotes using `[^1]` syntax:

Claspt uses AES-256-GCM for encryption[^1], with Argon2id for key derivation[^2].

[^1]: AES-256-GCM is an authenticated encryption algorithm providing both confidentiality and integrity.
[^2]: Argon2id is a memory-hard key derivation function resistant to GPU and ASIC attacks.

## Science Extensions

### Chemical Formulas (mhchem)

Write chemical equations using KaTeX's mhchem extension with `\ce{...}` syntax inside math delimiters:

Water formation: $\ce{2H2 + O2 -> 2H2O}$

Carbonic acid equilibrium: $\ce{CO2 + H2O <=> H2CO3}$

## Diagram & Visual Extensions (Opt-in)

These extensions must be enabled in **Settings > Extensions** before they render.

### Charts (Chart.js)

Create charts using fenced code blocks with `chart` language and YAML configuration:

```chart
type: bar
data:
  labels: [Q1, Q2, Q3, Q4]
  datasets:
    - label: Revenue (thousands)
      data: [12, 19, 8, 15]
```

### Graphviz (Viz.js)

Render DOT language diagrams using `dot` or `graphviz` fenced code blocks:

```dot
digraph G {
    rankdir=LR;
    A -> B -> C;
    A -> D -> C;
}
```

### Timelines (vis-timeline)

Create interactive visual timelines using `timeline` fenced code blocks:

```timeline
- 2024-01-15: Project kickoff
- 2024-03-01: Design complete
- 2024-06-15: Beta release
- 2024-09-01: Launch
```

### Table of Contents

Generate a navigable heading list with `[[toc]]`. Place it anywhere in your document.

## Planning Extensions (Opt-in)

### Kanban Boards

Visual task boards using `kanban` fenced code blocks:

```kanban
## To Do
- [ ] Design mockups
- [ ] Write specs

## In Progress
- [x] Set up database
- [ ] Build API

## Done
- [x] Project setup
```

### Spreadsheets

Editable CSV grids using `spreadsheet` fenced code blocks. Supports `SUM`, `AVG`, `COUNT`, `MIN`, `MAX` formulas:

```spreadsheet
Item, Quantity, Price, Total
Widget, 10, 5.99, =B2*C2
Gadget, 3, 12.50, =B3*C3
,, Total:, =SUM(D2:D3)
```

## Media Extensions (Opt-in)

### Music Notation (abcjs)

Render ABC music notation as sheet music using `music` fenced code blocks:

```music
X:1
T:Example Melody
M:4/4
K:C
CDEF | GABc |
```

### Embeds

Embed YouTube, Vimeo, and other media using `@[type](url)` syntax.

## Document Extensions (Opt-in)

### Presentations

Create slide decks using `presentation` fenced code blocks. Separate slides with `---`. Click **Present** to enter fullscreen mode.

> [!tip] Extension settings are per-vault. Enable only what you need to keep the editor fast and the preview clean.
"#;

const SEARCH: &str = r#"Claspt provides instant full-text search across all your pages, tags, and secret labels.

## Opening Search

Press `Cmd+K` (or `Ctrl+K`) to open the search panel. Start typing to see results in real time (50ms debounce, sub-100ms response).

## What Gets Searched

| Content | Indexed? | Boost |
|---------|----------|-------|
| Page titles | Yes | 3x |
| Tags | Yes | 2x |
| Secret labels | Yes | 2x |
| Page content | Yes | 1x |
| Secret values | **No** | — |

Secret *values* are never indexed or included in search results — only their labels are searchable.

## Search Ranking

Results are ranked using **BM25** (a standard information retrieval algorithm) with the field boosts above — matches in titles, tags, and secret labels rank higher than matches in body content.

## Search Scopes

Use the scope dropdown at the top of the search panel to narrow results:

- **All pages** — search the entire vault
- **Secrets only** — show only pages that contain secret blocks
- **A specific folder** — pick any folder by name to search just that folder

## Preview & Results

- **Preview pane** — the selected result is previewed on the right. Arrow keys or hover to move the selection; secret values are masked (you'll see the label, never the value), and full-body-encrypted pages show a locked placeholder.
- **Include AI memory** — a checkbox (on by default) toggles whether pages under `ai/memory/` appear in results.
- **Load more** — results load in pages; scroll to the bottom to fetch more. A count shows how many results are shown.
- **Right-click a result** for a menu with **Open** and **Delete** (to the OS trash — a confirm-guarded, recoverable delete), so search doubles as a quick cleanup tool.

## Search Tips

- Search is **case-insensitive** by default
- Partial words match (typing "pass" finds "password")
- Use tags in combination with search to narrow results further

## Rebuilding the Search Index

If search results seem stale or incomplete, you can rebuild the index:

1. Open **Settings** (`Cmd+,`)
2. Go to the **Utilities** section
3. Click **Rebuild Search Index**

This re-indexes all pages from disk. It usually takes a few seconds.

> [!note] The search index is stored locally in `.securenotes/index/` and is never synced between devices. Each device builds its own index.
"#;

const PASSWORD_GENERATOR: &str = r#"Claspt includes a built-in password generator with four generation modes — accessible via `Cmd+G`, the secret template picker, and the browser extension.

## Generator Modes

### Random Password

Cryptographically random strings with configurable character sets:

- **Length:** 8 to 128 characters (default 20)
- **Character sets:** uppercase, lowercase, digits, symbols — toggle each independently
- **Strength indicator:** real-time feedback from Weak to Very Strong

### Passphrase

Multiple random words joined by a separator — easy to type and remember while still secure:

- **Word count:** 3 to 10 words (default 4)
- **Separator:** dash, space, period, underscore, or custom
- **Capitalize:** optionally capitalize each word
- **Include number:** append a random digit for policies that require numbers

### Memorable Password

A pronounceable password that alternates consonants and vowels, making it easier to remember than a random string while still being unique:

- **Length:** 8 to 32 characters
- **Mix of letters and digits** for password policy compatibility

### PIN

Numeric-only codes for banking, device locks, and 2FA:

- **Length:** 4 to 12 digits (default 6)

## Accessing the Generator

- **`Cmd+G`** — opens the full generator panel with all options and a copy button
- **Secret template picker** (`Cmd+Shift+S`) — generates a password inline when inserting a login template
- **Browser extension** — generate and fill passwords directly on web pages

## Strength Meter

The strength indicator analyzes your generated password for:

- Length and character diversity
- Pattern detection (sequential characters, repeated sequences)
- Entropy estimation

Ratings range from **Weak** (red) through **Fair**, **Good**, **Strong**, to **Very Strong** (green).

> [!tip] For most accounts, a 20-character random password or a 4-word passphrase provides excellent security. Use PINs only where numeric input is required.
"#;

const SHARING_EXPORT: &str = r#"Share pages or individual secrets with others, import from other apps, and export your vault for backup.

## Sharing a Page

1. Open the page you want to share
2. Press `Cmd+Shift+E` or click the **Share** button in the toolbar
3. Configure share options:
   - **Password** — required; the recipient needs this to view the share
   - **Expiry** — how long the link stays active (1 hour to 30 days)
   - **Burn after reading** — if enabled, the share is deleted after one view
   - **Recipient email** — optional; for your records only
4. Click **Create Share Link**
5. Copy the link and send it along with the password (via a separate channel)

## Sharing a Single Secret

Instead of sharing an entire page, you can share just one secret block:

1. In the page, find the secret block you want to share
2. Click the **Share** button on the secret card
3. Follow the same steps as above

The recipient sees only the selected secret, not the rest of the page.

## Receiving Shared Content

When someone shares a page or secret with you:

1. Open the share link in your browser
2. Enter the password the sender gave you
3. View the decrypted content
4. Optionally click **Import to Vault** to save it to your own vault

## Vault Export

Export your data for backup, migration, or portability. Open **Settings > Export** to access both options.

### Complete Vault Export

Creates a `.zip` archive containing every page as a `.md` file, preserving your folder structure:

- Optionally **password-protect** the zip with AES-256 encryption
- Includes all markdown content, frontmatter, and encrypted secret blocks
- Perfect for full backups or migrating to another machine

### Secrets-Only Export

Exports just your secrets as a structured `.json` file:

- Each entry includes the page title, folder, label, and key-value fields
- Fields are exported as structured pairs (e.g., `"Username": "alice", "Password": "s3cret"`)
- Useful for importing into other password managers or for auditing credentials

> [!warning] Exported files contain your decrypted secret values in plaintext. Store them securely and delete them when no longer needed.

## Import from Other Apps

Claspt can import data from popular password managers and formats:

### Supported Formats

| Source | Format | How to Export |
|--------|--------|---------------|
| **LastPass** | CSV | Settings > Advanced > Export |
| **1Password** | CSV | File > Export > CSV |
| **RoboForm** | CSV | Options > Export |
| **KeePass** | XML | File > Export > KeePass XML |
| **Markdown** | `.md` | Any markdown file |

### How to Import

1. Open **Settings** (`Cmd+,`) or use the Import button in the sidebar
2. Select your import format
3. Choose the file to import
4. **Preview** the entries before committing — review how they'll map to Claspt pages
5. Select a destination folder
6. Click **Import**

Each imported entry becomes a page with secret blocks for sensitive fields.

> [!tip] When importing from a password manager, each credential becomes a page with a Login secret template. Review the preview to ensure fields mapped correctly.
"#;

const HARDENING: &str = r#"Claspt encrypts your secrets, but a few things are yours to get right — mainly **where the vault lives** and **who else can read that folder**. This page is the short list.

## Start here

Three things matter more than everything else below:

1. **Turn on full-disk encryption.** FileVault on macOS, BitLocker on Windows, LUKS on Linux. This is the single highest-value step, and it protects your vault against a lost or stolen machine no matter what else you do.
2. **Keep the vault inside your own user folder.** Not a shared drive, not the root of a disk, not a folder other accounts on the machine can open.
3. **Use a long, unique master password.** Length beats complexity. Four or five unrelated words is stronger than a short password with symbols in it.

## Where to keep your vault

Claspt suggests `Documents/Claspt` on macOS and Windows, and `~/Claspt` on Linux. Those are good defaults because your home folder is already restricted to your account.

Two files inside `.securenotes/` deserve the care:

| File | What it is | If someone copies it |
|------|-----------|---------------------|
| `vault.key` | Your master key, encrypted with your password | They can guess your password offline, at their own pace, with no lockout and no rate limit |
| `config.json` | Vault settings, including a verifier used to check your password | It tells an attacker when a guess is correct, which is what makes the offline attack practical |

Argon2id makes each guess deliberately slow, so a long password stays out of reach. A short or reused one does not.

### On Windows, this needs a little more attention

On macOS and Linux, Claspt sets these files to owner-only. **Windows has no equivalent step in Claspt today** — the files inherit whatever permissions the containing folder has.

That is fine inside `C:\Users\<you>\`, which Windows already restricts to your account. It is **not** fine anywhere else:

- Do not put the vault in `C:\`, `D:\`, or any drive root
- Do not put it in `C:\Users\Public` or any folder shared between accounts
- Do not put it on a network share or a NAS mount
- Do not put it on a USB drive you leave plugged in

If you have already put a vault somewhere like that, move the folder into your user profile and reopen it from the new location.

## Cloud sync folders — read this one

`Documents` is synced to the cloud by default on a lot of machines. **OneDrive** does it on many Windows installs; **iCloud Drive** can do it on macOS when Desktop & Documents syncing is on.

If your vault sits in a synced folder, `vault.key` is uploaded to that provider along with everything else. Your secrets stay encrypted, but your encrypted master key is now somewhere you did not choose to put it.

Claspt writes a `.nosync` marker inside `.securenotes/` on macOS, which keeps iCloud Drive and Dropbox from copying that folder. It does **nothing** for OneDrive, and nothing on Windows or Linux.

So:

- Check whether your vault folder is being synced, before you fill it with credentials
- If it is, either move the vault somewhere outside the synced folder, or exclude it in your sync client's settings
- Use Claspt's own sync instead — it uploads encrypted bundles and never uploads `vault.key`

> [!tip] Not sure? Look for a cloud status icon on the folder, or open your sync client's settings and check which folders it covers.

## Master password and recovery key

- **Twelve characters minimum**, and longer is genuinely better. A passphrase of four or five unrelated words is easy to remember and hard to guess.
- **Do not reuse it.** If it protects anything else, a breach elsewhere becomes a breach here.
- **Store the recovery key offline** — printed, or in a different password manager. Not in this vault, and not in a note on the same machine.
- Losing both the password and the recovery key means the data is gone. There is no backdoor.

## Locking

Set both timers in **Settings > Security**:

- **Auto-lock** hides the interface behind a password prompt. Fifteen minutes is a sensible default; five is better on a laptop you carry.
- **Hard lock** wipes the encryption key from memory. Until it fires, the key stays resident so the API, MCP and browser extension keep working. A shorter hard lock means a shorter window in which memory holds anything useful.

Lock manually before you walk away, or before handing your machine to anyone.

## Giving AI agents access

Claspt issues two kinds of token. The difference is the whole point:

| Token | Prefix | Can read secrets |
|-------|--------|-----------------|
| **Notes** | `clsn_` | No — values come back redacted |
| **Secrets** | `clss_` | Yes — full decryption |

- **Start with the Notes token.** Most agent work is reading and writing notes; it does not need your passwords. Only issue the Secrets token to something that genuinely has to fill or read a credential.
- Give each tool the narrowest token that lets it do its job.
- Turn on **approve** mode in **Settings > Integrations** if you want a prompt before any secret is decrypted over the API. Note that approving with "Remember for this session" grants access to **every** secret until the vault locks, not just the one being asked for.
- **Regenerate a token the moment you suspect it has leaked.** The old one stops working immediately.
- Turn the local API off entirely when you are not using an agent.

## Backups

- Back up the whole vault folder somewhere encrypted. The pages are portable markdown, so a copy stays readable even without Claspt.
- Keep the recovery key somewhere separate from the backup. Together in one place, they are one thing to lose.
- Test a restore occasionally. A backup nobody has ever restored is a hope, not a backup.

## If you are on Linux

Claspt stores API tokens in your desktop keyring (GNOME Keyring, KWallet, or anything else that speaks Secret Service). On a headless or minimal system there may be no such service running, in which case the tokens stay in `config.json` instead — still owner-only, but on disk rather than in a credential store.

If that matters to you, install and unlock a Secret Service provider before generating tokens.

## Removing Claspt

Uninstalling the app does not remove your data — by design, since the vault is yours. To remove it fully:

1. Delete the vault folder, including the hidden `.securenotes/` directory inside it
2. Remove the Claspt entries from your system keychain, credential manager, or keyring
3. Delete any backups and any exported files
4. If you used Claspt sync, delete your account so the server drops its copy

Deleting files does not overwrite the underlying disk blocks. On a drive with full-disk encryption that is fine — which is one more reason for the first item on this page.
"#;

const SECURITY: &str = r#"Claspt is built with security as a core principle. Here's how your data is protected.

## Master Password

Your master password unlocks the vault and derives the encryption key. Requirements:

- Minimum **12 characters**
- Key derivation uses **Argon2id** (memory-hard, resistant to GPU/ASIC attacks)
- The password is never stored — only its derived key is used

## Recovery Key

When you create a vault, you receive a **recovery key** — a base64-encoded copy of your master encryption key. This is your backup if you forget your password.

- The recovery key is shown **once** during vault creation
- Store it somewhere safe (printed, in a separate password manager, etc.)
- It can decrypt your vault even if you forget your master password

> [!danger] If you lose both your master password and your recovery key, your encrypted data is permanently inaccessible. There is no backdoor and no recovery mechanism.

## Encryption Details

| Property | Value |
|----------|-------|
| **Algorithm** | AES-256-GCM |
| **Key derivation** | Argon2id |
| **Nonce** | Unique per secret block (random 96-bit) |
| **Library** | `ring` (Rust, FIPS-capable) |
| **Key storage** | `vault.key` file (encrypted master key) |

### What's Encrypted

- Secret block **values** — always encrypted on disk
- Full-page content — when page encryption is enabled
- `vault.key` — master key encrypted with password-derived key

### What's Not Encrypted

- Secret block **labels** — kept readable for search and organization
- Page titles, folder names, tags — plaintext for markdown portability
- File names — based on page title for human readability

## Auto-Lock

The vault automatically locks after a period of inactivity. Configure the timeout in **Settings > Security**:

- Range: 1 minute to 120 minutes
- Default: 15 minutes
- When the vault hard-locks, the master encryption key is wiped from memory, so nothing further can be decrypted until you unlock again

> [!note] Secret values you already revealed during a session may remain in the application's memory until that memory is reused. The encryption key is wiped; individual decrypted values are not tracked and wiped one by one. This matters only against an attacker who can read the machine's memory or a crash dump — and such an attacker could read the key itself while the vault was unlocked. See **15. Hardening Checklist** for the settings that reduce this window.

## Biometric Unlock

On supported platforms, enable biometric authentication:

- **macOS:** Touch ID
- **Windows:** Windows Hello
- **Linux:** Not currently supported

### Biometric Modes

| Mode | Behavior |
|------|----------|
| **Disabled** | Password only (default) |
| **Re-auth only** | Use biometric to re-unlock after auto-lock; first unlock requires password |
| **Primary unlock** | Use biometric as primary unlock method |

## Secret Display Settings

Configure how encrypted content is displayed in **Settings > Security**:

- **Secret auto-hide timeout** — how long revealed secrets stay visible (5–300 seconds, default 30)
- **Clipboard auto-clear** — how long copied secrets stay in clipboard (5–300 seconds, default 30)
- **Encrypted page display mode** — lock overlay, auto reveal, or require password

## Memory Safety

- Encryption keys are wiped from memory as soon as they are no longer needed, and the hard lock wipes the master key
- The Rust backend uses `zeroize` crate for secure memory cleanup
- Frontend buffers are cleared on vault lock

> [!note] The `vault.key` file is **never synced** between devices. Each device creates its own `vault.key` when you enter your master password, so your encryption key never leaves your device.
"#;

const SYNC_HISTORY: &str = r#"Claspt automatically tracks every change with Git and optionally syncs across devices.

## Git Version History

Every time you save a page, Claspt creates a Git commit automatically. This gives you:

- **Complete history** of every page change
- **Visual diffs** showing exactly what changed
- **Rollback capability** to any previous version

### Viewing History

1. Open the **Inspector** panel (`Cmd+I`)
2. Click the **History** tab
3. Browse commits for the current page
4. Click any commit to see the diff compared to the previous version

### How Auto-Commit Works

- Saves are batched with a 5-second window to avoid excessive commits
- Each commit message includes the page title and timestamp
- The Git repository is initialized automatically when you create a vault

## Cloud Sync (Pro Feature)

Sync your vault across multiple devices with Claspt Sync:

### Setup

Sync is part of Pro.

1. Open **Settings > Account & Sync**
2. Choose your sync backend:
   - **Claspt Sync** — managed cloud sync
   - **Google Drive** — store encrypted vault data in your Drive
3. Sign in and authorize
4. Sync happens automatically in the background

### Device Management

- View all synced devices in **Settings > Account & Sync > Devices**
- How many devices a licence covers is set by the licence itself, and shown
  there
- Remove a device to free up a slot

### Conflict Resolution

When the same page is edited on two devices before syncing:

1. Claspt detects the conflict automatically
2. A **diff viewer** opens showing both versions side by side
3. Choose to keep yours, keep theirs, or manually merge

### What Syncs

| Data | Synced? |
|------|---------|
| Pages (`.md` files) | Yes |
| Folders | Yes |
| Tags | Yes |
| Secret blocks (encrypted) | Yes |
| `vault.key` | **No** — each device has its own |
| Search index | **No** — rebuilt locally |
| License token | **No** — per-device |

### Sync Status

The sync indicator in the sidebar footer shows:

- **Green** — fully synced
- **Yellow** — syncing in progress
- **Red** — sync error (click for details)
- **Gray** — sync not configured

> [!note] Even without cloud sync, your vault is a standard Git repository. You can use any Git hosting (GitHub, GitLab, etc.) to sync manually via `git push`/`git pull`.
"#;

const BROWSER_EXTENSION: &str = r#"The **Claspt Browser Extension** lets you auto-fill credentials from your vault directly on web pages — available for Chrome and Chromium-based browsers.

## How It Works

The extension connects to the Claspt desktop app running on your machine via a local API. Your secrets never leave your device or pass through any external server.

1. **Claspt desktop app** must be running and unlocked
2. The extension communicates over `http://127.0.0.1` (localhost only)
3. Credentials are fetched on demand and filled into web forms

## Features

### Auto-Fill Credentials

When you visit a site that matches credentials in your vault:

- A **Claspt icon** appears on username and password fields
- Click the icon to see matching credentials in a dropdown
- Click **Fill** to auto-fill the username and password
- Or click a credential to fill it directly

The extension matches credentials by domain — it checks the current site's URL against URLs stored in your secret blocks.

### Inline Password Generator

Click the Claspt icon on any password field to access the built-in generator:

- **Preview** the generated password before using it
- **Regenerate** with one click
- **Copy** to clipboard
- **Use** to fill the password into the field
- Adjust length with a slider (8–64 characters)
- Quick presets: Strong (20), Long (32), PIN (6)

### Search All Credentials

The dropdown includes a search bar to find any credential in your vault — not just those matching the current domain. Type a site name, username, or label to filter.

### Quick Add

Save new credentials directly from the extension:

- Click **Add new** at the bottom of the popup
- Choose from the same templates as the desktop picker (Website Login, Email Account, Server Login, SSH Key, Database, API Key, Environment Variable, Software Licence, Credit Card, Bank Account, Wi-Fi Network, Identity Document, Crypto Wallet) or Custom; every field you fill is saved
- Fill in the fields and save — the credential is stored in your Claspt vault

### Keyboard Shortcut

Press `Cmd+Shift+L` (macOS) or `Ctrl+Shift+L` (Windows/Linux) to fill credentials for the current page without opening the popup.

## Setup

1. Install the extension from the Chrome Web Store
2. Open the extension popup and go to **Settings**
3. Ensure the **API Port** matches your Claspt desktop app (default: `9315`)
4. Enter your **API Token** from the Claspt desktop app (**Settings > Integrations**)
5. Click **Test Connection** to verify

## Tabs

The extension popup has four tabs:

| Tab | Purpose |
|-----|---------|
| **Logins** | View and fill credentials for the current site |
| **Generator** | Generate passwords with full options |
| **Identity** | Store and fill personal info (name, address, etc.) |
| **Settings** | Configure connection, theme, and preferences |

> [!tip] The extension works best when your credentials have a URL field matching the websites you visit. When importing from other password managers, make sure URLs are preserved.
"#;

const UTILITIES: &str = r#"Claspt includes several utility tools for managing your vault at scale. Access them from **Settings > Utilities**.

## Consolidate Credentials

If you imported credentials from a password manager, you may have many individual pages — one per login. The **Consolidate** utility merges these into grouped pages by domain:

### How It Works

1. Select the source folders containing individual credential pages
2. Click **Preview** to see the consolidation plan — which domains will be grouped and how many pages each contains
3. Review the plan and click **Execute**
4. Claspt creates new grouped pages in a `credentials` folder, with all secrets properly re-encrypted

### Test Mode

Run consolidation in **test mode** first to verify results without modifying your vault:

- Enable the **Test Mode** checkbox
- Set a limit (e.g., process only the first 10 domains)
- Results go to a `_consolidate-test` folder that you can review and delete

### What Happens to Originals

After consolidation, the source folders are cleaned up:

- Pages that were fully merged are deleted
- The source folders are removed if empty
- Pages with content beyond just credentials are left in place

> [!warning] Always run a **test consolidation** first on a small subset. Review the results in the test folder before running on your full vault.

## Bulk Tag Operations

Apply or remove tags across many pages at once:

1. Go to **Settings > Utilities > Bulk Tags**
2. Choose **Add tag** or **Remove tag**
3. Select the target pages or folders
4. Enter the tag name and execute

## Rebuild Search Index

If search results seem stale or incomplete:

1. Go to **Settings > Utilities**
2. Click **Rebuild Search Index**
3. Wait a few seconds for re-indexing to complete

The index is rebuilt from disk — no data is lost.

## Reset Help Pages

Want to get the latest help pages after a Claspt update? Or accidentally deleted them?

1. Go to **Settings > General**
2. Click **Reset Help Pages**
3. The help folder is refreshed with up-to-date content matching your current Claspt version

This replaces existing help pages with the latest versions. Any customizations you made to help pages will be overwritten, but your other pages are never affected.

> [!tip] These utilities are designed for one-time cleanup tasks. The consolidate tool is especially useful right after importing from another password manager.
"#;

const AI_INTEGRATION: &str = r#"Claspt can act as a **secure memory and credential store for AI agents**. Connect your AI assistant (Claude Code, Claude Desktop, Cursor, Gemini, and other MCP-compatible tools) and it can store and retrieve credentials — encrypted at rest — and keep persistent, structured memory about your projects, all inside your vault.

This is powered by two local, private interfaces:

- **MCP server** — exposes Claspt's tools to AI agents over stdio (JSON-RPC). This is the recommended path.
- **Local HTTP API** — a `127.0.0.1`-only REST API (the same one the browser extension uses) for scripts and other clients.

Nothing leaves your machine: both run locally, and the AI talks to your unlocked vault directly.

## What your AI can do

**Credentials (encrypted):**

- **`store_secret`** — save an API key, password, token, or connection string. The value is encrypted with AES-256-GCM at rest — never stored in plaintext.
- **`find_secrets`** — search all stored credentials by label, service, or tag. Returns metadata only (label, page, tags) — never the values.
- **`read_secret`** — decrypt a specific credential. You may be prompted to approve access.

**Project memory:**

- **`bootstrap_project`** — set up a project's memory structure (guide, conventions, decisions, session log). Idempotent.
- **`memory_guide`** — read the conventions for how memory is stored; the agent calls this at the start of a task.
- **`memory_upsert` / `memory_read` / `memory_list` / `memory_delete`** — persist and recall decisions, conventions, and context.

Plus the usual vault tools (`search`, `read_page`, `create_page`, `list_folders`), password generation, and strength checking.

## Where the data lives

Everything the AI stores is under the visible **`ai/`** folder, so you can browse, search, and audit it like any other page:

- **`ai/<service>`** — credentials (e.g. `ai/aws`, `ai/stripe`), one encrypted page per service.
- **`ai/memory/<project>`** — project memory, one namespace per project. The namespace is derived automatically from the **project folder name** (the directory your AI tool was launched from), so ten projects get ten separate memories with zero configuration. Set `CLASPT_AGENT_NS` in the MCP server's environment to override it.
- **`ai/memory/global`** — shared cross-project memory: `standards` (practices every project follows), `preferences` (how you like work delivered), and `projects-index` (one line per project). The AI seeds these and reads them in every project; edit them yourself anytime — they're ordinary markdown pages, and your edits are authoritative.

The AI can **read** across your whole vault (hand-entered secrets, extension-saved, CLI) but can only **write** inside `ai/` — so a misbehaving agent can't scatter data across your notes.

## Setup (three steps)

1. **Enable the API and create a token.** Go to **Settings > Integrations**, turn on the Local API, and create a token. Use a **Secrets token** (`clss_...`) so the AI can read and write encrypted credentials; a **Notes token** (`clsn_...`) can see secret *labels* but never decrypt values.

2. **Register the MCP server with your AI tool.** Settings > Integrations generates ready-to-copy snippets with your token and binary path. For example:

   Claude Code:

   ```
   claude mcp add claspt -e CLASPT_API_TOKEN=clss_your_token -- claspt --mcp
   ```

   Claude Desktop / Cursor / Gemini (config file):

   ```json
   {
     "mcpServers": {
       "claspt": {
         "command": "claspt",
         "args": ["--mcp"],
         "env": { "CLASPT_API_TOKEN": "clss_your_token" }
       }
     }
   }
   ```

3. **Save the instruction set** below into your AI's *persistent* instructions file so it applies to every session automatically — you should never have to paste it into a chat:

   - **Claude Code:** `~/.claude/CLAUDE.md` (all projects) or a project's `CLAUDE.md`
   - **Cursor:** `.cursorrules` or `AGENTS.md`
   - **Claude Desktop / others:** the project or system instructions field

Your vault must be **unlocked** for the AI to reach it.

## Instruction set (save into CLAUDE.md)

Copy this block verbatim into the instructions file for your AI tool (see step 3 above). It is self-contained: it tells the AI how to set up project memory on first use, how to handle credentials, and how to keep memory current — no further setup prompts needed.

```
You have access to Claspt (via its MCP server) as my secure store for
credentials and long-term project memory. Use it as follows.

CREDENTIALS
- To save any secret (API key, password, token, connection string), call
  store_secret — it encrypts the value at rest. NEVER write secrets into
  files, notes, code, or memory in plaintext.
- To use a secret, call find_secrets to locate it (returns labels/metadata
  only), then read_secret with its page path to get the value. I may be
  prompted to approve access.
- Prefer reading credentials from Claspt at runtime over hardcoding them.

PROJECT MEMORY
- Memory is namespaced per project automatically (from the project folder
  name). At the start of a task, call memory_guide to load this project's
  conventions. If the memory structure doesn't exist yet (memory_list is
  empty), call bootstrap_project once — it creates the guide, conventions,
  decisions, and session-log pages, plus the shared global namespace.
- Also read the GLOBAL memory (pass namespace: "global" to memory_read/
  memory_list): `standards` and `preferences` apply to every project.
  Update them only for durable cross-project guidance; register new
  projects in `projects-index`. My in-app edits to global pages are
  authoritative.
- Record decisions, conventions, and useful context with memory_upsert;
  recall them with memory_read / memory_list. Keep memory current as the
  project evolves.
- At the end of a task, append a short entry to the session-log memory:
  what changed, what was decided, and any open questions.

Treat Claspt as the single source of truth for my secrets and your long-term
memory about my projects.
```

## Security notes

- Credentials are **encrypted at rest** (AES-256-GCM); secret *values* are never indexed or logged.
- Agent **writes are confined to `ai/`**; reads are broad but return values only via `read_secret`.
- `read_secret` can require **your explicit approval** each time (or once, per your setting).
- Tokens are **scoped** — hand a less-trusted client a Notes token so it can never decrypt secrets.
- Everything is **local** (`127.0.0.1`); the AI reaches the vault only while it is unlocked.

> [!tip] Move your scattered `.env` files and hardcoded keys into Claspt via `store_secret`, then have your AI read them at runtime — one encrypted, auditable source of truth instead of secrets spread across projects.
"#;
