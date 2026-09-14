// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useCallback, useRef, useState } from "react";
import { toggleDebug, isDebugEnabled } from "@/shared/debug";

interface HeaderProps {
  connection: "connected" | "vault_locked" | "disconnected" | "permission_needed";
  matchCount: number;
  desktopVersion?: string;
  vaultSyncVersion?: number;
  plan?: string;
}

const EXT_VERSION = chrome.runtime.getManifest().version;

export function Header({
  connection,
  matchCount,
  desktopVersion,
  vaultSyncVersion,
  plan,
}: HeaderProps) {
  const [debugOn, setDebugOn] = useState(isDebugEnabled());
  const clickCount = useRef(0);
  const clickTimer = useRef<ReturnType<typeof setTimeout>>();

  const handleVersionClick = useCallback(() => {
    clickCount.current++;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    if (clickCount.current >= 3) {
      clickCount.current = 0;
      toggleDebug().then(setDebugOn);
    } else {
      clickTimer.current = setTimeout(() => { clickCount.current = 0; }, 500);
    }
  }, []);
  return (
    <div className="border-b border-border bg-surface">
      <div className="flex h-[48px] items-center justify-between px-3">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <img
            src={new URL("../../assets/logo-claspt.png", import.meta.url).href}
            alt="Claspt"
            className="h-7 w-7 rounded"
          />
          <div className="flex flex-col">
            <span className="flex items-center gap-1.5">
              <span className="text-sm font-bold text-text-primary tracking-tight leading-none">Claspt</span>
              {plan && (
                <span className={`rounded-full px-1.5 py-px text-[9px] font-semibold leading-none ${
                  plan === "Free" || plan === "Trial"
                    ? "bg-surface-raised text-text-muted"
                    : "bg-accent/15 text-accent"
                }`}>
                  {plan === "pro_plus" ? "Pro+" : plan === "pro" ? "Pro" : plan}
                </span>
              )}
            </span>
            <span
              className="text-[9px] text-text-dim leading-none mt-0.5 cursor-default select-none"
              onClick={handleVersionClick}
            >
              ext v{EXT_VERSION}
              {desktopVersion ? ` · app v${desktopVersion}` : ""}
              {vaultSyncVersion !== undefined ? ` · vault v${vaultSyncVersion}` : ""}
              {debugOn ? " · DEBUG" : ""}
            </span>
          </div>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-2">
          {matchCount > 0 && connection === "connected" && (
            <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold text-accent">
              {matchCount}
            </span>
          )}

          {connection === "connected" && (
            <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" title="Connected" />
          )}
        </div>
      </div>

      {/* Connection status banner — shown when not connected */}
      {connection !== "connected" && (
        <div className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium ${
          connection === "vault_locked"
            ? "bg-yellow-500/10 text-yellow-600"
            : connection === "permission_needed"
              ? "bg-blue-500/10 text-blue-500"
              : "bg-red-500/10 text-red-500"
        }`}>
          {connection === "vault_locked" ? (
            <>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="shrink-0">
                <path d="M8 1a4 4 0 00-4 4v2H3a1 1 0 00-1 1v6a1 1 0 001 1h10a1 1 0 001-1V8a1 1 0 00-1-1h-1V5a4 4 0 00-4-4zm-2 4a2 2 0 114 0v2H6V5z" />
              </svg>
              Vault locked — open Claspt to unlock
            </>
          ) : connection === "permission_needed" ? (
            <>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="7" width="12" height="7" rx="1.5" />
                <path d="M5 7V4.5a3 3 0 016 0V7" />
              </svg>
              Click "Allow local connection" below to finish setup
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Not connected — open Claspt desktop app to sync credentials
            </>
          )}
        </div>
      )}
    </div>
  );
}
