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

/// What `render` prints in place of the token, so a config can be shown or
/// pasted into docs without a live secret in it.
pub const TOKEN_PLACEHOLDER: &str = "<CLASPT_API_TOKEN>";

const SERVER_KEY: &str = "claspt";

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
        existing
            .parse()
            .map_err(|e| format!("existing config.toml does not parse: {e}"))?
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
        let home = Path::new("/home/u");
        let cfg = Path::new("/home/u/.config");
        let cwd = Path::new("/work/repo");
        for client in Client::ALL {
            assert_eq!(Client::parse(client.name()), Some(client));
            assert_eq!(Client::parse(&client.name().to_uppercase()), Some(client));
            let path = config_path(client, Scope::User, home, cfg, cwd).unwrap();
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
        let v: toml::Value = out.parse().unwrap();
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
}
