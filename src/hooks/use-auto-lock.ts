// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useEffect, useRef } from "react";
import { useVaultStore } from "@/stores/vault-store";

const ACTIVITY_EVENTS = [
  "mousedown",
  "mousemove",
  "keydown",
  "scroll",
  "touchstart",
] as const;

/**
 * Auto-lock hook. Monitors user activity and locks the vault
 * after the configured idle timeout (default 15 minutes).
 *
 * Any of {@link ACTIVITY_EVENTS} resets the idle timer; when it finally elapses
 * the hook calls the same `lock("auto")` action used by manual locking. The
 * effect is only armed while the vault is unlocked and a config is loaded, and a
 * non-positive timeout (0 or negative `auto_lock_minutes`) disables it entirely.
 * This is the frontend half of idle protection; the Rust backend runs its own
 * key-lock watchdog independently.
 */
export function useAutoLock() {
  const config = useVaultStore((s) => s.config);
  const isUnlocked = useVaultStore((s) => s.isUnlocked);
  const lock = useVaultStore((s) => s.lock);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!isUnlocked || !config) return;

    const timeoutMs = (config.auto_lock_minutes ?? 15) * 60 * 1000;
    if (timeoutMs <= 0) return;

    function resetTimer() {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        lock("auto");
      }, timeoutMs);
    }

    // Start the timer
    resetTimer();

    // Reset on user activity
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, resetTimer, { passive: true });
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, resetTimer);
      }
    };
  }, [isUnlocked, config, lock]);
}
