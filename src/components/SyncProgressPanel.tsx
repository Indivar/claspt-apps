// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * SyncProgressPanel — the steps of a running fresh-copy push, the current
 * one marked, with the elapsed time. Fed by the sync store, which forwards
 * the backend's progress lines. Nothing here predicts how long the upload
 * will take: the size and the clock are what is known.
 */
import { useEffect, useState } from "react";
import { useSyncStore } from "@/stores/sync-store";
import { elapsedSeconds, stageLabel } from "@/lib/sync-progress";

/** A clock that ticks once a second while mounted. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function SyncProgressPanel({ stages }: { stages: readonly string[] }) {
  const progress = useSyncStore((s) => s.identityProgress);
  const startedAt = useSyncStore((s) => s.identityStartedAt);
  const now = useNow();
  const current = progress ? stages.indexOf(progress.stage) : -1;
  const elapsed = startedAt != null ? elapsedSeconds(startedAt, now) : 0;

  return (
    <div role="status" aria-live="polite" className="space-y-2">
      <ol className="space-y-1">
        {stages.map((stage, index) => {
          const state =
            index < current ? "done" : index === current ? "current" : "pending";
          return (
            <li
              key={stage}
              className={`flex items-center gap-2 text-[12px] ${
                state === "current"
                  ? "text-text-primary"
                  : state === "done"
                    ? "text-text-muted"
                    : "text-text-muted/50"
              }`}
            >
              <span aria-hidden="true" className="w-4 text-center">
                {state === "done" ? "✓" : state === "current" ? "…" : "·"}
              </span>
              <span>
                {state === "current" && progress
                  ? stageLabel(stage, progress.bytes)
                  : stageLabel(stage, null)}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-[11px] text-text-muted">
        {elapsed} s so far. A large vault takes a few minutes to pack and upload.
      </p>
    </div>
  );
}
