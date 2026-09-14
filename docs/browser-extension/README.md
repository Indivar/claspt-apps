# Claspt Browser Extension

Auto-fill passwords, generate secure credentials, and manage your vault — all from your browser.

## Installation

### Chrome Web Store
1. Visit the [Claspt extension page](https://chrome.google.com/webstore/detail/claspt) on the Chrome Web Store
2. Click "Add to Chrome"
3. Click the puzzle icon in the toolbar and pin Claspt for easy access

### Manual Installation (Development)
1. Clone the repository and build:
   ```bash
   cd browser-extension
   npm install
   npm run build:all
   ```
2. Go to `chrome://extensions`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" → select the `browser-extension/dist` folder

## Setup

1. Open Claspt desktop app
2. Go to **Settings → Integrations → Local API**
3. Enable the Local API and copy the **Secrets token** (starts with `clss_`)
4. Click the Claspt extension icon in your browser
5. Go to **Settings** tab
6. Paste the token and click **Test Connection**

## Features

### Auto-Fill
- Automatically detects login forms (username, password, email, OTP fields)
- Click the Claspt icon on any input field to see matching credentials
- **Eye icon (👁)** on each credential to view all fields, copy individually, show/hide passwords
- Keyboard shortcut: **Cmd+Shift+L** (Mac) / **Ctrl+Shift+L** (Windows/Linux)
- Works with React, Vue, Angular, and plain HTML forms
- Multi-step login support (Google, Microsoft — stores email from step 1)
- Fill safety: prevents username from being filled into password fields and vice versa

### Password Generator
- **Works without desktop connection** — pure local crypto (Web Crypto API)
- Three modes: Password, Passphrase, PIN
- Presets: Strong 20, Long 32, Memorable, PIN 4, PIN 6
- Exclude ambiguous characters (0O, 1lI)
- Exclude problematic characters (backslash, quotes, braces)
- Strength meter with entropy bits and crack time estimate
- **Password history**: Last 50 generated passwords, persistent across sessions

### Credential Management
- **Save bar**: Slide-in notification when you log in — save new or update existing credentials
- **Unsaved queue**: If you miss the save bar, credentials go to a persistent queue (never lost)
- **Quick Add**: Create credentials from the popup with templates (Login, API Key, SSH, Database, Credit Card)
- **Recently used**: Quick-access pills for your most-used credentials

### Identity & Credit Cards
- Store multiple identities (Personal, Work, Home) with name, email, phone, address
- Store credit cards with Stripe-like visual display and brand detection
- All data stored securely in your vault — never in browser storage
- Fill checkout forms with one click

### Security
- **Phishing warnings**: Red banner when a site URL doesn't match the saved credential URL
- **Iframe protection**: Blocks auto-fill inside iframes to prevent clickjacking
- **Auto-lock**: Configurable idle timer, locks on browser close and system sleep
- **Clipboard auto-clear**: Copied values cleared after 30 seconds (configurable)
- **Exclude domains**: Never prompt to save on specified sites
- **No telemetry**: Zero analytics, no external network requests except to localhost

### Context Menu
Right-click on any page to:
- **Fill with Claspt** — auto-fill the current form
- **Generate password** — generate and copy to clipboard
- **Copy password for this site** — copy the top-matching password
- **Copy username for this site** — copy the top-matching username

## How It's Different

| Feature | Claspt | 1Password | Bitwarden | LastPass |
|---------|--------|-----------|-----------|----------|
| Works offline (generator) | Yes | No | No | No |
| Notes + passwords together | Yes | No | No | No |
| Vault is plain .md files | Yes | No | No | No |
| MCP server for AI tools | Yes | No | No | No |
| No cloud account required | Yes | No | Yes | No |
| Open vault format | Yes | No | No | No |
| Unsaved credential queue | Yes | No | No | No |
| Built-in phishing warnings | Yes | Yes | Yes | Yes |
| TOTP auto-paste | Yes | Yes | Yes | No |
| Credit card auto-fill | Yes | Yes | Yes | Yes |
| Password history | Yes | No | Yes | Yes |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+Shift+L / Ctrl+Shift+L | Fill credentials for current page |
| / | Focus search (when popup is open) |
| Arrow Up/Down | Navigate credential list |
| Enter | Fill selected credential |
| Escape | Close popup |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-fill credentials | On | Show inline icons on login fields |
| Auto-fill on page load | Off | Fill automatically without clicking (exact domain match only) |
| Auto-paste TOTP | On | Fill 2FA code after password |
| Show fill flash | On | Gold highlight on filled fields |
| Phishing warnings | On | Warn on domain mismatches |
| Iframe protection | On | Block fill in iframes |
| Lock on browser close | On | Clear cache when browser closes |
| Auto-lock after idle | 15 min | Configurable (0 = never) |
| Clipboard clear | 30s | Auto-clear copied values (0 = never) |

## Troubleshooting

### "Claspt is not running"
- Check that the desktop app is open and the vault is unlocked
- Go to Settings → Integrations → Local API and make sure it's enabled
- Verify the port (default 9315) and token match in the extension settings

### Credentials not detected on a site
- The form may use non-standard input patterns
- Try clicking the Claspt icon directly on the password field
- Use the popup to search and manually copy username/password

### Username copied to both fields
- Some sites have unusual form structures
- The extension now has safety checks to prevent this
- If it still happens, expand the credential in the popup and use the individual Copy buttons

## Version History

See [CHANGELOG.md](../../browser-extension/CHANGELOG.md) for the full version history.
