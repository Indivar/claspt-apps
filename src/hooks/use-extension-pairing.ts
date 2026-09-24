// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The short window during which the browser extension may collect a key.
 *
 * Shared by the setup walkthrough and Settings > Integrations. It lived only
 * in the walkthrough, which meant the extension could be paired exactly once,
 * during first run: anyone who skipped that step, revoked the extension's key,
 * reinstalled the extension, or moved to a new browser had no way back in.
 *
 * The window closing after it opened is what tells us the extension took the
 * key. There is nothing else to observe — the desktop hands the key to whoever
 * asks within the window, and the extension does not report back.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as cmd from "@/lib/commands";

export interface ExtensionPairing {
  /** A window is open and the extension may collect its key now. */
  pairing: boolean;
  /** How long the open window has left. */
  secondsLeft: number;
  /** A key was collected while we were watching. */
  connected: boolean;
  begin: () => Promise<void>;
  cancel: () => void;
}

export function useExtensionPairing(): ExtensionPairing {
  const [pairing, setPairing] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [connected, setConnected] = useState(false);
  const wasArmed = useRef(false);

  const begin = useCallback(async () => {
    try {
      // The extension decrypts in order to fill a password, and now to fill an
      // identity, so it is the one client that genuinely needs the secrets
      // scope.
      await cmd.beginExtensionPairing("secrets");
      wasArmed.current = false;
      setConnected(false);
      setPairing(true);
    } catch {
      setPairing(false);
    }
  }, []);

  const cancel = useCallback(() => {
    setPairing(false);
    void cmd.cancelExtensionPairing().catch(() => {});
  }, []);

  useEffect(() => {
    if (!pairing) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await cmd.extensionPairingStatus();
        if (cancelled) return;
        if (status.armed) {
          wasArmed.current = true;
          setSecondsLeft(status.secondsLeft);
          return;
        }
        if (wasArmed.current) setConnected(true);
        setPairing(false);
      } catch {
        if (!cancelled) setPairing(false);
      }
    };

    void poll();
    const id = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pairing]);

  // Leaving the screen closes the window rather than letting it sit open with
  // a key available to anything that asks.
  useEffect(() => () => void cmd.cancelExtensionPairing().catch(() => {}), []);

  return { pairing, secondsLeft, connected, begin, cancel };
}
