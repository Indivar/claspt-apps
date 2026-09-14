// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! The agent's listener and per-connection loop, and the vault-backed
//! backend that answers it.
//!
//! The socket layer is generic over [`AgentBackend`] so it can be driven in
//! tests with a fake; the real backend reaches the vault through the app
//! handle and puts every signature through the approval gate.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;

use super::keys::{self, Identity};
use super::protocol::{self, Request};

/// Client identity the agent uses in prompts, grants and the access log.
/// Fixed, because there is one agent per app and no token to name it by.
pub const CLIENT_ID: &str = "ssh-agent";
pub const CLIENT_NAME: &str = "SSH agent";

/// What the socket layer needs from whoever owns the keys.
pub trait AgentBackend: Send + Sync + 'static {
    fn identities(&self) -> Vec<Identity>;
    /// A wire-encoded signature, or a reason (logged, never sent to `ssh`,
    /// which only understands failure).
    fn sign(
        &self,
        blob: &[u8],
        data: &[u8],
        flags: u32,
    ) -> impl std::future::Future<Output = Result<Vec<u8>, String>> + Send;
}

/// Answer one client until it hangs up.
pub async fn handle_connection<S, B>(mut stream: S, backend: Arc<B>)
where
    S: AsyncRead + AsyncWrite + Unpin,
    B: AgentBackend,
{
    loop {
        let msg = match protocol::read_frame(&mut stream).await {
            Ok(Some(m)) => m,
            Ok(None) => return,
            Err(e) => {
                log::debug!("[ssh-agent] connection closed: {e}");
                return;
            }
        };
        let reply = match protocol::parse_request(&msg) {
            Ok(Request::RequestIdentities) => {
                let keys: Vec<(Vec<u8>, String)> = backend
                    .identities()
                    .into_iter()
                    .map(|i| (i.blob, i.comment))
                    .collect();
                protocol::identities_answer(&keys)
            }
            Ok(Request::Sign {
                key_blob,
                data,
                flags,
            }) => match backend.sign(&key_blob, &data, flags).await {
                Ok(sig) => protocol::sign_response(&sig),
                Err(e) => {
                    log::info!("[ssh-agent] signature refused: {e}");
                    protocol::failure()
                }
            },
            Ok(Request::Unsupported(kind)) => {
                log::debug!("[ssh-agent] unsupported request {kind}");
                protocol::failure()
            }
            Err(e) => {
                log::debug!("[ssh-agent] bad request: {e}");
                protocol::failure()
            }
        };
        if stream.write_all(&protocol::frame(&reply)).await.is_err() {
            return;
        }
    }
}

/// Where the agent listens: a Unix socket in the app's data directory, or a
/// named pipe on Windows. `ssh` is pointed at it with `SSH_AUTH_SOCK`.
pub fn socket_path() -> Result<String, String> {
    #[cfg(windows)]
    {
        Ok(r"\\.\pipe\claspt-ssh-agent".to_string())
    }
    #[cfg(not(windows))]
    {
        let dir = dirs::data_dir()
            .ok_or("no data directory for this user")?
            .join("in.indivar.claspt");
        Ok(dir.join("ssh-agent.sock").to_string_lossy().into_owned())
    }
}

/// Serve until `shutdown` turns true.
pub async fn serve<B: AgentBackend>(
    backend: Arc<B>,
    path: String,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = std::path::PathBuf::from(&path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
            // The directory, not just the socket, keeps other users out.
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
        // A socket file left by a previous run would refuse the bind.
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("cannot replace {}: {e}", path.display()))?;
        }
        let listener = tokio::net::UnixListener::bind(&path)
            .map_err(|e| format!("cannot listen on {}: {e}", path.display()))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot restrict {}: {e}", path.display()))?;
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        let backend = backend.clone();
                        tokio::spawn(async move { handle_connection(stream, backend).await });
                    }
                    Err(e) => log::warn!("[ssh-agent] accept failed: {e}"),
                },
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        break;
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&path);
        Ok(())
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        // Named pipes have no directory to protect; the default security
        // descriptor grants access to the creating user's session, which is
        // what a per-user agent wants.
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&path)
            .map_err(|e| format!("cannot create pipe {path}: {e}"))?;
        loop {
            tokio::select! {
                connected = server.connect() => {
                    if let Err(e) = connected {
                        log::warn!("[ssh-agent] pipe connect failed: {e}");
                        continue;
                    }
                    let client = server;
                    server = ServerOptions::new()
                        .create(&path)
                        .map_err(|e| format!("cannot create pipe {path}: {e}"))?;
                    let backend = backend.clone();
                    tokio::spawn(async move { handle_connection(client, backend).await });
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        break;
                    }
                }
            }
        }
        Ok(())
    }
}

/// Tauri-managed lifecycle handle, the same shape as the local API's.
pub struct SshAgentState {
    shutdown: Mutex<Option<watch::Sender<bool>>>,
    running: Mutex<bool>,
}

impl Default for SshAgentState {
    fn default() -> Self {
        Self::new()
    }
}

impl SshAgentState {
    pub fn new() -> Self {
        Self {
            shutdown: Mutex::new(None),
            running: Mutex::new(false),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.lock().map(|g| *g).unwrap_or(false)
    }

    /// Start serving with the vault-backed backend. Returns at once; the
    /// listener runs on the async runtime until [`stop`](Self::stop).
    pub fn start(&self, services: Arc<dyn Services>) -> Result<String, String> {
        if self.is_running() {
            return socket_path();
        }
        let path = socket_path()?;
        let (tx, rx) = watch::channel(false);
        if let Ok(mut g) = self.shutdown.lock() {
            *g = Some(tx);
        }
        if let Ok(mut g) = self.running.lock() {
            *g = true;
        }
        let backend = Arc::new(VaultBackend {
            services: services.clone(),
        });
        let serve_path = path.clone();
        let owner = services.clone();
        services.spawn(Box::pin(async move {
            if let Err(e) = serve(backend, serve_path, rx).await {
                log::error!("[ssh-agent] stopped: {e}");
            }
            owner.ssh_agent().mark_stopped();
        }));
        log::info!("[ssh-agent] listening on {path}");
        Ok(path)
    }

    fn mark_stopped(&self) {
        if let Ok(mut g) = self.running.lock() {
            *g = false;
        }
        if let Ok(mut g) = self.shutdown.lock() {
            *g = None;
        }
    }

    pub fn stop(&self) {
        if let Ok(g) = self.shutdown.lock() {
            if let Some(tx) = g.as_ref() {
                let _ = tx.send(true);
            }
        }
    }
}

use crate::local_api::Services;

/// The real backend: keys from the open vault, every signature through the
/// approval gate, rate limit and access log that secret reads use.
struct VaultBackend {
    services: Arc<dyn Services>,
}

impl VaultBackend {
    fn vault(&self) -> Option<(std::path::PathBuf, zeroize::Zeroizing<Vec<u8>>)> {
        let state = self.services.vault();
        Some((state.vault_dir()?, state.master_key()?))
    }
}

impl AgentBackend for VaultBackend {
    fn identities(&self) -> Vec<Identity> {
        match self.vault() {
            Some((dir, key)) => keys::identities(&dir, &key),
            None => Vec::new(),
        }
    }

    async fn sign(&self, blob: &[u8], data: &[u8], flags: u32) -> Result<Vec<u8>, String> {
        let started = Instant::now();
        let (vault_dir, master_key) = self.vault().ok_or("vault is locked")?;
        let identity = keys::identities(&vault_dir, &master_key)
            .into_iter()
            .find(|i| i.blob == blob)
            .ok_or("no such key in the vault")?;
        let target = identity.key.page_path.clone();
        let config = crate::vault::init::read_config(&vault_dir).map_err(|e| e.to_string())?;

        let limiter = self.services.limiter();
        let log_outcome = |status: u16| {
            let entry = crate::internal::access_log::AccessEntry {
                ts: chrono::Utc::now(),
                client_id: CLIENT_ID.to_string(),
                client_name: CLIENT_NAME.to_string(),
                scope: Some(crate::local_api::auth::TokenScope::Secrets),
                action: "ssh.sign".to_string(),
                method: "AGENT".to_string(),
                target: target.clone(),
                status,
                duration_ms: started.elapsed().as_millis() as u64,
            };
            if let Err(e) = crate::internal::access_log::record(&vault_dir, &entry) {
                log::warn!("[ssh-agent] access log write failed: {e}");
            }
        };

        if let Err(wait) = limiter.record(
            CLIENT_ID,
            config.secret_read_rate_limit_per_minute,
            Instant::now(),
        ) {
            log_outcome(429);
            return Err(format!(
                "rate limit of {} signatures a minute reached; retry in {} s",
                config.secret_read_rate_limit_per_minute, wait.seconds
            ));
        }

        // A headless host decides from its policy (client "ssh-agent", target
        // the page); the desktop applies the approval rules.
        let ask = match self.services.authorize(
            &crate::local_api::clients::ClientToken::synthetic(CLIENT_ID, CLIENT_NAME),
            "ssh.sign",
            &target,
        ) {
            crate::local_api::services::Authorization::Allow => false,
            crate::local_api::services::Authorization::Ask => true,
            crate::local_api::services::Authorization::Deny(reason) => {
                log_outcome(403);
                return Err(reason);
            }
        };
        if ask && config.secret_access_mode.as_deref() == Some("approve") {
            let allowed = crate::local_api::approval::gate(
                self.services.as_ref(),
                &vault_dir,
                CLIENT_ID,
                CLIENT_NAME,
                &target,
                &format!("ssh signature with '{}'", identity.key.label),
                limiter.recent(CLIENT_ID, Instant::now()),
            )
            .await;
            if !allowed {
                log_outcome(403);
                return Err("signature denied or not approved in time".to_string());
            }
        }

        let result = keys::load_private(&vault_dir, &master_key, &identity.key)
            .and_then(|private| keys::sign(&private, data, flags));
        log_outcome(if result.is_ok() { 200 } else { 500 });
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ssh_key::{Algorithm, PrivateKey};

    struct Fake {
        key: PrivateKey,
        allow: bool,
    }

    impl AgentBackend for Fake {
        fn identities(&self) -> Vec<Identity> {
            vec![Identity {
                key: keys::KeyRef {
                    page_path: "ai/k.md".into(),
                    page_title: "k".into(),
                    label: "Key".into(),
                },
                public: self.key.public_key().clone(),
                blob: self.key.public_key().to_bytes().unwrap(),
                comment: "Key (k)".into(),
            }]
        }

        async fn sign(&self, blob: &[u8], data: &[u8], flags: u32) -> Result<Vec<u8>, String> {
            if !self.allow {
                return Err("denied".into());
            }
            if blob != self.key.public_key().to_bytes().unwrap() {
                return Err("unknown key".into());
            }
            keys::sign(&self.key, data, flags)
        }
    }

    async fn roundtrip(backend: Arc<Fake>, request: Vec<u8>) -> Vec<u8> {
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(handle_connection(server, backend));
        client.write_all(&protocol::frame(&request)).await.unwrap();
        let reply = protocol::read_frame(&mut client).await.unwrap().unwrap();
        // Dropping the client is the hang-up the server loop ends on.
        drop(client);
        task.await.unwrap();
        reply
    }

    fn sign_request(blob: &[u8], data: &[u8]) -> Vec<u8> {
        let mut m = vec![protocol::SSH_AGENTC_SIGN_REQUEST];
        m.extend_from_slice(&(blob.len() as u32).to_be_bytes());
        m.extend_from_slice(blob);
        m.extend_from_slice(&(data.len() as u32).to_be_bytes());
        m.extend_from_slice(data);
        m.extend_from_slice(&0u32.to_be_bytes());
        m
    }

    #[tokio::test]
    async fn a_connection_lists_keys_signs_and_fails_closed() {
        let key = PrivateKey::random(&mut rand::rngs::OsRng, Algorithm::Ed25519).unwrap();
        let blob = key.public_key().to_bytes().unwrap();
        let allow = Arc::new(Fake {
            key: key.clone(),
            allow: true,
        });
        let answer = roundtrip(allow.clone(), vec![protocol::SSH_AGENTC_REQUEST_IDENTITIES]).await;
        assert_eq!(answer[0], protocol::SSH_AGENT_IDENTITIES_ANSWER);
        assert_eq!(&answer[1..5], &1u32.to_be_bytes());
        assert_eq!(&answer[9..9 + blob.len()], &blob[..]);

        let reply = roundtrip(allow.clone(), sign_request(&blob, b"data")).await;
        assert_eq!(reply[0], protocol::SSH_AGENT_SIGN_RESPONSE);
        let sig_len = u32::from_be_bytes([reply[1], reply[2], reply[3], reply[4]]) as usize;
        let wire = &reply[5..5 + sig_len];
        use ssh_encoding::Decode;
        let sig = ssh_key::Signature::decode(&mut &wire[..]).unwrap();
        assert!(signature::Verifier::verify(key.public_key(), b"data", &sig).is_ok());

        // Unknown key, denied backend, unsupported request: all plain failure.
        assert_eq!(
            roundtrip(allow.clone(), sign_request(b"other", b"data")).await,
            protocol::failure()
        );
        let deny = Arc::new(Fake { key, allow: false });
        assert_eq!(
            roundtrip(deny, sign_request(&blob, b"data")).await,
            protocol::failure()
        );
        assert_eq!(roundtrip(allow, vec![17]).await, protocol::failure());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_unix_listener_serves_and_stops() {
        use tokio::io::AsyncWriteExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent.sock").to_string_lossy().into_owned();
        let key = PrivateKey::random(&mut rand::rngs::OsRng, Algorithm::Ed25519).unwrap();
        let backend = Arc::new(Fake { key, allow: true });
        let (tx, rx) = watch::channel(false);
        let server = tokio::spawn(serve(backend, path.clone(), rx));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let mut stream = tokio::net::UnixStream::connect(&path).await.unwrap();
        stream
            .write_all(&protocol::frame(&[protocol::SSH_AGENTC_REQUEST_IDENTITIES]))
            .await
            .unwrap();
        let reply = protocol::read_frame(&mut stream).await.unwrap().unwrap();
        assert_eq!(reply[0], protocol::SSH_AGENT_IDENTITIES_ANSWER);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        tx.send(true).unwrap();
        server.await.unwrap().unwrap();
        assert!(!std::path::Path::new(&path).exists());
    }
}
