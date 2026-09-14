// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Top-of-window banner that checks for app updates via the Tauri updater on mount.
 * When an update is available it offers install-and-restart, streaming download
 * progress and relaunching the app when finished. Dismissible per the share store.
 */
import { useCallback, useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useShareStore } from "@/stores/share-store";
import { APP_VERSION } from "@/lib/version";

type UpdateState = "idle" | "available" | "downloading" | "ready";

/** Auto-update banner: detects, downloads, and installs a new app version. */
export function UpdateBanner() {
  const { updateDismissed, dismissUpdate } = useShareStore();
  const [state, setState] = useState<UpdateState>("idle");
  const [version, setVersion] = useState("");
  const [progress, setProgress] = useState(0);
  const [updateRef, setUpdateRef] = useState<Awaited<ReturnType<typeof check>> | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    check()
      .then((update) => {
        if (cancelled) return;
        if (update) {
          setVersion(update.version);
          setUpdateRef(update);
          setState("available");
        }
      })
      .catch(() => {
        // Update check failed — silently ignore (offline, server down, etc.)
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleInstall = useCallback(async () => {
    if (!updateRef) return;
    setState("downloading");
    let totalBytes = 0;
    let downloadedBytes = 0;
    await updateRef.downloadAndInstall((event) => {
      if (event.event === "Started" && event.data.contentLength) {
        totalBytes = event.data.contentLength;
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        if (totalBytes > 0) {
          setProgress(Math.round((downloadedBytes / totalBytes) * 100));
        }
      } else if (event.event === "Finished") {
        setState("ready");
      }
    });
    await relaunch();
  }, [updateRef]);

  if (state === "idle" || updateDismissed) return null;

  return (
    <div className="flex items-center gap-3 border-b border-accent/20 bg-accent/5 px-4 py-2">
      <div className="flex-1">
        {state === "available" && (
          <p className="text-[13px] text-text-primary">
            <span className="font-medium text-accent">Update v{version}</span> available{" "}
            <span className="text-text-muted">(current: v{APP_VERSION})</span>
          </p>
        )}
        {state === "downloading" && (
          <div className="flex items-center gap-3">
            <p className="text-[13px] text-text-primary">Downloading update...</p>
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-border/40">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-[11px] text-text-muted">{progress}%</span>
          </div>
        )}
        {state === "ready" && (
          <p className="text-[13px] text-text-primary">Update ready. Restarting...</p>
        )}
      </div>

      {state === "available" && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleInstall}
            className="rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-white transition-all hover:bg-accent-hover active:scale-95"
          >
            Install &amp; Restart
          </button>
          <button
            onClick={dismissUpdate}
            className="rounded-lg px-2 py-1 text-[12px] text-text-muted transition-all hover:bg-surface-overlay active:scale-95"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
