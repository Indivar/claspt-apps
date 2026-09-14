// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useEffect, useState, useCallback } from "react";
import type { Credential, Message, RecentCredential } from "@/shared/types";
import { STORAGE_KEY_RECENT } from "@/shared/constants";

interface Props {
  onFill: (credential: Credential) => void;
  onCopy: (text: string, label: string) => void;
}

export function RecentlyFilled({ onFill, onCopy }: Props) {
  const [recent, setRecent] = useState<RecentCredential[]>([]);

  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY_RECENT, (result) => {
      setRecent(result[STORAGE_KEY_RECENT] ?? []);
    });
  }, []);

  if (recent.length === 0) return null;

  return (
    <div className="px-3 py-1.5 border-b border-border">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-text-dim mb-1">Recently Used</div>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {recent.slice(0, 5).map((r, idx) => (
          <button
            key={`${r.pagePath}:${r.label}:${idx}`}
            onClick={() => {
              // Fetch full credential and fill
              chrome.runtime.sendMessage(
                { type: "SEARCH_CREDENTIALS", query: r.label } as Message,
                (res: Message) => {
                  if (res?.type === "SEARCH_RESULT" && res.credentials.length > 0) {
                    const match = res.credentials.find(
                      (c) => c.pagePath === r.pagePath && c.label === r.label
                    ) ?? res.credentials[0];
                    onFill(match);
                  }
                }
              );
            }}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 py-1 text-[10px] text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors shrink-0"
            title={`${r.label}\n${r.username}\n${r.domain}`}
          >
            <span className="flex h-4 w-4 items-center justify-center rounded bg-accent/10 text-[8px] font-bold text-accent">
              {(r.domain?.[0] ?? r.label[0] ?? "?").toUpperCase()}
            </span>
            <span className="truncate max-w-[80px]">{r.domain || r.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
