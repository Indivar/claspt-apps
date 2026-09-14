// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! One-shot "log me in" jobs handed from the desktop to the browser extension.
//!
//! An agent asks for a login by page; the owner approves that request in the
//! app like any secret read; the desktop decrypts the credential and queues it
//! here; the extension long-polls, fills the form, and reports back. The agent
//! only ever learns whether it worked. A queued credential is held in memory
//! until the extension takes it or [`QUEUE_TTL`] passes, whichever is first,
//! and is dropped the moment it is taken: this is delivery in flight, not a
//! cache, and nothing here reaches disk.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// How long a job waits for the extension before it is failed.
pub const QUEUE_TTL: Duration = Duration::from_secs(60);
/// How long a finished job's outcome stays readable.
const DONE_TTL: Duration = Duration::from_secs(600);
/// How recently the extension must have polled to count as connected.
const PRESENCE_WINDOW: Duration = Duration::from_secs(90);

/// The credential in the shape the extension's content script fills.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCredential {
    pub page_path: String,
    pub page_title: String,
    pub label: String,
    pub fields: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginJob {
    pub id: String,
    /// Where to log in. Absent means the browser's active tab.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub submit: bool,
    pub requested_by: String,
    pub credential: JobCredential,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Taken,
    Done,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobStatus {
    pub id: String,
    pub state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

struct Entry {
    status: JobStatus,
    created: Instant,
    /// Present only while queued; dropped when taken or expired.
    job: Option<LoginJob>,
}

struct Inner {
    entries: Vec<Entry>,
    last_poll: Option<Instant>,
}

pub struct BrowserJobs {
    inner: Mutex<Inner>,
    notify: Notify,
}

impl Default for BrowserJobs {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserJobs {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: Vec::new(),
                last_poll: None,
            }),
            notify: Notify::new(),
        }
    }

    /// Queue a job and wake a waiting poller. Returns the job id.
    pub fn enqueue(&self, mut job: LoginJob) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        job.id = id.clone();
        let mut inner = self.lock();
        Self::sweep_inner(&mut inner, Instant::now());
        inner.entries.push(Entry {
            status: JobStatus {
                id: id.clone(),
                state: JobState::Queued,
                ok: None,
                message: None,
            },
            created: Instant::now(),
            job: Some(job),
        });
        drop(inner);
        self.notify.notify_one();
        id
    }

    /// The oldest queued job, waiting up to `wait` for one to arrive. Records
    /// the poll so the desktop knows an extension is listening.
    pub async fn take(&self, wait: Duration) -> Option<LoginJob> {
        let deadline = Instant::now() + wait;
        loop {
            {
                let mut inner = self.lock();
                inner.last_poll = Some(Instant::now());
                Self::sweep_inner(&mut inner, Instant::now());
                if let Some(entry) = inner
                    .entries
                    .iter_mut()
                    .find(|e| e.status.state == JobState::Queued)
                {
                    entry.status.state = JobState::Taken;
                    return entry.job.take();
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            if tokio::time::timeout(deadline - now, self.notify.notified())
                .await
                .is_err()
            {
                return None;
            }
        }
    }

    /// The extension's report on a taken job. False when the id is unknown or
    /// the job was never taken, so a stray report cannot mark a queued job done.
    pub fn complete(&self, id: &str, ok: bool, message: &str) -> bool {
        let mut inner = self.lock();
        match inner
            .entries
            .iter_mut()
            .find(|e| e.status.id == id && e.status.state == JobState::Taken)
        {
            Some(entry) => {
                entry.status.state = JobState::Done;
                entry.status.ok = Some(ok);
                entry.status.message = Some(message.to_string());
                entry.created = Instant::now();
                true
            }
            None => false,
        }
    }

    pub fn status(&self, id: &str) -> Option<JobStatus> {
        let mut inner = self.lock();
        Self::sweep_inner(&mut inner, Instant::now());
        inner
            .entries
            .iter()
            .find(|e| e.status.id == id)
            .map(|e| e.status.clone())
    }

    /// Whether an extension has polled recently enough to pick a job up.
    pub fn extension_listening(&self) -> bool {
        self.lock()
            .last_poll
            .is_some_and(|t| t.elapsed() < PRESENCE_WINDOW)
    }

    /// Fail queued jobs older than [`QUEUE_TTL`], dropping their credential,
    /// and forget finished ones older than the retention window. Every
    /// operation sweeps with the real clock; tests drive it with a chosen one.
    #[cfg(test)]
    pub fn sweep(&self, now: Instant) {
        Self::sweep_inner(&mut self.lock(), now);
    }

    fn sweep_inner(inner: &mut Inner, now: Instant) {
        for entry in inner.entries.iter_mut() {
            if entry.status.state == JobState::Queued
                && now.duration_since(entry.created) >= QUEUE_TTL
            {
                entry.job = None;
                entry.status.state = JobState::Done;
                entry.status.ok = Some(false);
                entry.status.message =
                    Some("no browser extension picked the job up in time".to_string());
                entry.created = now;
            }
        }
        inner.entries.retain(|e| {
            e.status.state != JobState::Done || now.duration_since(e.created) < DONE_TTL
        });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock only means another thread panicked mid-update; the
        // queue holds nothing that a partial update could corrupt.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Which of a page's secret blocks is the login to use. An explicit label
/// wins; otherwise the block must carry a `password` field, and when several
/// do, the one whose own URL matches the requested host. Errors name labels
/// only, never values.
pub fn choose_login_block(
    blocks: &[(String, Vec<(String, String)>)],
    label: Option<&str>,
    url_host: Option<&str>,
) -> Result<(String, BTreeMap<String, String>), String> {
    let as_map = |fields: &[(String, String)]| -> BTreeMap<String, String> {
        fields.iter().cloned().collect()
    };
    if let Some(label) = label {
        return blocks
            .iter()
            .find(|(l, _)| l == label)
            .map(|(l, f)| (l.clone(), as_map(f)))
            .ok_or_else(|| format!("no secret block labelled '{label}' on this page"));
    }
    let logins: Vec<&(String, Vec<(String, String)>)> = blocks
        .iter()
        .filter(|(_, f)| f.iter().any(|(k, _)| k == "password"))
        .collect();
    match logins.as_slice() {
        [] => Err("no secret block on this page has a 'password' field".to_string()),
        [one] => Ok((one.0.clone(), as_map(&one.1))),
        many => {
            if let Some(host) = url_host {
                let matching: Vec<&&(String, Vec<(String, String)>)> = many
                    .iter()
                    .filter(|(_, f)| {
                        block_url(f)
                            .and_then(|u| url::Url::parse(&u).ok())
                            .and_then(|u| u.host_str().map(|h| h.to_string()))
                            .is_some_and(|h| h == host)
                    })
                    .collect();
                if let [one] = matching.as_slice() {
                    return Ok((one.0.clone(), as_map(&one.1)));
                }
            }
            let labels: Vec<&str> = many.iter().map(|(l, _)| l.as_str()).collect();
            Err(format!(
                "this page has {} logins; pass 'label' to choose one of: {}",
                many.len(),
                labels.join(", ")
            ))
        }
    }
}

/// The URL a block names for itself, under any of the field names the
/// extension already recognises.
pub fn block_url(fields: &[(String, String)]) -> Option<String> {
    ["url", "site", "website"].iter().find_map(|k| {
        fields
            .iter()
            .find(|(name, _)| name == k)
            .map(|(_, v)| v.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(url: Option<&str>) -> LoginJob {
        LoginJob {
            id: String::new(),
            url: url.map(str::to_string),
            submit: true,
            requested_by: "agent".into(),
            credential: JobCredential {
                page_path: "ai/x.md".into(),
                page_title: "x".into(),
                label: "Login".into(),
                fields: BTreeMap::from([("password".to_string(), "p".to_string())]),
                url: None,
            },
        }
    }

    #[tokio::test]
    async fn a_job_moves_from_queued_to_taken_to_done() {
        let jobs = BrowserJobs::new();
        assert!(!jobs.extension_listening());
        let id = jobs.enqueue(job(Some("https://example.com/login")));
        assert_eq!(jobs.status(&id).unwrap().state, JobState::Queued);
        // A report on a job nobody took is ignored.
        assert!(!jobs.complete(&id, true, "nope"));
        let taken = jobs.take(Duration::from_millis(10)).await.unwrap();
        assert_eq!(taken.id, id);
        assert_eq!(taken.credential.fields["password"], "p");
        assert!(jobs.extension_listening());
        assert_eq!(jobs.status(&id).unwrap().state, JobState::Taken);
        // Taking again finds nothing and times out quickly.
        assert!(jobs.take(Duration::from_millis(10)).await.is_none());
        assert!(jobs.complete(&id, true, "filled"));
        let done = jobs.status(&id).unwrap();
        assert_eq!(done.state, JobState::Done);
        assert_eq!(done.ok, Some(true));
        assert!(!jobs.complete(&id, false, "again"));
        assert!(jobs.status("unknown").is_none());
    }

    #[tokio::test]
    async fn a_waiting_poll_wakes_when_a_job_arrives() {
        let jobs = std::sync::Arc::new(BrowserJobs::new());
        let poller = {
            let jobs = jobs.clone();
            tokio::spawn(async move { jobs.take(Duration::from_secs(5)).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let id = jobs.enqueue(job(None));
        let taken = tokio::time::timeout(Duration::from_secs(2), poller)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(taken.id, id);
    }

    #[tokio::test]
    async fn an_unclaimed_job_expires_and_drops_its_credential() {
        let jobs = BrowserJobs::new();
        let id = jobs.enqueue(job(None));
        jobs.sweep(Instant::now() + QUEUE_TTL);
        let status = jobs.status(&id).unwrap();
        assert_eq!(status.state, JobState::Done);
        assert_eq!(status.ok, Some(false));
        assert!(jobs.take(Duration::from_millis(5)).await.is_none());
        jobs.sweep(Instant::now() + QUEUE_TTL + DONE_TTL);
        assert!(jobs.status(&id).is_none());
    }

    #[test]
    fn login_block_choice_prefers_label_then_password_then_host() {
        let blocks = vec![
            (
                "Notes".to_string(),
                vec![("token".to_string(), "t".to_string())],
            ),
            (
                "Prod".to_string(),
                vec![
                    ("username".to_string(), "a".to_string()),
                    ("password".to_string(), "p1".to_string()),
                    (
                        "url".to_string(),
                        "https://app.example.com/login".to_string(),
                    ),
                ],
            ),
            (
                "Staging".to_string(),
                vec![
                    ("password".to_string(), "p2".to_string()),
                    (
                        "site".to_string(),
                        "https://staging.example.com".to_string(),
                    ),
                ],
            ),
        ];
        assert_eq!(
            choose_login_block(&blocks, Some("Notes"), None).unwrap().0,
            "Notes"
        );
        assert!(choose_login_block(&blocks, Some("Nope"), None).is_err());
        let err = choose_login_block(&blocks, None, None).unwrap_err();
        assert!(err.contains("Prod, Staging"), "{err}");
        assert!(!err.contains("p1"));
        assert_eq!(
            choose_login_block(&blocks, None, Some("staging.example.com"))
                .unwrap()
                .0,
            "Staging"
        );
        assert!(choose_login_block(&blocks, None, Some("other.example.com")).is_err());
        let single = vec![blocks[1].clone()];
        assert_eq!(choose_login_block(&single, None, None).unwrap().0, "Prod");
        let none = vec![blocks[0].clone()];
        assert!(choose_login_block(&none, None, None).is_err());
        assert_eq!(
            block_url(&blocks[2].1).as_deref(),
            Some("https://staging.example.com")
        );
    }
}
