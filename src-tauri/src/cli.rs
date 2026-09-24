// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! CLI tool for interacting with the local API server.
//!
//! Invoked via `claspt <subcommand>`. Makes HTTP requests to the
//! local API running on 127.0.0.1.

use clap::{Parser, Subcommand};

/// Top-level parsed command line. With no subcommand the app launches normally; `--mcp`
/// runs the stdio MCP server and `--tray` starts tray-only.
#[derive(Parser)]
#[command(name = "claspt", about = "Claspt vault CLI", version = env!("APP_VERSION"))]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<CliCommand>,

    /// Run as MCP server (JSON-RPC over stdio)
    #[arg(long)]
    pub mcp: bool,

    /// Start in tray-only mode (no main window)
    #[arg(long)]
    pub tray: bool,
}

/// The headless subcommands, each of which drives the local API over HTTP.
#[derive(Subcommand)]
pub enum CliCommand {
    /// Show vault / API status
    Status,
    /// Search pages
    Search {
        /// Search query
        query: String,
    },
    /// Read a page by path
    Read {
        /// Relative page path
        path: String,
    },
    /// Create a new page
    Create {
        /// Page title
        title: String,
        /// Folder (default: general)
        #[arg(short, long, default_value = "general")]
        folder: String,
        /// Content (reads from stdin if not provided)
        #[arg(short, long)]
        content: Option<String>,
    },
    /// Update a page's content
    Update {
        /// Relative page path
        path: String,
        /// New content (reads from stdin if not provided)
        #[arg(short, long)]
        content: Option<String>,
    },
    /// List pages (optionally filtered by folder)
    List {
        /// Filter by folder
        #[arg(short, long)]
        folder: Option<String>,
    },
    /// List folders
    Folders,
    /// Run a program with secrets in its environment, without printing them
    ///
    /// Any --env value, --env-file value or inherited variable that is a
    /// claspt://secret/<page>#<field> reference is replaced by the secret.
    /// The value exists only inside the child process.
    Run {
        /// NAME=claspt://secret/<page>?block=<label>#<field> (repeatable)
        #[arg(long = "env", short = 'e', value_name = "NAME=REF")]
        env: Vec<String>,
        /// dotenv-style file whose values may be references (repeatable)
        #[arg(long = "env-file", short = 'f', value_name = "FILE")]
        env_file: Vec<std::path::PathBuf>,
        /// The program and its arguments
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<std::ffi::OsString>,
    },
    /// Fill a template's claspt://secret references and print or write it
    ///
    /// Reads the template from a file ('-' for stdin). Writes to stdout, or
    /// with --out to a file only the current user can read.
    Inject {
        /// Template file, or '-' for stdin
        template: String,
        /// Write here (owner-only permissions) instead of stdout
        #[arg(long, short = 'o')]
        out: Option<std::path::PathBuf>,
    },
    /// Run the local API without the desktop app (key-file unlock, policy file)
    Serve {
        #[command(subcommand)]
        action: ServeAction,
    },
    /// SSH agent: point ssh at the vault's keys
    Ssh {
        #[command(subcommand)]
        action: SshAction,
    },
    /// Report secret material stored unencrypted anywhere in the vault
    Audit {
        /// Instead, list stored passwords older than the rotation limit
        #[arg(long)]
        rotation: bool,
    },
    /// Connect an MCP client (Claude Code, Cursor, Codex, ...) to this vault
    Mcp {
        #[command(subcommand)]
        action: McpAction,
    },
    /// Show API activity: which client did what, and when
    Log {
        /// How many entries (newest first)
        #[arg(short, long, default_value_t = 50)]
        limit: usize,
        /// Only this client id (from `claspt tokens list`)
        #[arg(long)]
        client: Option<String>,
        /// A whole month, YYYY-MM, instead of the most recent entries
        #[arg(long)]
        month: Option<String>,
    },
    /// List, create or revoke the named clients that may call the API
    Tokens {
        #[command(subcommand)]
        action: TokensAction,
    },
    /// Show or pin the agent memory namespace for the current directory
    Namespace {
        #[command(subcommand)]
        action: Option<NamespaceAction>,
    },
    /// Manage agent memory store
    Memory {
        #[command(subcommand)]
        action: MemoryAction,
    },
    /// Generate passwords, passphrases, PINs, or UUIDs
    Generate {
        /// Type: password, passphrase, memorable, pin, uuid
        #[arg(default_value = "password")]
        r#type: String,
        /// Length (password) or digits (pin) or syllables (memorable)
        #[arg(short, long, default_value = "20")]
        length: usize,
        /// Number of values to generate
        #[arg(short, long, default_value = "1")]
        count: usize,
        /// Memorable style: pronounceable or pattern
        #[arg(short, long)]
        style: Option<String>,
        /// Word list for passphrase: eff or bip39
        #[arg(short, long, default_value = "eff")]
        word_list: String,
        /// Separator for passphrase
        #[arg(long, default_value = "-")]
        separator: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

/// Configuration for connecting to the local API.
struct ApiConfig {
    port: u16,
    token: String,
}

impl ApiConfig {
    fn from_env_or_config() -> Result<Self, String> {
        // Try environment variables first
        let port = std::env::var("CLASPT_API_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(9315);
        let token = std::env::var("CLASPT_API_TOKEN").or_else(|_| Self::cli_token())?;
        Ok(Self { port, token })
    }

    /// This CLI's own client token.
    ///
    /// The CLI is a client like any other: it has a named entry in the vault's
    /// client registry and keeps its plaintext token in the OS keychain. The
    /// first run mints it ("CLI on <host>"), which is visible and revocable in
    /// Settings. A revoked token is not silently re-minted: the keychain still
    /// holds it, the API refuses it, and the user is told how to replace it.
    fn cli_token() -> Result<String, String> {
        use crate::local_api::auth::TokenScope;
        use crate::vault::token_store::{self, TokenKind};
        let vault_dir = vault_dir_for_cli()?;
        let config = crate::vault::init::read_config(&vault_dir)
            .map_err(|e| format!("Cannot read vault config: {e}"))?;
        let vault_id = config
            .vault_id
            .filter(|id| !id.is_empty())
            .ok_or("This vault has not been opened in the app yet; unlock it once first.")?;
        match token_store::load(&vault_id, TokenKind::Cli) {
            Ok(Some(token)) => return Ok(token.to_string()),
            Ok(None) => {}
            Err(e) => {
                return Err(format!(
                    "Cannot reach the OS keychain ({e}). Set CLASPT_API_TOKEN to a token created in Settings."
                ))
            }
        }
        let minted = crate::local_api::clients::create(
            &vault_dir,
            &crate::local_api::clients::default_name("CLI"),
            TokenScope::Secrets,
            &[],
        )
        .map_err(|e| format!("Cannot register this CLI as an API client: {e}"))?;
        token_store::store(&vault_id, TokenKind::Cli, &minted.token).map_err(|e| {
            format!("Registered the CLI but could not keep its token in the keychain: {e}")
        })?;
        eprintln!(
            "Registered this CLI as API client \"{}\" (revocable in Settings).",
            minted.client.name
        );
        Ok(minted.token.to_string())
    }
}

/// Resolves `claspt://secret/...` references through the API, reading each
/// page once. Every read goes through the same approval gate, rate limit and
/// access log as any other client; the user may be asked in the app.
struct SecretResolver<'a> {
    config: &'a ApiConfig,
    pages: std::collections::HashMap<String, crate::secret_ref::SecretBlocks>,
}

impl<'a> SecretResolver<'a> {
    fn new(config: &'a ApiConfig) -> Self {
        Self {
            config,
            pages: std::collections::HashMap::new(),
        }
    }

    fn resolve(&mut self, reference: &crate::secret_ref::SecretRef) -> Result<String, String> {
        if !self.pages.contains_key(&reference.page) {
            let listing = api_get(
                self.config,
                &format!("/api/pages/{}/secret", urlencoding::encode(&reference.page)),
            )?;
            let blocks = crate::secret_ref::blocks_from_listing(&listing)?;
            self.pages.insert(reference.page.clone(), blocks);
        }
        reference
            .select(&self.pages[&reference.page])
            .map(str::to_string)
    }
}

/// Variables that authenticate *this* process to Claspt and must not be
/// inherited by the program `claspt run` starts.
///
/// The child gets the resolved secret values it asked for and nothing that
/// would let it ask for more. Forwarding `CLASPT_API_TOKEN` handed every
/// dependency of `npm start` a Secrets-scope token and, with it, the whole
/// vault over the local API, which is the opposite of what running a program
/// with one injected value is for.
const CLI_CREDENTIAL_VARS: &[&str] = &[
    "CLASPT_API_TOKEN",
    "CLASPT_API_PORT",
    "CLASPT_SERVE_PASSPHRASE",
    "CLASPT_PASSWORD",
];

/// The parent environment minus [`CLI_CREDENTIAL_VARS`].
fn child_environment(parent: Vec<(String, String)>) -> Vec<(String, String)> {
    parent
        .into_iter()
        .filter(|(name, _)| !CLI_CREDENTIAL_VARS.contains(&name.as_str()))
        .collect()
}

/// `claspt run`: build the child's environment, spawn, wait, return its exit
/// code. The parent's environment, less the CLI's own credentials, is the
/// base; entries from files and --env are applied on top in the order given.
fn run_with_secrets(
    config: &ApiConfig,
    env: Vec<String>,
    env_files: Vec<std::path::PathBuf>,
    command: Vec<std::ffi::OsString>,
) -> Result<i32, String> {
    use crate::secret_ref;
    let mut entries: Vec<(String, String)> = child_environment(std::env::vars().collect());
    for file in &env_files {
        let text = std::fs::read_to_string(file)
            .map_err(|e| format!("cannot read {}: {e}", file.display()))?;
        entries.extend(
            secret_ref::parse_env_file(&text).map_err(|e| format!("{}: {e}", file.display()))?,
        );
    }
    for pair in &env {
        let (k, v) = pair
            .split_once('=')
            .ok_or_else(|| format!("--env expects NAME=REF, got '{pair}'"))?;
        entries.push((k.to_string(), v.to_string()));
    }
    let references = entries
        .iter()
        .filter(|(_, v)| v.starts_with(secret_ref::PREFIX))
        .count();
    if references > 0 {
        eprintln!("claspt: resolving {references} secret reference(s); approve in the Claspt app if asked");
    }
    let mut resolver = SecretResolver::new(config);
    let resolved = secret_ref::resolve_env(entries, |r| resolver.resolve(r))?;
    let (program, args) = command
        .split_first()
        .ok_or("claspt run needs a program to run")?;
    let status = std::process::Command::new(program)
        .args(args)
        .env_clear()
        .envs(&resolved)
        .status()
        .map_err(|e| format!("cannot start {}: {e}", program.to_string_lossy()))?;
    Ok(status.code().unwrap_or(1))
}

/// `claspt inject`: substitute every reference in a template. Output goes to
/// stdout unless `--out` names a file, which is written owner-only because it
/// now holds secret values.
fn inject_template(
    config: &ApiConfig,
    template: &str,
    out: Option<&std::path::Path>,
) -> Result<(), String> {
    use std::io::Read;
    let mut text = String::new();
    if template == "-" {
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|e| format!("cannot read stdin: {e}"))?;
    } else {
        text = std::fs::read_to_string(template)
            .map_err(|e| format!("cannot read {template}: {e}"))?;
    }
    let mut resolver = SecretResolver::new(config);
    let filled = crate::secret_ref::substitute(&text, |r| resolver.resolve(r))?;
    match out {
        Some(path) => {
            crate::vault::init::write_restricted(path, filled.as_bytes())
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            eprintln!("claspt: wrote {} (owner-only)", path.display());
        }
        None => {
            use std::io::Write;
            let mut stdout = std::io::stdout().lock();
            stdout
                .write_all(filled.as_bytes())
                .and_then(|_| stdout.flush())
                .map_err(|e| format!("cannot write output: {e}"))?;
        }
    }
    Ok(())
}

fn run_serve(action: ServeAction) -> Result<(), String> {
    match action {
        ServeAction::InitKey { vault, out } => {
            let vault = match vault {
                Some(v) => v,
                None => vault_dir_for_cli()?,
            };
            crate::serve::init_key(&vault, &out)?;
            eprintln!(
                "Wrote {} (owner-only). Keep {} with it on the server; the vault password stays here.",
                out.display(),
                crate::serve::PASSPHRASE_ENV
            );
            Ok(())
        }
        ServeAction::Run {
            vault,
            key_file,
            policy,
            port,
            ssh_agent,
        } => {
            let vault_dir = match vault {
                Some(v) => v,
                None => vault_dir_for_cli()?,
            };
            let port = match port {
                Some(p) => p,
                None => crate::vault::init::read_config(&vault_dir)
                    .map(|c| c.local_api_port)
                    .map_err(|e| format!("cannot read vault config: {e}"))?,
            };
            let policy =
                policy.unwrap_or_else(|| vault_dir.join(".securenotes").join("policy.toml"));
            crate::serve::run(crate::serve::ServeOptions {
                vault_dir,
                key_file,
                policy,
                port,
                ssh_agent,
            })
        }
    }
}

/// The vault the CLI talks about: `CLASPT_VAULT_DIR`, else `~/Claspt`.
/// The vault a command works on: `CLASPT_VAULT_DIR`, else the vault the app
/// opened last, else the default directory (see `last_opened::cli_vault_dir`).
fn vault_dir_for_cli() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find vault: no home dir")?;
    let env_override = std::env::var("CLASPT_VAULT_DIR").ok();
    let app_config_dir = crate::vault::last_opened::app_config_dir();
    Ok(crate::vault::last_opened::cli_vault_dir(
        env_override.as_deref(),
        app_config_dir.as_deref(),
        &home,
    ))
}

/// Subcommands under `claspt serve`.
#[derive(Subcommand)]
pub enum ServeAction {
    /// Serve the vault: unlock from the key file, decide requests by the policy
    ///
    /// The key file's passphrase is read from CLASPT_SERVE_PASSPHRASE.
    Run {
        /// Vault directory (default: CLASPT_VAULT_DIR, else ~/Claspt)
        #[arg(long)]
        vault: Option<std::path::PathBuf>,
        /// Key file made by `claspt serve init-key`
        #[arg(long)]
        key_file: std::path::PathBuf,
        /// Policy file (default: <vault>/.securenotes/policy.toml)
        #[arg(long)]
        policy: Option<std::path::PathBuf>,
        /// Port on 127.0.0.1 (default: the vault's local_api_port)
        #[arg(long)]
        port: Option<u16>,
        /// Also serve the SSH agent
        #[arg(long)]
        ssh_agent: bool,
    },
    /// Make a key file: reads the vault password from stdin, wraps the master
    /// key with the passphrase in CLASPT_SERVE_PASSPHRASE, writes it owner-only
    InitKey {
        /// Vault directory (default: CLASPT_VAULT_DIR, else ~/Claspt)
        #[arg(long)]
        vault: Option<std::path::PathBuf>,
        /// Where to write the key file
        #[arg(long)]
        out: std::path::PathBuf,
    },
}

/// Subcommands under `claspt ssh`.
#[derive(Subcommand)]
pub enum SshAction {
    /// Print the shell line that points ssh at the agent (eval "$(claspt ssh env)")
    Env,
    /// List the keys the agent offers (public halves and where they live)
    List,
    /// Store an OpenSSH private key file in the vault for the agent
    Add {
        /// Path to the private key (its .pub, if present, is stored too)
        file: std::path::PathBuf,
        /// Label for the secret block (default: the file name)
        #[arg(long)]
        label: Option<String>,
        /// Page the key goes on, under ai/ (default: ssh-keys)
        #[arg(long, default_value = "ssh-keys")]
        page: String,
        /// Read the key's passphrase from stdin and store it alongside
        #[arg(long)]
        passphrase_stdin: bool,
    },
}

/// Subcommands under `claspt mcp`.
#[derive(Subcommand)]
pub enum McpAction {
    /// Write this app's MCP server into one or more clients' config files
    ///
    /// By default every tool on this machine shares one token: it is issued
    /// once, written into each named client, and refreshed in every other
    /// config that carried the previous shared token or a token the vault no
    /// longer knows. --separate gives the named clients a token of their own.
    Install {
        /// One or more of: claude-code, claude-desktop, cursor, windsurf, gemini-cli, codex
        #[arg(required = true, num_args = 1..)]
        clients: Vec<String>,
        /// Use the Secrets token (can decrypt, with approval) instead of the Notes token
        #[arg(long)]
        secrets: bool,
        /// Write the project-scoped config in the current directory (claude-code, cursor);
        /// a project token is always its own, limited to that project's memory
        #[arg(long)]
        project: bool,
        /// A token of its own for each named client, instead of the shared one
        #[arg(long)]
        separate: bool,
        /// Print the config instead of writing it; the token is masked
        #[arg(long)]
        print: bool,
        /// The vault to register the token in (default: the vault the app has open)
        #[arg(long)]
        vault: Option<std::path::PathBuf>,
        /// The Claspt binary to write into the configs (default: this one); for a
        /// build that is not the installed app
        #[arg(long)]
        command: Option<std::path::PathBuf>,
    },
    /// Check every AI tool's config on this machine against the open vault
    Doctor {
        /// The vault to check against (default: the vault the app has open)
        #[arg(long)]
        vault: Option<std::path::PathBuf>,
    },
    /// List supported clients and where each one's config lives
    Clients,
}

/// Subcommands under `claspt tokens`.
#[derive(Subcommand)]
pub enum TokensAction {
    /// List registered clients (names, scopes, hints; never tokens)
    List,
    /// Mint a token for a new named client and print it once
    Create {
        /// A name you will recognise in Settings, e.g. "Deploy script"
        name: String,
        /// Secrets scope (can decrypt, with approval) instead of Notes
        #[arg(long)]
        secrets: bool,
        /// Restrict memory access to these namespaces (comma-separated; default: all)
        #[arg(long, value_delimiter = ',')]
        namespaces: Vec<String>,
    },
    /// Revoke a client by id (from `claspt tokens list`)
    Revoke { id: String },
    /// Forget this CLI's own token so the next command registers a new one
    ResetCli,
}

/// Subcommands under `claspt namespace`.
#[derive(Subcommand)]
pub enum NamespaceAction {
    /// Print the resolved namespace and where it came from (default)
    Show,
    /// Write a `.claspt` marker in the current directory pinning the namespace
    Init {
        /// Namespace to pin (default: the currently resolved one)
        name: Option<String>,
    },
    /// Accept the `.claspt` marker found from the current directory upward, so
    /// that it decides the namespace on this machine. A marker that arrived
    /// with a clone is ignored until it is accepted, because it could point an
    /// agent session at another project's memory.
    Trust,
}

/// Subcommands under `claspt memory` for the agent memory store.
#[derive(Subcommand)]
pub enum MemoryAction {
    /// Create or update a memory
    Upsert {
        /// Memory title
        title: String,
        /// Namespace (default: resolved for the current directory, see `claspt namespace`)
        #[arg(long)]
        ns: Option<String>,
        /// Content (reads from stdin if not provided)
        #[arg(short, long)]
        content: Option<String>,
        /// Comma-separated tags
        #[arg(short, long)]
        tags: Option<String>,
        /// Time-to-live in hours (0 = permanent)
        #[arg(long)]
        ttl: Option<u64>,
        /// Only if the memory is still at this etag (from `claspt memory read`)
        #[arg(long)]
        if_match: Option<String>,
        /// Kind: episodic, semantic or procedural
        #[arg(long)]
        kind: Option<String>,
        /// Title of the memory that replaces this one
        #[arg(long)]
        superseded_by: Option<String>,
    },
    /// Search memory pages across namespaces
    Search {
        /// Search terms
        query: String,
        /// Limit to these namespaces (comma-separated; default: all you may use)
        #[arg(long, value_delimiter = ',')]
        namespaces: Vec<String>,
        /// Max hits
        #[arg(short, long, default_value_t = 20)]
        limit: usize,
    },
    /// Import another tool's memory (mem0, letta, zep, claude-md, cursor-rules)
    Import {
        /// Source format
        #[arg(long)]
        from: String,
        /// File to import; for cursor-rules, a directory of .mdc files is accepted
        path: std::path::PathBuf,
        /// Namespace (default: resolved for the current directory)
        #[arg(long)]
        ns: Option<String>,
        /// Show what would be written and stop
        #[arg(long)]
        dry_run: bool,
    },
    /// Move older sections of a memory into an archive page
    Compact {
        /// Memory title
        title: String,
        /// Namespace (default: resolved for the current directory)
        #[arg(long)]
        ns: Option<String>,
        /// How many newest `## ` sections stay
        #[arg(long, default_value_t = 10)]
        keep: usize,
    },
    /// Confirm a memory is still true (sets verified_on to now)
    Verify {
        /// Memory title
        title: String,
        /// Namespace (default: resolved for the current directory, see `claspt namespace`)
        #[arg(long)]
        ns: Option<String>,
    },
    /// Append text to the end of a memory (creates it if missing)
    Append {
        /// Memory title
        title: String,
        /// Namespace (default: resolved for the current directory, see `claspt namespace`)
        #[arg(long)]
        ns: Option<String>,
        /// Text to append (reads from stdin if not provided)
        #[arg(short, long)]
        text: Option<String>,
        /// Only if the memory is still at this etag (from `claspt memory read`)
        #[arg(long)]
        if_match: Option<String>,
    },
    /// List memories in a namespace
    List {
        /// Namespace (default: resolved for the current directory, see `claspt namespace`)
        #[arg(long)]
        ns: Option<String>,
        /// Filter by tag
        #[arg(short, long)]
        tag: Option<String>,
    },
    /// Read a specific memory
    Read {
        /// Memory title
        title: String,
        /// Namespace (default: resolved for the current directory, see `claspt namespace`)
        #[arg(long)]
        ns: Option<String>,
    },
    /// Delete a memory
    Delete {
        /// Memory title
        title: String,
        /// Namespace (default: resolved for the current directory, see `claspt namespace`)
        #[arg(long)]
        ns: Option<String>,
    },
    /// Trigger TTL cleanup
    Cleanup,
}

fn api_delete(config: &ApiConfig, path: &str) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{}{path}", config.port);
    let resp = reqwest::blocking::Client::new()
        .delete(&url)
        .header("Authorization", format!("Bearer {}", config.token))
        .send()
        .map_err(|e| format!("Request failed: {e}"))?;
    if resp.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(serde_json::json!({ "deleted": true }));
    }
    crate::api_response::read_response(resp)
}

fn api_get(config: &ApiConfig, path: &str) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{}{path}", config.port);
    let resp = reqwest::blocking::Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.token))
        .send()
        .map_err(|e| format!("Request failed: {e}"))?;
    crate::api_response::read_response(resp)
}

fn api_post(
    config: &ApiConfig,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{}{path}", config.port);
    let resp = reqwest::blocking::Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.token))
        .json(body)
        .send()
        .map_err(|e| format!("Request failed: {e}"))?;
    crate::api_response::read_response(resp)
}

fn api_put(
    config: &ApiConfig,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{}{path}", config.port);
    let resp = reqwest::blocking::Client::new()
        .put(&url)
        .header("Authorization", format!("Bearer {}", config.token))
        .json(body)
        .send()
        .map_err(|e| format!("Request failed: {e}"))?;
    crate::api_response::read_response(resp)
}

/// One request with an optional JSON body and an optional `If-Match`.
fn api_send(
    config: &ApiConfig,
    method: reqwest::Method,
    path: &str,
    body: Option<&serde_json::Value>,
    if_match: Option<&str>,
) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{}{path}", config.port);
    let mut request = reqwest::blocking::Client::new()
        .request(method, &url)
        .header("Authorization", format!("Bearer {}", config.token));
    if let Some(body) = body {
        request = request.json(body);
    }
    if let Some(etag) = if_match {
        request = request.header("If-Match", etag);
    }
    let resp = request.send().map_err(|e| format!("Request failed: {e}"))?;
    crate::api_response::read_response(resp)
}

/// Run a CLI command. Returns Ok(true) if a CLI command was handled, Ok(false) if not.
pub fn run_cli() -> Result<bool, String> {
    let cli = Cli::parse();

    // --mcp flag
    if cli.mcp {
        crate::mcp::run_mcp_server();
        return Ok(true);
    }

    // --tray flag: launch GUI but request tray-only mode via env
    if cli.tray {
        std::env::set_var("CLASPT_TRAY_ONLY", "1");
        return Ok(false); // proceed to GUI launch
    }

    // No subcommand — launch GUI
    let command = match cli.command {
        Some(cmd) => cmd,
        None => return Ok(false),
    };

    if let CliCommand::Log {
        limit,
        client,
        month,
    } = command
    {
        use crate::internal::access_log;
        let vault_dir = vault_dir_for_cli()?;
        let entries = match month {
            Some(m) => access_log::read_month(&vault_dir, &m, client.as_deref()),
            None => access_log::read_recent(&vault_dir, limit, client.as_deref()),
        }
        .map_err(|e| e.to_string())?;
        if entries.is_empty() {
            let months = access_log::list_months(&vault_dir).map_err(|e| e.to_string())?;
            let on_file = if months.is_empty() {
                "none".to_string()
            } else {
                months.join(", ")
            };
            println!("No API activity recorded. Months on file: {on_file}");
            return Ok(true);
        }
        println!(
            "{:<20}  {:<6}  {:<16}  {:<28}  target",
            "time (UTC)", "status", "action", "client"
        );
        for e in entries {
            println!(
                "{:<20}  {:<6}  {:<16}  {:<28}  {}",
                e.ts.format("%Y-%m-%d %H:%M:%S"),
                e.status,
                e.action,
                e.client_name.chars().take(28).collect::<String>(),
                e.target
            );
        }
        return Ok(true);
    }
    if let CliCommand::Tokens { action } = command {
        run_tokens(action)?;
        return Ok(true);
    }
    if let CliCommand::Mcp { action } = command {
        run_mcp(action)?;
        return Ok(true);
    }
    if let CliCommand::Namespace { action } = command {
        run_namespace(action.unwrap_or(NamespaceAction::Show))?;
        return Ok(true);
    }
    if let CliCommand::Serve { action } = command {
        run_serve(action)?;
        return Ok(true);
    }
    if let CliCommand::Ssh {
        action: SshAction::Env,
    } = command
    {
        let path = crate::ssh_agent::socket_path()?;
        if cfg!(windows) {
            println!("$env:SSH_AUTH_SOCK = '{path}'");
        } else {
            println!("export SSH_AUTH_SOCK=\"{path}\"");
        }
        return Ok(true);
    }

    let config = ApiConfig::from_env_or_config()?;

    match command {
        CliCommand::Serve { .. }
        | CliCommand::Namespace { .. }
        | CliCommand::Mcp { .. }
        | CliCommand::Tokens { .. }
        | CliCommand::Log { .. } => {
            unreachable!("handled before the API config is loaded")
        }
        CliCommand::Run {
            env,
            env_file,
            command,
        } => {
            let code = run_with_secrets(&config, env, env_file, command)?;
            std::process::exit(code);
        }
        CliCommand::Inject { template, out } => {
            inject_template(&config, &template, out.as_deref())?;
        }
        CliCommand::Ssh {
            action: SshAction::Env,
        } => unreachable!("handled before the API config is loaded"),
        CliCommand::Ssh {
            action:
                SshAction::Add {
                    file,
                    label,
                    page,
                    passphrase_stdin,
                },
        } => {
            use crate::ssh_agent::keys;
            let pem = std::fs::read_to_string(&file)
                .map_err(|e| format!("cannot read {}: {e}", file.display()))?;
            let body = keys::one_line_body(&pem)?;
            let key = keys::parse_private(&body)?;
            let mut fields = serde_json::Map::new();
            fields.insert(
                keys::PRIVATE_KEY_FIELD.into(),
                serde_json::Value::String(body),
            );
            if key.is_encrypted() {
                if passphrase_stdin {
                    let mut line = String::new();
                    std::io::stdin()
                        .read_line(&mut line)
                        .map_err(|e| format!("cannot read passphrase: {e}"))?;
                    let line = line.trim_end_matches(['\r', '\n']).to_string();
                    if line.is_empty() {
                        return Err("empty passphrase".into());
                    }
                    fields.insert(
                        keys::PASSPHRASE_FIELD.into(),
                        serde_json::Value::String(line),
                    );
                } else {
                    return Err(
                        "this key has a passphrase; rerun with --passphrase-stdin and pipe it in, or add a 'passphrase' field to the block in the app"
                            .into(),
                    );
                }
            }
            let pub_path = file.with_extension(match file.extension().and_then(|e| e.to_str()) {
                Some(ext) => format!("{ext}.pub"),
                None => "pub".to_string(),
            });
            let public = match std::fs::read_to_string(&pub_path) {
                Ok(text) => text.trim().to_string(),
                Err(_) => key.public_key().to_openssh().unwrap_or_default(),
            };
            if !public.is_empty() {
                fields.insert(
                    keys::PUBLIC_KEY_FIELD.into(),
                    serde_json::Value::String(public),
                );
            }
            let label = label.unwrap_or_else(|| {
                file.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "SSH key".to_string())
            });
            let result = api_post(
                &config,
                "/api/secrets",
                &serde_json::json!({
                    "service": page,
                    "label": label,
                    "fields": fields,
                    "tags": [keys::KEY_TAG],
                    "agent_ns": "cli",
                }),
            )?;
            println!(
                "Stored '{label}' on {} (tagged {}); the agent offers it now.",
                result
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("the page"),
                keys::KEY_TAG
            );
        }
        CliCommand::Ssh {
            action: SshAction::List,
        } => {
            let result = api_get(&config, "/api/ssh/identities")?;
            let running = result
                .get("agent_running")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let socket = result.get("socket").and_then(|v| v.as_str()).unwrap_or("?");
            println!(
                "agent: {} ({socket})",
                if running { "running" } else { "stopped" }
            );
            for item in result
                .get("items")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                println!(
                    "{}  {}  {} [{}]",
                    item.get("fingerprint")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    item.get("label").and_then(|v| v.as_str()).unwrap_or(""),
                    item.get("page_title")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    item.get("page").and_then(|v| v.as_str()).unwrap_or("")
                );
            }
        }
        CliCommand::Audit { rotation } => {
            let path = if rotation {
                "/api/audit/rotation"
            } else {
                "/api/audit/secrets"
            };
            let result = api_get(&config, path)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
        }
        CliCommand::Status => {
            let result = api_get(&config, "/api/status")?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
        }
        CliCommand::Search { query } => {
            let result = api_get(
                &config,
                &format!("/api/search?q={}", urlencoding::encode(&query)),
            )?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
        }
        CliCommand::Read { path } => {
            let result = api_get(
                &config,
                &format!("/api/pages/{}", urlencoding::encode(&path)),
            )?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
        }
        CliCommand::Create {
            title,
            folder,
            content,
        } => {
            let content = content.unwrap_or_else(|| {
                let mut buf = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf).ok();
                buf
            });
            let body = serde_json::json!({
                "title": title,
                "folder": folder,
                "content": content,
            });
            let result = api_post(&config, "/api/pages", &body)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
        }
        CliCommand::Update { path, content } => {
            let content = content.unwrap_or_else(|| {
                let mut buf = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf).ok();
                buf
            });
            let body = serde_json::json!({ "content": content });
            let result = api_put(
                &config,
                &format!("/api/pages/{}", urlencoding::encode(&path)),
                &body,
            )?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
        }
        CliCommand::List { folder } => {
            let path = match folder {
                Some(f) => format!("/api/pages?folder={}", urlencoding::encode(&f)),
                None => "/api/pages".to_string(),
            };
            let result = api_get(&config, &path)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
        }
        CliCommand::Folders => {
            let result = api_get(&config, "/api/folders")?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
        }
        CliCommand::Memory { action } => match action {
            MemoryAction::Append {
                title,
                ns,
                text,
                if_match,
            } => {
                let ns = ns.unwrap_or_else(|| crate::agent_namespace::resolve().namespace);
                let text = text.unwrap_or_else(|| {
                    let mut buf = String::new();
                    std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf).ok();
                    buf
                });
                let result = api_send(
                    &config,
                    reqwest::Method::POST,
                    &format!(
                        "/api/memory/{}/{}/append",
                        urlencoding::encode(&ns),
                        urlencoding::encode(&title)
                    ),
                    Some(&serde_json::json!({ "text": text })),
                    if_match.as_deref(),
                )?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
            }
            MemoryAction::Upsert {
                title,
                ns,
                content,
                tags,
                ttl,
                if_match,
                kind,
                superseded_by,
            } => {
                let ns = ns.unwrap_or_else(|| crate::agent_namespace::resolve().namespace);
                let content = content.unwrap_or_else(|| {
                    let mut buf = String::new();
                    std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf).ok();
                    buf
                });
                let tags_vec: Vec<&str> = tags
                    .as_deref()
                    .map(|t| t.split(',').map(|s| s.trim()).collect())
                    .unwrap_or_default();
                let body = serde_json::json!({
                    "title": title,
                    "content": content,
                    "tags": tags_vec,
                    "ttl_hours": ttl,
                    "kind": kind,
                    "superseded_by": superseded_by,
                });
                let result = api_send(
                    &config,
                    reqwest::Method::PUT,
                    &format!("/api/memory/{}", urlencoding::encode(&ns)),
                    Some(&body),
                    if_match.as_deref(),
                )?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
            }
            MemoryAction::List { ns, tag } => {
                let ns = ns.unwrap_or_else(|| crate::agent_namespace::resolve().namespace);
                let mut path = format!("/api/memory/{}", urlencoding::encode(&ns));
                if let Some(ref t) = tag {
                    path = format!("{path}?tag={}", urlencoding::encode(t));
                }
                let result = api_get(&config, &path)?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
            }
            MemoryAction::Search {
                query,
                namespaces,
                limit,
            } => {
                let mut path = format!(
                    "/api/memory/search?q={}&limit={limit}",
                    urlencoding::encode(&query)
                );
                if !namespaces.is_empty() {
                    path.push_str(&format!(
                        "&namespaces={}",
                        urlencoding::encode(&namespaces.join(","))
                    ));
                }
                let result = api_get(&config, &path)?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
            }
            MemoryAction::Import {
                from,
                path,
                ns,
                dry_run,
            } => {
                use crate::memory_import::{self, Source};
                let source = Source::parse(&from)?;
                let ns = ns.unwrap_or_else(|| crate::agent_namespace::resolve().namespace);
                let mut files: Vec<std::path::PathBuf> = Vec::new();
                if path.is_dir() {
                    if source != Source::CursorRules {
                        return Err("a directory is only accepted for --from cursor-rules".into());
                    }
                    let mut entries: Vec<_> = std::fs::read_dir(&path)
                        .map_err(|e| format!("cannot read {}: {e}", path.display()))?
                        .filter_map(|e| e.ok().map(|e| e.path()))
                        .filter(|p| p.extension().is_some_and(|x| x == "mdc"))
                        .collect();
                    entries.sort();
                    files.extend(entries);
                } else {
                    files.push(path.clone());
                }
                let mut items = Vec::new();
                for file in &files {
                    let text = std::fs::read_to_string(file)
                        .map_err(|e| format!("cannot read {}: {e}", file.display()))?;
                    let name = file
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    items.extend(
                        memory_import::parse(source, &text, &name)
                            .map_err(|e| format!("{}: {e}", file.display()))?,
                    );
                }
                let inputs = memory_import::to_inputs(items);
                if inputs.is_empty() {
                    println!("Nothing to import.");
                } else if dry_run {
                    println!("Would write {} memories to '{ns}':", inputs.len());
                    for input in &inputs {
                        println!("  {}  [{}]", input.title, input.tags.join(", "));
                    }
                } else {
                    let result = api_post(
                        &config,
                        &format!("/api/memory/{}/bulk", urlencoding::encode(&ns)),
                        &serde_json::json!({ "memories": inputs }),
                    )?;
                    let written = result.as_array().map(|a| a.len()).unwrap_or(inputs.len());
                    println!("Imported {written} memories into '{ns}'.");
                }
            }
            MemoryAction::Compact { title, ns, keep } => {
                let ns = ns.unwrap_or_else(|| crate::agent_namespace::resolve().namespace);
                let result = api_post(
                    &config,
                    &format!(
                        "/api/memory/{}/{}/compact",
                        urlencoding::encode(&ns),
                        urlencoding::encode(&title)
                    ),
                    &serde_json::json!({ "keep_sections": keep }),
                )?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
            }
            MemoryAction::Verify { title, ns } => {
                let ns = ns.unwrap_or_else(|| crate::agent_namespace::resolve().namespace);
                let result = api_post(
                    &config,
                    &format!(
                        "/api/memory/{}/{}/verify",
                        urlencoding::encode(&ns),
                        urlencoding::encode(&title)
                    ),
                    &serde_json::json!({}),
                )?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
            }
            MemoryAction::Read { title, ns } => {
                let ns = ns.unwrap_or_else(|| crate::agent_namespace::resolve().namespace);
                let result = api_get(
                    &config,
                    &format!(
                        "/api/memory/{}/{}",
                        urlencoding::encode(&ns),
                        urlencoding::encode(&title)
                    ),
                )?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
            }
            MemoryAction::Delete { title, ns } => {
                let ns = ns.unwrap_or_else(|| crate::agent_namespace::resolve().namespace);
                let result = api_delete(
                    &config,
                    &format!(
                        "/api/memory/{}/{}",
                        urlencoding::encode(&ns),
                        urlencoding::encode(&title)
                    ),
                )?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
            }
            MemoryAction::Cleanup => {
                let result = api_post(&config, "/api/memory/cleanup", &serde_json::json!({}))?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                );
            }
        },
        CliCommand::Generate {
            r#type,
            length,
            count,
            style,
            word_list,
            separator,
            json,
        } => {
            if count > 1 {
                // Bulk generate via API
                let options = match r#type.as_str() {
                    "password" => {
                        serde_json::json!({ "length": length, "uppercase": true, "lowercase": true, "numbers": true, "special": true })
                    }
                    "passphrase" => {
                        serde_json::json!({ "word_count": length, "separator": separator, "capitalize": true, "word_list": word_list })
                    }
                    "memorable" => {
                        serde_json::json!({ "style": style.unwrap_or_else(|| "pronounceable".into()), "syllable_count": length })
                    }
                    "pin" => serde_json::json!({ "length": length }),
                    "uuid" => serde_json::json!({}),
                    _ => return Err(format!("Unknown type: {}", r#type)),
                };
                let body = serde_json::json!({
                    "type": r#type,
                    "options": options,
                    "count": count,
                });
                let result = api_post(&config, "/api/generate/bulk", &body)?;
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&result).unwrap_or_default()
                    );
                } else if let Some(arr) = result.as_array() {
                    for v in arr {
                        println!("{}", v.as_str().unwrap_or_default());
                    }
                }
            } else {
                // Single generate
                let (path, body) = match r#type.as_str() {
                    "password" => (
                        "/api/generate/password",
                        serde_json::json!({ "length": length, "uppercase": true, "lowercase": true, "numbers": true, "special": true }),
                    ),
                    "passphrase" => (
                        "/api/generate/passphrase",
                        serde_json::json!({ "word_count": length, "separator": separator, "capitalize": true, "word_list": word_list }),
                    ),
                    "memorable" => (
                        "/api/generate/memorable",
                        serde_json::json!({ "style": style.unwrap_or_else(|| "pronounceable".into()), "syllable_count": length }),
                    ),
                    "pin" => ("/api/generate/pin", serde_json::json!({ "length": length })),
                    "uuid" => {
                        let result = api_get(&config, "/api/generate/uuid")?;
                        if json {
                            println!(
                                "{}",
                                serde_json::to_string_pretty(&result).unwrap_or_default()
                            );
                        } else {
                            println!(
                                "{}",
                                result
                                    .get("value")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                            );
                        }
                        return Ok(true);
                    }
                    _ => return Err(format!("Unknown type: {}", r#type)),
                };
                let result = api_post(&config, path, &body)?;
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&result).unwrap_or_default()
                    );
                } else {
                    println!(
                        "{}",
                        result
                            .get("value")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                    );
                }
            }
        }
    }

    Ok(true)
}

/// `claspt namespace [show|init]`. Works without the desktop app: it only
/// reads the environment and the working directory.
fn run_namespace(action: NamespaceAction) -> Result<(), String> {
    use crate::agent_namespace::{
        marker_namespace, marker_text, namespace_from_marker_text, resolve, TrustedMarkers,
        MARKER_FILE,
    };
    match action {
        NamespaceAction::Trust => {
            let cwd = std::env::current_dir().map_err(|e| format!("cannot read cwd: {e}"))?;
            let (namespace, path) = marker_namespace(&cwd, dirs::home_dir().as_deref())
                .ok_or_else(|| {
                    format!(
                        "no usable {MARKER_FILE} marker from {} upward",
                        cwd.display()
                    )
                })?;
            let mut trusted = TrustedMarkers::load();
            trusted.trust(&path, &namespace);
            trusted
                .save()
                .map_err(|e| format!("cannot record the accepted marker: {e}"))?;
            println!(
                "Accepted {} on this machine: sessions under it use namespace \"{namespace}\".",
                path.display()
            );
            Ok(())
        }
        NamespaceAction::Show => {
            let resolved = resolve();
            println!(
                "{}",
                serde_json::to_string_pretty(&resolved).unwrap_or_default()
            );
            Ok(())
        }
        NamespaceAction::Init { name } => {
            let cwd = std::env::current_dir().map_err(|e| format!("cannot read cwd: {e}"))?;
            let path = cwd.join(MARKER_FILE);
            // Never overwrite: a marker is committed history, and replacing it
            // silently would move the project's memory.
            if path.exists() {
                return Err(format!(
                    "{} already exists; edit it by hand to change the namespace",
                    path.display()
                ));
            }
            let name = name.unwrap_or_else(|| resolve().namespace);
            // Validate through the same parser that will read the file back.
            let text = marker_text(&name);
            let checked = namespace_from_marker_text(&text)?;
            std::fs::write(&path, text)
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            // The user wrote it here, so it is accepted here; other machines
            // accept it with `claspt namespace trust` after cloning.
            let mut trusted = TrustedMarkers::load();
            trusted.trust(&path, &checked);
            trusted
                .save()
                .map_err(|e| format!("cannot record the accepted marker: {e}"))?;
            println!(
                "Pinned namespace \"{checked}\" in {}. Commit this file; on other machines run `claspt namespace trust` after cloning.",
                path.display()
            );
            Ok(())
        }
    }
}

/// `claspt mcp install <client>` and `claspt mcp clients`. Reads the token
/// from the keychain or vault config; never prints it.
fn run_mcp(action: McpAction) -> Result<(), String> {
    use crate::mcp_install::{self, Client, Scope};
    match action {
        McpAction::Install {
            clients: names,
            secrets,
            project,
            separate,
            print,
            vault,
            command,
        } => {
            let mut requested = Vec::new();
            for name in &names {
                let client = Client::parse(name).ok_or_else(|| {
                    format!(
                        "Unknown client '{name}'. Supported: {}",
                        Client::ALL
                            .iter()
                            .map(|c| c.name())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })?;
                if !requested.contains(&client) {
                    requested.push(client);
                }
            }
            let scope = if project { Scope::Project } else { Scope::User };
            let command = match command {
                Some(path) => {
                    if !path.is_file() {
                        return Err(format!("--command {} is not a file", path.display()));
                    }
                    path
                }
                None => std::env::current_exe()
                    .map_err(|e| format!("cannot locate this binary: {e}"))?,
            };
            let home = dirs::home_dir().ok_or("No home dir")?;
            let config_dir = dirs::config_dir().ok_or("No config dir")?;
            let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
            if print {
                for client in &requested {
                    println!(
                        "{}",
                        mcp_install::render(*client, &command, mcp_install::TOKEN_PLACEHOLDER)?
                    );
                    println!(
                        "\nReplace {} with a {} token from Claspt > Settings > API. File: {}",
                        mcp_install::TOKEN_PLACEHOLDER,
                        if secrets { "Secrets" } else { "Notes" },
                        mcp_install::config_path(*client, scope, &home, &config_dir, &cwd)?
                            .display()
                    );
                }
                return Ok(());
            }
            let token_scope = if secrets {
                crate::local_api::auth::TokenScope::Secrets
            } else {
                crate::local_api::auth::TokenScope::Notes
            };
            let vault_dir = match vault {
                Some(v) => v,
                None => vault_dir_for_cli()?,
            };
            if !vault_dir.join(".securenotes").join("config.json").is_file() {
                return Err(format!(
                    "No vault at {}. Open the vault in Claspt once, or pass --vault <dir>.",
                    vault_dir.display()
                ));
            }
            let scope_word = if secrets { "Secrets" } else { "Notes" };

            if project || separate {
                // One client per install: revocable on its own, named in the
                // access log. A project install is limited to this project's
                // memory and the shared namespace.
                let namespaces: Vec<String> = if project {
                    vec![
                        crate::agent_namespace::resolve().namespace,
                        crate::pages::agent_memory::GLOBAL_NAMESPACE.to_string(),
                    ]
                } else {
                    Vec::new()
                };
                for client in &requested {
                    let minted = crate::local_api::clients::create(
                        &vault_dir,
                        &crate::local_api::clients::default_name(client.name()),
                        token_scope,
                        &namespaces,
                    )
                    .map_err(|e| {
                        format!("Cannot register {} as an API client: {e}", client.name())
                    })?;
                    let written = mcp_install::install(
                        *client,
                        scope,
                        &command,
                        minted.token.as_str(),
                        &home,
                        &config_dir,
                        &cwd,
                    )?;
                    println!(
                        "Added Claspt to {} as client \"{}\" ({scope_word} scope, its own token). Restart {} to pick it up.",
                        written.display(),
                        minted.client.name,
                        client.name()
                    );
                }
                return Ok(());
            }

            // The shared token: issued once, written everywhere it belongs.
            let registry = crate::local_api::clients::load(&vault_dir)
                .map_err(|e| format!("Cannot read the client registry: {e}"))?;
            let holders = mcp_install::holders(&home, &config_dir);
            let plan = mcp_install::plan_shared(&registry, &holders, &requested);
            let minted = crate::local_api::clients::create_with_kind(
                &vault_dir,
                &crate::local_api::clients::default_name(mcp_install::SHARED_CLIENT_NAME),
                token_scope,
                &[],
                Some(mcp_install::SHARED_CLIENT_KIND),
            )
            .map_err(|e| format!("Cannot register the shared client: {e}"))?;
            let token = minted.token.as_str();

            let mut written: Vec<String> = Vec::new();
            for client in &requested {
                let has_entry = holders
                    .iter()
                    .any(|h| h.client == *client && h.location == mcp_install::Location::User);
                if !has_entry {
                    let path = mcp_install::install(
                        *client,
                        Scope::User,
                        &command,
                        token,
                        &home,
                        &config_dir,
                        &cwd,
                    )?;
                    written.push(format!("{} ({})", client.name(), path.display()));
                }
            }
            for index in &plan.refresh {
                let holder = &holders[*index];
                mcp_install::refresh(holder, &command, token)?;
                written.push(holder.describe());
            }
            // Only once every file carries the new token is the old one retired.
            let mut retired = 0;
            for id in &plan.revoke {
                if crate::local_api::clients::revoke(&vault_dir, id)
                    .map_err(|e| format!("Cannot retire the previous shared token: {e}"))?
                {
                    retired += 1;
                }
            }

            println!(
                "One shared {scope_word} token, client \"{}\" ({}), registered in {}.",
                minted.client.name,
                minted.client.hint,
                vault_dir.display()
            );
            println!("Written to:");
            for line in &written {
                println!("  {line}");
            }
            for index in &plan.keep {
                println!(
                    "  kept as is: {} (a token of its own)",
                    holders[*index].describe()
                );
            }
            if retired > 0 {
                println!("Retired {retired} previous shared token(s).");
            }
            println!(
                "Restart each tool to pick the token up. A Claude Code session that was open \
                 during this install may write its old copy of ~/.claude.json back on exit; \
                 run `claspt mcp doctor` afterwards to check."
            );
            Ok(())
        }
        McpAction::Doctor { vault } => {
            let vault_dir = match vault {
                Some(v) => v,
                None => vault_dir_for_cli()?,
            };
            let home = dirs::home_dir().ok_or("No home dir")?;
            let config_dir = dirs::config_dir().ok_or("No config dir")?;
            run_mcp_doctor(&vault_dir, &home, &config_dir)
        }
        McpAction::Clients => {
            let home = dirs::home_dir().ok_or("No home dir")?;
            let config_dir = dirs::config_dir().ok_or("No config dir")?;
            let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
            for client in Client::ALL {
                let user = mcp_install::config_path(client, Scope::User, &home, &config_dir, &cwd)?;
                let project =
                    mcp_install::config_path(client, Scope::Project, &home, &config_dir, &cwd)
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|_| "-".to_string());
                println!(
                    "{:<15} user: {}  project: {}",
                    client.name(),
                    user.display(),
                    project
                );
            }
            Ok(())
        }
    }
}

/// `claspt mcp doctor`: every config file's token against the open vault's
/// registry, and against the running app when it answers. Prints hints, never
/// tokens.
fn run_mcp_doctor(
    vault_dir: &std::path::Path,
    home: &std::path::Path,
    config_dir: &std::path::Path,
) -> Result<(), String> {
    use crate::local_api::clients::{self, token_hint};
    use crate::mcp_install::{self, Standing};

    if !vault_dir.join(".securenotes").join("config.json").is_file() {
        return Err(format!(
            "No vault at {}. Open the vault in Claspt once, or pass --vault <dir>.",
            vault_dir.display()
        ));
    }
    let registry =
        clients::load(vault_dir).map_err(|e| format!("Cannot read the client registry: {e}"))?;
    let config = crate::vault::init::read_config(vault_dir)
        .map_err(|e| format!("Cannot read vault config: {e}"))?;
    let port = config.local_api_port;
    let base_url = format!("http://127.0.0.1:{port}");

    println!("Vault: {}", vault_dir.display());
    println!(
        "Local API: port {port}, {}",
        if config.local_api_enabled == Some(true) {
            "enabled"
        } else {
            "not enabled"
        }
    );
    println!();
    println!("Tokens the vault knows:");
    if registry.clients.is_empty() {
        println!("  none");
    }
    for c in &registry.clients {
        let kind = match c.kind.as_deref() {
            Some(mcp_install::SHARED_CLIENT_KIND) => "shared",
            Some(other) => other,
            None => "own",
        };
        println!(
            "  {:<12}  {:<8}  {:<7}  {}",
            c.hint,
            format!("{:?}", c.scope).to_lowercase(),
            kind,
            c.name
        );
    }
    println!();

    let holders = mcp_install::holders(home, config_dir);
    println!("Config files on this machine:");
    if holders.is_empty() {
        println!("  none hold a claspt entry");
    }
    let mut stale = 0;
    let mut answered = false;
    for holder in &holders {
        let standing = match mcp_install::standing(&registry, &holder.token) {
            Standing::Shared => "shared token".to_string(),
            Standing::Separate {
                name,
                project_bound,
            } => {
                if project_bound {
                    format!("project token ({name})")
                } else {
                    format!("own token ({name})")
                }
            }
            Standing::Unknown => {
                stale += 1;
                "NOT KNOWN to this vault".to_string()
            }
        };
        let live = match probe_token(&base_url, &holder.token) {
            Some(true) => {
                answered = true;
                "app accepts it"
            }
            Some(false) => {
                answered = true;
                "app refuses it"
            }
            None => "app not answering",
        };
        println!(
            "  {:<12}  {:<26}  {:<18}  {}",
            token_hint(&holder.token),
            standing,
            live,
            holder.describe()
        );
    }
    println!();
    // A registered token no config here carries is either used elsewhere
    // (another machine, a script) or left over from a re-issue. Say so, and
    // let the owner decide in Settings; the extension keeps its token in the
    // browser, not in a file.
    let held: Vec<String> = holders
        .iter()
        .filter_map(|h| registry.find(&h.token).map(|c| c.id.clone()))
        .collect();
    let unheld: Vec<&clients::ClientToken> = registry
        .clients
        .iter()
        .filter(|c| c.kind.as_deref() != Some("extension"))
        .filter(|c| !held.contains(&c.id))
        .collect();
    if !unheld.is_empty() {
        println!(
            "Tokens no config file here carries (in use elsewhere, or left over; revoke in Settings if not):"
        );
        for c in unheld {
            println!("  {:<12}  {}", c.hint, c.name);
        }
        println!();
    }
    if !answered {
        println!(
            "Claspt did not answer on port {port}: open the app and unlock the vault, then run this again."
        );
    }
    if stale > 0 {
        println!(
            "{stale} config file(s) hold a token this vault does not know. Fix them in one go:\n  \
             claspt mcp install claude-code claude-desktop --secrets\n\
             (name every tool you use; each one then shares the same token)."
        );
    } else if !holders.is_empty() {
        println!("Every config file holds a token this vault knows.");
    }
    Ok(())
}

/// Ask the running app whether it accepts a token: `Some(true)`, `Some(false)`
/// for a refusal, `None` when nothing answered.
fn probe_token(base_url: &str, token: &str) -> Option<bool> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()?;
    let resp = client
        .get(format!("{base_url}/api/status"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .ok()?;
    Some(resp.status() != reqwest::StatusCode::UNAUTHORIZED)
}

/// `claspt tokens list|create|revoke|reset-cli`. Works on the registry file
/// directly, so it needs no running app and no token of its own.
fn run_tokens(action: TokensAction) -> Result<(), String> {
    use crate::local_api::auth::TokenScope;
    use crate::local_api::clients;
    let vault_dir = vault_dir_for_cli()?;
    match action {
        TokensAction::List => {
            let list = clients::list(&vault_dir).map_err(|e| e.to_string())?;
            if list.is_empty() {
                println!("No API clients registered.");
                return Ok(());
            }
            println!(
                "{:<36}  {:<8}  {:<12}  {:<20}  name  [namespaces]",
                "id", "scope", "hint", "created"
            );
            for c in list {
                let ns = if c.namespaces.is_empty() {
                    String::new()
                } else {
                    format!("  [{}]", c.namespaces.join(", "))
                };
                println!(
                    "{:<36}  {:<8}  {:<12}  {:<20}  {}{ns}",
                    c.id,
                    format!("{:?}", c.scope).to_lowercase(),
                    c.hint,
                    c.created_at.format("%Y-%m-%d %H:%M UTC"),
                    c.name
                );
            }
            Ok(())
        }
        TokensAction::Create {
            name,
            secrets,
            namespaces,
        } => {
            let scope = if secrets {
                TokenScope::Secrets
            } else {
                TokenScope::Notes
            };
            let minted = clients::create(&vault_dir, &name, scope, &namespaces)
                .map_err(|e| e.to_string())?;
            println!("{}", minted.token.as_str());
            eprintln!(
                "Created client \"{}\" (id {}). This token is shown once; it is not stored.",
                minted.client.name, minted.client.id
            );
            Ok(())
        }
        TokensAction::Revoke { id } => {
            if clients::revoke(&vault_dir, &id).map_err(|e| e.to_string())? {
                println!("Revoked {id}.");
                Ok(())
            } else {
                Err(format!("No client with id {id}"))
            }
        }
        TokensAction::ResetCli => {
            use crate::vault::token_store::{self, TokenKind};
            let config = crate::vault::init::read_config(&vault_dir)
                .map_err(|e| format!("Cannot read vault config: {e}"))?;
            let vault_id = config
                .vault_id
                .filter(|id| !id.is_empty())
                .ok_or("This vault has not been opened in the app yet.")?;
            token_store::delete(&vault_id, TokenKind::Cli).map_err(|e| e.to_string())?;
            println!("Forgot this CLI's token. Revoke the old \"CLI on …\" client in Settings; the next command registers a new one.");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_child_never_inherits_the_cli_credentials() {
        let parent = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("CLASPT_API_TOKEN".to_string(), "clss_secret".to_string()),
            ("CLASPT_API_PORT".to_string(), "9315".to_string()),
            ("CLASPT_SERVE_PASSPHRASE".to_string(), "pass".to_string()),
            ("CLASPT_PASSWORD".to_string(), "pass".to_string()),
            ("CLASPT_VAULT_DIR".to_string(), "/v".to_string()),
        ];
        let child = child_environment(parent);
        let names: Vec<&str> = child.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["PATH", "CLASPT_VAULT_DIR"]);
    }
}
