// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useState, useEffect, useCallback } from "react";
import type { CapturedItem, Message } from "@/shared/types";

interface Props {
  /** Whether the desktop app is connected; only then can the vault be listed. */
  connected: boolean;
  /** Called after a capture was saved or discarded, so the login list refreshes. */
  onChanged?: () => void;
}

/**
 * Logins taken into the vault at submit time and not yet answered. Each row
 * is a real vault page; Save keeps it as an ordinary login, Discard sends it
 * to the trash. Nothing here holds a password: the vault does.
 */
export function WaitingToSave({ connected, onChanged }: Props) {
  const [items, setItems] = useState<CapturedItem[]>([]);
  const [parked, setParked] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(() => {
    try {
      chrome.runtime.sendMessage({ type: "LIST_CAPTURED" } as Message, (res: Message) => {
        if (chrome.runtime.lastError) return;
        if (res?.type === "CAPTURED_RESULT") {
          setItems(res.items);
          setParked(res.parked);
        }
      });
    } catch {
      // The worker is restarting; the next open lists again.
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, connected]);

  const act = useCallback(
    (item: CapturedItem, type: "CONFIRM_CAPTURE" | "DISCARD_CAPTURE") => {
      setBusy(item.pagePath);
      setFailed(null);
      chrome.runtime.sendMessage(
        { type, pagePath: item.pagePath } as Message,
        (res: Message) => {
          setBusy(null);
          const ok =
            !chrome.runtime.lastError &&
            (res?.type === "CONFIRM_CAPTURE_RESULT" ||
              res?.type === "DISCARD_CAPTURE_RESULT") &&
            res.success;
          if (ok) {
            setItems((prev) => prev.filter((i) => i.pagePath !== item.pagePath));
            onChanged?.();
          } else {
            setFailed(item.pagePath);
          }
        },
      );
    },
    [onChanged],
  );

  const total = items.length + parked;
  if (total === 0) return null;

  return (
    <section
      className="border-b border-border bg-accent/5"
      aria-label="Logins waiting to be saved"
    >
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="text-[11px] font-medium text-text-primary">
          {total === 1
            ? "1 login waiting to be saved"
            : `${total} logins waiting to be saved`}
        </span>
        {parked > 0 && (
          <span className="text-[10px] text-text-muted">
            {connected
              ? `${parked} being written…`
              : parked === 1
                ? "1 kept until Claspt is back"
                : `${parked} kept until Claspt is back`}
          </span>
        )}
      </div>

      {items.length > 0 && (
        <ul className="px-2 pb-2 space-y-1">
          {items.map((item) => {
            const isBusy = busy === item.pagePath;
            return (
              <li
                key={item.pagePath}
                className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-text-primary">
                    {item.domain || item.title}
                  </div>
                  <div className="truncate text-[11px] text-text-muted">
                    {item.username || "No username"}
                    <span className="text-text-dim">
                      {" "}
                      · {formatWhen(item.capturedAt)}
                    </span>
                  </div>
                  {failed === item.pagePath && (
                    <div className="mt-0.5 text-[10px] text-red-500">
                      Could not reach Claspt. Try again in a moment.
                    </div>
                  )}
                </div>
                <button
                  onClick={() => act(item, "CONFIRM_CAPTURE")}
                  disabled={isBusy}
                  className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                >
                  {isBusy ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => act(item, "DISCARD_CAPTURE")}
                  disabled={isBusy}
                  className="rounded-md px-2 py-1 text-[11px] font-medium text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  title="Move this login to the trash"
                >
                  Discard
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function formatWhen(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const seconds = Math.floor((Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
