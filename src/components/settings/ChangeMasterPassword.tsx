// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Change the master password from Settings.
 *
 * There was no way to do this. `change_password` had existed in the crypto
 * layer all along but was never exposed, so the only route to a new password
 * was the recovery screen — which means anyone wanting to rotate a password
 * they still knew had to pretend they had forgotten it.
 *
 * Two consequences are stated here rather than discovered later. The recovery
 * key does not change, because it is the master key and this re-wraps that
 * same key; and on a synced vault the other devices keep deriving the old sync
 * key until their password is changed too, since that key comes from the
 * password.
 */
import { useState } from "react";
import * as cmd from "@/lib/commands";
import { SECRET_INPUT_PROPS } from "@/lib/secret-input";

export function ChangeMasterPassword({ syncConfigured }: { syncConfigured: boolean }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm !== "" && next !== confirm;
  const canSubmit =
    current !== "" && next.length >= 12 && next === confirm && !busy && next !== current;

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await cmd.changeMasterPassword(current, next);
      reset();
      setDone(true);
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="pb-2">
        {done && (
          <p className="mb-2 text-[12px] leading-relaxed text-success">
            Master password changed. Your recovery key is unchanged and still works.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setDone(false);
            setOpen(true);
          }}
          className="rounded-lg border border-border/60 bg-surface px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
        >
          Change master password
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-text-muted/60">
          Everything already saved stays readable, and your recovery key keeps working.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 pb-2">
      <Field
        label="Current password"
        value={current}
        onChange={setCurrent}
        placeholder="Your password now"
        autoFocus
      />
      <Field
        label="New password"
        value={next}
        onChange={setNext}
        placeholder="Min 12 characters"
      />
      <Field
        label="Confirm new password"
        value={confirm}
        onChange={setConfirm}
        placeholder="Type it again"
        invalid={mismatch}
      />
      {mismatch && <p className="text-[12px] text-danger">Passwords do not match.</p>}

      {syncConfigured && (
        <p className="rounded-lg border border-warning/35 bg-warning/[0.07] px-3 py-2 text-[12px] leading-relaxed text-text-secondary">
          This vault syncs. The sync key is derived from your password, so your other
          devices will keep using the old one until you change the password there too.
        </p>
      )}

      {error && (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] leading-relaxed text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="btn-accent rounded-lg px-4 py-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Changing…" : "Change password"}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="rounded-lg border border-border/60 bg-surface px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  invalid,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-text-secondary">
        {label}
      </span>
      <input
        type="password"
        {...SECRET_INPUT_PROPS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={`focus-accent w-full rounded-lg border bg-surface px-3 py-2 text-[13px] text-text-primary outline-none placeholder:text-text-muted/60 ${
          invalid ? "border-danger" : "border-border/60"
        }`}
      />
    </label>
  );
}
