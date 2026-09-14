// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! `claspt serve`: the local API without the desktop app.
//!
//! The server unlocks the vault from a key file (the master key wrapped by
//! a passphrase of its own, made once with `claspt serve init-key` on a
//! machine where the vault password is typed) and decides every request
//! from a policy file, deny by default. No prompt exists, so nothing can
//! be approved interactively: what the policy does not allow is refused.
//! Tokens, rate limits and the access log are the vault's own, shared with
//! the desktop app.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use zeroize::Zeroizing;

use crate::commands::crypto::VaultState;
use crate::crypto::vault_key;
use crate::local_api::policy::Policy;
use crate::local_api::services::HeadlessServices;
use crate::local_api::{self, Services};

/// Environment variable holding the key file's passphrase. An environment
/// variable rather than a flag so it never appears in `ps` output.
pub const PASSPHRASE_ENV: &str = "CLASPT_SERVE_PASSPHRASE";

fn passphrase_from_env() -> Result<Zeroizing<Vec<u8>>, String> {
    let value = std::env::var(PASSPHRASE_ENV)
        .map_err(|_| format!("{PASSPHRASE_ENV} is not set; it holds the key file's passphrase"))?;
    // Out of the environment as soon as it is read, so a child process
    // (the SSH agent hands none out, but a future one might) cannot inherit it.
    std::env::remove_var(PASSPHRASE_ENV);
    if value.trim().is_empty() {
        return Err(format!("{PASSPHRASE_ENV} is empty"));
    }
    Ok(Zeroizing::new(value.into_bytes()))
}

fn read_line_from_stdin(what: &str) -> Result<Zeroizing<String>, String> {
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .map_err(|e| format!("cannot read {what} from stdin: {e}"))?;
    let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
    if trimmed.is_empty() {
        return Err(format!("empty {what}"));
    }
    Ok(Zeroizing::new(trimmed))
}

/// `claspt serve init-key`: unlock with the vault password (read from stdin)
/// and write the master key wrapped by the passphrase in the environment.
pub fn init_key(vault_dir: &Path, out: &Path) -> Result<(), String> {
    crate::vault::init::validate_vault_exists(vault_dir).map_err(|e| e.to_string())?;
    let passphrase = passphrase_from_env()?;
    let password = read_line_from_stdin("vault password")?;
    let vault_key_path = vault_dir.join(".securenotes").join("vault.key");
    let master_key = vault_key::unlock_vault_key(password.as_bytes(), &vault_key_path)
        .map_err(|_| "wrong vault password".to_string())?;
    vault_key::write_key_file(&passphrase, &master_key, out)
        .map_err(|e| format!("cannot write {}: {e}", out.display()))?;
    Ok(())
}

/// Unlock from a key file and check the result against the vault's own
/// verification hash, so a key file from another vault is refused before
/// anything is served.
pub fn unlock_from_key_file(
    vault_dir: &Path,
    key_file: &Path,
) -> Result<Zeroizing<Vec<u8>>, String> {
    crate::vault::init::validate_vault_exists(vault_dir).map_err(|e| e.to_string())?;
    let passphrase = passphrase_from_env()?;
    let master_key = vault_key::unlock_vault_key(&passphrase, key_file)
        .map_err(|_| format!("cannot unlock {} with {PASSPHRASE_ENV}", key_file.display()))?;
    let config = crate::vault::init::read_config(vault_dir).map_err(|e| e.to_string())?;
    if let Some(expected) = config.master_key_verify.as_deref() {
        let actual = vault_key::compute_master_key_verify(&master_key);
        if !local_api::auth::constant_time_eq(actual.as_bytes(), expected.as_bytes()) {
            return Err(format!(
                "{} does not unlock the vault at {}",
                key_file.display(),
                vault_dir.display()
            ));
        }
    }
    Ok(master_key)
}

pub struct ServeOptions {
    pub vault_dir: PathBuf,
    pub key_file: PathBuf,
    pub policy: PathBuf,
    pub port: u16,
    pub ssh_agent: bool,
}

/// Run until Ctrl-C (or SIGTERM on Unix).
pub fn run(opts: ServeOptions) -> Result<(), String> {
    let policy = Policy::load(&opts.policy)?;
    if policy.rules.is_empty() {
        log::warn!(
            "[serve] policy {} has no rules: every request will be refused",
            opts.policy.display()
        );
    }
    let master_key = unlock_from_key_file(&opts.vault_dir, &opts.key_file)?;

    let vault = VaultState::new();
    *vault.master_key.lock().map_err(|_| "lock poisoned")? = Some(master_key);
    *vault.vault_path.lock().map_err(|_| "lock poisoned")? = Some(opts.vault_dir.clone());

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("cannot start the async runtime: {e}"))?;
    let services: Arc<dyn Services> = Arc::new(HeadlessServices::new(
        vault,
        policy,
        runtime.handle().clone(),
    ));

    if let Err(e) = crate::commands::search::init_search_engine(&opts.vault_dir, services.search())
    {
        log::warn!("[serve] search index unavailable: {e}");
    }
    services.git().batcher.set_vault_dir(&opts.vault_dir);

    runtime.block_on(async move {
        let listener = local_api::server::bind(opts.port).await?;
        let (tx, rx) = tokio::sync::watch::channel(false);
        if opts.ssh_agent {
            let path = services.ssh_agent().start(services.clone())?;
            eprintln!("claspt serve: SSH agent on {path}");
        }
        eprintln!(
            "claspt serve: vault {} on http://127.0.0.1:{} (policy {}), Ctrl-C to stop",
            opts.vault_dir.display(),
            opts.port,
            opts.policy.display()
        );
        let server = tokio::spawn(local_api::server::serve_until(
            services.clone(),
            listener,
            rx,
        ));
        wait_for_shutdown().await;
        let _ = tx.send(true);
        services.ssh_agent().stop();
        server
            .await
            .map_err(|e| format!("server task failed: {e}"))??;
        // The batched commit may still hold a save; write it before leaving.
        if let Err(e) = services.git().batcher.flush() {
            log::warn!("[serve] final commit failed: {e}");
        }
        Ok::<(), String>(())
    })
}

async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(s) => s,
                Err(_) => {
                    let _ = tokio::signal::ctrl_c().await;
                    return;
                }
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_file_unlocks_only_its_own_vault() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        crate::vault::init::initialize_vault(&vault, b"vault-password").unwrap();
        let vault_key_path = vault.join(".securenotes").join("vault.key");
        let master = vault_key::unlock_vault_key(b"vault-password", &vault_key_path).unwrap();
        let key_file = dir.path().join("serve.key");
        vault_key::write_key_file(b"serve-passphrase", &master, &key_file).unwrap();

        std::env::set_var(PASSPHRASE_ENV, "serve-passphrase");
        let unlocked = unlock_from_key_file(&vault, &key_file).unwrap();
        assert_eq!(&*unlocked, &*master);
        // The passphrase is gone from the environment once read.
        assert!(std::env::var(PASSPHRASE_ENV).is_err());

        std::env::set_var(PASSPHRASE_ENV, "wrong");
        assert!(unlock_from_key_file(&vault, &key_file).is_err());

        // A key file from another vault is refused by the verification hash.
        let other = dir.path().join("other");
        crate::vault::init::initialize_vault(&other, b"other-password").unwrap();
        std::env::set_var(PASSPHRASE_ENV, "serve-passphrase");
        let err = unlock_from_key_file(&other, &key_file).unwrap_err();
        assert!(err.contains("does not unlock"), "{err}");

        std::env::remove_var(PASSPHRASE_ENV);
        assert!(unlock_from_key_file(&vault, &key_file).is_err());
    }
}
