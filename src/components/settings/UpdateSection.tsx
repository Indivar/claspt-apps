// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * UpdateSection — settings widget showing the current app version and, when the
 * share store reports one, an available update with release notes and a download
 * link. Also exposes a manual "Check for Updates" action.
 */
import { useShareStore } from "@/stores/share-store";
import { checkForSignedUpdate, installUpdate } from "@/lib/updater";
import { useCallback, useState } from "react";
import { APP_VERSION } from "@/lib/version";

/** Renders current version, any available update, and a manual update-check button. */
export function UpdateSection() {
  const { availableUpdate, checking, check } = useShareStore();
  const [installing, setInstalling] = useState(false);
  const [installPercent, setInstallPercent] = useState<number | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const installFromSettings = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const update = await checkForSignedUpdate();
      if (!update) {
        setInstallError("No signed update is available for this build yet.");
        return;
      }
      await installUpdate(update, (p) => setInstallPercent(p.percent));
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-text-primary">
          Current version: <span className="font-mono font-medium">v{APP_VERSION}</span>
        </p>
      </div>

      {availableUpdate ? (
        <div className="flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5">
          <div className="flex-1">
            <p className="text-[13px] font-medium text-accent">
              v{availableUpdate.version} available
            </p>
            {availableUpdate.notes && (
              <p className="mt-0.5 text-[11px] text-text-muted">
                {availableUpdate.notes}
              </p>
            )}
            {installError && (
              <p className="mt-0.5 text-[11px] text-danger">{installError}</p>
            )}
          </div>
          {/* Through the updater, never the server's URL as a link: the
              updater verifies the manifest's signature before it writes a
              byte, and a raw link did not. */}
          <button
            onClick={() => void installFromSettings()}
            disabled={installing}
            className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-all hover:bg-accent-hover active:scale-95 disabled:opacity-60"
          >
            {installing
              ? installPercent === null
                ? "Downloading…"
                : `Downloading ${installPercent}%`
              : "Install update"}
          </button>
        </div>
      ) : (
        <p className="text-[12px] text-text-muted">
          {checking ? "Checking for updates..." : "You're on the latest version."}
        </p>
      )}

      <button
        onClick={() => check()}
        disabled={checking}
        className="rounded-lg border border-border/60 px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-all hover:bg-surface-overlay active:scale-95 disabled:opacity-50"
      >
        {checking ? "Checking..." : "Check for Updates"}
      </button>
    </div>
  );
}
