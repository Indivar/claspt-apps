// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tantivy-backed search engine: schema definition, index open/build, incremental
//! indexing, and query execution.
//!
//! The schema has eight fields. Four are searched with score boosts — `title` (3x),
//! `tags` (2x), `secret_labels` (2x), and `content` (1x) — while `page_id`, `folder`,
//! `path`, and `has_secrets` are stored/filter-only. Only plaintext is indexed: secret
//! block *values* are stripped by [`strip_secret_values`] before a page reaches the
//! index, so only their labels are searchable.
//!
//! Queries default to conjunction (all terms must match) and, for search-as-you-type,
//! the final token is expanded into a [`PhrasePrefixQuery`] so `"Crypt"` matches
//! `"Cryptography"`. [`SearchScope`] narrows results to a folder subtree or to
//! secret-bearing pages only.
use std::path::Path;

use serde::{Deserialize, Serialize};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, BoostQuery, Occur, PhrasePrefixQuery, QueryParser};
use tantivy::schema::*;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};

use super::error::SearchError;

/// Search result returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    /// Stable page identifier (matches the page's frontmatter `id`).
    pub page_id: String,
    /// Page title.
    pub title: String,
    /// Short excerpt of matching content, centered on the first query term.
    pub snippet: String,
    /// Folder the page lives in (may be nested, e.g. `credentials/work`).
    pub folder: String,
    /// Vault-relative path to the page's `.md` file.
    pub path: String,
    /// Tantivy relevance score, after field boosts. Higher is more relevant.
    pub score: f32,
}

/// Scope filter for search queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum SearchScope {
    /// Search all pages in the vault (default).
    #[default]
    All,
    /// Restrict to a folder and its nested subfolders (prefix match on folder path).
    Folder(String),
    /// Restrict to pages that contain at least one secret block.
    SecretsOnly,
}

/// Schema field handles for the tantivy index.
struct SchemaFields {
    page_id: Field,
    title: Field,
    content: Field,
    tags: Field,
    secret_labels: Field,
    folder: Field,
    path: Field,
    has_secrets: Field,
}

/// The search engine wrapping a tantivy index.
pub struct SearchEngine {
    index: Index,
    reader: IndexReader,
    fields: SchemaFields,
}

impl SearchEngine {
    /// Open or create a tantivy index in the given directory.
    pub fn open(index_dir: &Path) -> Result<Self, SearchError> {
        std::fs::create_dir_all(index_dir)?;

        let schema = build_schema();

        let index = if index_dir.join("meta.json").exists() {
            Index::open_in_dir(index_dir)
                .map_err(|e| SearchError::Index(format!("failed to open index: {e}")))?
        } else {
            Index::create_in_dir(index_dir, schema.clone())
                .map_err(|e| SearchError::Index(format!("failed to create index: {e}")))?
        };

        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|e| SearchError::Index(format!("failed to create reader: {e}")))?;

        let fields = SchemaFields {
            page_id: schema
                .get_field("page_id")
                .map_err(|_| SearchError::Index("schema missing page_id field".into()))?,
            title: schema
                .get_field("title")
                .map_err(|_| SearchError::Index("schema missing title field".into()))?,
            content: schema
                .get_field("content")
                .map_err(|_| SearchError::Index("schema missing content field".into()))?,
            tags: schema
                .get_field("tags")
                .map_err(|_| SearchError::Index("schema missing tags field".into()))?,
            secret_labels: schema
                .get_field("secret_labels")
                .map_err(|_| SearchError::Index("schema missing secret_labels field".into()))?,
            folder: schema
                .get_field("folder")
                .map_err(|_| SearchError::Index("schema missing folder field".into()))?,
            path: schema
                .get_field("path")
                .map_err(|_| SearchError::Index("schema missing path field".into()))?,
            has_secrets: schema
                .get_field("has_secrets")
                .map_err(|_| SearchError::Index("schema missing has_secrets field".into()))?,
        };

        Ok(Self {
            index,
            reader,
            fields,
        })
    }

    /// Index or update a single page.
    pub fn index_page(&self, page: &PageDocument) -> Result<(), SearchError> {
        let mut writer = self.writer()?;

        // Delete existing document for this page_id
        let page_id_term = tantivy::Term::from_field_text(self.fields.page_id, &page.page_id);
        writer.delete_term(page_id_term);

        writer
            .add_document(doc!(
                self.fields.page_id => page.page_id.clone(),
                self.fields.title => page.title.clone(),
                self.fields.content => page.content.clone(),
                self.fields.tags => page.tags.clone(),
                self.fields.secret_labels => page.secret_labels.clone(),
                self.fields.folder => page.folder.clone(),
                self.fields.path => page.path.clone(),
                self.fields.has_secrets => if page.has_secrets { "true" } else { "false" },
            ))
            .map_err(|e| SearchError::Index(format!("failed to add document: {e}")))?;

        writer
            .commit()
            .map_err(|e| SearchError::Index(format!("commit failed: {e}")))?;

        self.reader
            .reload()
            .map_err(|e| SearchError::Index(format!("reader reload failed: {e}")))?;

        Ok(())
    }

    /// Index multiple pages in a single writer/commit cycle.
    /// Much faster than calling `index_page` in a loop (avoids per-entry commits).
    pub fn index_pages_batch(&self, pages: &[PageDocument]) -> Result<(), SearchError> {
        if pages.is_empty() {
            return Ok(());
        }
        let mut writer = self.writer()?;

        for page in pages {
            // Delete existing document for this page_id (upsert)
            let page_id_term = tantivy::Term::from_field_text(self.fields.page_id, &page.page_id);
            writer.delete_term(page_id_term);

            writer
                .add_document(doc!(
                    self.fields.page_id => page.page_id.clone(),
                    self.fields.title => page.title.clone(),
                    self.fields.content => page.content.clone(),
                    self.fields.tags => page.tags.clone(),
                    self.fields.secret_labels => page.secret_labels.clone(),
                    self.fields.folder => page.folder.clone(),
                    self.fields.path => page.path.clone(),
                    self.fields.has_secrets => if page.has_secrets { "true" } else { "false" },
                ))
                .map_err(|e| SearchError::Index(format!("failed to add document: {e}")))?;
        }

        writer
            .commit()
            .map_err(|e| SearchError::Index(format!("commit failed: {e}")))?;

        self.reader
            .reload()
            .map_err(|e| SearchError::Index(format!("reader reload failed: {e}")))?;

        Ok(())
    }

    /// Remove a page from the index by its ID.
    pub fn remove_page(&self, page_id: &str) -> Result<(), SearchError> {
        let mut writer = self.writer()?;
        let term = tantivy::Term::from_field_text(self.fields.page_id, page_id);
        writer.delete_term(term);
        writer
            .commit()
            .map_err(|e| SearchError::Index(format!("commit failed: {e}")))?;
        self.reader
            .reload()
            .map_err(|e| SearchError::Index(format!("reader reload failed: {e}")))?;
        Ok(())
    }

    /// Search the index with field boosts: title 3x, tags 2x, secret_labels 2x, content 1x.
    pub fn search(
        &self,
        query_str: &str,
        scope: &SearchScope,
        limit: usize,
    ) -> Result<Vec<SearchResult>, SearchError> {
        if query_str.trim().is_empty() {
            return Ok(vec![]);
        }

        let searcher = self.reader.searcher();

        let search_fields_with_boosts = vec![
            (self.fields.title, 3.0),
            (self.fields.tags, 2.0),
            (self.fields.secret_labels, 2.0),
            (self.fields.content, 1.0),
        ];
        let search_fields: Vec<Field> = search_fields_with_boosts.iter().map(|&(f, _)| f).collect();

        // Build query parser with field boosts
        let mut query_parser = QueryParser::for_index(&self.index, search_fields.clone());
        for &(field, boost) in &search_fields_with_boosts {
            query_parser.set_field_boost(field, boost);
        }
        query_parser.set_conjunction_by_default();

        // Build the query with prefix expansion for search-as-you-type.
        // PhrasePrefixQuery is constructed programmatically because tantivy's
        // QueryParser rejects single-term "word"* syntax.
        let query: Box<dyn tantivy::query::Query> =
            if let Some((earlier, last_word)) = split_for_prefix(query_str) {
                let prefix_q = build_prefix_query_for_word(last_word, &search_fields_with_boosts);

                // If there are earlier words, parse them normally and AND with prefix
                let base_q: Box<dyn tantivy::query::Query> = if let Some(earlier) = earlier {
                    let parsed = query_parser
                        .parse_query(earlier)
                        .map_err(|e| SearchError::QueryParse(e.to_string()))?;
                    Box::new(BooleanQuery::new(vec![
                        (Occur::Must, parsed),
                        (Occur::Must, prefix_q),
                    ]))
                } else {
                    prefix_q
                };

                // Apply scope filter (folder scope uses post-filtering for prefix matching)
                match scope {
                    SearchScope::All | SearchScope::Folder(_) => base_q,
                    SearchScope::SecretsOnly => {
                        let scope_q = query_parser
                            .parse_query("has_secrets:true")
                            .map_err(|e| SearchError::QueryParse(e.to_string()))?;
                        Box::new(BooleanQuery::new(vec![
                            (Occur::Must, base_q),
                            (Occur::Must, scope_q),
                        ]))
                    }
                }
            } else {
                // No prefix expansion — quoted phrases, field queries, etc.
                // Folder scope uses post-filtering for prefix matching.
                let effective_query = match scope {
                    SearchScope::All | SearchScope::Folder(_) => query_str.to_string(),
                    SearchScope::SecretsOnly => {
                        format!("({query_str}) AND has_secrets:true")
                    }
                };

                query_parser
                    .parse_query(&effective_query)
                    .map_err(|e| SearchError::QueryParse(e.to_string()))?
            };

        // For folder scope, fetch more results to account for post-filtering
        let fetch_limit = match scope {
            SearchScope::Folder(_) => limit * 5,
            _ => limit,
        };

        let top_docs = searcher
            .search(&query, &TopDocs::with_limit(fetch_limit))
            .map_err(|e| SearchError::Index(format!("search failed: {e}")))?;

        let mut results = Vec::with_capacity(top_docs.len());
        for (score, doc_address) in top_docs {
            let doc: TantivyDocument = searcher
                .doc(doc_address)
                .map_err(|e| SearchError::Index(format!("failed to retrieve doc: {e}")))?;

            let page_id = get_text_field(&doc, self.fields.page_id);
            let title = get_text_field(&doc, self.fields.title);
            let content = get_text_field(&doc, self.fields.content);
            let folder = get_text_field(&doc, self.fields.folder);
            let path = get_text_field(&doc, self.fields.path);

            // Folder scope: prefix match — searching "credentials" includes "credentials/work/..."
            if let SearchScope::Folder(ref scope_folder) = scope {
                if folder != *scope_folder && !folder.starts_with(&format!("{scope_folder}/")) {
                    continue;
                }
            }

            // Create a simple snippet from content — catch_unwind as safety net
            // so a bad string slice never crashes the app
            let snippet =
                std::panic::catch_unwind(|| make_search_snippet(&content, query_str, 200))
                    .unwrap_or_else(|_| {
                        log::error!(
                    "make_search_snippet panicked for page '{title}' — returning empty snippet"
                );
                        String::new()
                    });

            results.push(SearchResult {
                page_id,
                title,
                snippet,
                folder,
                path,
                score,
            });

            if results.len() >= limit {
                break;
            }
        }

        Ok(results)
    }

    /// Rebuild the entire index from a set of page documents.
    pub fn rebuild(&self, pages: &[PageDocument]) -> Result<(), SearchError> {
        let mut writer = self.writer()?;
        writer
            .delete_all_documents()
            .map_err(|e| SearchError::Index(format!("failed to clear index: {e}")))?;

        for page in pages {
            writer
                .add_document(doc!(
                    self.fields.page_id => page.page_id.clone(),
                    self.fields.title => page.title.clone(),
                    self.fields.content => page.content.clone(),
                    self.fields.tags => page.tags.clone(),
                    self.fields.secret_labels => page.secret_labels.clone(),
                    self.fields.folder => page.folder.clone(),
                    self.fields.path => page.path.clone(),
                    self.fields.has_secrets => if page.has_secrets { "true" } else { "false" },
                ))
                .map_err(|e| SearchError::Index(format!("failed to add document: {e}")))?;
        }

        writer
            .commit()
            .map_err(|e| SearchError::Index(format!("commit failed: {e}")))?;

        self.reader
            .reload()
            .map_err(|e| SearchError::Index(format!("reader reload failed: {e}")))?;

        Ok(())
    }

    /// Get an index writer with 50MB heap.
    fn writer(&self) -> Result<IndexWriter, SearchError> {
        self.index
            .writer(50_000_000)
            .map_err(|e| SearchError::Index(format!("failed to create writer: {e}")))
    }
}

/// A page document ready for indexing (no encrypted content).
#[derive(Debug, Clone)]
pub struct PageDocument {
    /// Stable page identifier; used as the delete key for upserts.
    pub page_id: String,
    /// Page title (boosted 3x at query time).
    pub title: String,
    /// Plaintext content with secret block values stripped.
    pub content: String,
    /// Space-separated tags (boosted 2x at query time).
    pub tags: String,
    /// Space-separated secret block labels (boosted 2x; secret values are never indexed).
    pub secret_labels: String,
    /// Folder path the page lives in (stored/filter-only).
    pub folder: String,
    /// Vault-relative path to the page's `.md` file (stored/filter-only).
    pub path: String,
    /// Whether the page contains any secret block; backs the `SecretsOnly` scope filter.
    pub has_secrets: bool,
}

/// Build the tantivy schema for the search index.
fn build_schema() -> Schema {
    let mut schema_builder = Schema::builder();

    // `TEXT` fields are tokenized and full-text searchable; `STRING` fields are stored
    // verbatim (exact-match / filter only). All fields are `STORED` so results can be
    // reconstructed without re-reading the source `.md` file.
    schema_builder.add_text_field("page_id", STRING | STORED);
    schema_builder.add_text_field("title", TEXT | STORED);
    schema_builder.add_text_field("content", TEXT | STORED);
    schema_builder.add_text_field("tags", TEXT | STORED);
    schema_builder.add_text_field("secret_labels", TEXT | STORED);
    schema_builder.add_text_field("folder", STRING | STORED);
    schema_builder.add_text_field("path", STRING | STORED);
    schema_builder.add_text_field("has_secrets", STRING | STORED);

    schema_builder.build()
}

/// Extract text from a tantivy document field.
fn get_text_field(doc: &TantivyDocument, field: Field) -> String {
    doc.get_first(field)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Check whether a query should use prefix expansion (search-as-you-type).
///
/// Returns `Some((earlier_words, last_word))` when the last token should be
/// treated as a prefix, or `None` if the query should be passed through as-is.
fn split_for_prefix(query: &str) -> Option<(Option<&str>, &str)> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Don't modify quoted phrases or already-wildcarded queries
    if (trimmed.starts_with('"') && trimmed.ends_with('"')) || trimmed.ends_with('*') {
        return None;
    }

    let (prefix, last_token) = match trimmed.rsplit_once(char::is_whitespace) {
        Some((pre, last)) => (Some(pre), last),
        None => (None, trimmed),
    };

    // Don't modify if last token is: field query or single char (too broad)
    if last_token.contains(':') || last_token.len() <= 1 {
        return None;
    }

    Some((prefix, last_token))
}

/// Build a PhrasePrefixQuery for a single word across multiple fields.
///
/// Splits the word on non-alphanumeric characters (matching tantivy's default
/// TEXT tokenizer) so that queries like "google.com" produce a multi-term
/// PhrasePrefixQuery ["google", "com"] instead of a single unmatched term.
fn build_prefix_query_for_word(
    word: &str,
    fields_with_boosts: &[(Field, f32)],
) -> Box<dyn tantivy::query::Query> {
    let tokens: Vec<String> = word
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect();

    if tokens.is_empty() {
        return Box::new(BooleanQuery::new(vec![]));
    }

    let clauses: Vec<_> = fields_with_boosts
        .iter()
        .map(|&(field, boost)| {
            let terms: Vec<Term> = tokens
                .iter()
                .map(|t| Term::from_field_text(field, t))
                .collect();
            let ppq = PhrasePrefixQuery::new(terms);
            let boosted = BoostQuery::new(Box::new(ppq), boost);
            (
                Occur::Should,
                Box::new(boosted) as Box<dyn tantivy::query::Query>,
            )
        })
        .collect();
    Box::new(BooleanQuery::new(clauses))
}

/// Snap a byte index to the nearest valid UTF-8 char boundary (backward).
fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let idx = idx.min(s.len());
    let mut i = idx;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Snap a byte index to the nearest valid UTF-8 char boundary (forward).
fn ceil_char_boundary(s: &str, idx: usize) -> usize {
    let idx = idx.min(s.len());
    let mut i = idx;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Create a search snippet from content, centering around the first occurrence of a query term.
fn make_search_snippet(content: &str, query: &str, max_len: usize) -> String {
    if content.is_empty() {
        return String::new();
    }

    let content_lower = content.to_lowercase();
    let query_lower = query.to_lowercase();

    // Find first query term occurrence (strip trailing * from prefix queries)
    let first_term = query_lower
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches('*');

    // Map position from lowercased string back to original using char indices
    let pos = if first_term.is_empty() {
        0
    } else if let Some(lower_pos) = content_lower.find(first_term) {
        // Convert char offset in lowercased string to byte offset in original
        let char_offset = content_lower[..lower_pos].chars().count();
        content
            .char_indices()
            .nth(char_offset)
            .map(|(i, _)| i)
            .unwrap_or(0)
    } else {
        0
    };

    // Window around the match — snap to valid char boundaries
    let start = floor_char_boundary(content, pos.saturating_sub(max_len / 4));
    let end = ceil_char_boundary(content, (start + max_len).min(content.len()));

    // Align to word boundaries (whitespace)
    let start = content[..start]
        .rfind(char::is_whitespace)
        .map(|p| ceil_char_boundary(content, p + 1))
        .unwrap_or(start);
    let end = content[end..]
        .find(char::is_whitespace)
        .map(|p| end + p)
        .unwrap_or(end);

    let mut snippet = String::new();
    if start > 0 {
        snippet.push_str("...");
    }
    snippet.push_str(content[start..end].trim());
    if end < content.len() {
        snippet.push_str("...");
    }

    snippet
}

/// Strip secret block values from content, keeping only non-secret text.
/// Secret labels are extracted separately via extract_secret_labels.
pub fn strip_secret_values(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut in_secret = false;

    for line in content.lines() {
        if line.trim().starts_with(":::secret[") {
            in_secret = true;
            // Don't include the fence line in indexed content
            continue;
        }
        if in_secret {
            if line.trim() == ":::" {
                in_secret = false;
            }
            // Skip secret block content entirely
            continue;
        }
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(line);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_test_engine() -> (tempfile::TempDir, SearchEngine) {
        let dir = tempdir().unwrap();
        let index_dir = dir.path().join("index");
        let engine = SearchEngine::open(&index_dir).unwrap();
        (dir, engine)
    }

    fn sample_page(id: &str, title: &str, content: &str) -> PageDocument {
        PageDocument {
            page_id: id.to_string(),
            title: title.to_string(),
            content: content.to_string(),
            tags: String::new(),
            secret_labels: String::new(),
            folder: "general".to_string(),
            path: format!("general/{id}.md"),
            has_secrets: false,
        }
    }

    #[test]
    fn create_and_search_index() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&sample_page(
                "1",
                "Meeting Notes",
                "Discussed project timeline",
            ))
            .unwrap();
        engine
            .index_page(&sample_page("2", "Shopping List", "Milk, eggs, bread"))
            .unwrap();

        let results = engine.search("meeting", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_id, "1");
        assert_eq!(results[0].title, "Meeting Notes");
    }

    #[test]
    fn title_boost_ranks_higher() {
        let (_dir, engine) = create_test_engine();

        // Page with "meeting" in content
        engine
            .index_page(&sample_page(
                "1",
                "Random Page",
                "We had a meeting yesterday",
            ))
            .unwrap();
        // Page with "meeting" in title
        engine
            .index_page(&sample_page("2", "Meeting Notes", "Some other content"))
            .unwrap();

        let results = engine.search("meeting", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 2);
        // Title match (3x boost) should rank higher
        assert_eq!(results[0].page_id, "2");
    }

    #[test]
    fn tag_boost() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&PageDocument {
                page_id: "1".to_string(),
                title: "Some Page".to_string(),
                content: "Lorem ipsum dolor sit amet".to_string(),
                tags: "urgent important".to_string(),
                secret_labels: String::new(),
                folder: "general".to_string(),
                path: "general/1.md".to_string(),
                has_secrets: false,
            })
            .unwrap();

        let results = engine.search("urgent", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_id, "1");
    }

    #[test]
    fn secret_labels_searchable() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&PageDocument {
                page_id: "1".to_string(),
                title: "Credentials".to_string(),
                content: "My credentials page".to_string(),
                tags: String::new(),
                secret_labels: "AWS Access Key Database Password".to_string(),
                folder: "credentials".to_string(),
                path: "credentials/1.md".to_string(),
                has_secrets: true,
            })
            .unwrap();

        let results = engine.search("AWS", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn scope_folder_filter() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&PageDocument {
                page_id: "1".to_string(),
                title: "Note A".to_string(),
                content: "important stuff".to_string(),
                tags: String::new(),
                secret_labels: String::new(),
                folder: "general".to_string(),
                path: "general/1.md".to_string(),
                has_secrets: false,
            })
            .unwrap();
        engine
            .index_page(&PageDocument {
                page_id: "2".to_string(),
                title: "Note B".to_string(),
                content: "important stuff too".to_string(),
                tags: String::new(),
                secret_labels: String::new(),
                folder: "credentials".to_string(),
                path: "credentials/2.md".to_string(),
                has_secrets: false,
            })
            .unwrap();

        let results = engine
            .search("important", &SearchScope::Folder("general".to_string()), 10)
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].folder, "general");
    }

    #[test]
    fn scope_secrets_only() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&PageDocument {
                page_id: "1".to_string(),
                title: "Regular".to_string(),
                content: "some content".to_string(),
                tags: String::new(),
                secret_labels: String::new(),
                folder: "general".to_string(),
                path: "general/1.md".to_string(),
                has_secrets: false,
            })
            .unwrap();
        engine
            .index_page(&PageDocument {
                page_id: "2".to_string(),
                title: "Secrets Page".to_string(),
                content: "some content".to_string(),
                tags: String::new(),
                secret_labels: "API Key".to_string(),
                folder: "general".to_string(),
                path: "general/2.md".to_string(),
                has_secrets: true,
            })
            .unwrap();

        let results = engine
            .search("content", &SearchScope::SecretsOnly, 10)
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_id, "2");
    }

    #[test]
    fn update_existing_page() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&sample_page("1", "Original Title", "original content"))
            .unwrap();

        // Update the same page
        engine
            .index_page(&sample_page("1", "Updated Title", "updated content"))
            .unwrap();

        // Should only find one result (not duplicate)
        let results = engine.search("original", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 0); // Old content gone

        let results = engine.search("updated", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Updated Title");
    }

    #[test]
    fn remove_page_from_index() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&sample_page("1", "Test Page", "test content"))
            .unwrap();
        engine.remove_page("1").unwrap();

        let results = engine.search("test", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn rebuild_index() {
        let (_dir, engine) = create_test_engine();

        // Index some pages
        engine
            .index_page(&sample_page("1", "Old Page", "old content"))
            .unwrap();

        // Rebuild with different pages
        let pages = vec![
            sample_page("2", "New Page A", "alpha content"),
            sample_page("3", "New Page B", "beta content"),
        ];
        engine.rebuild(&pages).unwrap();

        // Old page should be gone
        let results = engine.search("old", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 0);

        // New pages should be there
        let results = engine.search("alpha", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_id, "2");
    }

    #[test]
    fn empty_query_returns_empty() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&sample_page("1", "Test", "content"))
            .unwrap();

        let results = engine.search("", &SearchScope::All, 10).unwrap();
        assert!(results.is_empty());

        let results = engine.search("   ", &SearchScope::All, 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn strip_secret_values_works() {
        let content = "Some text\n:::secret[Password]\nmy-secret\n:::\nMore text";
        let stripped = strip_secret_values(content);
        assert!(stripped.contains("Some text"));
        assert!(stripped.contains("More text"));
        assert!(!stripped.contains("my-secret"));
        assert!(!stripped.contains(":::secret"));
    }

    #[test]
    fn prefix_search_matches_partial() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&sample_page(
                "1",
                "Cryptography Notes",
                "AES and RSA algorithms",
            ))
            .unwrap();
        engine
            .index_page(&sample_page("2", "Shopping List", "Milk and bread"))
            .unwrap();

        // "Crypt" should match "Cryptography"
        let results = engine.search("Crypt", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].page_id, "1");
    }

    #[test]
    fn prefix_search_multiword() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&sample_page(
                "1",
                "Meeting Notes",
                "Discussed project timeline",
            ))
            .unwrap();
        engine
            .index_page(&sample_page("2", "Random Page", "Some notes about meeting"))
            .unwrap();
        engine
            .index_page(&sample_page("3", "Shopping List", "Buy milk and bread"))
            .unwrap();

        // "meeting note" uses AND logic — both words must appear
        let results = engine
            .search("meeting note", &SearchScope::All, 10)
            .unwrap();
        assert_eq!(results.len(), 2); // pages 1 and 2 both have "meeting" + "note*"
                                      // Page 3 should NOT match (no "meeting")
        assert!(results.iter().all(|r| r.page_id != "3"));
    }

    #[test]
    fn split_for_prefix_cases() {
        // Single word → returns (None, word) for prefix expansion
        assert_eq!(split_for_prefix("Crypt"), Some((None, "Crypt")));
        // Multi-word → returns (earlier, last_word)
        assert_eq!(
            split_for_prefix("hello world"),
            Some((Some("hello"), "world"))
        );
        // Quoted phrase → None (no prefix expansion)
        assert_eq!(split_for_prefix("\"exact phrase\""), None);
        // Already wildcarded → None
        assert_eq!(split_for_prefix("test*"), None);
        // Single char → None (too broad)
        assert_eq!(split_for_prefix("a"), None);
        // Field query → None
        assert_eq!(split_for_prefix("folder:general"), None);
        // Empty → None
        assert_eq!(split_for_prefix(""), None);
        // Whitespace → None
        assert_eq!(split_for_prefix("   "), None);
    }

    #[test]
    fn phrase_search() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&sample_page(
                "1",
                "Meeting Notes",
                "The quick brown fox jumped over the lazy dog",
            ))
            .unwrap();

        let results = engine
            .search("\"quick brown fox\"", &SearchScope::All, 10)
            .unwrap();
        assert_eq!(results.len(), 1);

        let results = engine
            .search("\"brown quick fox\"", &SearchScope::All, 10)
            .unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn scope_folder_includes_nested() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&PageDocument {
                page_id: "1".to_string(),
                title: "Root Cred".to_string(),
                content: "important data".to_string(),
                tags: String::new(),
                secret_labels: String::new(),
                folder: "credentials".to_string(),
                path: "credentials/1.md".to_string(),
                has_secrets: false,
            })
            .unwrap();
        engine
            .index_page(&PageDocument {
                page_id: "2".to_string(),
                title: "Nested Cred".to_string(),
                content: "important data".to_string(),
                tags: String::new(),
                secret_labels: String::new(),
                folder: "credentials/work".to_string(),
                path: "credentials/work/2.md".to_string(),
                has_secrets: false,
            })
            .unwrap();
        engine
            .index_page(&PageDocument {
                page_id: "3".to_string(),
                title: "Other".to_string(),
                content: "important data".to_string(),
                tags: String::new(),
                secret_labels: String::new(),
                folder: "general".to_string(),
                path: "general/3.md".to_string(),
                has_secrets: false,
            })
            .unwrap();

        // Searching in "credentials" should include "credentials/work" pages
        let results = engine
            .search(
                "important",
                &SearchScope::Folder("credentials".to_string()),
                10,
            )
            .unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.page_id == "1"));
        assert!(results.iter().any(|r| r.page_id == "2"));
    }

    #[test]
    fn dotted_query_matches() {
        let (_dir, engine) = create_test_engine();

        engine
            .index_page(&sample_page(
                "1",
                "accounts.google.com - cvs@indivar",
                "Login credentials for google.com account",
            ))
            .unwrap();

        // "google" alone should match
        let results = engine.search("google", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 1);

        // "google.com" should also match (dot-separated tokens)
        let results = engine.search("google.com", &SearchScope::All, 10).unwrap();
        assert_eq!(results.len(), 1);

        // "accounts.google" should match
        let results = engine
            .search("accounts.google", &SearchScope::All, 10)
            .unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn snippet_with_emoji_does_not_panic() {
        // Regression: multi-byte UTF-8 chars caused panic at string slice boundaries
        let content = "Hello 😀 world 🌍 this is a test with emoji 🎉 and more text after";
        let snippet = make_search_snippet(content, "world", 30);
        assert!(snippet.contains("world"));
    }

    #[test]
    fn snippet_with_cjk_does_not_panic() {
        let content = "这是一个测试 hello world 你好世界 more text here for padding";
        let snippet = make_search_snippet(content, "hello", 20);
        assert!(snippet.contains("hello"));
    }

    #[test]
    fn snippet_with_accented_chars_does_not_panic() {
        let content = "café résumé naïve über straße coöperate hello world test";
        let snippet = make_search_snippet(content, "hello", 25);
        assert!(snippet.contains("hello"));
    }

    #[test]
    fn snippet_empty_content() {
        let snippet = make_search_snippet("", "test", 100);
        assert_eq!(snippet, "");
    }

    #[test]
    fn snippet_no_match_returns_beginning() {
        let content = "some text that does not contain the query";
        let snippet = make_search_snippet(content, "zzz", 20);
        assert!(!snippet.is_empty());
    }
}
