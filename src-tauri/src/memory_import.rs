// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! `claspt memory import`: other tools' memory into vault memory pages.
//!
//! Every source becomes the same thing: a list of memories with a title,
//! markdown content, tags, a kind and, when the source records one, a
//! creation time. The JSON exports of mem0, Letta and Zep differ in field
//! names but not in shape (a list of records with a text and a timestamp),
//! so one tolerant reader covers all three; CLAUDE.md and Cursor rules are
//! markdown and split by heading or file.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};

use crate::pages::agent_memory::MemoryInput;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Mem0,
    Letta,
    Zep,
    ClaudeMd,
    CursorRules,
}

impl Source {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name.to_ascii_lowercase().as_str() {
            "mem0" => Ok(Self::Mem0),
            "letta" | "memgpt" => Ok(Self::Letta),
            "zep" => Ok(Self::Zep),
            "claude-md" | "claude.md" | "claude" => Ok(Self::ClaudeMd),
            "cursor-rules" | "cursor" | "cursorrules" => Ok(Self::CursorRules),
            other => Err(format!(
                "unknown source '{other}'; one of mem0, letta, zep, claude-md, cursor-rules"
            )),
        }
    }

    pub fn tag(&self) -> &'static str {
        match self {
            Self::Mem0 => "mem0",
            Self::Letta => "letta",
            Self::Zep => "zep",
            Self::ClaudeMd => "claude-md",
            Self::CursorRules => "cursor-rules",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Imported {
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub kind: &'static str,
    pub created: Option<DateTime<Utc>>,
    pub meta: Vec<(String, String)>,
}

/// One file's worth of memories. `file_name` names untitled content.
pub fn parse(source: Source, text: &str, file_name: &str) -> Result<Vec<Imported>, String> {
    let items = match source {
        Source::Mem0 | Source::Letta | Source::Zep => parse_json_records(source, text)?,
        Source::ClaudeMd => parse_markdown_sections(text, file_name, "procedural", source.tag()),
        Source::CursorRules => parse_cursor_rule(text, file_name),
    };
    Ok(items)
}

fn first_string<'a>(
    obj: &'a serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| obj.get(*k).and_then(|v| v.as_str()))
        .filter(|s| !s.trim().is_empty())
}

fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|d| d.with_timezone(&Utc))
        .or_else(|| {
            text.parse::<i64>().ok().and_then(|n| {
                // Seconds or milliseconds since the epoch, whichever it looks like.
                let secs = if n > 100_000_000_000 { n / 1000 } else { n };
                DateTime::from_timestamp(secs, 0)
            })
        })
}

/// Records from a mem0 / Letta / Zep export: a top-level array, or the first
/// array under one of the usual keys.
fn parse_json_records(source: Source, text: &str) -> Result<Vec<Imported>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    let records: Vec<serde_json::Value> = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(obj) => {
            const KEYS: [&str; 8] = [
                "results", "memories", "passages", "facts", "data", "items", "messages", "nodes",
            ];
            KEYS.iter()
                .find_map(|k| obj.get(*k).and_then(|v| v.as_array()).cloned())
                .ok_or("JSON object has no array of records under a known key")?
        }
        _ => return Err("JSON is neither an array nor an object".into()),
    };
    let mut out = Vec::new();
    for record in records {
        let Some(obj) = record.as_object() else {
            if let Some(text) = record.as_str() {
                out.push(imported_from_text(text, source, None, Vec::new()));
            }
            continue;
        };
        let Some(text) = first_string(
            obj,
            &["memory", "text", "content", "fact", "data", "summary"],
        ) else {
            continue;
        };
        let created = first_string(obj, &["created_at", "createdAt", "timestamp", "created"])
            .and_then(parse_time)
            .or_else(|| {
                obj.get("created_at")
                    .and_then(|v| v.as_i64())
                    .and_then(|n| parse_time(&n.to_string()))
            });
        let mut tags = Vec::new();
        for key in ["user_id", "agent_id", "run_id", "session_id"] {
            if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
                tags.push(v.to_string());
            }
        }
        if let Some(cats) = obj.get("categories").and_then(|v| v.as_array()) {
            tags.extend(cats.iter().filter_map(|c| c.as_str().map(str::to_string)));
        }
        if let Some(meta) = obj.get("metadata").and_then(|v| v.as_object()) {
            for (k, v) in meta {
                if let Some(s) = v.as_str() {
                    tags.push(format!("{k}:{s}"));
                }
            }
        }
        out.push(imported_from_text(text, source, created, tags));
    }
    Ok(out)
}

fn title_from(text: &str, fallback: &str) -> String {
    let first = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or(fallback)
        .trim_start_matches('#')
        .trim();
    let mut title: String = first.chars().take(60).collect();
    if first.chars().count() > 60 {
        title.push('…');
    }
    if title.is_empty() {
        fallback.to_string()
    } else {
        title
    }
}

fn imported_from_text(
    text: &str,
    source: Source,
    created: Option<DateTime<Utc>>,
    mut tags: Vec<String>,
) -> Imported {
    tags.insert(0, source.tag().to_string());
    tags.insert(0, "imported".to_string());
    Imported {
        title: title_from(text, "memory"),
        content: text.trim().to_string(),
        tags,
        kind: "semantic",
        created,
        meta: vec![("source".to_string(), source.tag().to_string())],
    }
}

/// A markdown file split at `## ` headings: what comes before the first
/// heading is one page, each section is another. Headings inside fenced
/// code stay where they are.
fn parse_markdown_sections(
    text: &str,
    file_name: &str,
    kind: &'static str,
    source_tag: &str,
) -> Vec<Imported> {
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "notes".to_string());
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut current_title = format!("{stem} — overview");
    let mut current = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
        }
        if !in_fence && line.starts_with("## ") {
            sections.push((current_title.clone(), current.trim().to_string()));
            current_title = line[3..].trim().to_string();
            current = String::new();
            continue;
        }
        current.push_str(line);
        current.push('\n');
    }
    sections.push((current_title, current.trim().to_string()));
    sections
        .into_iter()
        .filter(|(_, body)| !body.is_empty())
        .map(|(title, body)| Imported {
            title,
            content: body,
            tags: vec!["imported".into(), source_tag.into()],
            kind,
            created: None,
            meta: vec![
                ("source".into(), source_tag.into()),
                ("file".into(), file_name.into()),
            ],
        })
        .collect()
}

/// A `.cursorrules` file or one `.mdc` rule: the `.mdc` frontmatter's
/// `description` names the page and `globs` / `alwaysApply` ride along as
/// metadata, the body is the rule.
fn parse_cursor_rule(text: &str, file_name: &str) -> Vec<Imported> {
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "cursor-rules".to_string());
    let mut meta = vec![
        ("source".to_string(), "cursor-rules".to_string()),
        ("file".to_string(), file_name.to_string()),
    ];
    let mut title = stem.clone();
    let mut body = text;
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let front = &rest[..end];
            body = rest[end + 4..].trim_start_matches('\n');
            for line in front.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let (k, v) = (k.trim(), v.trim().trim_matches('"').trim_matches('\''));
                    match k {
                        "description" if !v.is_empty() => title = v.to_string(),
                        "globs" | "alwaysApply" if !v.is_empty() => {
                            meta.push((k.to_string(), v.to_string()))
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    let content = body.trim();
    if content.is_empty() {
        return Vec::new();
    }
    vec![Imported {
        title,
        content: content.to_string(),
        tags: vec!["imported".into(), "cursor-rules".into()],
        kind: "procedural",
        created: None,
        meta,
    }]
}

/// The bulk-upsert inputs for a set of imports: exact duplicates dropped,
/// titles made unique, source metadata kept.
pub fn to_inputs(items: Vec<Imported>) -> Vec<MemoryInput> {
    let mut seen_content: HashSet<String> = HashSet::new();
    let mut seen_titles: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    for item in items {
        if !seen_content.insert(item.content.clone()) {
            continue;
        }
        let n = seen_titles.entry(item.title.clone()).or_insert(0);
        *n += 1;
        let title = if *n == 1 {
            item.title.clone()
        } else {
            format!("{} ({})", item.title, n)
        };
        let mut custom_meta: HashMap<String, String> = item.meta.into_iter().collect();
        if let Some(created) = item.created {
            custom_meta.insert("imported_created".into(), created.to_rfc3339());
        }
        out.push(MemoryInput {
            title,
            content: item.content,
            tags: item.tags,
            ttl_hours: None,
            custom_meta: Some(custom_meta),
            kind: Some(item.kind.to_string()),
            valid_from: item.created,
            valid_until: None,
            superseded_by: None,
            verified_on: None,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_exports_read_text_time_and_tags_under_any_of_the_usual_names() {
        let mem0 = r#"{"results":[
            {"id":"1","memory":"Likes tea, not coffee","created_at":"2026-01-02T03:04:05Z","user_id":"alice","categories":["preferences"]},
            {"id":"2","memory":"  ","created_at":"2026-01-02T03:04:05Z"},
            {"id":"3","memory":"Works at Example","metadata":{"team":"platform","n":1}}
        ]}"#;
        let items = parse(Source::Mem0, mem0, "mem0.json").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Likes tea, not coffee");
        assert_eq!(items[0].kind, "semantic");
        assert_eq!(
            items[0].created.unwrap().to_rfc3339(),
            "2026-01-02T03:04:05+00:00"
        );
        assert_eq!(items[0].tags, ["imported", "mem0", "alice", "preferences"]);
        assert_eq!(items[1].tags, ["imported", "mem0", "team:platform"]);

        let letta = r#"[{"text":"Archival: the deploy key lives in Claspt","created_at":1735689600}, "bare string passage"]"#;
        let items = parse(Source::Letta, letta, "x.json").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0].created.unwrap().to_rfc3339(),
            "2025-01-01T00:00:00+00:00"
        );
        assert_eq!(items[1].title, "bare string passage");

        let zep = r#"{"facts":[{"fact":"Alice prefers dark mode","createdAt":"2026-02-01T00:00:00+05:30","session_id":"s1"}]}"#;
        let items = parse(Source::Zep, zep, "z.json").unwrap();
        assert_eq!(items[0].tags, ["imported", "zep", "s1"]);
        assert_eq!(
            items[0].created.unwrap().to_rfc3339(),
            "2026-01-31T18:30:00+00:00"
        );

        assert!(parse(Source::Mem0, "not json", "x").is_err());
        assert!(parse(Source::Mem0, r#"{"nothing":1}"#, "x").is_err());
        assert!(parse(Source::Zep, "42", "x").is_err());
    }

    #[test]
    fn claude_md_splits_by_heading_and_keeps_fenced_headings_in_place() {
        let text = "Intro line.\n\n## Build\nnpm test\n```\n## not a heading\n```\n\n## Style\nNo any.\n\n## Empty\n\n";
        let items = parse(Source::ClaudeMd, text, "CLAUDE.md").unwrap();
        let titles: Vec<&str> = items.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles, ["CLAUDE — overview", "Build", "Style"]);
        assert!(items[1].content.contains("## not a heading"));
        assert_eq!(items[1].kind, "procedural");
        assert_eq!(items[1].tags, ["imported", "claude-md"]);
        let single = parse(Source::ClaudeMd, "just text", "AGENTS.md").unwrap();
        assert_eq!(single[0].title, "AGENTS — overview");
    }

    #[test]
    fn cursor_rules_take_their_name_from_the_frontmatter() {
        let mdc = "---\ndescription: \"React conventions\"\nglobs: src/**/*.tsx\nalwaysApply: false\n---\n\nUse function components.\n";
        let items = parse(Source::CursorRules, mdc, "react.mdc").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "React conventions");
        assert_eq!(items[0].content, "Use function components.");
        assert!(items[0]
            .meta
            .contains(&("globs".to_string(), "src/**/*.tsx".to_string())));
        let plain = parse(Source::CursorRules, "Always write tests.", ".cursorrules").unwrap();
        assert_eq!(plain[0].title, ".cursorrules");
        assert!(
            parse(Source::CursorRules, "---\ndescription: x\n---\n", "e.mdc")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn inputs_drop_duplicates_and_keep_titles_unique() {
        let items = vec![
            imported_from_text("same text", Source::Mem0, None, vec![]),
            imported_from_text("same text", Source::Mem0, None, vec![]),
            imported_from_text(
                "same text\nbut different body",
                Source::Mem0,
                Some(Utc::now()),
                vec![],
            ),
        ];
        let inputs = to_inputs(items);
        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0].title, "same text");
        assert_eq!(inputs[1].title, "same text (2)");
        assert_eq!(inputs[1].kind.as_deref(), Some("semantic"));
        assert!(inputs[1].valid_from.is_some());
        assert_eq!(inputs[1].custom_meta.as_ref().unwrap()["source"], "mem0");
        assert!(inputs[1]
            .custom_meta
            .as_ref()
            .unwrap()
            .contains_key("imported_created"));
        assert!(Source::parse("MemGPT").is_ok());
        assert!(Source::parse("notion").is_err());
    }
}
