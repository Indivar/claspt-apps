// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ServerStatus — settings widget showing when the app last polled the share
 * server and letting the user trigger an on-demand check. Reflects connection
 * errors from the share store.
 */
import { useShareStore } from "@/stores/share-store";

/** Displays last-check time, a "Check Now" button, and any reachability error. */
export function ServerStatus() {
  const { lastCheck, checking, checkError, check } = useShareStore();
  const formattedLastCheck = lastCheck
    ? new Date(lastCheck).toLocaleTimeString()
    : "Never";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] text-text-muted">Last check: {formattedLastCheck}</p>
        </div>
        <button
          onClick={() => check()}
          disabled={checking}
          className="rounded-lg border border-border/60 px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-all hover:bg-surface-overlay active:scale-95 disabled:opacity-50"
        >
          {checking ? "Checking..." : "Check Now"}
        </button>
      </div>
      {checkError && (
        <p className="rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">
          Could not reach server. Will retry automatically.
        </p>
      )}
    </div>
  );
}
