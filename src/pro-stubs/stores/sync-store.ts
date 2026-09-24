// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Stand-in for the sync store in a build without sync. Every action resolves
 * at once; status stays "not configured". See src/pro-stubs/README.md.
 */
import { create } from "zustand";
import type { MergeNotice, ResolvedPage, SyncProgress } from "@/lib/commands";
import type { ConflictInfo, SyncResolution, SyncStatus } from "@claspt/shared/types";

/**
 * A registered device, mirrored here rather than imported: the module that
 * declares the sync protocol is not part of this build. Only the device
 * listing is reproduced, not the manifest or bundle format. The contract
 * test in src/__tests__ fails if this drifts from the real declaration.
 */
interface DeviceInfo {
  device_id: string;
  name: string;
  platform: string;
  last_seen: string;
  sync_version: number;
}

export interface V2Status {
  configured: boolean;
  engine_active: boolean;
  backend?: string;
  group_id?: string;
  device_id?: string;
  last_synced_version?: number;
  server_url?: string;
  merge_notices_pending?: number;
  vault_mismatch?: { local: string; remote: string } | null;
}

/** Mirrors the real result; this build never produces one. */
interface AdoptAccountVaultResult {
  previous_vault_id: string | null;
  vault_id: string;
  biometric: "moved" | "off" | "none";
  pushed_version: number | null;
  push_error: string | null;
}

interface SyncStore {
  status: SyncStatus | null;
  syncing: boolean;
  conflicts: ConflictInfo[];
  conflictModalOpen: boolean;
  error: string | null;
  v2Status: V2Status | null;
  devicesV2: DeviceInfo[];
  mergeNotices: MergeNotice[];
  mergeNoticesOpen: boolean;
  identityDialogOpen: boolean;
  identityDismissed: string | null;
  identityProgress: SyncProgress | null;
  identityStartedAt: number | null;
  fetchStatus: () => Promise<void>;
  syncNow: () => Promise<void>;
  configure: (
    backend: string,
    remoteUrl?: string,
    intervalSecs?: number,
  ) => Promise<void>;
  stop: () => Promise<void>;
  resolveConflict: (path: string, resolution: SyncResolution) => Promise<void>;
  setConflictModalOpen: (open: boolean) => void;
  setupV2: (backend: string, serverUrl: string) => Promise<void>;
  fetchV2Status: () => Promise<void>;
  pushV2: () => Promise<void>;
  pullV2: () => Promise<void>;
  syncV2: () => Promise<void>;
  fetchDevicesV2: () => Promise<void>;
  removeDeviceV2: (deviceId: string) => Promise<void>;
  disableV2: () => Promise<void>;
  fetchMergeNotices: () => Promise<void>;
  dismissMergeNotices: () => Promise<void>;
  setMergeNoticesOpen: (open: boolean) => void;
  announceResolved: (resolved: ResolvedPage[]) => Promise<void>;
  setIdentityDialogOpen: (open: boolean) => void;
  adoptAccountVault: (password: string) => Promise<AdoptAccountVaultResult | null>;
  retryFreshCopy: () => Promise<{ version: number; bytes_uploaded: number } | null>;
}

const done = async () => {};

export const useSyncStore = create<SyncStore>((set) => ({
  status: null,
  syncing: false,
  conflicts: [],
  conflictModalOpen: false,
  error: null,
  v2Status: null,
  devicesV2: [],
  mergeNotices: [],
  mergeNoticesOpen: false,
  identityDialogOpen: false,
  identityDismissed: null,
  identityProgress: null,
  identityStartedAt: null,
  fetchStatus: done,
  syncNow: done,
  configure: done,
  stop: done,
  resolveConflict: done,
  setConflictModalOpen: (open) => set({ conflictModalOpen: open }),
  setupV2: done,
  fetchV2Status: done,
  pushV2: done,
  pullV2: done,
  syncV2: done,
  fetchDevicesV2: done,
  removeDeviceV2: done,
  disableV2: done,
  fetchMergeNotices: done,
  dismissMergeNotices: done,
  setMergeNoticesOpen: (open) => set({ mergeNoticesOpen: open }),
  announceResolved: done,
  setIdentityDialogOpen: (open) => set({ identityDialogOpen: open }),
  adoptAccountVault: async () => null,
  retryFreshCopy: async () => null,
}));
