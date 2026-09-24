// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Pair the browser extension, from Settings.
 *
 * This existed only in the first-run walkthrough, so the extension could be
 * paired exactly once. Skipping that step, revoking the extension's key,
 * reinstalling the extension, or moving to another browser all left no way
 * back in — and Settings said "extension pairing creates theirs
 * automatically", which was true and unreachable.
 *
 * The window is short and closes itself. Nothing is revealed on screen: the
 * key goes to whichever extension asks while the window is open, so there is
 * no token here to read over someone's shoulder or paste into the wrong place.
 */
import { useExtensionPairing } from "@/hooks/use-extension-pairing";

export function PairExtension() {
  const { pairing, secondsLeft, connected, begin, cancel } = useExtensionPairing();

  return (
    <div className="pb-2">
      {pairing ? (
        <>
          <div className="mb-2 flex items-center gap-2.5">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
            <p className="text-[13px] text-text-primary">
              Open the Claspt extension in your browser and choose Connect.
            </p>
          </div>
          <p className="mb-2.5 text-[12px] leading-relaxed text-text-muted">
            This window closes on its own in {secondsLeft} second
            {secondsLeft === 1 ? "" : "s"}. Until it does, the extension that asks first
            receives a key that can read and decrypt this vault.
          </p>
          <button
            type="button"
            onClick={cancel}
            className="rounded-lg border border-border/60 bg-surface px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          {connected && (
            <p className="mb-2 text-[12px] leading-relaxed text-success">
              Extension connected. It can now fill your logins and identities.
            </p>
          )}
          <button
            type="button"
            onClick={() => void begin()}
            className="rounded-lg border border-border/60 bg-surface px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
          >
            {connected ? "Pair another browser" : "Pair browser extension"}
          </button>
          <p className="mt-2 max-w-[60ch] text-[11px] leading-relaxed text-text-muted/60">
            Opens a short window during which the extension can collect its own key. Pair
            again after reinstalling the extension, revoking its key, or moving to another
            browser. Existing keys keep working; revoke them below.
          </p>
        </>
      )}
    </div>
  );
}
