// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The passkeys kept in this vault.
 *
 * Passkeys could be created by the browser extension and then never seen
 * again: nothing listed them, and nothing could remove one. Someone who had
 * been using the feature for months had no way to answer "which sites am I
 * signed into this way", which is the first question anyone asks.
 */
import { useCallback, useEffect, useState } from "react";
import { listPasskeys, deletePasskey, type PasskeySummary } from "@/lib/commands";

/** A date the vault wrote, shown the way a person writes one. */
function formatDate(value: string): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function PasskeysTab() {
  const [items, setItems] = useState<PasskeySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listPasskeys()
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((e: unknown) => {
        setItems([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(refresh, [refresh]);

  const remove = useCallback(
    (item: PasskeySummary) => {
      setBusy(item.credential_id);
      deletePasskey(item.page_path, item.credential_id)
        .then(() => {
          setConfirming(null);
          refresh();
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(null));
    },
    [refresh],
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">Passkeys</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">
          A passkey signs you in without a password, and cannot be used on a copycat site
          because it only works on the domain it was made for. Claspt stores them in this
          vault like any other secret. Create one from a website, using the Claspt browser
          extension.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      {items === null && (
        <p className="text-[12.5px] text-text-muted">Reading the vault…</p>
      )}

      {items !== null && items.length === 0 && !error && (
        <div className="rounded-xl border border-border/60 bg-surface/40 px-4 py-5 text-center">
          <p className="text-[13px] font-medium text-text-secondary">No passkeys yet</p>
          <p className="mx-auto mt-1.5 max-w-sm text-[12px] leading-relaxed text-text-muted">
            When a site offers to create a passkey, choose Claspt in the browser prompt.
            It will appear here, and you can sign in with it on any machine where this
            vault is open.
          </p>
        </div>
      )}

      {items !== null && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.credential_id}
              className="rounded-xl border border-border/60 bg-surface/40 px-3.5 py-3"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-text-primary">
                    {item.rp_name || item.rp_id}
                  </p>
                  <p className="truncate text-[12px] text-text-muted">
                    {item.user_display_name || item.user_name || "no account name"}
                    {item.rp_name && item.rp_id ? ` · ${item.rp_id}` : ""}
                  </p>
                  <p className="mt-1 text-[11px] text-text-dim">
                    Added {formatDate(item.created)}
                    {item.last_used
                      ? ` · last used ${formatDate(item.last_used)}`
                      : " · never used"}
                  </p>
                </div>
                {confirming === item.credential_id ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => setConfirming(null)}
                      className="rounded-lg border border-border/70 px-2.5 py-1 text-[11.5px] text-text-muted hover:text-text-primary"
                    >
                      Keep
                    </button>
                    <button
                      onClick={() => remove(item)}
                      disabled={busy === item.credential_id}
                      className="rounded-lg bg-danger px-2.5 py-1 text-[11.5px] font-medium text-white disabled:opacity-60"
                    >
                      {busy === item.credential_id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirming(item.credential_id)}
                    className="shrink-0 rounded-lg border border-border/70 px-2.5 py-1 text-[11.5px] text-text-muted hover:border-danger/40 hover:text-danger"
                  >
                    Delete
                  </button>
                )}
              </div>
              {confirming === item.credential_id && (
                <p className="mt-2 border-t border-border/50 pt-2 text-[11.5px] leading-relaxed text-text-muted">
                  Deleting it here does not remove it from{" "}
                  <span className="text-text-secondary">{item.rp_id}</span>. That site
                  will keep offering this passkey until you remove it in its own security
                  settings, and you will need to create a new one to sign in again.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
