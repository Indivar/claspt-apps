// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! The policy file that stands in for the approval prompt when there is no
//! one to ask (`claspt serve`).
//!
//! Deny by default. A request is allowed when some rule names the client
//! (by name, id, or `*`), an action pattern matches the request's action
//! (`secret.read`, `memory.*`, `*`), and a target pattern matches its
//! target: the page path for page and secret routes, `memory/<namespace>`
//! for memory routes, and the request path for everything else. Patterns
//! are globs where `*` matches anything, including `/`.
//!
//! ```toml
//! # policy.toml
//! [[rule]]
//! client = "CI runner"
//! actions = ["secret.read", "secret.list"]
//! targets = ["credentials/*", "ai/deploy.md"]
//!
//! [[rule]]
//! client = "*"
//! actions = ["status", "memory.*"]
//! targets = ["memory/ci", "/api/status"]
//! ```

use std::path::Path;

use serde::Deserialize;

use super::clients::ClientToken;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Rule {
    pub client: String,
    pub actions: Vec<String>,
    pub targets: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct Policy {
    #[serde(default, rename = "rule")]
    pub rules: Vec<Rule>,
}

impl Policy {
    pub fn parse(text: &str) -> Result<Self, String> {
        let policy: Policy = toml::from_str(text).map_err(|e| format!("policy file: {e}"))?;
        for (i, rule) in policy.rules.iter().enumerate() {
            if rule.client.trim().is_empty() {
                return Err(format!("policy rule {} has an empty client", i + 1));
            }
            if rule.actions.is_empty() || rule.targets.is_empty() {
                return Err(format!(
                    "policy rule {} for '{}' needs at least one action and one target",
                    i + 1,
                    rule.client
                ));
            }
        }
        Ok(policy)
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read policy {}: {e}", path.display()))?;
        Self::parse(&text)
    }

    pub fn allows(&self, client: &ClientToken, action: &str, target: &str) -> bool {
        self.rules.iter().any(|rule| {
            let client_matches =
                rule.client == "*" || rule.client == client.name || rule.client == client.id;
            client_matches
                && rule.actions.iter().any(|p| glob_matches(p, action))
                && rule.targets.iter().any(|p| glob_matches(p, target))
        })
    }
}

/// `*` matches any run of characters, including none and including `/`.
/// Everything else matches itself.
pub fn glob_matches(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    // Classic two-pointer wildcard match with backtracking to the last star.
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// The thing a policy rule names, from a decoded request path.
pub fn policy_target(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("/api/pages/") {
        let page = rest
            .strip_suffix("/secret")
            .or_else(|| rest.strip_suffix("/secret/rename"))
            .unwrap_or(rest);
        for suffix in ["/move", "/title", "/tags", "/pin", "/archive"] {
            if let Some(p) = page.strip_suffix(suffix) {
                return p.to_string();
            }
        }
        return page.to_string();
    }
    if let Some(rest) = path.strip_prefix("/api/memory/") {
        let ns = rest.split('/').next().unwrap_or("");
        if !ns.is_empty() && ns != "cleanup" && ns != "search" {
            return format!("memory/{ns}");
        }
    }
    if let Some(rest) = path.strip_prefix("/api/browser/login/") {
        return rest.to_string();
    }
    if let Some(rest) = path.strip_prefix("/api/passkeys/") {
        if let Some(rp) = rest.split('/').next().filter(|r| !r.is_empty()) {
            return format!("passkeys/{rp}");
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_api::auth::TokenScope;

    fn client(name: &str) -> ClientToken {
        ClientToken {
            id: "id-1".into(),
            name: name.into(),
            scope: TokenScope::Secrets,
            token_hash: String::new(),
            hint: String::new(),
            created_at: chrono::Utc::now(),
            namespaces: Vec::new(),
            kind: None,
        }
    }

    #[test]
    fn globs_match_whole_strings_with_stars_anywhere() {
        assert!(glob_matches("*", ""));
        assert!(glob_matches("*", "anything/at/all"));
        assert!(glob_matches("credentials/*", "credentials/a/b.md"));
        assert!(!glob_matches("credentials/*", "general/a.md"));
        assert!(glob_matches("memory.*", "memory.read"));
        assert!(!glob_matches("memory.*", "secret.read"));
        assert!(glob_matches("*.md", "ai/x.md"));
        assert!(glob_matches("a*b*c", "aXXbYYc"));
        assert!(!glob_matches("a*b*c", "aXXbYY"));
        assert!(!glob_matches("secret.read", "secret.reader"));
    }

    #[test]
    fn targets_are_pages_namespaces_or_paths() {
        assert_eq!(
            policy_target("/api/pages/credentials/x.md"),
            "credentials/x.md"
        );
        assert_eq!(
            policy_target("/api/pages/credentials/x.md/secret"),
            "credentials/x.md"
        );
        assert_eq!(
            policy_target("/api/pages/credentials/x.md/tags"),
            "credentials/x.md"
        );
        assert_eq!(policy_target("/api/memory/ci/decisions"), "memory/ci");
        assert_eq!(policy_target("/api/memory/ci"), "memory/ci");
        assert_eq!(policy_target("/api/memory/search"), "/api/memory/search");
        assert_eq!(policy_target("/api/browser/login/ai/gh.md"), "ai/gh.md");
        assert_eq!(policy_target("/api/status"), "/api/status");
    }

    #[test]
    fn policy_denies_by_default_and_allows_only_full_matches() {
        let policy = Policy::parse(
            r#"
            [[rule]]
            client = "CI runner"
            actions = ["secret.read"]
            targets = ["credentials/*"]

            [[rule]]
            client = "*"
            actions = ["status", "memory.*"]
            targets = ["memory/ci", "/api/status"]
            "#,
        )
        .unwrap();
        assert!(Policy::parse("").unwrap().rules.is_empty());
        assert!(!Policy::parse("")
            .unwrap()
            .allows(&client("x"), "status", "/api/status"));
        let ci = client("CI runner");
        assert!(policy.allows(&ci, "secret.read", "credentials/prod.md"));
        assert!(!policy.allows(&ci, "secret.read", "general/notes.md"));
        assert!(!policy.allows(&ci, "secret.write", "credentials/prod.md"));
        assert!(!policy.allows(
            &client("someone else"),
            "secret.read",
            "credentials/prod.md"
        ));
        assert!(policy.allows(&client("anyone"), "memory.read", "memory/ci"));
        assert!(!policy.allows(&client("anyone"), "memory.read", "memory/other"));
        assert!(policy.allows(&client("anyone"), "status", "/api/status"));
        // A rule may name the client by id.
        let by_id =
            Policy::parse("[[rule]]\nclient = \"id-1\"\nactions = [\"*\"]\ntargets = [\"*\"]\n")
                .unwrap();
        assert!(by_id.allows(&ci, "page.delete", "anything"));
        // Malformed rules are refused, not ignored.
        assert!(
            Policy::parse("[[rule]]\nclient = \"\"\nactions = [\"*\"]\ntargets = [\"*\"]\n")
                .is_err()
        );
        assert!(
            Policy::parse("[[rule]]\nclient = \"a\"\nactions = []\ntargets = [\"*\"]\n").is_err()
        );
        assert!(Policy::parse("not = [toml").is_err());
    }
}
