// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The vault gate shown before the app is usable. Handles four entry paths:
 * unlocking an existing vault with the master password, creating a new vault,
 * restoring from a cloud account, and password recovery via recovery key.
 *
 * Also drives biometric unlock: on mount it checks availability and, depending
 * on the configured biometric mode, auto-triggers the OS biometric prompt.
 * A distinct "UI lock" mode re-verifies the password while the master key is
 * still held in memory (used after auto-lock), avoiding a full re-unlock.
 */
import { useState, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { VERSION_DISPLAY } from "@/lib/version";
import { useUIStore, isDarkTheme } from "@/stores/ui-store";
import { useVaultStore } from "@/stores/vault-store";
import { BrandLogo } from "@/components/BrandLogo";
import { SpinnerIcon } from "@/components/ui/icons";
import { suggestDefaultVaultDir, vaultExistsAt } from "@/lib/commands";
import { RestoreFromAccount } from "@/components/RestoreFromAccount";

const VAULT_DIR_KEY = "claspt:vault-dir";

/**
 * "Forgot password" flow: accepts a recovery key and a new master password,
 * then re-derives the vault key. Requires the new password to be ≥12 chars and
 * confirmed.
 */
function RecoveryForm({
  vaultDir,
  loading,
  error,
  onBack,
}: {
  vaultDir: string;
  loading: boolean;
  error: string | null;
  onBack: () => void;
}) {
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const recoverWithKey = useVaultStore((s) => s.recoverWithKey);
  const clearError = useVaultStore((s) => s.clearError);

  const mismatch = confirmPassword !== "" && newPassword !== confirmPassword;
  const canSubmit =
    recoveryKey.trim() !== "" &&
    newPassword.length >= 12 &&
    newPassword === confirmPassword &&
    !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await recoverWithKey(recoveryKey.trim(), newPassword, vaultDir);
    setRecoveryKey("");
    setNewPassword("");
    setConfirmPassword("");
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="recovery-key"
          className="mb-1.5 block text-[13px] font-medium text-text-secondary"
        >
          Recovery Key
        </label>
        <textarea
          id="recovery-key"
          value={recoveryKey}
          onChange={(e) => {
            setRecoveryKey(e.target.value);
            clearError();
          }}
          rows={3}
          className="unlock-input w-full resize-none rounded-xl border border-border/60 bg-surface/60 px-4 py-2.5 font-mono text-[12px] text-text-primary transition-all placeholder:text-text-muted/60"
          placeholder="Paste your recovery key here"
          autoFocus
        />
      </div>

      <div>
        <label
          htmlFor="new-password"
          className="mb-1.5 block text-[13px] font-medium text-text-secondary"
        >
          New Password
        </label>
        <input
          id="new-password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="unlock-input w-full rounded-xl border border-border/60 bg-surface/60 px-4 py-2.5 text-[13px] text-text-primary transition-all placeholder:text-text-muted/60"
          placeholder="Min 12 characters"
        />
      </div>

      <div>
        <label
          htmlFor="confirm-password"
          className="mb-1.5 block text-[13px] font-medium text-text-secondary"
        >
          Confirm Password
        </label>
        <input
          id="confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className={`unlock-input w-full rounded-xl border bg-surface/60 px-4 py-2.5 text-[13px] text-text-primary transition-all placeholder:text-text-muted/60 ${
            mismatch ? "border-danger" : "border-border/60"
          }`}
          placeholder="Repeat new password"
        />
        {mismatch && (
          <p className="mt-1 text-[12px] text-danger">Passwords do not match</p>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      )}

      <div className="pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="unlock-submit btn-accent w-full rounded-xl px-4 py-3 text-[13px]"
        >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <SpinnerIcon size={14} className="animate-spin" />
              Recovering...
            </span>
          ) : (
            "Reset Password"
          )}
        </button>
      </div>

      <button
        type="button"
        onClick={onBack}
        className="w-full text-center text-[12px] text-text-muted transition-colors hover:text-accent"
      >
        Back to password unlock
      </button>
    </form>
  );
}

/** Full-screen unlock/create/restore/recovery gate with biometric support. */
export function UnlockScreen() {
  const [password, setPassword] = useState("");
  const [vaultDir, setVaultDir] = useState("~/Claspt");
  const [mode, setMode] = useState<"unlock" | "create" | "restore">("unlock");
  const [showRecovery, setShowRecovery] = useState(false);
  /** Whether a vault exists at `vaultDir`. `null` while the check is in flight. */
  const [vaultPresent, setVaultPresent] = useState<boolean | null>(null);
  /** Set once the user picks a tab, so the detection below stops overriding them. */
  const [modeChosenByUser, setModeChosenByUser] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const {
    isUnlocked,
    isUILocked,
    unlock,
    uiUnlock,
    createVault,
    loading,
    error,
    clearError,
    biometricAvailable,
    biometricMode,
    biometricFailures,
    hasUnlockedWithPassword,
    checkBiometric,
    unlockWithBiometric,
  } = useVaultStore();

  // UI lock = master key still in memory, just need password re-verification
  const isUILockMode = isUnlocked && isUILocked;
  const { theme, cycleTheme } = useUIStore();

  const biometricAutoTriggered = useRef(false);

  useEffect(() => {
    checkBiometric();
  }, [checkBiometric]);

  // Auto-trigger biometric prompt when the unlock screen appears and
  // biometric is available (e.g. after auto-lock in "primary" mode,
  // or "reauth" mode after password was already entered this session).
  useEffect(() => {
    if (biometricAutoTriggered.current) return;
    if (!biometricAvailable || biometricFailures >= 3 || loading) return;
    const canBiometric =
      biometricMode === "enabled" ||
      biometricMode === "primary" ||
      (biometricMode === "reauth" && hasUnlockedWithPassword);
    if (!canBiometric) return;

    biometricAutoTriggered.current = true;
    // Small delay so the unlock screen renders before the OS prompt appears
    const timer = setTimeout(() => {
      unlockWithBiometric(vaultDir);
    }, 300);
    return () => clearTimeout(timer);
  }, [
    biometricAvailable,
    biometricMode,
    biometricFailures,
    hasUnlockedWithPassword,
    loading,
    vaultDir,
    unlockWithBiometric,
  ]);

  useEffect(() => {
    const saved = localStorage.getItem(VAULT_DIR_KEY);
    if (saved) {
      setVaultDir(saved);
    } else {
      suggestDefaultVaultDir()
        .then(setVaultDir)
        .catch(() => {});
    }
  }, []);

  // Ask whether a vault is actually at this path, and open on the right form.
  //
  // This screen used to start in "unlock" mode always, having no way to tell.
  // On a first install that meant presenting a path to a vault that was not
  // there, a password box, and an Unlock button that could only fail — leaving
  // someone new to work out for themselves that they wanted the Create tab.
  useEffect(() => {
    if (!vaultDir.trim()) return;
    let cancelled = false;
    vaultExistsAt(vaultDir)
      .then((exists) => {
        if (cancelled) return;
        setVaultPresent(exists);
        // Only steer while the user has not expressed a preference. Someone who
        // deliberately opened "Create" over an existing vault is not corrected.
        if (!exists && !modeChosenByUser) setMode("create");
      })
      .catch(() => {
        // Unknown rather than absent: leave the form as it is rather than
        // asserting something about the user's disk that we could not check.
        if (!cancelled) setVaultPresent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultDir, modeChosenByUser]);

  const handleBrowse = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setVaultDir(selected);
      localStorage.setItem(VAULT_DIR_KEY, selected);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (isUILockMode) {
        // UI lock — just verify password, no full unlock needed
        await uiUnlock(password);
      } else if (mode === "unlock") {
        await unlock(password, vaultDir);
      } else {
        await createVault(password, vaultDir);
      }
      localStorage.setItem(VAULT_DIR_KEY, vaultDir);
    } finally {
      setPassword("");
      setConfirmPassword("");
      setShowPassword(false);
    }
  };

  return (
    <div className="unlock-bg flex h-screen items-center justify-center">
      {/* Theme toggle */}
      <button
        onClick={cycleTheme}
        className="absolute right-5 top-5 z-10 rounded-lg p-2.5 text-text-muted transition-all hover:bg-surface-overlay/60 hover:text-text-secondary"
        title="Toggle theme"
      >
        {isDarkTheme(theme) ? (
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="4" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path
              d="M14 9.27A7 7 0 016.73 2 7 7 0 1014 9.27z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      <div className="unlock-card unlock-card-anim w-full max-w-[400px] rounded-2xl px-10 py-10">
        {/* Logo & branding */}
        <div className="mb-8 text-center">
          <div className="unlock-logo-anim mx-auto mb-5 flex items-center justify-center">
            <BrandLogo size="unlock" />
          </div>
          <h1
            className="unlock-stagger-1 brand-gradient text-2xl font-extrabold tracking-tight"
            style={{ letterSpacing: "-0.02em" }}
          >
            Claspt
          </h1>
          <p className="unlock-stagger-1 mt-1.5 text-[13px] tracking-wide text-text-muted">
            {showRecovery ? "Recover your vault" : "Secure notes vault"}
          </p>
        </div>

        {!showRecovery && (
          <>
            {/* Mode toggle */}
            <div className="unlock-stagger-2 mb-6 flex rounded-xl border border-border/60 bg-surface/60 p-1">
              <button
                onClick={() => {
                  setMode("unlock");
                  setModeChosenByUser(true);
                  clearError();
                }}
                className={`flex-1 rounded-lg px-3 py-2 text-[13px] font-medium transition-all ${
                  mode === "unlock"
                    ? "bg-surface-raised text-text-primary shadow-sm"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                Unlock
              </button>
              <button
                onClick={() => {
                  setMode("create");
                  setModeChosenByUser(true);
                  clearError();
                }}
                className={`flex-1 rounded-lg px-3 py-2 text-[13px] font-medium transition-all ${
                  mode === "create"
                    ? "bg-surface-raised text-text-primary shadow-sm"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                Create Vault
              </button>
              <button
                onClick={() => {
                  setMode("restore");
                  setModeChosenByUser(true);
                  clearError();
                }}
                className={`flex-1 rounded-lg px-3 py-2 text-[13px] font-medium transition-all ${
                  mode === "restore"
                    ? "bg-surface-raised text-text-primary shadow-sm"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                Restore
              </button>
            </div>

            {/* Form */}
            {mode === "restore" ? (
              <RestoreFromAccount
                vaultDir={vaultDir}
                onBack={() => {
                  setMode("unlock");
                  clearError();
                }}
              />
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="unlock-stagger-3">
                  <label
                    htmlFor="vault-dir"
                    className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                  >
                    Vault Directory
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="vault-dir"
                      type="text"
                      value={vaultDir}
                      onChange={(e) => setVaultDir(e.target.value)}
                      className="unlock-input min-w-0 flex-1 rounded-xl border border-border/60 bg-surface/60 px-4 py-2.5 text-[13px] text-text-primary transition-all placeholder:text-text-muted/60"
                      placeholder="~/Claspt"
                    />
                    <button
                      type="button"
                      onClick={handleBrowse}
                      className="shrink-0 rounded-xl border border-border/60 bg-surface/60 px-3 py-2.5 text-text-secondary transition-all hover:bg-surface-overlay/60 hover:text-text-primary"
                      title="Browse for folder"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path
                          d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 1.5H12.5c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5h-9C2.67 13.5 2 12.83 2 12V4.5Z"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </div>
                  {vaultPresent === false && (
                    <p className="mt-1.5 text-[12px] leading-relaxed text-text-muted">
                      No vault here yet — a new one will be created at this location. If
                      you already have a vault, use the folder button to find it.
                    </p>
                  )}
                  {vaultPresent === true && mode === "create" && (
                    <p className="mt-1.5 text-[12px] leading-relaxed text-warning">
                      A vault already exists here. Choose an empty folder, or switch to
                      Unlock to open this one.
                    </p>
                  )}
                </div>

                <div className="unlock-stagger-4">
                  <label
                    htmlFor="password"
                    className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                  >
                    Master Password
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="unlock-input w-full rounded-xl border border-border/60 bg-surface/60 py-2.5 pl-4 pr-16 text-[13px] text-text-primary transition-all placeholder:text-text-muted/60"
                      placeholder={
                        mode === "create" ? "Min 12 characters" : "Enter password"
                      }
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-overlay/60 hover:text-text-secondary"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                {mode === "create" && (
                  <div className="unlock-stagger-4">
                    <label
                      htmlFor="confirm-password"
                      className="mb-1.5 block text-[13px] font-medium text-text-secondary"
                    >
                      Confirm Master Password
                    </label>
                    <input
                      id="confirm-password"
                      type={showPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="unlock-input w-full rounded-xl border border-border/60 bg-surface/60 px-4 py-2.5 text-[13px] text-text-primary transition-all placeholder:text-text-muted/60"
                      placeholder="Type it again"
                    />
                    {/* A mistyped master password is unrecoverable: it encrypts
                        the vault, and the recovery key is only shown afterwards,
                        so at this moment there is nothing to fall back on. */}
                    {confirmPassword !== "" && password !== confirmPassword && (
                      <p className="mt-1.5 text-[12px] text-danger">
                        The two passwords do not match.
                      </p>
                    )}
                    {password !== "" && password.length < 12 && (
                      <p className="mt-1.5 text-[12px] text-text-muted">
                        {12 - password.length} more character
                        {12 - password.length === 1 ? "" : "s"} needed.
                      </p>
                    )}
                    <p className="mt-2 text-[12px] leading-relaxed text-text-muted">
                      There is no way to reset this password. Write it down somewhere safe
                      before continuing.
                    </p>
                  </div>
                )}

                {error && (
                  <p className="rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">
                    {error}
                  </p>
                )}

                <div className="unlock-stagger-5 pt-1">
                  <button
                    type="submit"
                    disabled={
                      loading ||
                      !password ||
                      (mode === "create" &&
                        (password.length < 12 || password !== confirmPassword))
                    }
                    className="unlock-submit btn-accent w-full rounded-xl px-4 py-3 text-[13px]"
                  >
                    {loading ? (
                      <span className="inline-flex items-center gap-2">
                        <SpinnerIcon size={14} className="animate-spin" />
                        {mode === "unlock" ? "Unlocking..." : "Creating..."}
                      </span>
                    ) : mode === "unlock" ? (
                      "Unlock Vault"
                    ) : (
                      "Create Vault"
                    )}
                  </button>
                </div>

                {mode === "unlock" && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowRecovery(true);
                      clearError();
                    }}
                    className="w-full text-center text-[12px] text-text-muted transition-colors hover:text-accent"
                  >
                    Forgot password?
                  </button>
                )}

                {mode === "unlock" && biometricAvailable && biometricFailures >= 3 && (
                  <p className="text-center text-[12px] text-text-muted">
                    Too many biometric failures — use your password
                  </p>
                )}

                {mode === "unlock" &&
                  biometricAvailable &&
                  biometricFailures < 3 &&
                  (biometricMode === "enabled" ||
                    biometricMode === "primary" ||
                    (biometricMode === "reauth" && hasUnlockedWithPassword)) && (
                    <div className="unlock-stagger-5 pt-1">
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => unlockWithBiometric(vaultDir)}
                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-border/60 bg-surface/60 px-4 py-3 text-[13px] font-medium text-text-secondary transition-all hover:bg-surface-overlay/60"
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <path
                            d="M4 8.5C4 6.01 6.01 4 8.5 4s4.5 2.01 4.5 4.5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                          <path
                            d="M6 8.5a2.5 2.5 0 015 0v1"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                          <path
                            d="M8.5 8v3"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                          <path
                            d="M2 7C2 3.69 4.69 1 8 1s6 2.69 6 6"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                          <path
                            d="M1 8.5c0-3.87 3.13-7 7-7s7 3.13 7 7"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            opacity="0.4"
                          />
                        </svg>
                        Unlock with Biometric
                      </button>
                    </div>
                  )}
              </form>
            )}
          </>
        )}

        {showRecovery && (
          <RecoveryForm
            vaultDir={vaultDir}
            loading={loading}
            error={error}
            onBack={() => {
              setShowRecovery(false);
              clearError();
            }}
          />
        )}

        {/* Version footer */}
        <p className="mt-6 text-center text-[11px] tracking-wider text-text-muted/70">
          v{VERSION_DISPLAY}
        </p>
      </div>
    </div>
  );
}
