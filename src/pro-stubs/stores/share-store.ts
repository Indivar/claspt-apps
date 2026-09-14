// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Stand-in for the share store in a build without the sharing server:
 * no shares, no server update check, no email registration. The app's own
 * updater is separate and unaffected. See src/pro-stubs/README.md.
 */
import { create } from "zustand";
import type { CheckResponse, PendingShare, UpdateInfo } from "@claspt/shared/types";

type RegistrationStep = "idle" | "code_sent" | "verified";

interface ShareStore {
  pendingShares: PendingShare[];
  availableUpdate: UpdateInfo | null;
  updateDismissed: boolean;
  lastCheck: string | null;
  checking: boolean;
  checkError: string | null;
  pollIntervalId: ReturnType<typeof setInterval> | null;
  email: string | null;
  emailVerified: boolean;
  registrationStep: RegistrationStep;
  registering: boolean;
  registrationError: string | null;
  check: () => Promise<CheckResponse | null>;
  loadEmailState: () => Promise<void>;
  startPolling: (intervalMs?: number) => void;
  stopPolling: () => void;
  clearShares: () => void;
  dismissUpdate: () => void;
  registerEmail: (email: string) => Promise<boolean>;
  verifyCode: (code: string) => Promise<boolean>;
  resetRegistration: () => void;
}

export const useShareStore = create<ShareStore>((set) => ({
  pendingShares: [],
  availableUpdate: null,
  updateDismissed: false,
  lastCheck: null,
  checking: false,
  checkError: null,
  pollIntervalId: null,
  email: null,
  emailVerified: false,
  registrationStep: "idle",
  registering: false,
  registrationError: null,
  check: async () => null,
  loadEmailState: async () => {},
  startPolling: () => {},
  stopPolling: () => {},
  clearShares: () => set({ pendingShares: [] }),
  dismissUpdate: () => set({ updateDismissed: true }),
  registerEmail: async () => false,
  verifyCode: async () => false,
  resetRegistration: () => set({ registrationStep: "idle", registrationError: null }),
}));
