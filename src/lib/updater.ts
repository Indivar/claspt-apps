// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The one way an update gets onto this machine: through the updater plugin,
 * which fetches the signed manifest and verifies the minisign signature
 * before anything is written. The settings screen used to render the
 * server's download URL as a plain link, which skipped that check entirely;
 * both the banner and the settings screen now go through here.
 */
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Where the download stands, as a percentage, or null before the size is known. */
export interface DownloadProgress {
  total: number;
  downloaded: number;
  percent: number | null;
  finished: boolean;
}

export const NO_PROGRESS: DownloadProgress = {
  total: 0,
  downloaded: 0,
  percent: null,
  finished: false,
};

/** Fold one updater event into the running progress. Pure, so it is tested. */
export function reduceProgress(
  state: DownloadProgress,
  event: DownloadEvent,
): DownloadProgress {
  switch (event.event) {
    case "Started": {
      const total = event.data.contentLength ?? 0;
      return { ...state, total, percent: total > 0 ? 0 : null };
    }
    case "Progress": {
      const downloaded = state.downloaded + event.data.chunkLength;
      const percent =
        state.total > 0
          ? Math.min(100, Math.round((downloaded / state.total) * 100))
          : null;
      return { ...state, downloaded, percent };
    }
    case "Finished":
      return { ...state, finished: true, percent: state.total > 0 ? 100 : state.percent };
    default:
      return state;
  }
}

/** Ask the updater whether a signed update exists for this build. */
export function checkForSignedUpdate(): Promise<Update | null> {
  return check();
}

/** Download, verify, install and relaunch, reporting progress as it goes. */
export async function installUpdate(
  update: Update,
  onProgress: (progress: DownloadProgress) => void,
): Promise<void> {
  let progress = NO_PROGRESS;
  await update.downloadAndInstall((event) => {
    progress = reduceProgress(progress, event);
    onProgress(progress);
  });
  await relaunch();
}
