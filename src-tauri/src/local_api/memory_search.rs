// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Search across memory namespaces.
//!
//! `memory_read` needs an exact title, and `search` ranks memory pages
//! against every other page in the vault. An agent starting a new project
//! has had no cheap way to ask "what do I already know about auth
//! middleware?". This is that: full text over the memory tree only, limited
//! to the namespaces the client may use, each hit carrying what a reader
//! needs to weigh it (kind, stale, verified, read statistics).
//!
//! Ranking is the tantivy score. When a local Ollama answers, the top hits
//! are re-ordered by embedding similarity to the query, which catches
//! meaning that keyword scoring misses ("login" for "authentication").
//! Nothing leaves the machine: Ollama is `127.0.0.1` by default, and the
//! response says which ranking was used so nobody mistakes one for the
//! other. No Ollama, or any error from it, and the full-text order stands.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::pages::agent_memory;
use crate::search::engine::{SearchEngine, SearchScope};

const MEMORY_ROOT: &str = "ai/memory";
/// Hits fetched before the namespace filter is applied; the engine already
/// over-fetches for folder scope, this keeps a narrow namespace list from
/// returning nothing when other namespaces dominate the top of the ranking.
const OVERFETCH: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryHit {
    pub page_id: String,
    pub title: String,
    pub namespace: String,
    pub path: String,
    pub snippet: String,
    pub score: f32,
    pub kind: Option<String>,
    pub stale: bool,
    pub verified_on: Option<chrono::DateTime<chrono::Utc>>,
    pub written_by_name: Option<String>,
    pub reviewed: bool,
    pub read_count: u64,
    pub last_read: Option<chrono::DateTime<chrono::Utc>>,
}

/// The namespaces a client may search: what it asked for, cut down to what
/// it is allowed. An empty allowance means everything; an empty request
/// means "whatever I am allowed".
pub fn effective_namespaces(requested: &[String], allowed: &[String]) -> Vec<String> {
    let requested: Vec<String> = requested
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    match (requested.is_empty(), allowed.is_empty()) {
        (true, _) => allowed.to_vec(),
        (false, true) => requested,
        (false, false) => requested
            .into_iter()
            .filter(|r| allowed.contains(r))
            .collect(),
    }
}

/// Namespace of a memory page from its folder (`ai/memory/<ns>`).
fn namespace_of(folder: &str) -> Option<&str> {
    folder
        .strip_prefix(MEMORY_ROOT)
        .and_then(|rest| rest.strip_prefix('/'))
        .map(|rest| rest.split('/').next().unwrap_or(rest))
        .filter(|ns| !ns.is_empty())
}

/// Full-text hits over the memory tree, in engine order.
///
/// `namespaces` empty means every namespace. Each hit's descriptive fields
/// come from the page on disk, so a stale or superseded memory is marked as
/// such in the result rather than presented as current.
pub fn fulltext(
    engine: &SearchEngine,
    vault_dir: &Path,
    query: &str,
    namespaces: &[String],
    limit: usize,
) -> Result<Vec<MemoryHit>, String> {
    let results = engine
        .search(
            query,
            &SearchScope::Folder(MEMORY_ROOT.to_string()),
            limit.max(1) * OVERFETCH,
        )
        .map_err(|e| e.to_string())?;
    let stats = crate::internal::memory_reads::all(vault_dir);
    let mut hits = Vec::new();
    for r in results {
        let Some(ns) = namespace_of(&r.folder) else {
            continue;
        };
        if !namespaces.is_empty() && !namespaces.iter().any(|n| n == ns) {
            continue;
        }
        let meta = crate::pages::crud::read_page(vault_dir, &r.path)
            .ok()
            .map(|p| p.meta);
        let reads = stats.get(&r.page_id).copied();
        hits.push(MemoryHit {
            page_id: r.page_id,
            title: r.title,
            namespace: ns.to_string(),
            path: r.path,
            snippet: r.snippet,
            score: r.score,
            kind: meta.as_ref().and_then(|m| m.memory_kind.clone()),
            stale: meta.as_ref().is_some_and(agent_memory::is_stale),
            verified_on: meta.as_ref().and_then(|m| m.verified_on),
            written_by_name: meta.as_ref().and_then(|m| m.written_by_name.clone()),
            reviewed: !meta.as_ref().is_some_and(agent_memory::needs_review),
            read_count: reads.map(|s| s.read_count).unwrap_or(0),
            last_read: reads.map(|s| s.last_read),
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

/// Indices of `candidates`, most similar to `query` first. Pure, so the
/// ordering is testable without a model.
pub fn order_by_similarity(query: &[f32], candidates: &[Vec<f32>]) -> Vec<usize> {
    let mut scored: Vec<(usize, f32)> = candidates
        .iter()
        .enumerate()
        .map(|(i, v)| (i, cosine(query, v)))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().map(|(i, _)| i).collect()
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

/// Whether an Ollama server answers at `base_url`. Half a second: a local
/// server answers in milliseconds and a missing one refuses at once.
pub async fn ollama_available(base_url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(format!("{}/api/tags", base_url.trim_end_matches('/')))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Re-order `hits` by embedding similarity to `query` using Ollama's
/// `/api/embed`. Any failure returns the error and the caller keeps the
/// full-text order; a re-rank must never make a search fail.
pub async fn rerank_with_ollama(
    base_url: &str,
    model: &str,
    query: &str,
    hits: Vec<MemoryHit>,
) -> Result<Vec<MemoryHit>, String> {
    if hits.is_empty() {
        return Ok(hits);
    }
    let mut input = Vec::with_capacity(hits.len() + 1);
    input.push(query.to_string());
    for h in &hits {
        input.push(format!("{}\n{}", h.title, h.snippet));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(format!("{}/api/embed", base_url.trim_end_matches('/')))
        .json(&EmbedRequest { model, input })
        .send()
        .await
        .map_err(|e| format!("embed request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("embed request returned {}", response.status()));
    }
    let body: EmbedResponse = response
        .json()
        .await
        .map_err(|e| format!("embed response unreadable: {e}"))?;
    if body.embeddings.len() != hits.len() + 1 {
        return Err(format!(
            "embed response had {} vectors for {} inputs",
            body.embeddings.len(),
            hits.len() + 1
        ));
    }
    let (query_vec, candidate_vecs) = body.embeddings.split_at(1);
    let order = order_by_similarity(&query_vec[0], candidate_vecs);
    let mut slots: Vec<Option<MemoryHit>> = hits.into_iter().map(Some).collect();
    Ok(order
        .into_iter()
        .filter_map(|i| slots.get_mut(i).and_then(Option::take))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::agent_memory::{upsert_memory, MemoryWrite};

    #[test]
    fn effective_namespaces_intersects_request_with_allowance() {
        let none: Vec<String> = vec![];
        let claspt = vec!["claspt".to_string(), "global".to_string()];
        assert_eq!(
            effective_namespaces(&none, &none),
            none,
            "unrestricted, unspecified: all"
        );
        assert_eq!(
            effective_namespaces(&none, &claspt),
            claspt,
            "restricted, unspecified: allowance"
        );
        assert_eq!(
            effective_namespaces(&["other".into(), " claspt ".into()], &claspt),
            vec!["claspt".to_string()],
            "restricted: only what is allowed"
        );
        assert_eq!(
            effective_namespaces(&["a".into(), "".into()], &none),
            vec!["a".to_string()],
            "unrestricted: what was asked, blanks dropped"
        );
    }

    #[test]
    fn namespace_comes_from_the_memory_folder() {
        assert_eq!(namespace_of("ai/memory/claspt"), Some("claspt"));
        assert_eq!(namespace_of("ai/memory/claspt/_media"), Some("claspt"));
        assert_eq!(namespace_of("ai/memory"), None);
        assert_eq!(namespace_of("general"), None);
        assert_eq!(namespace_of("ai/secrets"), None);
    }

    #[test]
    fn similarity_orders_by_cosine_and_ignores_magnitude() {
        let query = vec![1.0, 0.0];
        let candidates = vec![
            vec![0.0, 1.0],
            vec![10.0, 1.0],
            vec![0.5, 0.0],
            vec![0.0, 0.0],
        ];
        // Index 2 is exactly the query's direction; 1 is close; 0 orthogonal; 3 zero.
        assert_eq!(order_by_similarity(&query, &candidates), vec![2, 1, 0, 3]);
    }

    #[test]
    fn fulltext_returns_only_memory_pages_in_allowed_namespaces_with_their_state() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let key = [7u8; 32];
        let engine = SearchEngine::open(&vault.join(".securenotes").join("index")).unwrap();
        // Two namespaces, plus an ordinary page that mentions the same word.
        let a = upsert_memory(
            vault,
            "alpha",
            &MemoryWrite::new("Auth middleware", "jwt validation notes"),
            &key,
            None,
        )
        .unwrap();
        let b = upsert_memory(
            vault,
            "beta",
            &MemoryWrite::new("Auth flow", "oauth and jwt"),
            &key,
            None,
        )
        .unwrap();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        let plain = crate::pages::crud::create_page(
            vault,
            "JWT cheat sheet",
            "general",
            "jwt everywhere",
            false,
        )
        .unwrap();
        for p in [&a, &b, &plain] {
            engine
                .index_page(&crate::commands::search::page_to_document(p))
                .unwrap();
        }
        // Mark beta's page superseded so it comes back stale.
        upsert_memory(
            vault,
            "beta",
            &MemoryWrite {
                superseded_by: Some("Auth flow v2"),
                ..MemoryWrite::new("Auth flow", "oauth and jwt")
            },
            &key,
            None,
        )
        .unwrap();

        let all = fulltext(&engine, vault, "jwt", &[], 10).unwrap();
        let titles: Vec<&str> = all.iter().map(|h| h.title.as_str()).collect();
        assert!(titles.contains(&"Auth middleware") && titles.contains(&"Auth flow"));
        assert!(
            !titles.contains(&"JWT cheat sheet"),
            "ordinary pages are not memory"
        );
        let beta_hit = all.iter().find(|h| h.namespace == "beta").unwrap();
        assert!(beta_hit.stale);
        let alpha_hit = all.iter().find(|h| h.namespace == "alpha").unwrap();
        assert!(!alpha_hit.stale);

        let only_alpha = fulltext(&engine, vault, "jwt", &["alpha".to_string()], 10).unwrap();
        assert_eq!(only_alpha.len(), 1);
        assert_eq!(only_alpha[0].namespace, "alpha");

        assert!(fulltext(&engine, vault, "", &[], 10).unwrap().is_empty());
    }

    #[tokio::test]
    async fn without_ollama_the_rerank_fails_softly_and_availability_is_false() {
        // Nothing listens on this port; the caller keeps full-text order.
        let base = "http://127.0.0.1:1";
        assert!(!ollama_available(base).await);
        let hit = MemoryHit {
            page_id: "p".into(),
            title: "t".into(),
            namespace: "n".into(),
            path: "ai/memory/n/t.md".into(),
            snippet: "s".into(),
            score: 1.0,
            kind: None,
            stale: false,
            verified_on: None,
            written_by_name: None,
            reviewed: true,
            read_count: 0,
            last_read: None,
        };
        assert!(rerank_with_ollama(base, "nomic-embed-text", "q", vec![hit])
            .await
            .is_err());
        assert!(rerank_with_ollama(base, "nomic-embed-text", "q", vec![])
            .await
            .unwrap()
            .is_empty());
    }
}
