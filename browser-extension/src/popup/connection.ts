// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { ConnectionState, Message } from "@/shared/types";

type StatusResult = Extract<Message, { type: "STATUS_RESULT" }>;

/** The popup's connection state for a status answer from the background. */
export function connectionFromStatus(status: StatusResult): ConnectionState {
  if (status.permissionNeeded) return "permission_needed";
  if (status.desktopTooOld) return "desktop_too_old";
  if (status.tokenRejected) return "unauthorized";
  if (status.connected) return "connected";
  return status.vaultUnlocked ? "vault_locked" : "disconnected";
}
