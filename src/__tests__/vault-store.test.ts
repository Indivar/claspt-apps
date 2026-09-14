// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useVaultStore } from "@/stores/vault-store";
import * as cmd from "@/lib/commands";

vi.mock("@/lib/commands", () => ({
  createVault: vi.fn(),
  unlockVault: vi.fn(),
  lockVault: vi.fn(),
  getVaultConfig: vi.fn(),
  setVaultConfig: vi.fn(),
  biometricAvailable: vi.fn(),
  biometricStatus: vi.fn(),
  biometricUnlock: vi.fn(),
  biometricEnroll: vi.fn(),
  biometricDisable: vi.fn(),
  biometricVerify: vi.fn(),
  touchActivity: vi.fn(),
  // Fire-and-forget post-unlock init; the store calls `.catch()` on its result,
  // so it must return a promise.
  postUnlockInit: vi.fn(() => Promise.resolve()),
}));

// Mock share-store to prevent cross-store side effects
vi.mock("@/stores/share-store", () => ({
  useShareStore: {
    getState: () => ({
      startPolling: vi.fn(),
      stopPolling: vi.fn(),
    }),
    setState: vi.fn(),
  },
}));

// Mock sync-store to prevent cross-store side effects
vi.mock("@/stores/sync-store", () => ({
  useSyncStore: {
    setState: vi.fn(),
  },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockCmd = vi.mocked(cmd);

const fakeConfig = {
  vault_version: "1",
  vault_id: null,
  theme: "dark",
  editor_font_size: 14,
  editor_font_family: "monospace",
  auto_save_delay_ms: 2000,
  clipboard_clear_seconds: 30,
  secret_auto_hide_seconds: 30,
  auto_lock_minutes: 5,
  biometric_mode: "disabled",
  sync_backend: "none",
  sync_remote_url: null,
  sync_interval_seconds: 300,
  license_key: null,
  last_opened_page_id: null,
  encrypted_page_display: "placeholder",
  ui_scale: 1.0,
};

describe("useVaultStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({
      isUnlocked: false,
      vaultDir: null,
      config: null,
      recoveryKey: null,
      error: null,
      loading: false,
      biometricAvailable: false,
      biometricMode: "disabled",
      biometricFailures: 0,
      hasUnlockedWithPassword: false,
    });
  });

  it("has correct initial state", () => {
    const state = useVaultStore.getState();
    expect(state.isUnlocked).toBe(false);
    expect(state.vaultDir).toBeNull();
    expect(state.config).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("createVault sets unlocked state and recovery key", async () => {
    mockCmd.createVault.mockResolvedValue({ recovery_key: "abc-recovery" });
    mockCmd.getVaultConfig.mockResolvedValue(fakeConfig);

    const result = await useVaultStore.getState().createVault("password123!", "/path");

    expect(result).toEqual({ recovery_key: "abc-recovery" });
    expect(useVaultStore.getState().isUnlocked).toBe(true);
    expect(useVaultStore.getState().vaultDir).toBe("/path");
    expect(useVaultStore.getState().recoveryKey).toBe("abc-recovery");
    expect(useVaultStore.getState().loading).toBe(false);
  });

  it("createVault handles errors", async () => {
    mockCmd.createVault.mockRejectedValue(new Error("weak password"));
    const result = await useVaultStore.getState().createVault("short", "/path");
    expect(result).toBeNull();
    expect(useVaultStore.getState().error).toContain("weak password");
    expect(useVaultStore.getState().isUnlocked).toBe(false);
  });

  it("unlock sets unlocked state", async () => {
    mockCmd.unlockVault.mockResolvedValue(undefined);
    mockCmd.getVaultConfig.mockResolvedValue(fakeConfig);

    const ok = await useVaultStore.getState().unlock("password123!", "/vault");

    expect(ok).toBe(true);
    expect(useVaultStore.getState().isUnlocked).toBe(true);
    expect(useVaultStore.getState().hasUnlockedWithPassword).toBe(true);
    expect(useVaultStore.getState().biometricFailures).toBe(0);
  });

  it("unlock returns false on wrong password", async () => {
    mockCmd.unlockVault.mockRejectedValue(new Error("Invalid password"));
    const ok = await useVaultStore.getState().unlock("wrong", "/vault");
    expect(ok).toBe(false);
    expect(useVaultStore.getState().error).toContain("Invalid password");
  });

  it("lock sets UI lock without clearing vault state", async () => {
    useVaultStore.setState({ isUnlocked: true, vaultDir: "/v", config: fakeConfig });
    mockCmd.lockVault.mockResolvedValue(undefined);

    await useVaultStore.getState().lock();

    // UI lock keeps isUnlocked true — backend stays operational
    expect(useVaultStore.getState().isUnlocked).toBe(true);
    expect(useVaultStore.getState().isUILocked).toBe(true);
    // Vault dir and config remain — only the UI overlay is shown
    expect(useVaultStore.getState().vaultDir).toBe("/v");
    expect(useVaultStore.getState().config).toEqual(fakeConfig);
  });

  it("loadConfig fetches and sets config", async () => {
    mockCmd.getVaultConfig.mockResolvedValue(fakeConfig);
    await useVaultStore.getState().loadConfig();
    expect(useVaultStore.getState().config).toEqual(fakeConfig);
  });

  it("updateConfig saves and sets config", async () => {
    mockCmd.setVaultConfig.mockResolvedValue(undefined);
    await useVaultStore.getState().updateConfig(fakeConfig);
    expect(mockCmd.setVaultConfig).toHaveBeenCalledWith(fakeConfig);
    expect(useVaultStore.getState().config).toEqual(fakeConfig);
  });

  it("checkBiometric detects availability", async () => {
    mockCmd.biometricAvailable.mockResolvedValue(true);
    mockCmd.biometricStatus.mockResolvedValue("primary");
    await useVaultStore.getState().checkBiometric();
    expect(useVaultStore.getState().biometricAvailable).toBe(true);
    expect(useVaultStore.getState().biometricMode).toBe("primary");
  });

  it("checkBiometric handles unavailable", async () => {
    mockCmd.biometricAvailable.mockResolvedValue(false);
    await useVaultStore.getState().checkBiometric();
    expect(useVaultStore.getState().biometricAvailable).toBe(false);
    expect(useVaultStore.getState().biometricMode).toBe("disabled");
  });

  it("unlockWithBiometric increments failures on error", async () => {
    mockCmd.biometricUnlock.mockRejectedValue(new Error("fingerprint mismatch"));
    await useVaultStore.getState().unlockWithBiometric("/vault");
    expect(useVaultStore.getState().biometricFailures).toBe(1);
    await useVaultStore.getState().unlockWithBiometric("/vault");
    expect(useVaultStore.getState().biometricFailures).toBe(2);
  });

  it("unlockWithBiometric resets failures on success", async () => {
    useVaultStore.setState({ biometricFailures: 2 });
    mockCmd.biometricUnlock.mockResolvedValue(undefined);
    mockCmd.getVaultConfig.mockResolvedValue(fakeConfig);
    await useVaultStore.getState().unlockWithBiometric("/vault");
    expect(useVaultStore.getState().biometricFailures).toBe(0);
    expect(useVaultStore.getState().isUnlocked).toBe(true);
  });

  it("toggleBiometric enables mode", async () => {
    mockCmd.biometricEnroll.mockResolvedValue(undefined);
    mockCmd.getVaultConfig.mockResolvedValue(fakeConfig);
    const ok = await useVaultStore.getState().toggleBiometric("/vault", "primary");
    expect(ok).toBe(true);
    expect(useVaultStore.getState().biometricMode).toBe("primary");
    expect(mockCmd.biometricEnroll).toHaveBeenCalledWith("/vault", "primary");
  });

  it("toggleBiometric disables mode", async () => {
    mockCmd.biometricDisable.mockResolvedValue(undefined);
    mockCmd.getVaultConfig.mockResolvedValue(fakeConfig);
    const ok = await useVaultStore.getState().toggleBiometric("/vault", "disabled");
    expect(ok).toBe(true);
    expect(useVaultStore.getState().biometricMode).toBe("disabled");
  });

  it("clearError and clearRecoveryKey work", () => {
    useVaultStore.setState({ error: "oops", recoveryKey: "key" });
    useVaultStore.getState().clearError();
    expect(useVaultStore.getState().error).toBeNull();
    useVaultStore.getState().clearRecoveryKey();
    expect(useVaultStore.getState().recoveryKey).toBeNull();
  });
});
