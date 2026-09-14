// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { siteAccessPath } from "@/shared/platform";
import { useState } from "react";
import type { Message } from "@/shared/types";

interface Props {
  /** Called after the user grants permission so the parent can refresh state. */
  onGranted: () => void;
}

const LOCALHOST_ORIGIN = "http://127.0.0.1/*";

/**
 * Explain why we need the optional host permission and request it via a
 * user-gesture-triggered chrome.permissions.request(). Must be rendered
 * inside a click handler chain — Chrome rejects request() calls that
 * aren't attributable to a user gesture.
 */
export function PermissionPrompt({ onGranted }: Props) {
  const [requesting, setRequesting] = useState(false);
  const [denied, setDenied] = useState(false);

  const requestPermission = () => {
    setRequesting(true);
    setDenied(false);
    // chrome.permissions.request resolves with `granted` — no promise form
    // on older Chrome, so use the callback API for maximum compatibility.
    chrome.permissions.request({ origins: [LOCALHOST_ORIGIN] }, (granted) => {
      setRequesting(false);
      if (granted) {
        // Nudge the background to re-check status. onPermissionChanged also
        // fires in the background and will refresh; this is a belt-and-braces.
        chrome.runtime.sendMessage({ type: "CHECK_HOST_PERMISSION" } as Message, () => {
          onGranted();
        });
      } else {
        setDenied(true);
      }
    });
  };

  return (
    <div className="flex flex-col items-center text-center px-5 py-8 gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-accent"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
      </div>
      <h2 className="text-sm font-bold text-text-primary">Connect to Claspt Desktop</h2>
      <p className="text-[12px] text-text-muted leading-relaxed max-w-[280px]">
        Claspt needs permission to talk to the desktop app on your own computer (
        <code className="rounded bg-surface-raised px-1 py-px text-[11px]">
          http://127.0.0.1
        </code>
        ). Nothing is sent to our servers — credentials stay on your machine.
      </p>

      <button
        type="button"
        onClick={requestPermission}
        disabled={requesting}
        className="mt-2 w-full rounded-lg bg-accent py-2 text-sm font-semibold text-white hover:bg-accent-hover transition-colors disabled:opacity-60"
      >
        {requesting ? "Waiting for the browser…" : "Allow local connection"}
      </button>

      {denied && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
          Permission denied. You can enable it later from <code>{siteAccessPath()}</code>.
        </p>
      )}

      <p className="text-[10px] text-text-dim mt-1 max-w-[260px]">
        The browser will show its permission dialog when you click above.
      </p>
    </div>
  );
}
