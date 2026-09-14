// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as cmd from "@/lib/commands";
import { StepHeading, StepFooter } from "@/components/setup/WizardFrame";

/** Where each browser's listing lives. Opened externally, never navigated to. */
const STORE_URLS: Record<string, string> = {
  Chrome: "https://chromewebstore.google.com/search/claspt",
  Edge: "https://microsoftedge.microsoft.com/addons/search?q=claspt",
};

/**
 * Connecting the browser extension.
 *
 * The install itself cannot be automated — Chrome removed that ability in 2018
 * and Edge and Firefox never had it — so the app opens the right listing and
 * says plainly that the browser will ask for confirmation.
 *
 * What IS automated is everything after: the app opens a short pairing window,
 * and the extension collects a token from it by itself. That replaces generating
 * a token in Settings and pasting it into the extension, which on a fresh
 * install was impossible because no token existed yet.
 */
export function PasswordsStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const [pairing, setPairing] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [connected, setConnected] = useState(false);
  const wasArmed = useRef(false);

  const beginPairing = useCallback(async () => {
    try {
      // The extension needs to decrypt in order to fill a password, so this is
      // the one client that genuinely requires the secrets scope.
      await cmd.beginExtensionPairing("secrets");
      wasArmed.current = false;
      setPairing(true);
    } catch {
      setPairing(false);
    }
  }, []);

  // Watch the pairing window. The window closing after it opened is what tells
  // us the extension took the token — there is nothing else to observe.
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

  // Leaving the step closes the window rather than letting it sit open.
  useEffect(() => () => void cmd.cancelExtensionPairing().catch(() => {}), []);

  return (
    <>
      <StepHeading eyebrow="Passwords" title="Fill passwords in your browser">
        Once the Claspt extension is installed, it offers your saved logins on the
        websites they belong to, so you do not have to type them.
      </StepHeading>

      <div className="mb-4 flex flex-col gap-2.5">
        <div className="rounded-xl border-[1.5px] border-accent bg-accent/[0.04] px-4 py-3.5">
          <p className="mb-1 text-[14px] font-semibold text-text-primary">
            1. Add the extension to your browser
          </p>
          <p className="mb-2.5 text-[12.5px] leading-normal text-text-muted">
            This opens your browser&rsquo;s extension store. Your browser will ask you to
            confirm — we cannot install it for you.
          </p>
          <div className="flex gap-2">
            {Object.entries(STORE_URLS).map(([name, url]) => (
              <button
                key={name}
                type="button"
                onClick={() => openUrl(url).catch(() => window.open(url, "_blank"))}
                className="rounded-lg border border-border/60 bg-surface px-4 py-2 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
              >
                Add to {name}
              </button>
            ))}
          </div>
        </div>

        <div
          className={`rounded-xl border border-border/60 bg-surface px-4 py-3.5 transition-opacity ${
            connected ? "" : "opacity-70"
          }`}
        >
          <p className="mb-1 text-[14px] font-semibold text-text-primary">
            2. Connect it to this vault
          </p>
          {connected ? (
            <p className="text-[12.5px] text-success">
              Connected. The extension can now fill your saved logins.
            </p>
          ) : pairing ? (
            <p className="text-[12.5px] text-text-muted">
              Ready — click the Claspt icon in your browser to finish. {secondsLeft}s
              left.
            </p>
          ) : (
            <div className="flex items-center gap-3">
              <p className="flex-1 text-[12.5px] text-text-muted">
                Connects the extension to this vault. Nothing to copy or type.
              </p>
              <button
                type="button"
                onClick={() => void beginPairing()}
                className="btn-accent shrink-0 rounded-lg px-5 py-2 text-[12.5px]"
              >
                Connect
              </button>
            </div>
          )}
        </div>
      </div>

      <StepFooter>
        <button
          type="button"
          onClick={onBack}
          className="px-1 py-2 text-[13px] text-text-muted transition-colors hover:text-text-secondary"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          className="btn-accent rounded-xl px-7 py-3 text-[13px]"
        >
          {connected ? "Continue" : "I'll do this later"}
        </button>
      </StepFooter>
    </>
  );
}
