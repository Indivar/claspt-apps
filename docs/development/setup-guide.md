# Claspt — Developer Environment Setup Guide

**Date:** February 2026
**Platform:** Ubuntu 24.04 LTS (aarch64) — adapt commands for macOS/Windows as noted
**Last verified:** February 2026

---

## Quick Status

| Dependency | Status | Action Required |
|------------|--------|-----------------|
| Rust toolchain (rustup, cargo, rustc) | **NOT INSTALLED** | Install via rustup |
| Node.js 20 LTS + npm | **NOT INSTALLED** | Install via nvm |
| Tauri 2.x CLI | **NOT INSTALLED** | Install via cargo |
| `pkg-config` | **NOT INSTALLED** | Install via apt |
| `libssl-dev` | **NOT INSTALLED** | Install via apt |
| `libgtk-3-dev` | **NOT INSTALLED** | Install via apt |
| `libwebkit2gtk-4.1-dev` | **NOT INSTALLED** | Install via apt |
| `libsoup-3.0-dev` | **NOT INSTALLED** | Install via apt |
| `libjavascriptcoregtk-4.1-dev` | **NOT INSTALLED** | Install via apt |
| `build-essential` | Installed | None |
| `curl` | Installed | None |
| `git` | Installed (2.43.0) | None |
| `libwebkit2gtk-4.1-0` (runtime) | Installed | None |
| `libsoup-3.0-0` (runtime) | Installed | None |
| `libjavascriptcoregtk-4.1-0` (runtime) | Installed | None |

---

## Step 1: System Dependencies (Linux/Ubuntu)

Install the development libraries Tauri 2.x requires. The runtime libraries are already present on this system, but the `-dev` header packages are needed for compilation.

```bash
sudo apt update
sudo apt install -y \
  pkg-config \
  libssl-dev \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

**Verify:**
```bash
pkg-config --modversion gtk+-3.0        # Expected: 3.24.x
pkg-config --modversion webkit2gtk-4.1  # Expected: 2.x
pkg-config --modversion libsoup-3.0     # Expected: 3.x
pkg-config --modversion openssl         # Expected: 3.x
```

### macOS

No system packages needed — Xcode Command Line Tools provide everything:
```bash
xcode-select --install
```

### Windows

Install [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload. Also install [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (included in Windows 11, may need manual install on Windows 10).

---

## Step 2: Rust Toolchain

Install Rust via `rustup` (the official Rust toolchain manager).

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Choose option 1 (default installation) when prompted. Then activate it:

```bash
source "$HOME/.cargo/env"
```

**Verify:**
```bash
rustc --version    # Expected: rustc 1.8x.x (latest stable)
cargo --version    # Expected: cargo 1.8x.x
rustup show        # Should show stable toolchain
```

### Add Rust components

```bash
rustup component add clippy rustfmt
```

### Cross-compilation targets (optional, for cross-platform builds)

```bash
# Only if building for other architectures on this machine:
rustup target add x86_64-unknown-linux-gnu    # Intel Linux
rustup target add x86_64-apple-darwin         # Intel Mac
rustup target add aarch64-apple-darwin        # Apple Silicon Mac
rustup target add x86_64-pc-windows-msvc      # Windows
```

---

## Step 3: Node.js 20 LTS

Install Node.js via `nvm` (Node Version Manager) for easy version management.

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Restart your terminal or source your profile:
```bash
source ~/.bashrc   # or ~/.zshrc
```

Install and use Node.js 20 LTS:
```bash
nvm install 20
nvm use 20
nvm alias default 20
```

**Verify:**
```bash
node --version   # Expected: v20.x.x
npm --version    # Expected: 10.x.x
```

### Alternative: Direct install (without nvm)

```bash
# Ubuntu/Debian:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## Step 4: Tauri 2.x CLI

Install the Tauri CLI via cargo:

```bash
cargo install tauri-cli --version "^2"
```

This compiles from source and takes a few minutes on first install.

**Verify:**
```bash
cargo tauri --version   # Expected: tauri-cli 2.x.x
```

### Create Tauri app (for initial scaffolding)

When ready to scaffold the project:
```bash
cargo tauri init
```

Or create a new project from scratch:
```bash
npm create tauri-app@latest claspt -- --template react-ts
```

---

## Step 5: Project Dependencies

Once the project is scaffolded, install all dependencies:

```bash
# Frontend dependencies
npm install

# Verify Rust backend compiles
cd src-tauri && cargo check && cd ..
```

### Key npm packages (to be added during scaffolding)

```bash
# React + TypeScript (included by Tauri template)
# Additional packages for Claspt:
npm install @codemirror/state @codemirror/view @codemirror/lang-markdown
npm install @codemirror/language @codemirror/commands @codemirror/search
npm install @lezer/highlight @lezer/markdown
npm install zustand
npm install tailwindcss @tailwindcss/typography autoprefixer postcss
npm install gray-matter                    # YAML frontmatter parsing
npm install uuid                           # UUID generation

# Dev dependencies
npm install -D vitest @testing-library/react @testing-library/jest-dom
npm install -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser
npm install -D prettier eslint-config-prettier
npm install -D @tauri-apps/cli
```

### Key Rust crates (to be added to `src-tauri/Cargo.toml`)

```toml
[dependencies]
tauri = { version = "2", features = ["shell-open"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
ring = "0.17"                    # AES-256-GCM encryption
argon2 = "0.5"                   # Argon2id key derivation
zeroize = { version = "1", features = ["derive"] }  # Memory zeroing
tantivy = "0.22"                 # Full-text search
git2 = "0.19"                    # Git operations (libgit2)
uuid = { version = "1", features = ["v4"] }
notify = "7"                     # Filesystem watcher
base64 = "0.22"
rand = "0.8"
chrono = { version = "0.4", features = ["serde"] }
```

---

## Step 6: IDE Setup (Recommended)

### VS Code

Install these extensions:
- **rust-analyzer** — Rust language support, code completion, inline errors
- **Tauri** — Tauri-specific tooling
- **ESLint** — JavaScript/TypeScript linting
- **Prettier** — Code formatting
- **Tailwind CSS IntelliSense** — Tailwind class autocomplete
- **CodeLens** — Inline test running

Recommended VS Code settings (`.vscode/settings.json`):
```json
{
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true,
  "[rust]": {
    "editor.defaultFormatter": "rust-lang.rust-analyzer",
    "editor.formatOnSave": true
  },
  "rust-analyzer.check.command": "clippy",
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

---

## Step 7: Verify Full Setup

Run through this checklist to confirm everything is ready:

```bash
# 1. System deps
pkg-config --modversion gtk+-3.0 webkit2gtk-4.1 libsoup-3.0 openssl

# 2. Rust
rustc --version && cargo --version

# 3. Rust components
cargo clippy --version && rustfmt --version

# 4. Node.js
node --version && npm --version

# 5. Tauri CLI
cargo tauri --version

# 6. Git
git --version
```

Expected output (versions may be newer):
```
3.24.43
2.46.5
3.4.4
3.0.13
clippy 0.1.8x
rustfmt 1.8.x
v20.x.x
10.x.x
tauri-cli 2.x.x
git version 2.43.0
```

### One-liner verification

```bash
echo "=== System ===" && pkg-config --modversion gtk+-3.0 webkit2gtk-4.1 libsoup-3.0 openssl && echo "=== Rust ===" && rustc --version && cargo --version && echo "=== Node ===" && node --version && npm --version && echo "=== Tauri ===" && cargo tauri --version && echo "=== Git ===" && git --version && echo "=== ALL GOOD ==="
```

---

## Troubleshooting

### `pkg-config` not finding libraries

Ensure you installed the `-dev` packages, not just the runtime libraries:
```bash
# Wrong (runtime only):
sudo apt install libgtk-3-0
# Right (development headers):
sudo apt install libgtk-3-dev
```

### Rust compilation errors with `ring` crate

The `ring` crate requires a C compiler and may need specific platform support:
```bash
# Ensure build-essential is installed (already present on this system)
sudo apt install build-essential
```

### Node.js version conflicts

If you have multiple Node versions or a system-installed Node:
```bash
nvm use 20        # Switch to Node 20
nvm alias default 20  # Set as default
```

### Tauri CLI version mismatch

Ensure the CLI matches Tauri 2.x:
```bash
cargo install tauri-cli --version "^2" --force
```

### WebKit2GTK version

Tauri 2.x requires `webkit2gtk-4.1` (not the older `4.0`). On Ubuntu 24.04, the correct package is `libwebkit2gtk-4.1-dev`.

### Permission issues on shared filesystems

This project is on a shared filesystem (`/media/psf/`). If you encounter permission issues with `cargo build` or file watchers:
```bash
# Build in a local directory instead
export CARGO_TARGET_DIR="$HOME/.cargo-target/claspt"
```

---

## Platform-Specific Notes

### macOS (development)
- Requires Xcode Command Line Tools
- Touch ID integration requires macOS 13+
- Universal binary builds require both `aarch64-apple-darwin` and `x86_64-apple-darwin` targets
- Code signing requires Apple Developer account ($99/year)

### Windows (development)
- Requires Visual Studio Build Tools with C++ workload
- WebView2 runtime (bundled in Windows 11)
- Windows Hello integration for biometric unlock
- `.msi` packaging via WiX Toolset (included in Tauri)

### Linux (this system)
- Ubuntu 24.04 aarch64 (ARM64)
- GTK3 + WebKit2GTK 4.1 for Tauri webview
- AppImage and `.deb` packaging supported natively
- Flatpak/Snap require additional configuration
