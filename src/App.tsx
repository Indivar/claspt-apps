// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * App — the root component and boot/lifecycle coordinator.
 *
 * Responsibilities:
 *  - **Unlock gate:** renders {@link UnlockScreen} until the vault is both
 *    backend-unlocked (`isUnlocked`) and not UI-locked (`isUILocked`), then swaps
 *    in the lazily-loaded {@link AppShell} (defers ~275KB of editor JS past unlock).
 *  - **Boot polish:** fades out the inline HTML splash once React mounts, and
 *    wraps the shell in a {@link ShellErrorBoundary} so a chunk-load/render error
 *    shows a reload panel instead of hanging on the Suspense fallback.
 *  - **Tauri event wiring:** listens for tray/watchdog lock events
 *    (`vault-lock-requested`, `vault-auto-lock`, `vault-key-locked`).
 *  - **Window state:** restores saved size/position after unlock (falling back to
 *    maximize when the saved rect would be off-screen — see
 *    {@link isSavedRectVisible}) and persists it on close.
 *
 * This file is intentionally the only place that talks to Tauri window/event APIs
 * directly; everything else goes through stores and `@/lib/commands`.
 */
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  Component,
  type ReactNode,
  type ErrorInfo,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Toaster } from "sonner";
import { SecretApprovalDialog } from "@/components/SecretApprovalDialog";
import { UnlockScreen } from "@/components/UnlockScreen";

import { useUIStore, applyThemeClasses } from "@/stores/ui-store";
import { useVaultStore } from "@/stores/vault-store";
import { log } from "@/lib/logger";

/** Lazy-load the full app shell (editor, sidebar, panels, modals).
 *  Defers ~275KB+ of JS (CodeMirror, marked, etc.) until after unlock. */
const AppShell = lazy(() => {
  log.debug("[BOOT] Starting AppShell lazy import...");
  return import("@/components/AppShell")
    .then((mod) => {
      log.debug("[BOOT] AppShell module loaded successfully");
      return mod;
    })
    .catch((err) => {
      log.error("[BOOT] AppShell import FAILED:", err);
      console.error("[BOOT] AppShell import FAILED:", err);
      throw err;
    });
});

/** Fade out and remove the inline splash screen from index.html. */
function dismissSplash() {
  log.debug("[BOOT] dismissSplash called");
  const splash = document.getElementById("splash");
  if (splash) {
    splash.classList.add("fade-out");
    setTimeout(() => splash.remove(), 300);
  } else {
    log.debug("[BOOT] splash element already gone");
  }
}

/** Error boundary to surface render errors instead of hanging on Suspense fallback. */
class ShellErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error("[BOOT] AppShell render error:", error.message, info.componentStack);
    console.error("[ShellErrorBoundary]", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen items-center justify-center bg-surface p-8">
          <div className="max-w-lg rounded-xl border border-danger/30 bg-danger/5 p-6">
            <h2 className="text-sm font-bold text-danger">Failed to load workspace</h2>
            <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap text-xs text-text-muted">
              {this.state.error.message}
              {"\n\n"}
              {this.state.error.stack}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** A saved window rectangle in logical (DPI-independent) pixels. */
type SavedRect = { x: number; y: number; width: number; height: number };

/**
 * Describes a monitor's available area in logical pixels. Matches the shape
 * of Tauri's `Monitor` where we care about `position` + `size` (both scale
 * by `scaleFactor` to produce logical coords).
 */
type MonitorInfo = {
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
};

/**
 * Decide whether a saved window rectangle is "visible enough" to be safe to
 * restore on the current monitor set. Return `true` to use the saved
 * position, `false` to fall back to `win.maximize()`.
 *
 * Why this matters:
 *  - Windows can legitimately park a window a few pixels past a monitor edge.
 *  - A taskbar-preview-only-visible window (the bug we're fixing) has its
 *    top-left inside a monitor but only 1-2px of the rect overlaps visible
 *    area — we want that to fail the check.
 *  - Multi-monitor roaming: a rect valid on the origin machine may land on
 *    no current monitor at all on the restore machine.
 *
 * Constraints:
 *  - `monitors` is in *physical* pixels (position and size). Divide each by
 *    its own `scaleFactor` to compare with the saved *logical* rect.
 *  - Return `true` only if enough of the rect intersects the union of
 *    visible monitor areas that a user could grab the title bar and move it.
 *
 * The rect is considered visible if it overlaps any monitor by at least ~50% of
 * its area, or exposes a draggable title-bar-sized strip at the top. Zero- or
 * negative-sized rects always fail.
 */
function isSavedRectVisible(rect: SavedRect, monitors: MonitorInfo[]): boolean {
  if (rect.width <= 0 || rect.height <= 0 || monitors.length === 0) return false;
  const rectArea = rect.width * rect.height;
  const TITLE_BAR_H = 32;
  const MIN_GRAB_W = 100;
  for (const m of monitors) {
    const mx = m.position.x / m.scaleFactor;
    const my = m.position.y / m.scaleFactor;
    const mw = m.size.width / m.scaleFactor;
    const mh = m.size.height / m.scaleFactor;
    const ix = Math.max(0, Math.min(rect.x + rect.width, mx + mw) - Math.max(rect.x, mx));
    const iy = Math.max(
      0,
      Math.min(rect.y + rect.height, my + mh) - Math.max(rect.y, my),
    );
    const titleOverlapW = Math.max(
      0,
      Math.min(rect.x + rect.width, mx + mw) - Math.max(rect.x, mx),
    );
    const titleInsideY = rect.y + TITLE_BAR_H > my && rect.y < my + mh;
    if (ix * iy >= rectArea * 0.5 && titleInsideY && titleOverlapW >= MIN_GRAB_W) {
      return true;
    }
  }
  return false;
}

/** Minimal loading skeleton shown while AppShell chunk loads after unlock. */
function ShellSkeleton() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
        <span className="text-xs text-text-muted">Loading workspace...</span>
      </div>
    </div>
  );
}

function App() {
  log.debug("[BOOT] App render, isUnlocked:", useVaultStore.getState().isUnlocked);
  const isUnlocked = useVaultStore((s) => s.isUnlocked);
  const isUILocked = useVaultStore((s) => s.isUILocked);
  const theme = useUIStore((s) => s.theme);
  const splashDismissed = useRef(false);

  useEffect(() => {
    applyThemeClasses(theme);
  }, [theme]);

  useEffect(() => {
    log.debug("[BOOT] App mounted");
    if (splashDismissed.current) return;
    splashDismissed.current = true;
    requestAnimationFrame(() => {
      dismissSplash();
    });
  }, []);

  // Listen for tray "Lock Vault" event (manual) — UI lock only
  useEffect(() => {
    const unlisten = listen("vault-lock-requested", () => {
      useVaultStore.getState().lock("manual");
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Listen for backend auto-lock watchdog event — UI lock only
  useEffect(() => {
    const unlisten = listen("vault-auto-lock", () => {
      useVaultStore.getState().lock("auto");
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Listen for key-lock event (master key zeroed by key_lock_minutes timer)
  useEffect(() => {
    const unlisten = listen("vault-key-locked", () => {
      // Key is zeroed — need full re-unlock with password next time
      useVaultStore.setState({ isUnlocked: false, isUILocked: false, lockReason: "key" });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Restore saved window size/position after unlock, or maximize on first run.
  // Always finishes with show/unminimize/setFocus so the window is surfaced
  // even if its state got wedged during a long restore operation.
  const windowRestored = useRef(false);
  const config = useVaultStore((s) => s.config);
  useEffect(() => {
    if (!isUnlocked || !config || windowRestored.current) return;
    windowRestored.current = true;

    const win = getCurrentWindow();
    (async () => {
      try {
        const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/dpi");
        const { availableMonitors } = await import("@tauri-apps/api/window");
        const monitors = await availableMonitors();

        if (config.window_maximized) {
          await win.maximize();
        } else if (
          config.window_width != null &&
          config.window_height != null &&
          config.window_x != null &&
          config.window_y != null &&
          isSavedRectVisible(
            {
              x: config.window_x,
              y: config.window_y,
              width: config.window_width,
              height: config.window_height,
            },
            monitors,
          )
        ) {
          await win.setSize(new LogicalSize(config.window_width, config.window_height));
          await win.setPosition(new LogicalPosition(config.window_x, config.window_y));
        } else {
          // First launch, no saved state, or saved rect is off-screen on this monitor set.
          await win.maximize();
        }
      } catch (e) {
        log.warn("[WINDOW] Failed to restore window state:", e);
        try {
          await win.maximize();
        } catch {
          /* last-resort; swallow */
        }
      }

      // Always surface the window regardless of which branch ran. Guards
      // against Windows cases where the HWND is alive but the WebView has
      // lost its frame (taskbar thumbnail renders but window is invisible).
      try {
        await win.show();
        await win.unminimize();
        await win.setFocus();
      } catch (e) {
        log.warn("[WINDOW] Failed to surface window:", e);
      }
    })();
  }, [isUnlocked, config]);

  // Save window size/position on close, then destroy window
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (event) => {
      event.preventDefault(); // Prevent default close — we'll close manually after saving
      try {
        const cfg = useVaultStore.getState().config;
        if (cfg) {
          const maximized = await win.isMaximized();
          const size = await win.innerSize();
          const pos = await win.outerPosition();
          const scaleFactor = await win.scaleFactor();
          await useVaultStore.getState().updateConfig({
            ...cfg,
            window_maximized: maximized,
            window_width: Math.round(size.width / scaleFactor),
            window_height: Math.round(size.height / scaleFactor),
            window_x: Math.round(pos.x / scaleFactor),
            window_y: Math.round(pos.y / scaleFactor),
          });
        }
      } catch (e) {
        log.warn("[WINDOW] Failed to save window state:", e);
      }
      // Close the window after saving (or on error)
      await win.destroy();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <div className="h-screen overflow-hidden bg-surface text-text-primary">
      {isUnlocked && !isUILocked ? (
        <ShellErrorBoundary>
          <Suspense fallback={<ShellSkeleton />}>
            <AppShell />
          </Suspense>
        </ShellErrorBoundary>
      ) : (
        <UnlockScreen />
      )}
      <SecretApprovalDialog />
      <Toaster theme="dark" position="bottom-right" richColors />
    </div>
  );
}

export default App;
