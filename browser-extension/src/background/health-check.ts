// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { ApiClient } from "./api-client";
import type { ApiFeatures, ConnectionState } from "@/shared/types";
import { ApiError } from "./api-client";

/**
 * Periodic health check against /api/status.
 * Updates the extension badge and tracks connection + vault state.
 *
 * v2.0.0: also captures `vault_format_version` and the `features` capability
 * map so the popup can feature-detect (and warn the user when their desktop
 * is older than the extension expects).
 *
 * v2.0.2: also captures `vault_sync_version` so the popup can show the same
 * `v{n}` revision number that appears in the desktop's footer.
 */
export class HealthCheck {
  private state: ConnectionState = "disconnected";
  private version: string | undefined;
  private vaultFormatVersion: number | undefined;
  private vaultSyncVersion: number | undefined;
  private plan: string | undefined;
  private features: ApiFeatures | undefined;

  constructor(private api: ApiClient) {}

  updateApi(api: ApiClient) {
    this.api = api;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getVersion(): string | undefined {
    return this.version;
  }

  getVaultFormatVersion(): number | undefined {
    return this.vaultFormatVersion;
  }

  getVaultSyncVersion(): number | undefined {
    return this.vaultSyncVersion;
  }

  getPlan(): string | undefined {
    return this.plan;
  }

  getFeatures(): ApiFeatures | undefined {
    return this.features;
  }

  /** Run a single health check. Returns the new connection state. */
  async check(): Promise<ConnectionState> {
    try {
      const status = await this.api.getStatus();
      this.version = status.version;
      this.vaultFormatVersion = status.vault_format_version;
      this.vaultSyncVersion = status.vault_sync_version;
      this.plan = status.plan;
      this.features = status.features;

      if (status.vault_unlocked) {
        this.state = "connected";
        this.updateBadge("connected");
      } else {
        this.state = "vault_locked";
        this.updateBadge("vault_locked");
      }
    } catch (error) {
      // A 401 is the app answering: it is running, and it does not know
      // this token. Calling that "not connected" sent people to start an
      // app that was already open; the fix is to pair again.
      const refused = error instanceof ApiError && error.status === 401;
      this.state = refused ? "unauthorized" : "disconnected";
      this.version = undefined;
      this.vaultFormatVersion = undefined;
      this.vaultSyncVersion = undefined;
      this.features = undefined;
      this.updateBadge(this.state);
    }

    return this.state;
  }

  private updateBadge(state: ConnectionState) {
    const config: Record<ConnectionState, { text: string; color: string }> = {
      connected: { text: "", color: "#22c55e" },          // green — no badge text when connected
      vault_locked: { text: "!", color: "#eab308" },       // yellow warning
      disconnected: { text: "X", color: "#ef4444" },       // red
      permission_needed: { text: "?", color: "#3b82f6" },  // blue — needs user action
      desktop_too_old: { text: "↑", color: "#eab308" },    // yellow — update the desktop app
      unauthorized: { text: "!", color: "#eab308" },       // yellow — pair again
    };
    const { text, color } = config[state];
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  }
}
