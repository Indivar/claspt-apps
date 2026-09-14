# Track vault.key and config.json in Git

## Context

Currently, ALL files in `.securenotes/` are excluded from git via the vault's `.gitignore`. This means:
- `vault.key` (encrypted master key) is not backed up in git and doesn't transfer between devices via git sync
- `config.json` (settings, license, preferences) doesn't sync across devices
- Multi-device setup requires the complex "Restore from Pro Account" flow even for Git sync users
- If vault.key is accidentally deleted, all secrets are lost (unless recovery key was saved)

**Proposed change:** Track `vault.key` and `config.json` in git. Keep device-specific files (`sync.json`, `index/`, `brute_force.json`) excluded.

## Security Assessment

| Concern | Analysis |
|---------|----------|
| vault.key in git remote | vault.key is encrypted with Argon2id (64MB, 3 iterations). Brute-force is ~1 attempt/sec. Same security model as 1Password/Bitwarden cloud sync. |
| Password change history | Old vault.key in git history + old password = same master key (password change re-encrypts the same key). No additional exposure — attacker with current vault.key + current password already has full access. |
| config.json has license_key | License tokens are Ed25519 signed, revocable server-side. Low risk. |
| config.json has API tokens | Local API tokens only work on localhost. Negligible remote risk. |
| Git remote is compromised | Attacker gets encrypted vault.key + encrypted secret blocks. Still needs password. Identical to any cloud password manager being compromised. |

**Conclusion:** No meaningful security reduction. The password is the security boundary, not the file's location.

## What Changes

### Current `.gitignore` (written to new vaults)
```
# Claspt vault — auto-generated
.securenotes/index/
.securenotes/vault.key
.securenotes/config.json
.securenotes/license.token
.securenotes/license.json
.securenotes/brute_force.json
.securenotes/sync.json
*.tmp
```

### New `.gitignore`
```
# Claspt vault — auto-generated
# Device-specific files (not synced)
.securenotes/index/
.securenotes/sync.json
.securenotes/brute_force.json
.securenotes/sharing_key.json
.securenotes/.nosync
*.tmp

# vault.key and config.json ARE tracked — they're encrypted
# and needed for multi-device sync and settings portability.
```

### Files that become git-tracked
| File | Why track it |
|------|-------------|
| `.securenotes/vault.key` | Encrypted master key — enables multi-device with same password, automatic backup |
| `.securenotes/config.json` | Settings, preferences, license — sync across devices |
| `.securenotes/license.json` | License state — available on all devices |
| `.securenotes/license.token` | Same as above (legacy format) |

### Files that remain excluded
| File | Why exclude |
|------|-----------|
| `.securenotes/index/` | Binary search index, large, auto-rebuilt |
| `.securenotes/sync.json` | Device-specific (device_id, sync version) |
| `.securenotes/brute_force.json` | Device-specific login attempt tracking |
| `.securenotes/sharing_key.json` | Device-specific sharing secret |
| `.securenotes/.nosync` | macOS-only iCloud marker |

## Implementation

### Files to modify

| File | Change |
|------|--------|
| `src-tauri/src/vault/init.rs` | Update `VAULT_GITIGNORE` constant |
| `src-tauri/src/commands/crypto.rs` | On unlock, migrate existing vaults: update .gitignore + `git add` newly tracked files |

### Step 1: Update VAULT_GITIGNORE for new vaults

In `src-tauri/src/vault/init.rs`, change the `VAULT_GITIGNORE` constant to the new version (shown above).

### Step 2: Migration for existing vaults

On unlock, check if `.gitignore` still has the old exclusions. If so:
1. Rewrite `.gitignore` with the new content
2. Run `git add .securenotes/vault.key .securenotes/config.json` to stage the newly tracked files
3. Auto-commit: "chore: track vault.key and config.json in git for multi-device sync"

This migration runs once per vault (check by looking for `.securenotes/vault.key` in .gitignore).

### Step 3: Simplify Git sync multi-device

With vault.key in git, the Git sync flow for S2 becomes:
1. Clone repo → vault.key is present
2. Enter password → vault.key decrypted → same master key as S1
3. All secrets decryptable immediately

The `group_key` derivation (SHA-256 from password) remains needed for Claspt Cloud sync (Pro+) where git bundles are encrypted separately. But for Git sync (Pro), it's no longer needed since all devices share the same vault.key and master_key.

## What this enables

1. **Git sync multi-device is trivial** — clone + enter password = done
2. **Automatic backup** — vault.key in git history, recoverable with `git checkout`
3. **Settings sync** — theme, extensions, license, preferences sync via git
4. **Simpler mental model** — "your vault IS the git repo, everything important is tracked"
5. **Recovery** — recovery key becomes a safety net, not the primary recovery path

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| User has public git repo | Docs + first-run warning: "Use a PRIVATE repository for your vault" |
| Old password in git history | Same master key regardless — no additional exposure |
| API tokens in config.json | Only work on localhost; strip before commit OR accept low risk |
| Migration breaks existing workflow | One-time auto-migration with informative commit message |

## Verification

1. New vault: `.gitignore` has new content, `git status` shows vault.key and config.json tracked
2. Existing vault: on unlock, `.gitignore` is updated, vault.key + config.json are committed
3. Clone vault to another machine → enter password → all secrets accessible
4. Change settings on S1 → git push → git pull on S2 → settings updated
