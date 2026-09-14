// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useState, useEffect, useCallback } from "react";
import type { Message } from "@/shared/types";
import { STORAGE_KEY_UNSAVED } from "@/shared/constants";

interface UnsavedCredential {
  username: string;
  password: string;
  url: string;
  domain: string;
  timestamp: number;
}

// Cleartext, not-yet-saved credentials live in memory-backed session storage
// (never storage.local) so they are wiped on browser close and on auto-lock.
const UNSAVED_KEY = STORAGE_KEY_UNSAVED;

interface Props {
  /** Whether the desktop app is connected (needed to save to vault) */
  connected: boolean;
}

export function UnsavedCredentials({ connected }: Props) {
  const [items, setItems] = useState<UnsavedCredential[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState<number | null>(null);

  const load = useCallback(() => {
    chrome.storage.session.get(UNSAVED_KEY, (result) => {
      setItems(result[UNSAVED_KEY] ?? []);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveToVault = useCallback((idx: number) => {
    const item = items[idx];
    if (!item) return;
    setSaving(idx);
    chrome.runtime.sendMessage(
      {
        type: "SAVE_CREDENTIAL",
        username: item.username,
        password: item.password,
        url: item.url,
        domain: item.domain,
      } as Message,
      (res: Message) => {
        if (res?.type === "SAVE_CREDENTIAL_RESULT" && res.success) {
          removeItem(idx);
        }
        setSaving(null);
      }
    );
  }, [items]);

  const removeItem = useCallback((idx: number) => {
    setItems((prev) => {
      const updated = prev.filter((_, i) => i !== idx);
      chrome.storage.session.set({ [UNSAVED_KEY]: updated });
      return updated;
    });
  }, []);

  const clearAll = useCallback(() => {
    setItems([]);
    chrome.storage.session.remove(UNSAVED_KEY);
  }, []);

  const copyPassword = useCallback((text: string) => {
    try {
      chrome.runtime.sendMessage(
        { type: "COPY_TO_CLIPBOARD", text, autoClear: true } as Message,
        () => {
          if (chrome.runtime.lastError) {
            navigator.clipboard.writeText(text).catch(() => {});
          }
        }
      );
    } catch {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="border-t border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-medium text-yellow-500 hover:bg-yellow-500/5 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2a1 1 0 011 1v4a1 1 0 01-2 0V4a1 1 0 011-1zm0 8a1 1 0 100-2 1 1 0 000 2z" />
          </svg>
          {items.length} unsaved credential{items.length !== 1 ? "s" : ""}
        </span>
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
          className={`transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>

      {expanded && (
        <div className="px-2 pb-2 space-y-1.5">
          {items.map((item, idx) => (
            <div
              key={`${item.domain}-${item.username}-${idx}`}
              className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-2.5"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-text-primary truncate">
                    {item.domain || "Unknown site"}
                  </div>
                  <div className="text-[11px] text-text-muted truncate">
                    {item.username || "No username"}
                  </div>
                </div>
                <span className="text-[9px] text-text-dim shrink-0">
                  {formatTimeAgo(item.timestamp)}
                </span>
              </div>

              <div className="flex gap-1.5">
                {connected && (
                  <button
                    onClick={() => saveToVault(idx)}
                    disabled={saving === idx}
                    className="flex-1 rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                  >
                    {saving === idx ? "Saving..." : "Save to Vault"}
                  </button>
                )}
                <button
                  onClick={() => copyPassword(item.password)}
                  className="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
                >
                  Copy PW
                </button>
                <button
                  onClick={() => removeItem(idx)}
                  className="rounded-md px-2 py-1 text-[10px] font-medium text-red-500/70 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                  title="Dismiss"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}

          {items.length > 1 && (
            <button
              onClick={clearAll}
              className="w-full text-center text-[10px] text-red-500/60 hover:text-red-500 transition-colors py-1"
            >
              Clear all unsaved
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
