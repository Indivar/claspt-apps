// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Vault store — the authentication and lifecycle hub for the encrypted vault.
 *
 * Owns everything about "is the vault open, and how": creating a new vault,
 * unlocking with password / biometric / recovery key, the two-tier lock model
 * (full backend lock vs. UI-only overlay), biometric enrollment, and loading /
 * persisting the {@link VaultConfig}.
 *
 * Lock model — there are two distinct kinds of "locked":
 *  - `isUnlocked` reflects the *backend* (Rust) state: whether the master key is
 *    resident in memory so crypto, search, sync, and the API/MCP/extension
 *    bridges can operate.
 *  - `isUILocked` is a *frontend-only* overlay. When true the UI is gated behind
 *    a re-auth prompt while the backend keeps running, so the local API and
 *    browser extension continue to serve requests. `uiLock`/`uiUnlock` toggle
 *    this without restarting the backend.
 *
 * Every mutation funnels through the typed IPC layer in `@/lib/commands`; errors
 * are normalized via {@link errorMessage} and surfaced on `error`.
 */
import { create } from "zustand";
import { errorMessage } from "@/lib/error-message";
import * as cmd from "@/lib/commands";
import { createLogger } from "@/lib/logger";
import { useExtensionStore } from "@/stores/extension-store";
import { useShareStore } from "@/stores/share-store";
import { applyUIScale } from "@/stores/ui-store";
import { clearAllDrafts } from "@/lib/drafts";
import type { VaultConfig, VaultCreationResult } from "@claspt/shared/types";

const vaultLog = createLogger("vault");

interface VaultStore {
  /** Whether the vault is currently unlocked (backend has master key). */
  isUnlocked: boolean;
  /** Whether the UI is locked (overlay shown, but backend may still be active). */
  isUILocked: boolean;
  /** Path to the vault directory. */
  vaultDir: string | null;
  /** Vault configuration (loaded after unlock). */
  config: VaultConfig | null;
  /** Recovery key shown once after vault creation. */
  recoveryKey: string | null;
  /** Error message from the last operation. */
  error: string | null;
  /** Loading state for async operations. */
  loading: boolean;
  /** Whether the platform supports biometric auth. */
  biometricAvailable: boolean;
  /** Current biometric mode from vault config ("disabled" | "reauth" | "primary" | "enabled"). */
  biometricMode: string;
  /** Consecutive biometric unlock failures (resets on success). */
  biometricFailures: number;
  /** Whether the user has unlocked with password this session (for reauth mode). */
  hasUnlockedWithPassword: boolean;
  /** The tab the unlock screen opens on next, set by a flow that locks the
   *  vault to send the owner somewhere specific (Restore from account). */
  requestedUnlockMode: "unlock" | "create" | "restore" | null;

  /** Create a brand-new vault; returns the one-time recovery key to display. */
  createVault: (
    password: string,
    vaultDir: string,
  ) => Promise<VaultCreationResult | null>;
  /** Unlock an existing vault with the master password (full backend unlock). */
  unlock: (password: string, vaultDir: string) => Promise<boolean>;
  /** Full lock: tells the backend to drop the master key from memory. */
  lock: (reason?: "auto" | "manual") => Promise<void>;
  /** UI-only lock: shows lock overlay, backend stays fully operational. */
  uiLock: () => void;
  /** UI unlock: verifies password and hides lock overlay (no backend restart needed). */
  uiUnlock: (password: string) => Promise<boolean>;
  /** Load {@link VaultConfig} from disk and apply UI scale + extension state. */
  loadConfig: () => Promise<void>;
  /** Persist an updated {@link VaultConfig} to disk. */
  updateConfig: (config: VaultConfig) => Promise<void>;
  clearError: () => void;
  clearRecoveryKey: () => void;
  /** Probe platform biometric support and sync the current biometric mode. */
  checkBiometric: (vaultDir?: string) => Promise<void>;
  /** Unlock via biometric — UI unlock if key already resident, else full unlock. */
  unlockWithBiometric: (vaultDir: string) => Promise<boolean>;
  /** Enroll or disable biometric unlock for the given mode. */
  toggleBiometric: (mode?: string) => Promise<boolean>;
  /** Recover access with the recovery key and set a new master password. */
  recoverWithKey: (
    recoveryKey: string,
    newPassword: string,
    vaultDir: string,
  ) => Promise<VaultCreationResult | null>;
}

/** Zustand hook exposing vault auth state and lifecycle actions. */
export const useVaultStore = create<VaultStore>((set, get) => ({
  isUnlocked: false,
  isUILocked: false,
  vaultDir: null,
  config: null,
  recoveryKey: null,
  error: null,
  loading: false,
  biometricAvailable: false,
  biometricMode: "disabled",
  biometricFailures: 0,
  hasUnlockedWithPassword: false,
  requestedUnlockMode: null,

  createVault: async (password, vaultDir) => {
    set({ loading: true, error: null });
    try {
      vaultLog.info(`Creating vault at ${vaultDir}`);
      const result = await cmd.createVault(password, vaultDir);
      set({
        isUnlocked: true,
        vaultDir,
        recoveryKey: result.recovery_key,
        loading: false,
      });
      vaultLog.info("Vault created successfully");
      await get().loadConfig();
      if (get().config?.server_enabled) {
        useShareStore.getState().startPolling();
      }
      return result;
    } catch (e) {
      vaultLog.error("Vault creation failed", e);
      set({ error: errorMessage(e), loading: false });
      return null;
    }
  },

  unlock: async (password, vaultDir) => {
    set({ loading: true, error: null });
    try {
      vaultLog.info(`Unlocking vault at ${vaultDir}`);
      await cmd.unlockVault(password, vaultDir);
      set({
        isUnlocked: true,
        vaultDir,
        loading: false,
        hasUnlockedWithPassword: true,
        biometricFailures: 0,
      });
      vaultLog.info("Vault unlocked");
      await get().loadConfig();
      if (get().config?.server_enabled) {
        useShareStore.getState().startPolling();
      }
      // Register device and capture vault stats
      cmd.postUnlockInit().catch(() => {});
      return true;
    } catch (e) {
      vaultLog.warn("Unlock failed", e);
      set({ error: errorMessage(e), loading: false });
      return false;
    }
  },

  lock: async (reason?: "auto" | "manual") => {
    // UI lock: show lock overlay, backend stays fully operational.
    // The master key remains in memory — API/MCP/browser extension keep working.
    try {
      await cmd.lockVault();
      vaultLog.info("UI locked", reason ?? "manual");
    } catch (e) {
      vaultLog.error("UI lock failed", e);
    }

    clearAllDrafts();
    set({ isUILocked: true, error: null });
  },

  uiLock: () => {
    clearAllDrafts();
    set({ isUILocked: true, error: null });
  },

  uiUnlock: async (password: string) => {
    try {
      await cmd.verifyPassword(password);
      // Reset activity timer so key-lock watchdog doesn't fire immediately
      await cmd.touchActivity();
      set({ isUILocked: false, error: null });
      vaultLog.info("UI unlocked");
      return true;
    } catch (e) {
      vaultLog.warn("UI unlock failed", e);
      set({ error: errorMessage(e) });
      return false;
    }
  },

  loadConfig: async () => {
    try {
      const config = await cmd.getVaultConfig();
      set({ config });
      applyUIScale(config.ui_scale ?? 1.0);
      useExtensionStore.getState().initFromConfig(config);
      vaultLog.debug("Config loaded");
    } catch (e) {
      vaultLog.error("Config load failed", e);
      set({ error: errorMessage(e) });
    }
  },

  updateConfig: async (config) => {
    try {
      vaultLog.debug("updateConfig — markdown_extensions:", config.markdown_extensions);
      await cmd.setVaultConfig(config);
      set({ config });
      applyUIScale(config.ui_scale ?? 1.0);
      vaultLog.debug("Config saved to disk");
    } catch (e) {
      vaultLog.error("Config update FAILED", e);
      set({ error: errorMessage(e) });
    }
  },

  checkBiometric: async (vaultDir?: string) => {
    try {
      const available = await cmd.biometricAvailable();
      let mode = get().biometricMode; // preserve existing mode (e.g. after auto-lock)
      if (available) {
        try {
          mode = await cmd.biometricStatus();
        } catch {
          // Config not readable before unlock — the keychain decides instead.
          // Entries are scoped per vault, so this needs to know which vault
          // is on screen; with no folder chosen yet there is nothing to look
          // up and the last known mode stands. A key that is gone (removed
          // by the app because it belonged to another vault) means off.
          if (vaultDir) {
            const enrolled = await cmd.biometricEnrolled(vaultDir);
            if (!enrolled) mode = "disabled";
            else if (mode === "disabled") mode = "enabled";
          }
        }
      } else {
        mode = "disabled";
      }
      set({ biometricAvailable: available, biometricMode: mode });
    } catch (e) {
      vaultLog.warn("Biometric check failed", e);
      set({ biometricAvailable: false, biometricMode: "disabled" });
    }
  },

  unlockWithBiometric: async (vaultDir) => {
    set({ loading: true, error: null });
    try {
      const { isUnlocked, isUILocked } = get();
      if (isUnlocked && isUILocked) {
        // UI lock mode — master key is already in memory, just verify identity
        vaultLog.info("Biometric verify for UI unlock");
        await cmd.biometricVerify();
        await cmd.touchActivity();
        set({ isUILocked: false, loading: false, error: null, biometricFailures: 0 });
        vaultLog.info("Biometric UI unlock succeeded");
      } else {
        // Full unlock — retrieve key from keychain and initialize subsystems
        vaultLog.info(`Biometric unlock at ${vaultDir}`);
        await cmd.biometricUnlock(vaultDir);
        set({
          isUnlocked: true,
          isUILocked: false,
          vaultDir,
          loading: false,
          biometricFailures: 0,
        });
        vaultLog.info("Biometric unlock succeeded");
        await get().loadConfig();
        if (get().config?.server_enabled) {
          useShareStore.getState().startPolling();
        }
        cmd.postUnlockInit().catch(() => {});
      }
      return true;
    } catch (e) {
      vaultLog.warn("Biometric unlock failed", e);
      const failures = get().biometricFailures + 1;
      set({ error: errorMessage(e), loading: false, biometricFailures: failures });
      // The app may have switched biometrics off during the attempt (the
      // keychain held another vault's key). Ask again so the button goes
      // and the message on screen is the only way left to unlock.
      await get().checkBiometric(vaultDir);
      return false;
    }
  },

  toggleBiometric: async (mode) => {
    const targetMode = mode ?? "disabled";
    try {
      if (targetMode === "disabled") {
        await cmd.biometricDisable();
        set({ biometricMode: "disabled" });
        vaultLog.info("Biometric disabled");
      } else {
        // Both "reauth" and "primary" enroll the same way (store key in keychain)
        await cmd.biometricEnroll(targetMode);
        set({ biometricMode: targetMode });
        vaultLog.info(`Biometric set to ${targetMode}`);
      }
      await get().loadConfig();
      return true;
    } catch (e) {
      vaultLog.warn("Biometric toggle failed", e);
      set({ error: errorMessage(e) });
      return false;
    }
  },

  recoverWithKey: async (recoveryKey, newPassword, vaultDir) => {
    set({ loading: true, error: null });
    try {
      vaultLog.info(`Recovering vault at ${vaultDir}`);
      const result = await cmd.recoverWithKey(recoveryKey, newPassword, vaultDir);
      set({
        isUnlocked: true,
        vaultDir,
        recoveryKey: result.recovery_key,
        loading: false,
        hasUnlockedWithPassword: true,
      });
      vaultLog.info("Vault recovered successfully");
      await get().loadConfig();
      if (get().config?.server_enabled) {
        useShareStore.getState().startPolling();
      }
      return result;
    } catch (e) {
      vaultLog.warn("Recovery failed", e);
      set({ error: errorMessage(e), loading: false });
      return null;
    }
  },

  clearError: () => set({ error: null }),
  clearRecoveryKey: () => set({ recoveryKey: null }),
}));
