// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Whether a secret block is shaped so the browser extension can fill a login.
//!
//! The extension parses a block's `key: value` lines, lowercases the keys, and
//! looks for specific names: `password` for the secret, `username` or `email`
//! for the identity, and `url` / `site` / `website` to match the site. A block
//! that holds a login under any other names is stored and encrypted correctly
//! but cannot be filled — and nothing says so, because autofill simply finds
//! nothing and does nothing.
//!
//! That failure is silent and far from its cause, which is how a batch of
//! credentials written by an agent in August 2026 sat unusable for a week. The
//! agent used the field NAMES as descriptions ("app.example.com signup A") and
//! put the whole credential in the value ("user@example.com / hunter2"). Every
//! secret was encrypted; none of them could be filled.
//!
//! The checks here are deliberately conservative. A block that already has a
//! `password` field is never reported, whatever else it contains, so a password
//! that happens to contain a slash cannot trigger a false warning.

/// Field names the extension accepts for the identity, lowercased.
const USERNAME_KEYS: [&str; 2] = ["username", "email"];

/// Field names the extension accepts for the secret, lowercased.
const PASSWORD_KEYS: [&str; 1] = ["password"];

/// Field names the extension accepts for site matching, lowercased.
const URL_KEYS: [&str; 3] = ["url", "site", "website"];

/// A reason a block cannot be used to fill a login form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginFillIssue {
    /// One field holds an identity and a secret together, e.g.
    /// `"signup A": "user@example.com / hunter2"`. The extension has no way to
    /// tell which half is which, so it fills neither.
    CredentialPairInOneField { field: String },

    /// Several fields each hold a whole credential, so the block describes more
    /// than one login. A block maps to exactly one credential in the extension,
    /// so all but one are unreachable however the names are fixed.
    SeveralCredentialsInOneBlock { count: usize },

    /// There is a password but nothing identifying who it belongs to.
    MissingUsername,

    /// There is a username but no password.
    MissingPassword,

    /// A field name plainly means to be a credential field but is not one the
    /// extension looks for — `"Console password"`, `"Username (corrected
    /// 2026-08-21)"`, `"User"`. The credential is right there and still cannot
    /// be filled, which is the most frustrating way for this to fail.
    UnrecognisedFieldName {
        field: String,
        suggestion: &'static str,
    },
}

impl std::fmt::Display for LoginFillIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CredentialPairInOneField { field } => write!(
                f,
                "the field {field:?} holds an identity and a secret in one value; \
                 split it into separate `username` and `password` fields"
            ),
            Self::SeveralCredentialsInOneBlock { count } => write!(
                f,
                "this block holds {count} separate credentials; a block fills one \
                 login, so give each its own block"
            ),
            Self::MissingUsername => write!(
                f,
                "there is a password but no `username` or `email` field, so autofill \
                 has nothing to put in the identity box"
            ),
            Self::MissingPassword => write!(
                f,
                "there is a username but no `password` field, so autofill has nothing \
                 to put in the password box"
            ),
            Self::UnrecognisedFieldName { field, suggestion } => write!(
                f,
                "the field {field:?} looks like a credential field but is not one \
                 autofill looks for; rename it to `{suggestion}` and move any \
                 explanation into a `notes` field"
            ),
        }
    }
}

fn has_any(fields: &[(String, String)], names: &[&str]) -> bool {
    fields
        .iter()
        .any(|(k, v)| !v.is_empty() && names.contains(&k.trim().to_lowercase().as_str()))
}

/// Does this value look like an identity and a secret joined by a separator?
///
/// Requires a slash surrounded by spaces and something identity-shaped on the
/// left — an email address, or a short token with no spaces. Both halves must be
/// non-empty. A URL is excluded, since `https://…` and paths are full of
/// slashes and are not credentials.
fn looks_like_credential_pair(value: &str) -> bool {
    let value = value.trim();
    if value.contains("://") {
        return false;
    }

    let Some((left, right)) = value.split_once(" / ") else {
        return false;
    };
    let (left, right) = (left.trim(), right.trim());
    if left.is_empty() || right.is_empty() || right.contains(" / ") {
        return false;
    }

    // The left side has to look like something you would type into a login box:
    // an email address, or a single word. A sentence means this is prose that
    // happens to contain a slash, and a run of digits, dots and dashes is a date
    // or a version range — `2026-01-01 / 2026-12-31` is not a credential.
    if left.contains(' ') || left.len() < 3 {
        return false;
    }
    if left.contains('@') {
        return true;
    }
    left.chars().any(|c| c.is_alphabetic())
        && !left
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c == '/')
}

/// A field name that clearly means to be a credential field but is not one the
/// extension looks for, and what it should be called instead.
///
/// Two shapes are recognised, and both are deliberately narrow:
///
/// - Exact near-misses. `user`, `login` and `pass` are the names people reach
///   for, and none of them fills anything.
/// - Prose names, meaning the name contains a space or a bracket. That is what
///   separates `"Console password"` and `"Password (as recorded April 2026)"`,
///   which are captions attached to a login field, from `POSTGRES_PASSWORD` and
///   `LLDAP_LDAP_USER_PASS`, which are environment variable names that must
///   stay exactly as they are so they can be copied into config.
fn unrecognised_credential_name(key: &str) -> Option<&'static str> {
    let k = key.trim().to_lowercase();

    match k.as_str() {
        "user" | "login" | "account" | "e-mail" | "user name" => return Some("username"),
        "pass" | "passwd" | "pwd" => return Some("password"),
        _ => {}
    }

    let is_prose = k.contains(' ') || k.contains('(');
    if !is_prose {
        return None;
    }

    if k.contains("password") || k.contains("passphrase") {
        return Some("password");
    }
    if k.contains("username") || k.contains("user name") || k.contains("email") {
        return Some("username");
    }
    None
}

/// Report why a block cannot fill a login, or nothing if it can, or if it is
/// plainly not a login at all.
///
/// Blocks that carry no identity, no password and no crammed pair — an API key,
/// an SSH key, a note — return an empty list. This is a check on credentials
/// that mean to be fillable, not a demand that every secret look like a login.
pub fn login_fill_issues(fields: &[(String, String)]) -> Vec<LoginFillIssue> {
    let has_username = has_any(fields, &USERNAME_KEYS);
    let has_password = has_any(fields, &PASSWORD_KEYS);

    // A block with a real password field is already in the shape the extension
    // understands. Nothing below can improve it, and inspecting values further
    // risks warning about a password that merely contains a slash.
    if has_password && has_username {
        return Vec::new();
    }

    let crammed: Vec<&String> = fields
        .iter()
        .filter(|(k, v)| {
            !USERNAME_KEYS.contains(&k.trim().to_lowercase().as_str())
                && !URL_KEYS.contains(&k.trim().to_lowercase().as_str())
                && looks_like_credential_pair(v)
        })
        .map(|(k, _)| k)
        .collect();

    let mut issues = Vec::new();

    if crammed.len() > 1 {
        issues.push(LoginFillIssue::SeveralCredentialsInOneBlock {
            count: crammed.len(),
        });
    }
    for field in &crammed {
        issues.push(LoginFillIssue::CredentialPairInOneField {
            field: (*field).clone(),
        });
    }

    // A name that is nearly right is worth saying out loud: the credential is
    // present and correct, and still nothing fills. Only reported when the
    // properly named field is absent, so a block carrying both `password` and
    // `Password hint` is left alone.
    for (k, v) in fields {
        if v.is_empty() {
            continue;
        }
        let Some(suggestion) = unrecognised_credential_name(k) else {
            continue;
        };
        let already_present = match suggestion {
            "password" => has_password,
            _ => has_username,
        };
        if !already_present {
            issues.push(LoginFillIssue::UnrecognisedFieldName {
                field: k.clone(),
                suggestion,
            });
        }
    }

    // Only complain about a missing half when the other half is present. A block
    // with neither is not a login and is none of this function's business.
    if crammed.is_empty() {
        if has_password && !has_username {
            issues.push(LoginFillIssue::MissingUsername);
        }
        if has_username && !has_password {
            issues.push(LoginFillIssue::MissingPassword);
        }
    }

    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn a_well_formed_login_has_no_issues() {
        assert!(login_fill_issues(&fields(&[
            ("username", "alice@example.com"),
            ("password", "hunter2"),
            ("url", "https://example.com"),
        ]))
        .is_empty());
    }

    #[test]
    fn field_names_are_matched_however_they_are_capitalised() {
        // The extension lowercases keys before looking them up, so `Username`
        // from the app's own login template is just as valid as `username`.
        assert!(login_fill_issues(&fields(&[
            ("Username", "alice@example.com"),
            ("Password", "hunter2"),
        ]))
        .is_empty());
        assert!(login_fill_issues(&fields(&[
            ("Email", "alice@example.com"),
            ("password", "hunter2"),
        ]))
        .is_empty());
    }

    #[test]
    fn things_that_are_not_logins_are_left_alone() {
        // An API key, an SSH key, a note — no identity, no password, no pair.
        for f in [
            fields(&[
                ("API Key", "sk-live-abc123"),
                ("Endpoint", "https://api.example.com"),
            ]),
            fields(&[("Note", "rotate this every 90 days")]),
            fields(&[("Private key", "-----BEGIN OPENSSH PRIVATE KEY-----")]),
        ] {
            assert!(
                login_fill_issues(&f).is_empty(),
                "a non-login block should not be reported: {f:?}"
            );
        }
    }

    /// The exact shape the August 2026 agent wrote: the field name is a
    /// description and the value holds both halves of the credential.
    #[test]
    fn a_credential_crammed_into_one_value_is_reported() {
        let issues = login_fill_issues(&fields(&[(
            "app.example.com signup A",
            "alice@example.com / hunter2",
        )]));
        assert_eq!(
            issues,
            vec![LoginFillIssue::CredentialPairInOneField {
                field: "app.example.com signup A".to_string()
            }]
        );
    }

    #[test]
    fn several_credentials_in_one_block_are_reported_as_such() {
        let issues = login_fill_issues(&fields(&[
            ("Note", "three were recorded; verify which is current"),
            ("signup A", "alice@example.com / hunter2"),
            ("signup B", "alice@example.com / hunter3"),
            ("most recent (2026-04-24)", "bob@example.com / hunter4"),
        ]));
        assert!(issues.contains(&LoginFillIssue::SeveralCredentialsInOneBlock { count: 3 }));
        assert_eq!(
            issues
                .iter()
                .filter(|i| matches!(i, LoginFillIssue::CredentialPairInOneField { .. }))
                .count(),
            3
        );
    }

    #[test]
    fn a_half_credential_is_reported() {
        assert_eq!(
            login_fill_issues(&fields(&[("password", "hunter2")])),
            vec![LoginFillIssue::MissingUsername]
        );
        assert_eq!(
            login_fill_issues(&fields(&[("username", "alice@example.com")])),
            vec![LoginFillIssue::MissingPassword]
        );
    }

    /// The check must not fire on values that merely contain a slash. A false
    /// warning on a correct block trains people to ignore the real ones.
    #[test]
    fn slashes_that_are_not_credentials_are_ignored() {
        for f in [
            // A password containing a slash, in a properly named field.
            fields(&[("username", "alice"), ("password", "a / b")]),
            // A URL.
            fields(&[("Endpoint", "https://example.com / v2")]),
            // Prose.
            fields(&[("Note", "use the staging key / not production")]),
            // A date range or similar, with no identity on the left.
            fields(&[("Valid", "2026-01-01 / 2026-12-31")]),
        ] {
            let issues = login_fill_issues(&f);
            assert!(
                !issues
                    .iter()
                    .any(|i| matches!(i, LoginFillIssue::CredentialPairInOneField { .. })),
                "false positive on {f:?}: {issues:?}"
            );
        }
    }

    #[test]
    fn a_url_field_holding_a_path_is_not_mistaken_for_a_credential() {
        assert!(login_fill_issues(&fields(&[
            ("url", "example.com / login"),
            ("username", "alice"),
            ("password", "hunter2"),
        ]))
        .is_empty());
    }

    /// Names that are nearly right are the most frustrating failure: the
    /// credential is present and correct, and still nothing fills. Every case
    /// here was found in a real vault after an agent wrote it.
    #[test]
    fn a_field_name_that_is_nearly_right_is_reported() {
        let cases: [(&[(&str, &str)], &str); 4] = [
            // Traefik: `User` instead of `username`.
            (
                &[("User", "admin"), ("URL", "traefik.example.com")],
                "username",
            ),
            // Stalwart: the caption swallowed the field name.
            (
                &[(
                    "Password (as recorded April 2026, verify against config.toml)",
                    "hunter2",
                )],
                "password",
            ),
            // AWS: the service name prefixed the field name.
            (&[("Console password", "hunter2")], "password"),
            // A shared password across several test accounts.
            (
                &[("Shared password (all 8 accounts)", "hunter2")],
                "password",
            ),
        ];

        for (fields_in, expected) in cases {
            let issues = login_fill_issues(&fields(fields_in));
            assert!(
                issues.iter().any(|i| matches!(
                    i,
                    LoginFillIssue::UnrecognisedFieldName { suggestion, .. } if suggestion == &expected
                )),
                "{fields_in:?} should suggest `{expected}`, got {issues:?}"
            );
        }
    }

    /// Environment variable names must be left alone. They are copied verbatim
    /// into config files, so "renaming" them would break the thing they are for
    /// — and a `.env` dump is not a login.
    #[test]
    fn environment_variable_names_are_not_reported() {
        let issues = login_fill_issues(&fields(&[
            ("POSTGRES_USER", "mailserver"),
            ("POSTGRES_PASSWORD", "hunter2"),
            ("LLDAP_LDAP_USER_PASS", "hunter3"),
            ("STALWART_ADMIN_PASSWORD", "hunter4"),
            ("LLDAP_JWT_SECRET", "abc"),
        ]));
        assert!(
            issues.is_empty(),
            "environment variable names should be left alone: {issues:?}"
        );
    }

    /// A block that already has the properly named field is not nagged about a
    /// second field that merely mentions the word.
    #[test]
    fn a_correct_field_alongside_a_descriptive_one_is_not_reported() {
        let issues = login_fill_issues(&fields(&[
            ("username", "alice"),
            ("password", "hunter2"),
            ("Password hint", "the usual one"),
            ("Recovery email", "alice@example.com"),
        ]));
        assert!(issues.is_empty(), "{issues:?}");
    }
}
