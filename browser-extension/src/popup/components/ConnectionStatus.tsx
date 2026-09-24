// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React from "react";
import type { ConnectionState } from "@/shared/types";

interface Props {
  state: ConnectionState;
  version?: string;
}

const statusConfig: Record<ConnectionState, { label: string; color: string }> = {
  connected: { label: "Connected", color: "#22c55e" },
  vault_locked: { label: "Vault Locked", color: "#eab308" },
  disconnected: { label: "Disconnected", color: "#ef4444" },
  permission_needed: { label: "Permission needed", color: "#3b82f6" },
  desktop_too_old: { label: "Update the desktop app", color: "#eab308" },
  unauthorized: { label: "Key refused, pair again", color: "#eab308" },
};

export function ConnectionStatus({ state, version }: Props) {
  const { label, color } = statusConfig[state];

  return (
    <div style={styles.container}>
      <div style={{ ...styles.dot, backgroundColor: color }} />
      <span style={styles.label}>
        {label}
        {version && state === "connected" ? ` v${version}` : ""}
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
  },
  label: {
    fontSize: 11,
    color: "#8b949e",
  },
};
