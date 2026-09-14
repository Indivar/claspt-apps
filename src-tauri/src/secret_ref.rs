// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! `claspt://secret/...` references: a way to name a secret without holding it.
//!
//! A reference is `claspt://secret/<page-path>?block=<label>#<field>`. It can
//! sit in a `.env` file, a config template or an environment variable; the
//! value only exists inside the process `claspt run` spawns or the file
//! `claspt inject` writes. `block` may be left out when the page has one
//! secret block. Page path, label and field are percent-encoded where they
//! contain characters a URL cannot carry.
//!
//! This module is pure: parsing, scanning text for references, picking the
//! field out of a page's blocks, and substituting. The CLI does the I/O.

use std::collections::BTreeMap;
use std::ops::Range;

pub const PREFIX: &str = "claspt://secret/";

/// A page's decrypted secret blocks: (label, field -> value).
pub type SecretBlocks = Vec<(String, BTreeMap<String, String>)>;

/// The `items` of a `GET /api/pages/{path}/secret` listing as blocks. A
/// redacted listing (Notes scope) is refused here rather than passed on as
/// a page with no fields, which would read as "field missing".
pub fn blocks_from_listing(listing: &serde_json::Value) -> Result<SecretBlocks, String> {
    let mut blocks = Vec::new();
    for item in listing
        .get("items")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let label = item
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let mut fields = BTreeMap::new();
        if let Some(obj) = item.get("fields").and_then(|v| v.as_object()) {
            if obj.get("redacted").and_then(|v| v.as_bool()) == Some(true) {
                return Err(
                    "this token has Notes scope; a secret reference needs a Secrets-scope token"
                        .to_string(),
                );
            }
            for (k, v) in obj {
                if let Some(value) = v.as_str() {
                    fields.insert(k.clone(), value.to_string());
                }
            }
        }
        blocks.push((label, fields));
    }
    Ok(blocks)
}

/// One parsed reference.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct SecretRef {
    /// Vault-relative page path (or page id; the API resolves both).
    pub page: String,
    /// Secret block label, when the page has more than one block.
    pub block: Option<String>,
    /// Field name inside the block.
    pub field: String,
}

impl SecretRef {
    pub fn parse(text: &str) -> Result<Self, String> {
        let rest = text
            .strip_prefix(PREFIX)
            .ok_or_else(|| format!("not a secret reference (expected {PREFIX}...): {text}"))?;
        let (before_hash, field) = rest
            .split_once('#')
            .ok_or_else(|| format!("reference has no #field: {text}"))?;
        let (page, query) = match before_hash.split_once('?') {
            Some((p, q)) => (p, Some(q)),
            None => (before_hash, None),
        };
        let page = decode(page)?;
        let field = decode(field)?;
        if page.is_empty() || field.is_empty() {
            return Err(format!("reference needs a page and a field: {text}"));
        }
        let mut block = None;
        for pair in query.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
            match pair.split_once('=') {
                Some(("block", v)) => block = Some(decode(v)?),
                _ => return Err(format!("unknown reference option '{pair}' in {text}")),
            }
        }
        Ok(Self { page, block, field })
    }

    /// The canonical text form.
    pub fn to_uri(&self) -> String {
        let mut uri = format!("{PREFIX}{}", encode(&self.page));
        if let Some(block) = &self.block {
            uri.push_str("?block=");
            uri.push_str(&encode(block));
        }
        uri.push('#');
        uri.push_str(&encode(&self.field));
        uri
    }

    /// Pick this reference's value out of a page's decrypted blocks. Errors
    /// name labels and field names, never values.
    pub fn select<'a>(
        &self,
        blocks: &'a [(String, BTreeMap<String, String>)],
    ) -> Result<&'a str, String> {
        let block = match &self.block {
            Some(label) => blocks
                .iter()
                .find(|(l, _)| l == label)
                .ok_or_else(|| format!("page {} has no secret block '{label}'", self.page))?,
            None => match blocks {
                [] => return Err(format!("page {} has no secret block", self.page)),
                [one] => one,
                many => {
                    let labels: Vec<&str> = many.iter().map(|(l, _)| l.as_str()).collect();
                    return Err(format!(
                        "page {} has {} secret blocks; add ?block=<label> to choose one of: {}",
                        self.page,
                        many.len(),
                        labels.join(", ")
                    ));
                }
            },
        };
        block.1.get(&self.field).map(String::as_str).ok_or_else(|| {
            let names: Vec<&str> = block.1.keys().map(String::as_str).collect();
            format!(
                "secret block '{}' on {} has no field '{}' (fields: {})",
                block.0,
                self.page,
                self.field,
                names.join(", ")
            )
        })
    }
}

/// A reference ends at whitespace or at a character that closes a shell
/// word, a quoted string or a bracket, so it can be dropped into a `.env`
/// line, a JSON string or a YAML value without escaping.
fn ends_reference(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '"' | '\'' | '`' | ',' | ';' | ')' | ']' | '}' | '>' | '<'
        )
}

/// Every reference in `text`, with the byte range it occupies.
pub fn find_all(text: &str) -> Result<Vec<(Range<usize>, SecretRef)>, String> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = text[from..].find(PREFIX) {
        let start = from + rel;
        let end = text[start..]
            .char_indices()
            .find(|(_, c)| ends_reference(*c))
            .map(|(i, _)| start + i)
            .unwrap_or(text.len());
        out.push((start..end, SecretRef::parse(&text[start..end])?));
        from = end;
    }
    Ok(out)
}

/// `text` with every reference replaced by what `resolve` returns for it.
/// The first resolution failure stops the whole substitution, so a partly
/// filled template is never produced.
pub fn substitute(
    text: &str,
    mut resolve: impl FnMut(&SecretRef) -> Result<String, String>,
) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (range, reference) in find_all(text)? {
        out.push_str(&text[last..range.start]);
        out.push_str(&resolve(&reference)?);
        last = range.end;
    }
    out.push_str(&text[last..]);
    Ok(out)
}

/// `KEY=VALUE` lines of a dotenv-style file: blank lines and `#` comments
/// skipped, an `export ` prefix allowed, matching single or double quotes
/// around the value removed. No interpolation; a value is what is written.
pub fn parse_env_file(text: &str) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("line {}: expected KEY=VALUE, got '{raw}'", n + 1))?;
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!(
                "line {}: '{key}' is not a valid variable name",
                n + 1
            ));
        }
        let value = value.trim();
        let value = match value.chars().next() {
            Some(q @ ('"' | '\'')) if value.len() >= 2 && value.ends_with(q) => {
                &value[1..value.len() - 1]
            }
            _ => value,
        };
        out.push((key.to_string(), value.to_string()));
    }
    Ok(out)
}

/// The environment a child gets: every entry whose value is a reference is
/// resolved, everything else passes through unchanged. Entries are applied in
/// order, so a later file or `--env` overrides an earlier one.
pub fn resolve_env(
    entries: Vec<(String, String)>,
    mut resolve: impl FnMut(&SecretRef) -> Result<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for (key, value) in entries {
        let value = if value.starts_with(PREFIX) {
            let reference = SecretRef::parse(value.trim())?;
            resolve(&reference).map_err(|e| format!("{key}: {e}"))?
        } else {
            value
        };
        out.insert(key, value);
    }
    Ok(out)
}

fn decode(part: &str) -> Result<String, String> {
    urlencoding::decode(part)
        .map(|c| c.into_owned())
        .map_err(|e| format!("reference is not valid UTF-8 after decoding: {e}"))
}

fn encode(part: &str) -> String {
    // Slashes stay readable in page paths; everything else a URL cannot
    // carry is percent-encoded.
    part.split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocks() -> SecretBlocks {
        vec![
            (
                "Prod".to_string(),
                BTreeMap::from([("password".to_string(), "p1".to_string())]),
            ),
            (
                "Staging".to_string(),
                BTreeMap::from([
                    ("password".to_string(), "p2".to_string()),
                    ("token".to_string(), "t2".to_string()),
                ]),
            ),
        ]
    }

    #[test]
    fn references_parse_and_print_round_trip() {
        let r = SecretRef::parse("claspt://secret/ai/aws.md?block=Prod#password").unwrap();
        assert_eq!(
            r,
            SecretRef {
                page: "ai/aws.md".into(),
                block: Some("Prod".into()),
                field: "password".into()
            }
        );
        assert_eq!(r.to_uri(), "claspt://secret/ai/aws.md?block=Prod#password");
        let odd = SecretRef {
            page: "credentials/2026-01-01-000000-my page.md".into(),
            block: Some("Prod & Co".into()),
            field: "API Key".into(),
        };
        assert_eq!(SecretRef::parse(&odd.to_uri()).unwrap(), odd);
        let plain = SecretRef::parse("claspt://secret/ai/aws.md#token").unwrap();
        assert_eq!(plain.block, None);
    }

    #[test]
    fn malformed_references_are_refused() {
        assert!(SecretRef::parse("https://example.com").is_err());
        assert!(SecretRef::parse("claspt://secret/ai/aws.md").is_err());
        assert!(SecretRef::parse("claspt://secret/#field").is_err());
        assert!(SecretRef::parse("claspt://secret/ai/aws.md#").is_err());
        assert!(SecretRef::parse("claspt://secret/ai/aws.md?label=x#f").is_err());
    }

    #[test]
    fn select_needs_the_block_only_when_the_page_has_several() {
        let many = blocks();
        let one = vec![many[0].clone()];
        let plain = SecretRef::parse("claspt://secret/p.md#password").unwrap();
        assert_eq!(plain.select(&one).unwrap(), "p1");
        let err = plain.select(&many).unwrap_err();
        assert!(err.contains("Prod, Staging"), "{err}");
        assert!(!err.contains("p1") && !err.contains("p2"));
        let staged = SecretRef::parse("claspt://secret/p.md?block=Staging#token").unwrap();
        assert_eq!(staged.select(&many).unwrap(), "t2");
        let missing = SecretRef::parse("claspt://secret/p.md?block=Staging#nope").unwrap();
        let err = missing.select(&many).unwrap_err();
        assert!(err.contains("fields: password, token"), "{err}");
        assert!(!err.contains("p2") && !err.contains("t2"));
        let no_block = SecretRef::parse("claspt://secret/p.md?block=QA#token").unwrap();
        assert!(no_block.select(&many).is_err());
        assert!(plain.select(&[]).is_err());
    }

    #[test]
    fn find_all_stops_at_quotes_and_brackets() {
        let text = "url=\"claspt://secret/a.md#u\" other: 'claspt://secret/b.md?block=B#f', [claspt://secret/c.md#x]\nplain claspt://secret/d.md#y";
        let found = find_all(text).unwrap();
        let uris: Vec<String> = found.iter().map(|(_, r)| r.to_uri()).collect();
        assert_eq!(
            uris,
            [
                "claspt://secret/a.md#u",
                "claspt://secret/b.md?block=B#f",
                "claspt://secret/c.md#x",
                "claspt://secret/d.md#y"
            ]
        );
        assert_eq!(&text[found[0].0.clone()], "claspt://secret/a.md#u");
        // A broken reference in the text is an error, not silently skipped.
        assert!(find_all("x claspt://secret/nofield y").is_err());
    }

    #[test]
    fn substitute_replaces_every_reference_or_nothing() {
        let text = "A=claspt://secret/a.md#u\nB=\"claspt://secret/a.md#u\"\nC=plain\n";
        let out = substitute(text, |r| Ok(format!("<{}>", r.field))).unwrap();
        assert_eq!(out, "A=<u>\nB=\"<u>\"\nC=plain\n");
        let mut calls = 0;
        let err = substitute(text, |_| {
            calls += 1;
            Err("denied".to_string())
        })
        .unwrap_err();
        assert_eq!(err, "denied");
        assert_eq!(calls, 1);
    }

    #[test]
    fn env_files_parse_like_dotenv_and_resolve_only_references() {
        let file = "# comment\n\nexport DB_URL='claspt://secret/ai/db.md#url'\nPLAIN=\"hello world\"\nBARE=x=y\n";
        let entries = parse_env_file(file).unwrap();
        assert_eq!(
            entries,
            [
                (
                    "DB_URL".to_string(),
                    "claspt://secret/ai/db.md#url".to_string()
                ),
                ("PLAIN".to_string(), "hello world".to_string()),
                ("BARE".to_string(), "x=y".to_string()),
            ]
        );
        assert!(parse_env_file("NOEQUALS").is_err());
        assert!(parse_env_file("BAD-NAME=1").is_err());
        let env = resolve_env(entries, |r| Ok(format!("resolved:{}", r.page))).unwrap();
        assert_eq!(env["DB_URL"], "resolved:ai/db.md");
        assert_eq!(env["PLAIN"], "hello world");
        // Later entries override earlier ones, as a shell would.
        let env = resolve_env(
            vec![("K".into(), "1".into()), ("K".into(), "2".into())],
            |_| Ok(String::new()),
        )
        .unwrap();
        assert_eq!(env["K"], "2");
        let err = resolve_env(
            vec![("TOKEN".into(), "claspt://secret/a.md#t".into())],
            |_| Err("not approved".into()),
        )
        .unwrap_err();
        assert_eq!(err, "TOKEN: not approved");
    }

    #[test]
    fn listings_convert_and_redacted_ones_are_refused() {
        let listing = serde_json::json!({ "items": [
            { "label": "A", "fields": { "user": "u", "password": "p" } },
            { "label": "B", "fields": { "token": "t" } }
        ]});
        let blocks = blocks_from_listing(&listing).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].1["password"], "p");
        let redacted =
            serde_json::json!({ "items": [ { "label": "A", "fields": { "redacted": true } } ] });
        assert!(blocks_from_listing(&redacted).is_err());
        assert!(blocks_from_listing(&serde_json::json!({}))
            .unwrap()
            .is_empty());
    }
}
