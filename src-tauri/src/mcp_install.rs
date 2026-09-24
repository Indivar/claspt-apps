// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! `claspt mcp install <client>`: put this binary into an MCP client's config.
//!
//! Every client keeps a JSON file with an `mcpServers` object (Codex keeps a
//! TOML file with an `mcp_servers` table), and every one of them wants the
//! same three things: the absolute path of the binary, `--mcp`, and the API
//! token in the environment. Hand-writing that is where setups fail: the
//! published guide once told people to run `claspt mcp-server` with no token,
//! which cannot work. Writing the file from the binary itself removes the
//! chance to get the path, the flag or the variable name wrong.
//!
//! The merge is conservative on purpose: an existing file is parsed, only the
//! `claspt` entry is replaced, every other key keeps its place, and a file that
//! does not parse is left untouched with an error rather than overwritten.
//! The written file is owner-only, because it now holds a token.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::local_api::clients::ClientRegistry;

/// What `render` prints in place of the token, so a config can be shown or
/// pasted into docs without a live secret in it.
pub const TOKEN_PLACEHOLDER: &str = "<CLASPT_API_TOKEN>";

const SERVER_KEY: &str = "claspt";

/// The registry `kind` of the one client every AI tool on a machine shares.
///
/// One token per tool was the original design, so each could be revoked on
/// its own. In practice it meant four config files holding three different
/// tokens, and a re-mint or a revoke in Settings silently breaking every tool
/// but the one that was just set up. The default is now one shared token,
/// refreshed in every file that carries it whenever it is issued again;
/// `--separate` still gives a tool a token of its own.
pub const SHARED_CLIENT_KIND: &str = "shared";
pub const SHARED_CLIENT_NAME: &str = "AI tools";

/// Where a `claspt` entry sits inside a config file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    /// The file's own `mcpServers` (or `mcp_servers`) table.
    User,
    /// Claude Code keeps one `mcpServers` per project inside `~/.claude.json`
    /// (what `claude mcp add` writes); this is that project's directory.
    ClaudeCodeProject(String),
}

/// A `claspt` entry found in a client's config: the token it carries and where.
pub struct Holder {
    pub client: Client,
    pub path: PathBuf,
    pub location: Location,
    pub token: Zeroizing<String>,
}

impl Holder {
    /// The file and, for a project entry, the project, for a report.
    pub fn describe(&self) -> String {
        match &self.location {
            Location::User => format!("{} ({})", self.client.name(), self.path.display()),
            Location::ClaudeCodeProject(project) => format!(
                "{} ({}, project {project})",
                self.client.name(),
                self.path.display()
            ),
        }
    }
}

/// Where a config file's token stands with the vault's registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Standing {
    /// The shared token.
    Shared,
    /// A token of its own: the registry name, and whether it is bound to a
    /// project's memory (a `--project` install), which no shared token can
    /// stand in for.
    Separate { name: String, project_bound: bool },
    /// Not a token this vault knows: stale, revoked, or for another vault.
    Unknown,
}

pub fn standing(registry: &ClientRegistry, token: &str) -> Standing {
    match registry.find(token) {
        Some(client) if client.kind.as_deref() == Some(SHARED_CLIENT_KIND) => Standing::Shared,
        Some(client) => Standing::Separate {
            name: client.name.clone(),
            project_bound: !client.namespaces.is_empty(),
        },
        None => Standing::Unknown,
    }
}

/// What issuing a shared token does besides writing the requested clients:
/// which existing entries take the new token (by index into the holders),
/// which are left alone, and which registry clients are retired afterwards.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SharedPlan {
    pub refresh: Vec<usize>,
    pub keep: Vec<usize>,
    pub revoke: Vec<String>,
}

/// An entry on the shared token, or on no token this vault knows, moves to
/// the new shared token: that is what "shared" means, and a stale entry is the
/// thing the owner most wants fixed. An entry with a token of its own joins
/// only when its tool was named in this install, and never when that token is
/// bound to a project's memory.
pub fn plan_shared(
    registry: &ClientRegistry,
    holders: &[Holder],
    requested: &[Client],
) -> SharedPlan {
    let mut plan = SharedPlan::default();
    for (index, holder) in holders.iter().enumerate() {
        let joins = match standing(registry, &holder.token) {
            Standing::Shared | Standing::Unknown => true,
            Standing::Separate { project_bound, .. } => {
                !project_bound && requested.contains(&holder.client)
            }
        };
        if joins {
            plan.refresh.push(index);
        } else {
            plan.keep.push(index);
        }
    }
    plan.revoke = registry
        .clients
        .iter()
        .filter(|c| c.kind.as_deref() == Some(SHARED_CLIENT_KIND))
        .map(|c| c.id.clone())
        .collect();
    plan
}

/// Every `claspt` entry in every client config on this machine. Project
/// scoped files are not scanned: they belong to a checkout, not the machine.
pub fn holders(home: &Path, config_dir: &Path) -> Vec<Holder> {
    let no_cwd = Path::new("/");
    let mut out = Vec::new();
    for client in Client::ALL {
        let Ok(path) = config_path(client, Scope::User, home, config_dir, no_cwd) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        out.extend(holders_in(client, &path, &text));
    }
    out
}

/// The entries one config file holds. A file that does not parse holds none.
pub fn holders_in(client: Client, path: &Path, text: &str) -> Vec<Holder> {
    let mut out = Vec::new();
    match client.format() {
        Format::JsonMcpServers => {
            let Ok(root) = serde_json::from_str::<Value>(text) else {
                return out;
            };
            if let Some(token) = token_in(root.get("mcpServers").and_then(|s| s.get(SERVER_KEY))) {
                out.push(Holder {
                    client,
                    path: path.to_path_buf(),
                    location: Location::User,
                    token: Zeroizing::new(token.to_string()),
                });
            }
            if client == Client::ClaudeCode {
                if let Some(Value::Object(projects)) = root.get("projects") {
                    for (project, settings) in projects {
                        let entry = settings.get("mcpServers").and_then(|s| s.get(SERVER_KEY));
                        if let Some(token) = token_in(entry) {
                            out.push(Holder {
                                client,
                                path: path.to_path_buf(),
                                location: Location::ClaudeCodeProject(project.clone()),
                                token: Zeroizing::new(token.to_string()),
                            });
                        }
                    }
                }
            }
        }
        Format::CodexToml => {
            let Ok(root) = toml::from_str::<toml::Value>(text) else {
                return out;
            };
            let token = root
                .get("mcp_servers")
                .and_then(|s| s.get(SERVER_KEY))
                .and_then(|e| e.get("env"))
                .and_then(|e| e.get("CLASPT_API_TOKEN"))
                .and_then(|v| v.as_str());
            if let Some(token) = token {
                out.push(Holder {
                    client,
                    path: path.to_path_buf(),
                    location: Location::User,
                    token: Zeroizing::new(token.to_string()),
                });
            }
        }
    }
    out
}

fn token_in(entry: Option<&Value>) -> Option<&str> {
    entry?.get("env")?.get("CLASPT_API_TOKEN")?.as_str()
}

/// Put `token` (and this binary) into the one entry a holder describes; the
/// rest of the file stays as it was.
pub fn refresh(holder: &Holder, command: &Path, token: &str) -> Result<PathBuf, String> {
    let existing = std::fs::read_to_string(&holder.path)
        .map_err(|e| format!("cannot read {}: {e}", holder.path.display()))?;
    let merged = match (&holder.location, holder.client.format()) {
        (Location::User, Format::JsonMcpServers) => {
            merge_json(&existing, holder.client, command, token)?
        }
        (Location::User, Format::CodexToml) => merge_codex_toml(&existing, command, token)?,
        (Location::ClaudeCodeProject(project), _) => {
            merge_claude_code_project(&existing, project, command, token)?
        }
    };
    crate::vault::init::write_restricted(&holder.path, merged.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", holder.path.display()))?;
    Ok(holder.path.clone())
}

/// Replace the `claspt` entry of one project inside `~/.claude.json`. The
/// project must already be there: this refreshes what `claude mcp add`
/// wrote, it does not invent projects.
pub fn merge_claude_code_project(
    existing: &str,
    project: &str,
    command: &Path,
    token: &str,
) -> Result<String, String> {
    let mut root: Value = serde_json::from_str(existing)
        .map_err(|e| format!("existing config is not valid JSON: {e}"))?;
    let entry = root
        .get_mut("projects")
        .and_then(|p| p.get_mut(project))
        .and_then(|p| p.get_mut("mcpServers"))
        .and_then(|s| s.as_object_mut())
        .ok_or_else(|| format!("no `mcpServers` for project {project}"))?;
    entry.insert(
        SERVER_KEY.to_string(),
        json_entry(Client::ClaudeCode, command, token),
    );
    let mut out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// A supported MCP client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Client {
    ClaudeCode,
    ClaudeDesktop,
    Cursor,
    Windsurf,
    GeminiCli,
    Codex,
}

impl Client {
    pub const ALL: [Client; 6] = [
        Client::ClaudeCode,
        Client::ClaudeDesktop,
        Client::Cursor,
        Client::Windsurf,
        Client::GeminiCli,
        Client::Codex,
    ];

    /// The name used on the command line and in docs.
    pub fn name(self) -> &'static str {
        match self {
            Client::ClaudeCode => "claude-code",
            Client::ClaudeDesktop => "claude-desktop",
            Client::Cursor => "cursor",
            Client::Windsurf => "windsurf",
            Client::GeminiCli => "gemini-cli",
            Client::Codex => "codex",
        }
    }

    pub fn parse(name: &str) -> Option<Client> {
        let wanted = name.trim().to_ascii_lowercase();
        Client::ALL.into_iter().find(|c| c.name() == wanted)
    }

    fn format(self) -> Format {
        match self {
            Client::Codex => Format::CodexToml,
            _ => Format::JsonMcpServers,
        }
    }

    /// Claude Code declares the transport explicitly; the others infer stdio
    /// from the presence of `command`.
    fn wants_type_field(self) -> bool {
        self == Client::ClaudeCode
    }
}

/// Whether the config applies to the user or to the current project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    JsonMcpServers,
    CodexToml,
}

/// Where a client keeps its config.
///
/// `config_dir` is the platform application-config directory (`dirs::config_dir`):
/// `~/Library/Application Support` on macOS, `%APPDATA%` on Windows,
/// `~/.config` on Linux. Claude Desktop is the only client that uses it; the
/// rest keep dot-directories under the home directory on every platform.
pub fn config_path(
    client: Client,
    scope: Scope,
    home: &Path,
    config_dir: &Path,
    cwd: &Path,
) -> Result<PathBuf, String> {
    let path = match (client, scope) {
        (Client::ClaudeCode, Scope::User) => home.join(".claude.json"),
        (Client::ClaudeCode, Scope::Project) => cwd.join(".mcp.json"),
        (Client::Cursor, Scope::User) => home.join(".cursor").join("mcp.json"),
        (Client::Cursor, Scope::Project) => cwd.join(".cursor").join("mcp.json"),
        (Client::ClaudeDesktop, Scope::User) => {
            config_dir.join("Claude").join("claude_desktop_config.json")
        }
        (Client::Windsurf, Scope::User) => home
            .join(".codeium")
            .join("windsurf")
            .join("mcp_config.json"),
        (Client::GeminiCli, Scope::User) => home.join(".gemini").join("settings.json"),
        (Client::Codex, Scope::User) => home.join(".codex").join("config.toml"),
        (client, Scope::Project) => {
            return Err(format!(
                "{} has no project-scoped config; omit --project",
                client.name()
            ))
        }
    };
    Ok(path)
}

/// The `claspt` server entry in the JSON shape the clients share.
fn json_entry(client: Client, command: &Path, token: &str) -> Value {
    let mut entry = json!({
        "command": command.to_string_lossy(),
        "args": ["--mcp"],
        "env": { "CLASPT_API_TOKEN": token },
    });
    if client.wants_type_field() {
        // Put `type` first so the entry reads the way Claude Code writes it.
        let mut with_type = serde_json::Map::new();
        with_type.insert("type".to_string(), Value::String("stdio".to_string()));
        if let Value::Object(rest) = entry {
            with_type.extend(rest);
        }
        entry = Value::Object(with_type);
    }
    entry
}

/// Merge the entry into an existing JSON config (or an empty one). Every other
/// key, including other servers, is kept in place. A file that does not parse
/// is an error, never a blank slate.
pub fn merge_json(
    existing: &str,
    client: Client,
    command: &Path,
    token: &str,
) -> Result<String, String> {
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing)
            .map_err(|e| format!("existing config is not valid JSON: {e}"))?
    };
    let Value::Object(root_map) = &mut root else {
        return Err("existing config is not a JSON object".to_string());
    };
    let servers = root_map.entry("mcpServers").or_insert_with(|| json!({}));
    let Value::Object(servers_map) = servers else {
        return Err("existing config has a non-object `mcpServers`".to_string());
    };
    servers_map.insert(SERVER_KEY.to_string(), json_entry(client, command, token));
    let mut out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// Merge into Codex's `config.toml`: `[mcp_servers.claspt]` with `command`,
/// `args` and an `env` table. Other tables are preserved.
pub fn merge_codex_toml(existing: &str, command: &Path, token: &str) -> Result<String, String> {
    let mut root: toml::Value = if existing.trim().is_empty() {
        toml::Value::Table(toml::map::Map::new())
    } else {
        // A document parse: since toml 0.9, `str::parse` reads a single
        // value, not a file.
        toml::from_str(existing).map_err(|e| format!("existing config.toml does not parse: {e}"))?
    };
    let toml::Value::Table(root_table) = &mut root else {
        return Err("existing config.toml is not a table".to_string());
    };
    let servers = root_table
        .entry("mcp_servers")
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let toml::Value::Table(servers_table) = servers else {
        return Err("existing config.toml has a non-table `mcp_servers`".to_string());
    };
    let mut env = toml::map::Map::new();
    env.insert(
        "CLASPT_API_TOKEN".to_string(),
        toml::Value::String(token.to_string()),
    );
    let mut entry = toml::map::Map::new();
    entry.insert(
        "command".to_string(),
        toml::Value::String(command.to_string_lossy().to_string()),
    );
    entry.insert(
        "args".to_string(),
        toml::Value::Array(vec![toml::Value::String("--mcp".to_string())]),
    );
    entry.insert("env".to_string(), toml::Value::Table(env));
    servers_table.insert(SERVER_KEY.to_string(), toml::Value::Table(entry));
    toml::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// The bare `claspt` server entry, pretty-printed, for a user to paste into
/// whichever config file their tool uses.
///
/// Shares [`json_entry`] with the writers above on purpose. The setup
/// walkthrough used to build this string itself and left out the `env` block,
/// so the snippet it handed out could not authenticate: the MCP server reads
/// `CLASPT_API_TOKEN` from the environment and nothing else, and without it
/// every tool call answered "Vault not connected". One renderer means the two
/// cannot drift apart again.
pub fn snippet(command: &Path, token: &str) -> Result<String, String> {
    let entry = json_entry(Client::ClaudeDesktop, command, token);
    let body = serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?;
    // Indent the entry's own lines so the fragment reads as it will sit inside
    // the surrounding `mcpServers` object.
    let indented = body
        .lines()
        .enumerate()
        .map(|(i, line)| {
            if i == 0 {
                line.to_string()
            } else {
                format!("  {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!("\"{SERVER_KEY}\": {indented}"))
}

/// The config fragment for one client, for printing. Pass
/// [`TOKEN_PLACEHOLDER`] as the token unless the output is going straight
/// into a file.
pub fn render(client: Client, command: &Path, token: &str) -> Result<String, String> {
    match client.format() {
        Format::JsonMcpServers => merge_json("", client, command, token),
        Format::CodexToml => merge_codex_toml("", command, token),
    }
}

/// Read the client's config, merge the entry, write it back owner-only.
/// Returns the path written.
pub fn install(
    client: Client,
    scope: Scope,
    command: &Path,
    token: &str,
    home: &Path,
    config_dir: &Path,
    cwd: &Path,
) -> Result<PathBuf, String> {
    let path = config_path(client, scope, home, config_dir, cwd)?;
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let merged = match client.format() {
        Format::JsonMcpServers => merge_json(&existing, client, command, token)?,
        Format::CodexToml => merge_codex_toml(&existing, command, token)?,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    // Atomic and owner-only: the file now carries a token.
    crate::vault::init::write_restricted(&path, merged.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd() -> PathBuf {
        PathBuf::from("/Applications/Claspt.app/Contents/MacOS/claspt")
    }

    #[test]
    fn every_client_parses_by_name_and_has_a_user_path_on_every_platform() {
        // Rooted in a real absolute directory: "/home/u" is not absolute on
        // Windows, where an absolute path starts with a drive.
        let root = std::env::temp_dir();
        let home = root.join("u");
        let cfg = home.join(".config");
        let cwd = root.join("repo");
        for client in Client::ALL {
            assert_eq!(Client::parse(client.name()), Some(client));
            assert_eq!(Client::parse(&client.name().to_uppercase()), Some(client));
            let path = config_path(client, Scope::User, &home, &cfg, &cwd).unwrap();
            assert!(path.is_absolute(), "{path:?}");
        }
        assert_eq!(Client::parse("vim"), None);
    }

    #[test]
    fn project_scope_exists_only_where_the_client_supports_it() {
        let home = Path::new("/home/u");
        let cfg = Path::new("/home/u/.config");
        let cwd = Path::new("/work/repo");
        assert_eq!(
            config_path(Client::ClaudeCode, Scope::Project, home, cfg, cwd).unwrap(),
            PathBuf::from("/work/repo/.mcp.json")
        );
        assert_eq!(
            config_path(Client::Cursor, Scope::Project, home, cfg, cwd).unwrap(),
            PathBuf::from("/work/repo/.cursor/mcp.json")
        );
        for client in [
            Client::ClaudeDesktop,
            Client::Windsurf,
            Client::GeminiCli,
            Client::Codex,
        ] {
            assert!(config_path(client, Scope::Project, home, cfg, cwd).is_err());
        }
        // Claude Desktop is the one that follows the platform config dir.
        assert_eq!(
            config_path(Client::ClaudeDesktop, Scope::User, home, cfg, cwd).unwrap(),
            PathBuf::from("/home/u/.config/Claude/claude_desktop_config.json")
        );
    }

    #[test]
    fn json_merge_keeps_other_servers_and_keys_in_place() {
        let existing = r#"{
  "theme": "dark",
  "mcpServers": {
    "github": { "command": "gh-mcp" },
    "claspt": { "command": "/old/path", "args": ["mcp-server"] }
  },
  "numStartups": 3
}"#;
        let out = merge_json(existing, Client::ClaudeCode, &cmd(), "clsn_abc").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["numStartups"], 3);
        assert_eq!(v["mcpServers"]["github"]["command"], "gh-mcp");
        assert_eq!(v["mcpServers"]["claspt"]["type"], "stdio");
        assert_eq!(v["mcpServers"]["claspt"]["args"], json!(["--mcp"]));
        assert_eq!(
            v["mcpServers"]["claspt"]["env"]["CLASPT_API_TOKEN"],
            "clsn_abc"
        );
        // Key order survives, so the user's file does not get shuffled.
        let theme_at = out.find("\"theme\"").unwrap();
        let servers_at = out.find("\"mcpServers\"").unwrap();
        let startups_at = out.find("\"numStartups\"").unwrap();
        assert!(theme_at < servers_at && servers_at < startups_at);
        assert!(
            !out.contains("mcp-server"),
            "old entry must be replaced whole"
        );
    }

    #[test]
    fn json_merge_starts_from_empty_and_refuses_broken_input() {
        let out = merge_json("", Client::Cursor, &cmd(), "t").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(
            v["mcpServers"]["claspt"].get("type").is_none(),
            "only Claude Code gets `type`"
        );
        assert!(merge_json("{ not json", Client::Cursor, &cmd(), "t").is_err());
        assert!(merge_json("[]", Client::Cursor, &cmd(), "t").is_err());
        assert!(merge_json(r#"{"mcpServers": 5}"#, Client::Cursor, &cmd(), "t").is_err());
    }

    #[test]
    fn codex_toml_merge_adds_the_table_and_keeps_the_rest() {
        let existing = "model = \"o3\"\n\n[mcp_servers.github]\ncommand = \"gh-mcp\"\n";
        let out = merge_codex_toml(existing, &cmd(), "clsn_abc").unwrap();
        let v: toml::Value = toml::from_str(&out).unwrap();
        assert_eq!(v["model"].as_str(), Some("o3"));
        assert_eq!(
            v["mcp_servers"]["github"]["command"].as_str(),
            Some("gh-mcp")
        );
        assert_eq!(
            v["mcp_servers"]["claspt"]["args"][0].as_str(),
            Some("--mcp")
        );
        assert_eq!(
            v["mcp_servers"]["claspt"]["env"]["CLASPT_API_TOKEN"].as_str(),
            Some("clsn_abc")
        );
        assert!(merge_codex_toml("= broken", &cmd(), "t").is_err());
    }

    #[test]
    fn render_carries_the_placeholder_not_a_token() {
        for client in Client::ALL {
            let text = render(client, &cmd(), TOKEN_PLACEHOLDER).unwrap();
            assert!(text.contains(TOKEN_PLACEHOLDER), "{}", client.name());
            assert!(text.contains("--mcp"));
        }
    }

    /// A registry with shared tokens, tokens of their own, and project-bound
    /// tokens (`--project` installs, which carry namespaces).
    fn registry_with(
        shared: &[&str],
        separate: &[(&str, &str)],
        project: &[(&str, &str)],
    ) -> ClientRegistry {
        use crate::local_api::auth::TokenScope;
        use crate::local_api::clients::{hash_token, ClientToken};
        let mut registry = ClientRegistry::default();
        let mut record = |name: &str, token: &str, kind: Option<&str>, namespaces: Vec<String>| {
            registry.clients.push(ClientToken {
                id: format!("id-{name}"),
                name: name.to_string(),
                scope: TokenScope::Secrets,
                token_hash: hash_token(token),
                hint: String::new(),
                created_at: chrono::Utc::now(),
                namespaces,
                kind: kind.map(str::to_string),
            });
        };
        for token in shared {
            record("AI tools", token, Some(SHARED_CLIENT_KIND), Vec::new());
        }
        for (name, token) in separate {
            record(name, token, None, Vec::new());
        }
        for (name, token) in project {
            record(
                name,
                token,
                None,
                vec!["proj".to_string(), "global".to_string()],
            );
        }
        registry
    }

    fn holder(client: Client, location: Location, token: &str) -> Holder {
        Holder {
            client,
            path: PathBuf::from("/cfg"),
            location,
            token: Zeroizing::new(token.to_string()),
        }
    }

    /// The owner's own case: four Claude Code projects on three tokens, only
    /// one of them known to the vault.
    #[test]
    fn every_claspt_entry_in_a_claude_code_file_is_found_with_its_token() {
        let text = r#"{
  "mcpServers": { "claspt": { "command": "c", "args": ["--mcp"], "env": { "CLASPT_API_TOKEN": "clss_user" } } },
  "projects": {
    "/work/a": { "mcpServers": { "claspt": { "env": { "CLASPT_API_TOKEN": "clss_a" } }, "other": {} } },
    "/work/b": { "mcpServers": { "other": { "command": "x" } } },
    "/work/c": { "allowedTools": [] }
  }
}"#;
        let found = holders_in(Client::ClaudeCode, Path::new("/h/.claude.json"), text);
        let mut seen: Vec<(String, String)> = found
            .iter()
            .map(|h| (format!("{:?}", h.location), h.token.to_string()))
            .collect();
        seen.sort();
        assert_eq!(
            seen,
            vec![
                (
                    "ClaudeCodeProject(\"/work/a\")".to_string(),
                    "clss_a".to_string()
                ),
                ("User".to_string(), "clss_user".to_string()),
            ]
        );
        assert!(holders_in(Client::ClaudeCode, Path::new("/h"), "{ broken").is_empty());

        let toml_text = "[mcp_servers.claspt]\ncommand = \"c\"\n[mcp_servers.claspt.env]\nCLASPT_API_TOKEN = \"clss_codex\"\n";
        let found = holders_in(Client::Codex, Path::new("/h/config.toml"), toml_text);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].token.as_str(), "clss_codex");
    }

    #[test]
    fn a_shared_install_refreshes_shared_and_stale_entries_and_retires_the_old_shared_client() {
        let registry = registry_with(
            &["clss_old_shared"],
            &[("Deploy script", "clss_deploy"), ("AI Tool", "clss_hand")],
            &[],
        );
        let holders = vec![
            holder(Client::ClaudeCode, Location::User, "clss_old_shared"),
            holder(
                Client::ClaudeCode,
                Location::ClaudeCodeProject("/p".into()),
                "clss_stale",
            ),
            holder(Client::ClaudeDesktop, Location::User, "clsn_gone"),
            holder(Client::Cursor, Location::User, "clss_deploy"),
            holder(Client::Codex, Location::User, "clss_deploy"),
            holder(
                Client::ClaudeCode,
                Location::ClaudeCodeProject("/q".into()),
                "clss_hand",
            ),
        ];

        let plan = plan_shared(&registry, &holders, &[Client::ClaudeCode, Client::Codex]);

        // Shared, stale and unknown entries join. A token of its own joins
        // only where its tool was asked for: Codex and the Claude Code project
        // on a hand-made token, not Cursor.
        assert_eq!(plan.refresh, vec![0, 1, 2, 4, 5]);
        assert_eq!(plan.keep, vec![3]);
        assert_eq!(plan.revoke, vec!["id-AI tools".to_string()]);
    }

    #[test]
    fn a_project_bound_token_is_never_moved_to_the_shared_one() {
        let registry = registry_with(&[], &[], &[("claude-code on box", "clss_project")]);
        let holders = vec![
            holder(
                Client::ClaudeCode,
                Location::ClaudeCodeProject("/p".into()),
                "clss_project",
            ),
            holder(Client::ClaudeCode, Location::User, "clss_project"),
        ];
        let plan = plan_shared(&registry, &holders, &[Client::ClaudeCode]);
        assert_eq!(plan.refresh, Vec::<usize>::new());
        assert_eq!(plan.keep, vec![0, 1]);
        assert!(plan.revoke.is_empty());
    }

    #[test]
    fn standing_tells_shared_from_own_from_project_bound_from_unknown() {
        let registry = registry_with(
            &["clss_shared"],
            &[("Deploy", "clss_own")],
            &[("Box", "clss_p")],
        );
        assert_eq!(standing(&registry, "clss_shared"), Standing::Shared);
        assert_eq!(
            standing(&registry, "clss_own"),
            Standing::Separate {
                name: "Deploy".into(),
                project_bound: false
            }
        );
        assert_eq!(
            standing(&registry, "clss_p"),
            Standing::Separate {
                name: "Box".into(),
                project_bound: true
            }
        );
        assert_eq!(standing(&registry, "clss_nope"), Standing::Unknown);
    }

    #[test]
    fn refreshing_one_project_entry_leaves_every_other_project_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(".claude.json");
        std::fs::write(
            &path,
            r#"{"projects":{"/a":{"mcpServers":{"claspt":{"env":{"CLASPT_API_TOKEN":"clss_old"}}}},"/b":{"mcpServers":{"claspt":{"env":{"CLASPT_API_TOKEN":"clss_b"}}}}}}"#,
        )
        .unwrap();
        let target = Holder {
            client: Client::ClaudeCode,
            path: path.clone(),
            location: Location::ClaudeCodeProject("/a".into()),
            token: Zeroizing::new("clss_old".into()),
        };

        refresh(&target, &cmd(), "clss_new").unwrap();

        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            v["projects"]["/a"]["mcpServers"]["claspt"]["env"]["CLASPT_API_TOKEN"],
            "clss_new"
        );
        assert_eq!(v["projects"]["/a"]["mcpServers"]["claspt"]["type"], "stdio");
        assert_eq!(
            v["projects"]["/b"]["mcpServers"]["claspt"]["env"]["CLASPT_API_TOKEN"],
            "clss_b"
        );
        assert!(merge_claude_code_project("{}", "/none", &cmd(), "t").is_err());
    }

    #[test]
    fn install_writes_the_file_owner_only_and_creates_parents() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let cfg = home.join(".config");
        let cwd = tmp.path().join("repo");
        std::fs::create_dir_all(&cwd).unwrap();

        let path = install(
            Client::Windsurf,
            Scope::User,
            &cmd(),
            "clsn_x",
            &home,
            &cfg,
            &cwd,
        )
        .unwrap();
        assert_eq!(path, home.join(".codeium/windsurf/mcp_config.json"));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            v["mcpServers"]["claspt"]["env"]["CLASPT_API_TOKEN"],
            "clsn_x"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "config holds a token and must be owner-only");
        }

        // A second install replaces only the claspt entry.
        std::fs::write(
            &path,
            r#"{"mcpServers":{"other":{"command":"x"},"claspt":{"command":"stale"}}}"#,
        )
        .unwrap();
        install(
            Client::Windsurf,
            Scope::User,
            &cmd(),
            "clsn_y",
            &home,
            &cfg,
            &cwd,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(
            v["mcpServers"]["claspt"]["env"]["CLASPT_API_TOKEN"],
            "clsn_y"
        );
    }

    #[test]
    fn the_pasteable_snippet_carries_the_token() {
        // The walkthrough handed out a snippet with no env block. The MCP
        // server reads CLASPT_API_TOKEN from the environment and nothing else,
        // so every tool call answered "Vault not connected".
        let out = snippet(&cmd(), "clsn_abc").unwrap();
        assert!(out.contains("CLASPT_API_TOKEN"), "no env block: {out}");
        assert!(out.contains("clsn_abc"), "no token: {out}");
        assert!(out.contains("--mcp"));
        assert!(out.starts_with("\"claspt\": {"), "{out}");
    }
}
