// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React from "react";
import { LockIcon, SearchIcon } from "./icons";
import { TroubleshootingPanel } from "./TroubleshootingPanel";

interface EmptyStateProps {
  variant:
    "no-credentials" | "no-results" | "disconnected" | "vault-locked" | "unauthorized";
  domain?: string;
  query?: string;
  onAction?: () => void;
}

export function EmptyState({ variant, domain, query, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {variant === "no-credentials" && (
        <>
          <LockIcon size={32} className="text-text-dim" />
          <p className="mt-3 text-sm font-medium text-text-primary">
            No credentials for {domain}
          </p>
          {onAction && (
            <button
              onClick={onAction}
              className="mt-3 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-accent-hover"
            >
              Add new
            </button>
          )}
        </>
      )}

      {variant === "no-results" && (
        <>
          <SearchIcon size={32} className="text-text-dim" />
          <p className="mt-3 text-sm font-medium text-text-primary">
            No results for &lsquo;{query}&rsquo;
          </p>
        </>
      )}

      {variant === "disconnected" && (
        <>
          <LockIcon size={32} className="text-text-dim" />
          <p className="mt-3 text-sm font-medium text-text-primary">
            Credentials unavailable
          </p>
          <p className="mt-1 max-w-[260px] text-xs leading-relaxed text-text-muted">
            Open the Claspt desktop app and enable the Local API to auto-fill credentials.
          </p>
          <p className="mt-2 max-w-[260px] text-[11px] leading-relaxed text-text-muted">
            The <strong className="text-accent">Generator</strong> tab works without a
            connection — switch to it to create passwords.
          </p>
          {onAction && (
            <button
              onClick={onAction}
              className="mt-3 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-accent-hover"
            >
              Configure Connection
            </button>
          )}
          <div className="w-full max-w-[280px]">
            <TroubleshootingPanel heading="Troubleshoot connection" />
          </div>
        </>
      )}

      {variant === "unauthorized" && (
        <>
          <LockIcon size={32} className="text-text-dim" />
          <p className="mt-3 text-sm font-medium text-text-primary">
            Pair this extension again
          </p>
          <p className="mt-1 max-w-[260px] text-xs leading-relaxed text-text-muted">
            Claspt is running, but it does not know this extension's key. In the app, open
            Settings › Integrations and press{" "}
            <strong className="text-accent">Pair another browser</strong>, then open this
            popup within two minutes.
          </p>
          <p className="mt-2 max-w-[260px] text-[11px] leading-relaxed text-text-muted">
            This happens after the key was revoked in the app, or after the extension was
            reinstalled.
          </p>
        </>
      )}

      {variant === "vault-locked" && (
        <>
          <span style={{ color: "var(--color-warning)" }}>
            <LockIcon size={32} />
          </span>
          <p className="mt-3 text-sm font-medium text-text-primary">Vault is locked</p>
          <p className="mt-1 max-w-[260px] text-xs leading-relaxed text-text-muted">
            Unlock Claspt to access your credentials.
          </p>
        </>
      )}
    </div>
  );
}
