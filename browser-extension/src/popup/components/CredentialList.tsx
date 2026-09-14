// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useState, useCallback, useEffect } from "react";
import type { Credential, Message } from "@/shared/types";
import { estimateStrength } from "@/shared/generator";
import { credKey, loadCredState, togglePin as togglePinShared, sortByPinAndRecency, isPinned, markUsed, onCredStateChange, type CredState } from "@/shared/cred-state";
import { isPrimary, isDeprecated, statusBucket } from "@/shared/cred-flags";
import { formatTimeAgo } from "@/shared/gen-history";
import type { StoredGeneratedEntry } from "@claspt/shared/generated-history";
import { buildFieldPatch } from "@/shared/patch-field";
import { RowContextMenu, type ContextAction } from "./RowContextMenu";

interface Props {
  credentials: Credential[];
  onCopy: (text: string, fieldName: string) => void;
  onFill: (credential: Credential, opts?: { submit?: boolean }) => void;
  copyFeedback: string | null;
  selectedIndex?: number;
  /** SHA-256 hashes of passwords used by 2+ credentials in the vault. */
  reusedHashes?: Set<string>;
  /** Map credentialKey -> hash, for fast lookup per row. */
  credentialHashes?: Map<string, string>;
}

function getCredentialUrl(c: Credential): string | null {
  return c.fields["url"] || c.fields["site"] || c.fields["website"] || null;
}

/**
 * Per-domain colored letter avatar — deterministic, fully local (no
 * external favicon fetch). Picks one of 7 warm-neutral palette tints
 * by hashing the credential's label/domain. Matches the Claspt
 * design mockup's row look.
 */
const AVATAR_PALETTE = [
  { bg: "#fef0d6", fg: "#a35a00" }, // amber
  { bg: "#dde7fa", fg: "#274aa8" }, // blue
  { bg: "#dcefdc", fg: "#296c34" }, // green
  { bg: "#ecdef6", fg: "#6a2c99" }, // purple
  { bg: "#fbe0db", fg: "#a83320" }, // red
  { bg: "#d8eaf2", fg: "#1d5b78" }, // teal
  { bg: "#f6ecd1", fg: "#7a5b15" }, // yellow
];

function avatarColor(seed: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function avatarInitials(seed: string): string {
  // Strip protocol/www and take up to 2 chars (matches the design's "aw",
  // "se", "ic" style initials when label is a domain).
  const cleaned = seed.replace(/^https?:\/\//i, "").replace(/^www\./i, "").trim();
  if (!cleaned) return "??";
  // For "Amazon AWS — IndivarSoftware" style labels, take the first letter
  // of each of the first two words.
  const words = cleaned.split(/[\s\-_·.]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

function LetterAvatar({ name }: { name: string }) {
  const { bg, fg } = avatarColor(name);
  const text = avatarInitials(name);
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold tracking-tight border border-border"
      style={{ background: bg, color: fg, letterSpacing: "-0.01em" }}
    >
      {text}
    </div>
  );
}

function TotpInline({ secret, onCopy, copyFeedback, label }: {
  secret: string;
  onCopy: (text: string, key: string) => void;
  copyFeedback: string | null;
  label: string;
}) {
  const [code, setCode] = useState("");
  const [remaining, setRemaining] = useState(30);
  const feedbackKey = `${label}:totp`;

  const fetchTotp = useCallback(() => {
    chrome.runtime.sendMessage({ type: "GENERATE_TOTP", secret } as Message, (res: Message) => {
      if (res?.type === "TOTP_RESULT") {
        setCode(res.code);
        setRemaining(res.remaining);
      }
    });
  }, [secret]);

  useEffect(() => {
    fetchTotp();
    const interval = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) { fetchTotp(); return 30; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [fetchTotp]);

  if (!code) return null;
  const circumference = 2 * Math.PI * 10;

  return (
    <div className="flex items-center gap-3 rounded-md bg-surface-raised/50 px-2.5 py-2 mt-1">
      <svg width="22" height="22" viewBox="0 0 24 24" className="shrink-0">
        <circle cx="12" cy="12" r="10" fill="none" stroke="#2d333b" strokeWidth="2" />
        <circle cx="12" cy="12" r="10" fill="none" stroke="#d4930a" strokeWidth="2"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - remaining / 30)}
          strokeLinecap="round" transform="rotate(-90 12 12)"
          style={{ transition: "stroke-dashoffset 1s linear" }} />
        <text x="12" y="12" textAnchor="middle" dominantBaseline="central" fill="#8b949e" fontSize="7">{remaining}</text>
      </svg>
      <span className="font-mono text-base font-semibold text-accent tracking-[0.2em] flex-1">{code}</span>
      <button
        onClick={() => onCopy(code, feedbackKey)}
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
          copyFeedback === feedbackKey ? "bg-green-500/10 text-green-400" : "border border-border text-accent hover:bg-accent/10"
        }`}
      >
        {copyFeedback === feedbackKey ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function PasswordField({ value, fieldKey, onCopy, copyFeedback }: {
  value: string; fieldKey: string;
  onCopy: (text: string, key: string) => void;
  copyFeedback: string | null;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-text-muted min-w-[60px]">Password</span>
      <span className="flex-1 font-mono text-text-secondary truncate">{visible ? value : "••••••••"}</span>
      <button
        onClick={() => setVisible(!visible)}
        className="shrink-0 rounded px-1 py-0.5 text-text-dim hover:text-text-primary transition-colors"
        title={visible ? "Hide" : "Show"}
      >
        {visible ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        )}
      </button>
      <button
        onClick={() => onCopy(value, fieldKey)}
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
          copyFeedback === fieldKey ? "bg-green-500/10 text-green-500" : "border border-border text-accent hover:bg-accent/10"
        }`}
      >
        {copyFeedback === fieldKey ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Inline edit form for username + password. Uses the v2.0.0 PATCH_SECRET_BLOCK
 * message → desktop's PATCH /api/pages/{*}/secret endpoint, which is
 * non-destructive and preserves notes / totp / url_match / primary /
 * deprecated. Captures the page's current ETag before save and reverts
 * optimistic UI on 412 (desktop wins).
 */
// Fields that have their own dedicated UI elsewhere — exclude from the
// generic "extra fields" list so users don't edit them in two places.
const RESERVED_FIELD_KEYS = new Set([
  "username", "user", "email", "login",
  "password", "pass",
  "note", "notes", "comment",
  "url_match", "primary", "deprecated", "tags",
]);

function CredentialEditForm({
  credential,
  editing: editingProp,
  onEditingChange,
}: {
  credential: Credential;
  /** Optional controlled editing state — when omitted, the form manages it internally. */
  editing?: boolean;
  onEditingChange?: (next: boolean) => void;
}) {
  const initialUsername =
    credential.fields["username"] || credential.fields["user"] ||
    credential.fields["email"] || credential.fields["login"] || "";
  const initialPassword = credential.fields["password"] || credential.fields["pass"] || "";

  // Extra fields = everything that doesn't have its own dedicated UI.
  // Order is preserved from the credential.fields object iteration order
  // (which matches the on-disk order in the secret block).
  const initialExtras: Array<[string, string]> = Object.entries(credential.fields)
    .filter(([k]) => !RESERVED_FIELD_KEYS.has(k));

  // Controlled if both editing prop and onEditingChange are provided.
  // Otherwise fall back to internal state — preserves existing call sites.
  const [internalEditing, setInternalEditing] = useState(false);
  const isControlled = editingProp !== undefined && onEditingChange !== undefined;
  const editing = isControlled ? editingProp : internalEditing;
  // useCallback keeps the dispatcher reference stable across renders so
  // downstream useCallback deps (save, cancel) don't churn — and the lint
  // rule is satisfied without excluding setEditing from their dep arrays.
  const setEditing = useCallback(
    (next: boolean) => {
      if (isControlled && onEditingChange) onEditingChange(next);
      else setInternalEditing(next);
    },
    [isControlled, onEditingChange],
  );
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState(initialPassword);
  const [extras, setExtras] = useState<Array<[string, string]>>(initialExtras);
  const [showExtras, setShowExtras] = useState(false);
  const [revealPw, setRevealPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  // Re-sync if the credential prop changes (cache refresh)
  useEffect(() => {
    if (!editing) {
      setUsername(initialUsername);
      setPassword(initialPassword);
      setExtras(initialExtras);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUsername, initialPassword, JSON.stringify(initialExtras), editing]);

  const updateExtra = (idx: number, kind: "key" | "value", value: string) => {
    setExtras((prev) => prev.map((row, i) => {
      if (i !== idx) return row;
      return kind === "key" ? [value, row[1]] : [row[0], value];
    }));
  };

  const removeExtra = (idx: number) => {
    setExtras((prev) => prev.filter((_, i) => i !== idx));
  };

  const addExtra = () => {
    setExtras((prev) => [...prev, ["", ""]]);
  };

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);

    // Capture current ETag for optimistic concurrency.
    const etag = await new Promise<string | null>((resolve) => {
      chrome.runtime.sendMessage(
        { type: "GET_PAGE_WITH_ETAG", pagePath: credential.pagePath } as Message,
        (res: Message) => {
          if (res?.type === "GET_PAGE_WITH_ETAG_RESULT" && res.success) resolve(res.etag ?? null);
          else resolve(null);
        },
      );
    });

    // Build the fields patch — only include keys whose values changed.
    // Empty value deletes the field.
    const fields: Record<string, string> = {};
    const deleteFields: string[] = [];

    const usernameKey = ["username", "user", "email", "login"]
      .find((k) => k in credential.fields) ?? "username";
    const passwordKey = ["password", "pass"].find((k) => k in credential.fields) ?? "password";
    if (username !== initialUsername) fields[usernameKey] = username;
    if (password !== initialPassword) fields[passwordKey] = password;

    // Diff extras — added / changed / removed.
    const initialMap = new Map(initialExtras);
    const finalMap = new Map<string, string>();
    for (const [k, v] of extras) {
      const trimmed = k.trim();
      if (!trimmed) continue;
      if (RESERVED_FIELD_KEYS.has(trimmed)) {
        setError(`"${trimmed}" is a reserved field — edit it in the dedicated section.`);
        setSaving(false);
        return;
      }
      finalMap.set(trimmed, v);
    }
    for (const [k, v] of finalMap) {
      if (initialMap.get(k) !== v) fields[k] = v;
    }
    for (const k of initialMap.keys()) {
      if (!finalMap.has(k)) deleteFields.push(k);
    }

    if (Object.keys(fields).length === 0 && deleteFields.length === 0) {
      setEditing(false);
      setSaving(false);
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "PATCH_SECRET_BLOCK",
        pagePath: credential.pagePath,
        label: credential.label,
        fields,
        deleteFields,
        ifMatch: etag ?? undefined,
      } as Message,
      (res: Message) => {
        setSaving(false);
        if (res?.type === "PATCH_SECRET_BLOCK_RESULT" && res.success) {
          setEditing(false);
          setSavedTick(true);
          setTimeout(() => setSavedTick(false), 1500);
        } else if (res?.type === "PATCH_SECRET_BLOCK_RESULT") {
          if (res.errorCode === "PRECONDITION_FAILED") {
            setError("This credential changed in the desktop. Reverted to the latest version.");
            setUsername(initialUsername);
            setPassword(initialPassword);
            setExtras(initialExtras);
          } else if (res.errorCode === "VAULT_LOCKED") {
            setError("Vault is locked. Unlock the desktop app and try again.");
          } else {
            setError(res.errorMessage ?? "Save failed. Try again.");
          }
        } else {
          setError("No response from desktop. Is it running?");
        }
      },
    );
  }, [credential.pagePath, credential.label, credential.fields, username, password, extras, initialUsername, initialPassword, initialExtras, setEditing]);

  const cancel = useCallback(() => {
    setUsername(initialUsername);
    setPassword(initialPassword);
    setExtras(initialExtras);
    setEditing(false);
    setError(null);
  }, [initialUsername, initialPassword, initialExtras, setEditing]);

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="mt-1.5 flex items-center gap-1 text-[10px] text-text-dim hover:text-accent transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path d="M11 2l3 3-7 7H4v-3l7-7z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Edit username / password
        {savedTick && <span className="ml-1 text-green-500">✓ Saved</span>}
      </button>
    );
  }

  return (
    <div className="mt-2 pt-2 border-t border-border/40 space-y-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-text-dim">Edit credential</span>
        {savedTick && <span className="text-[10px] text-green-500">✓ Saved</span>}
      </div>
      <label className="block text-[10px] text-text-muted">Username</label>
      <input
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-full rounded border border-border bg-surface-raised px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent"
      />
      <label className="block text-[10px] text-text-muted">Password</label>
      <div className="flex gap-1">
        <input
          type={revealPw ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="flex-1 rounded border border-border bg-surface-raised px-2 py-1 text-[11px] font-mono text-text-primary outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => setRevealPw((v) => !v)}
          className="rounded border border-border px-2 text-[10px] text-text-muted hover:text-accent"
          title={revealPw ? "Hide" : "Reveal"}
        >
          {revealPw ? "Hide" : "Show"}
        </button>
      </div>
      {/* Other fields disclosure — TOTP secret, URL, custom keys, etc. */}
      <button
        type="button"
        onClick={() => setShowExtras((v) => !v)}
        className="mt-1 flex items-center gap-1 text-[10px] text-text-muted hover:text-accent"
      >
        <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor" className={`transition-transform ${showExtras ? "rotate-90" : ""}`}>
          <path d="M5 4l6 4-6 4z" />
        </svg>
        {showExtras ? "Hide other fields" : `Other fields${extras.length ? ` (${extras.length})` : ""}`}
      </button>
      {showExtras && (
        <div className="space-y-1.5 pl-1">
          {extras.map(([key, value], idx) => {
            // Sensitive values (TOTP secrets, etc.) are masked unless individually revealed.
            const isSensitive = ["totp", "otp", "otp_secret", "secret", "authenticator", "2fa"].includes(key.toLowerCase());
            return (
              <ExtraFieldRow
                key={idx}
                fieldKey={key}
                value={value}
                isSensitive={isSensitive}
                onChangeKey={(v) => updateExtra(idx, "key", v)}
                onChangeValue={(v) => updateExtra(idx, "value", v)}
                onRemove={() => removeExtra(idx)}
              />
            );
          })}
          <button
            type="button"
            onClick={addExtra}
            className="flex items-center gap-1 text-[10px] text-accent hover:text-accent-hover"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <path d="M3 8h10M8 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Add field
          </button>
        </div>
      )}
      {error && (
        <p className="text-[10px] text-amber-600">{error}</p>
      )}
      <div className="flex justify-end gap-1 pt-1">
        <button
          onClick={cancel}
          className="rounded px-2 py-0.5 text-[10px] text-text-muted hover:text-text-primary"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/**
 * Single editable row inside the "Other fields" disclosure. Renders a
 * key input + value input + remove button. Sensitive values (TOTP, etc.)
 * default to masked display with a per-row reveal toggle.
 */
function ExtraFieldRow({ fieldKey, value, isSensitive, onChangeKey, onChangeValue, onRemove }: {
  fieldKey: string;
  value: string;
  isSensitive: boolean;
  onChangeKey: (v: string) => void;
  onChangeValue: (v: string) => void;
  onRemove: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="flex gap-1">
      <input
        type="text"
        value={fieldKey}
        onChange={(e) => onChangeKey(e.target.value)}
        placeholder="key"
        className="w-[80px] rounded border border-border bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-primary outline-none focus:border-accent"
      />
      <input
        type={isSensitive && !revealed ? "password" : "text"}
        value={value}
        onChange={(e) => onChangeValue(e.target.value)}
        placeholder="value"
        className="flex-1 rounded border border-border bg-surface-raised px-1.5 py-0.5 text-[10px] font-mono text-text-primary outline-none focus:border-accent"
      />
      {isSensitive && (
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="rounded px-1 text-[10px] text-text-muted hover:text-accent"
          title={revealed ? "Hide" : "Reveal"}
        >
          {revealed ? "🙈" : "👁"}
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="rounded px-1 text-[10px] text-text-muted hover:text-red-500"
        title="Remove field"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Free-text notes attached to a credential. Stored in the secret block as
 * `note: <text>`. Edit goes through the non-destructive PATCH_SECRET_BLOCK
 * background handler so other fields (totp, url_match, primary, etc.) survive.
 */
function NoteField({ credential }: { credential: Credential }) {
  const initial = credential.fields["note"] || credential.fields["notes"] || credential.fields["comment"] || "";
  const [value, setValue] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  // Re-sync if the credential itself changes (e.g. cache refresh)
  useEffect(() => { setValue(initial); }, [initial]);

  const save = useCallback(() => {
    setSaving(true);
    chrome.runtime.sendMessage(
      buildFieldPatch(credential.pagePath, credential.label, "note", value.trim()),
      (res: Message) => {
        setSaving(false);
        setEditing(false);
        if (res?.type === "PATCH_SECRET_BLOCK_RESULT" && res.success) {
          setSavedTick(true);
          setTimeout(() => setSavedTick(false), 1200);
        }
      }
    );
  }, [credential.pagePath, credential.label, value]);

  if (!editing && !value) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="mt-1.5 flex items-center gap-1 text-[10px] text-text-dim hover:text-accent transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path d="M3 8h10M8 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Add note
      </button>
    );
  }

  return (
    <div className="mt-2 pt-2 border-t border-border/40">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-text-dim">Note</span>
        {!editing && (
          <button onClick={() => setEditing(true)} className="text-[10px] text-text-muted hover:text-accent">Edit</button>
        )}
        {savedTick && <span className="text-[10px] text-green-500">✓ Saved</span>}
      </div>
      {editing ? (
        <>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Anything worth remembering — MFA setup, support contact…"
            rows={3}
            className="w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim outline-none focus:border-accent resize-none"
          />
          <div className="flex justify-end gap-1 mt-1">
            <button
              onClick={() => { setValue(initial); setEditing(false); }}
              className="rounded px-2 py-0.5 text-[10px] text-text-muted hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || value === initial}
              className="rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      ) : (
        <p className="text-[11px] text-text-secondary whitespace-pre-wrap">{value}</p>
      )}
    </div>
  );
}

/**
 * Per-credential URL-match policy. Lets the user pin a credential to an exact
 * URL, a hostname, the registrable domain (default), or disable autofill for
 * it entirely. Scoring honors this in `scoreCredentialMatch`.
 */
function UrlMatchPolicy({ credential }: { credential: Credential }) {
  const stored = (credential.fields["url_match"] || credential.fields["url match"] || "base_domain").toLowerCase();
  const [value, setValue] = useState(stored);
  const [tick, setTick] = useState(false);

  useEffect(() => { setValue(stored); }, [stored]);

  const change = (next: string) => {
    setValue(next);
    chrome.runtime.sendMessage(
      // Empty deletes the field — base_domain is the implicit default.
      buildFieldPatch(
        credential.pagePath,
        credential.label,
        "url_match",
        next === "base_domain" ? "" : next,
      ),
      (res: Message) => {
        if (res?.type === "PATCH_SECRET_BLOCK_RESULT" && res.success) {
          setTick(true);
          setTimeout(() => setTick(false), 1200);
        }
      }
    );
  };

  return (
    <div className="mt-2 flex items-center gap-2 text-[10px]">
      <span className="text-text-dim min-w-[60px]">URL match</span>
      <select
        value={value}
        onChange={(e) => change(e.target.value)}
        className="flex-1 rounded border border-border bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-primary outline-none focus:border-accent"
      >
        <option value="base_domain">Base domain (default)</option>
        <option value="host">Exact hostname</option>
        <option value="exact">Exact URL (origin + path)</option>
        <option value="never">Never auto-fill</option>
      </select>
      {tick && <span className="text-green-500">✓</span>}
    </div>
  );
}

/**
 * The last few passwords generated on the same site as this credential, so a
 * password that was generated and then not saved can still be recovered.
 *
 * This read from a browser-session store that was wiped on browser close and on
 * every vault lock, which meant the recovery path was empty exactly when it was
 * needed. It now reads the vault-backed list.
 */
function SiteHistory({ credential, onCopy, copyFeedback }: {
  credential: Credential;
  onCopy: (text: string, key: string) => void;
  copyFeedback: string | null;
}) {
  const [entries, setEntries] = useState<StoredGeneratedEntry[]>([]);
  const [revealedLabels, setRevealedLabels] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    chrome.runtime.sendMessage({ type: "LIST_GENERATED_PASSWORDS" } as Message, (res: Message) => {
      const all: StoredGeneratedEntry[] =
        res?.type === "LIST_GENERATED_PASSWORDS_RESULT" ? res.entries : [];
      const url = credential.fields["url"] || credential.fields["site"] || credential.fields["website"] || "";
      const targetHosts = new Set<string>();
      try {
        if (url) targetHosts.add(new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, ""));
      } catch { /* ignore */ }
      // Also match against the credential label tokens (e.g. "google.com - foo")
      const labelHosts = credential.label.toLowerCase().match(/\b[a-z0-9-]+\.[a-z]{2,}\b/g) ?? [];
      for (const h of labelHosts) targetHosts.add(h);
      if (targetHosts.size === 0) { setEntries([]); return; }
      const matching = all.filter((e) => {
        if (!e.site) return false;
        const ctx = e.site.toLowerCase().replace(/^www\./, "");
        for (const t of targetHosts) {
          if (ctx === t || ctx.endsWith(`.${t}`) || t.endsWith(`.${ctx}`)) return true;
        }
        return false;
      });
      setEntries(matching.slice(0, 3));
    });
  }, [credential]);

  useEffect(() => { refresh(); }, [refresh]);

  if (entries.length === 0) return null;

  const toggle = (label: string) => {
    setRevealedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  };

  const remove = (entry: StoredGeneratedEntry) => {
    chrome.runtime.sendMessage(
      {
        type: "DELETE_SECRET_BLOCK",
        pagePath: entry.pagePath,
        label: entry.label,
        deletePageIfEmpty: true,
      } as Message,
      () => refresh(),
    );
  };

  return (
    <div className="mt-2 pt-2 border-t border-border/40">
      <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1">Recent passwords used here</div>
      {entries.map((e) => {
        const revealed = revealedLabels.has(e.label);
        const masked = e.password.length > 4 ? "••••••••" + e.password.slice(-2) : "••••";
        const fk = `${credential.label}:hist:${e.label}`;
        return (
          <div key={e.label} className="flex items-center gap-1.5 text-[11px] py-0.5">
            <code className="flex-1 font-mono text-accent truncate">{revealed ? e.password : masked}</code>
            <span className="text-[9px] text-text-dim">{formatTimeAgo(Date.parse(e.generated))}</span>
            <button onClick={() => toggle(e.label)} className="rounded p-0.5 text-text-muted hover:text-accent" title={revealed ? "Hide" : "Reveal"}>
              {revealed ? (
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M2 2l12 12M6.5 6.5a2 2 0 002.83 2.83M3 8a8 8 0 0110-3.5M13 8a8 8 0 01-2.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" /></svg>
              )}
            </button>
            <button
              onClick={() => onCopy(e.password, fk)}
              className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${
                copyFeedback === fk ? "bg-green-500/10 text-green-500" : "border border-border text-accent hover:bg-accent/10"
              }`}
            >
              {copyFeedback === fk ? "✓" : "Copy"}
            </button>
            <button onClick={() => remove(e)} className="rounded p-0.5 text-text-muted hover:text-red-500" title="Forget">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3 5h10M6 5V3a1 1 0 011-1h2a1 1 0 011 1v2M5 5l1 9a1 1 0 001 1h2a1 1 0 001-1l1-9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Inline rename for a secret block label. Replaces the old window.prompt-based
 * Rename action — renders a small form below the row header with input + Save /
 * Cancel + error inline. The label is *not* a secret in itself, so no ETag
 * concurrency dance is needed here; LABEL_CONFLICT is the only meaningful
 * server error we surface.
 */
function RenameLabelInline({
  credential,
  onClose,
}: {
  credential: Credential;
  onClose: () => void;
}) {
  const [value, setValue] = useState(credential.label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = value.trim();
  const unchanged = trimmed === credential.label;
  const empty = trimmed === "";

  const submit = () => {
    if (empty || unchanged) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    chrome.runtime.sendMessage(
      {
        type: "RENAME_SECRET_BLOCK",
        pagePath: credential.pagePath,
        oldLabel: credential.label,
        newLabel: trimmed,
      } as Message,
      (res: Message) => {
        setSaving(false);
        if (res?.type === "RENAME_SECRET_BLOCK_RESULT" && res.success) {
          onClose();
          window.location.reload();
        } else if (res?.type === "RENAME_SECRET_BLOCK_RESULT") {
          setError(
            res.errorCode === "LABEL_CONFLICT"
              ? "That label is already used by another credential on this page."
              : (res.errorMessage ?? res.errorCode ?? "Rename failed."),
          );
        } else {
          setError("No response from desktop. Is it running?");
        }
      },
    );
  };

  return (
    <div className="px-3 pb-2 pt-1 border-t border-border/40">
      <label className="block text-[10px] uppercase tracking-wider text-text-dim mb-1">
        Rename label
      </label>
      <div className="flex gap-1">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") onClose();
          }}
          className="flex-1 rounded border border-border bg-surface-raised px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-[10px] text-text-muted hover:text-text-primary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saving || empty || unchanged}
          className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <p className="mt-1 text-[10px] text-amber-600">{error}</p>}
    </div>
  );
}

/**
 * Inline folder picker for "Move to folder". Lists existing folders from the
 * desktop API plus a "New folder…" inline input — eliminates window.prompt
 * and gives users a real picker instead of guessing folder names.
 */
function MoveFolderInline({
  credential,
  onClose,
}: {
  credential: Credential;
  onClose: () => void;
}) {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [creatingNew, setCreatingNew] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive current folder from the credential's pagePath (vault-relative).
  // listFolders is the source of truth though — we just preselect the current
  // folder so the picker shows where the credential lives.
  const currentFolder = credential.pagePath.includes("/")
    ? credential.pagePath.slice(0, credential.pagePath.lastIndexOf("/"))
    : "";

  React.useEffect(() => {
    chrome.runtime.sendMessage(
      { type: "LIST_FOLDERS" } as Message,
      (res: Message) => {
        if (res?.type === "LIST_FOLDERS_RESULT" && res.success) {
          setFolders(res.folders);
          // Default selection: any folder that is NOT the current one. If the
          // credential is in "credentials/", picking "credentials/" again is a
          // no-op, so we pick the first different folder by default. Falls back
          // to current if it's the only folder.
          const first = res.folders.find((f) => f !== currentFolder) ?? res.folders[0] ?? "";
          setSelected(first);
        } else {
          setError("Couldn't load folders. Is the desktop app running?");
          setFolders([]);
        }
      },
    );
  }, [currentFolder]);

  const submit = () => {
    const target = creatingNew ? newFolder.trim() : selected;
    if (!target) {
      setError("Pick a folder or type a new one.");
      return;
    }
    if (target === currentFolder) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    chrome.runtime.sendMessage(
      {
        type: "MOVE_PAGE",
        pagePath: credential.pagePath,
        folder: target,
      } as Message,
      (res: Message) => {
        setSaving(false);
        if (res?.type === "MOVE_PAGE_RESULT" && res.success) {
          onClose();
          window.location.reload();
        } else if (res?.type === "MOVE_PAGE_RESULT") {
          setError(res.errorMessage ?? res.errorCode ?? "Move failed.");
        } else {
          setError("No response from desktop. Is it running?");
        }
      },
    );
  };

  return (
    <div className="px-3 pb-2 pt-1 border-t border-border/40">
      <label className="block text-[10px] uppercase tracking-wider text-text-dim mb-1">
        Move to folder
      </label>
      {folders === null ? (
        <p className="text-[10px] text-text-muted">Loading folders…</p>
      ) : (
        <div className="flex flex-col gap-1">
          {!creatingNew && (
            <div className="flex gap-1">
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="flex-1 rounded border border-border bg-surface-raised px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent"
              >
                {folders.length === 0 && <option value="">(no folders)</option>}
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                    {f === currentFolder ? " (current)" : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setCreatingNew(true)}
                className="rounded border border-border px-2 py-1 text-[10px] text-text-muted hover:text-accent"
                title="Create a new folder"
              >
                + New
              </button>
            </div>
          )}
          {creatingNew && (
            <div className="flex gap-1">
              <input
                type="text"
                value={newFolder}
                placeholder="folder name (e.g. work/clients)"
                autoFocus
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                  else if (e.key === "Escape") setCreatingNew(false);
                }}
                className="flex-1 rounded border border-border bg-surface-raised px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => { setCreatingNew(false); setNewFolder(""); }}
                className="rounded px-2 py-1 text-[10px] text-text-muted hover:text-text-primary"
              >
                Back
              </button>
            </div>
          )}
          <div className="flex justify-end gap-1 mt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-2 py-1 text-[10px] text-text-muted hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving || (creatingNew ? newFolder.trim() === "" : selected === currentFolder)}
              className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Moving…" : "Move"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-[10px] text-amber-600">{error}</p>}
    </div>
  );
}

function CredentialCard({
  credential, isExpanded, onToggle, onCopy, onFill, copyFeedback,
  isPinned, onTogglePin, isReused,
}: {
  credential: Credential;
  isExpanded: boolean;
  onToggle: () => void;
  onCopy: (text: string, fieldName: string) => void;
  onFill: (opts?: { submit?: boolean }) => void;
  copyFeedback: string | null;
  isPinned: boolean;
  onTogglePin: () => void;
  isReused?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState(false);
  // Card-owned UI state for inline flows triggered from the context menu.
  // Lifting these here lets the menu actions open them without window.prompt.
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);

  const username =
    credential.fields["username"] || credential.fields["user"] ||
    credential.fields["email"] || credential.fields["login"] || "";
  const password = credential.fields["password"] || credential.fields["pass"] || "";
  const totpSecret =
    credential.fields["totp"] || credential.fields["otp_secret"] || credential.fields["authenticator"] || "";
  // No external favicon fetch — letter-initials avatar is fully local.
  const url = getCredentialUrl(credential);
  const feedbackKey = (field: string) => `${credential.label}:${field}`;
  const isWeak = password ? estimateStrength(password).score <= 1 : false;
  const isPrim = isPrimary(credential);
  const isDep = isDeprecated(credential);

  function openMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  const patchField = (key: string, value: string) => {
    chrome.runtime.sendMessage(buildFieldPatch(credential.pagePath, credential.label, key, value));
  };

  const actions: ContextAction[] = [
    { id: "fill", label: "Fill", onClick: () => onFill(), icon: <IconFill /> },
    ...(password
      ? [{ id: "fillsubmit", label: "Fill & Submit", onClick: () => onFill({ submit: true }), icon: <IconFlash /> }]
      : []),
    ...(url
      ? [{
          id: "login",
          label: "Log In (open + fill + submit)",
          onClick: () => {
            try { chrome.tabs.create({ url: url.startsWith("http") ? url : `https://${url}`, active: true }); } catch { /* ignore */ }
          },
          icon: <IconExternal />,
        }]
      : []),
    ...(url
      ? [{
          id: "goto",
          label: "Go To",
          onClick: () => {
            try { chrome.tabs.create({ url: url.startsWith("http") ? url : `https://${url}`, active: true }); } catch { /* ignore */ }
          },
          icon: <IconLink />,
          divider: true,
        }]
      : []),
    ...(username
      ? [{ id: "copyuser", label: "Copy Username", onClick: () => onCopy(username, feedbackKey("username")), icon: <IconCopy />, divider: true }]
      : []),
    ...(password
      ? [{ id: "copypw", label: "Copy Password", onClick: () => onCopy(password, feedbackKey("password")), icon: <IconCopy /> }]
      : []),
    ...(totpSecret
      ? [{ id: "copytotp", label: "Copy TOTP Code",
          onClick: () => {
            chrome.runtime.sendMessage({ type: "GENERATE_TOTP", secret: totpSecret } as Message, (res: Message) => {
              if (res?.type === "TOTP_RESULT") onCopy(res.code, feedbackKey("totp"));
            });
          }, icon: <IconCopy /> }]
      : []),
    { id: "view", label: isExpanded ? "Collapse details" : "View details", onClick: onToggle, icon: <IconEye />, divider: true },
    { id: "pin", label: isPinned ? "Unpin" : "Pin to top", onClick: onTogglePin, icon: <IconPin /> },
    { id: "primary", label: isPrim ? "Unmark primary" : "Mark as primary", onClick: () => patchField("primary", isPrim ? "" : "true") },
    { id: "deprecate", label: isDep ? "Restore (un-deprecate)" : "Mark as deprecated", onClick: () => patchField("deprecated", isDep ? "" : "true") },
    {
      id: "edit",
      label: "Edit credential…",
      onClick: () => {
        // Open the card and switch its inline edit form into edit mode.
        // No window.prompt — same form the "Edit username / password" link
        // shows when expanded.
        if (!isExpanded) onToggle();
        setEditing(true);
        setRenaming(false);
        setMoving(false);
      },
    },
    {
      id: "rename",
      label: "Rename label…",
      onClick: () => {
        setRenaming(true);
        setEditing(false);
        setMoving(false);
      },
    },
    {
      id: "move",
      label: "Move to folder…",
      onClick: () => {
        setMoving(true);
        setEditing(false);
        setRenaming(false);
      },
    },
    {
      id: "delete",
      label: "Delete credential…",
      divider: true,
      destructive: true,
      onClick: () => {
        // Two-step confirm — destructive action, irreversible without git history.
        const ok = window.confirm(
          `Delete "${credential.label}"?\n\nThis removes the credential from the vault. ` +
          `If it's the only credential on this page, the page will be deleted too. ` +
          `This cannot be undone from the extension.`
        );
        if (!ok) return;
        chrome.runtime.sendMessage(
          {
            type: "DELETE_SECRET_BLOCK",
            pagePath: credential.pagePath,
            label: credential.label,
            deletePageIfEmpty: true,
          } as Message,
          (res: Message) => {
            if (res?.type === "DELETE_SECRET_BLOCK_RESULT" && res.success) {
              // Force a popup refresh — easiest way is window.close + user re-opens,
              // but we'd rather feel responsive. The credential cache was cleared
              // on the background side; the next render fetch pulls fresh data.
              try { chrome.runtime.sendMessage({ type: "GET_STATUS" } as Message); } catch { /* ignore */ }
              window.location.reload();
            } else {
              const msg = res?.type === "DELETE_SECRET_BLOCK_RESULT" ? (res.errorMessage ?? res.errorCode ?? "Unknown") : "No response";
              window.alert(`Delete failed: ${msg}`);
            }
          },
        );
      },
    },
  ];

  return (
    <div
      className={`border-b border-border/60 last:border-0 relative ${isDep ? "opacity-60" : ""}`}
      onContextMenu={openMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className="flex items-center gap-3 px-3 py-3 cursor-pointer hover:bg-surface-raised/40 transition-colors"
        onClick={onToggle}
      >
        <LetterAvatar name={credential.label} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {isPinned && (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="#d4930a" className="shrink-0" aria-label="Pinned">
                <title>Pinned</title>
                <path d="M10 2l-1 5-4 2v2h3v4l1 1 1-1v-4h3V9l-4-2-1-5z" />
              </svg>
            )}
            {isPrim && (
              <span className="shrink-0 rounded-full bg-green-500/15 px-1 py-px text-[8px] font-bold uppercase tracking-wider text-green-600" title="Primary credential — auto-fill prefers this one">★ primary</span>
            )}
            <span className={`text-[13px] font-medium truncate ${isDep ? "text-text-muted line-through" : "text-text-primary"}`}>{credential.label}</span>
            {isWeak && (
              <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0" aria-label="Weak password">
                <title>Weak password</title>
                <path d="M8 1l7 13H1L8 1z" fill="#fbbf24" opacity="0.8" />
                <text x="8" y="12" textAnchor="middle" fill="#0c1017" fontSize="9" fontWeight="bold">!</text>
              </svg>
            )}
            {isReused && (
              <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0" aria-label="Reused password">
                <title>Reused — same password used on another credential</title>
                <circle cx="8" cy="8" r="7" fill="#f59e0b" opacity="0.85" />
                <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#0c1017" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
          </div>
          {username && <div className="text-[11px] text-text-muted truncate mt-0.5">{username}</div>}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Hover-reveal Fill button (RoboForm-style) */}
          {password && (
            <button
              onClick={(e) => { e.stopPropagation(); onFill(); }}
              className={`flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-all ${
                hover ? "bg-accent text-white" : "bg-accent/10 text-accent opacity-70"
              }`}
              title="Fill credentials"
            >
              <IconFill />
              <span className="hidden sm:inline">Fill</span>
            </button>
          )}

          <button
            onClick={openMenu}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-dim hover:bg-surface-overlay hover:text-text-muted transition-colors"
            title="More actions"
            aria-label="More actions"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="3" cy="8" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="13" cy="8" r="1.5" />
            </svg>
          </button>

          <svg
            width="12" height="12" viewBox="0 0 16 16" fill="currentColor"
            className={`text-text-dim transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`}
          >
            <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 011.06 0L8 8.94l2.72-2.72a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-1.06 0L4.22 7.28a.75.75 0 010-1.06z" clipRule="evenodd" />
          </svg>
        </div>
      </div>

      {renaming && (
        <RenameLabelInline
          credential={credential}
          onClose={() => setRenaming(false)}
        />
      )}

      {moving && (
        <MoveFolderInline
          credential={credential}
          onClose={() => setMoving(false)}
        />
      )}

      {isExpanded && (
        <div className="px-3 pb-3 space-y-1.5">
          {Object.entries(credential.fields)
            .filter(([key]) => !["url", "site", "website", "note", "notes", "comment", "url_match", "primary", "deprecated", "tags"].includes(key))
            .map(([key, value]) =>
              key === "password" || key === "pass" ? (
                <PasswordField key={key} value={value} fieldKey={feedbackKey(key)} onCopy={onCopy} copyFeedback={copyFeedback} />
              ) : (
                <div key={key} className="flex items-center gap-2 text-[11px]">
                  <span className="text-text-muted min-w-[60px] capitalize">{key}</span>
                  <span className="flex-1 font-mono text-text-secondary truncate">{value}</span>
                  <button
                    onClick={() => onCopy(value, feedbackKey(key))}
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                      copyFeedback === feedbackKey(key) ? "bg-green-500/10 text-green-500" : "border border-border text-accent hover:bg-accent/10"
                    }`}
                  >
                    {copyFeedback === feedbackKey(key) ? "Copied" : "Copy"}
                  </button>
                </div>
              ),
            )}
          {totpSecret && <TotpInline secret={totpSecret} onCopy={onCopy} copyFeedback={copyFeedback} label={credential.label} />}
          <CredentialEditForm
            credential={credential}
            editing={editing}
            onEditingChange={setEditing}
          />
          <NoteField credential={credential} />
          <UrlMatchPolicy credential={credential} />
          <SiteHistory credential={credential} onCopy={onCopy} copyFeedback={copyFeedback} />
          <div className="text-[10px] text-text-dim mt-2 truncate">{credential.pageTitle}</div>
        </div>
      )}

      {menu && <RowContextMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />}
    </div>
  );
}

export function CredentialList({ credentials, onCopy, onFill, copyFeedback, selectedIndex = -1, reusedHashes, credentialHashes }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [credState, setCredState] = useState<CredState>({ pinned: {}, lastUsed: {} });

  useEffect(() => {
    loadCredState().then(setCredState);
    return onCredStateChange(setCredState);
  }, []);

  const onTogglePin = useCallback(async (key: string) => {
    const next = await togglePinShared(key);
    setCredState(next);
  }, []);

  // Pinned first, then most-recently-used desc, with primary > normal > deprecated bucket — same sort the inline picker uses.
  const sorted = [...sortByPinAndRecency(credentials, credState)].sort((a, b) => statusBucket(a) - statusBucket(b));

  return (
    <div className="flex-1 overflow-y-auto">
      {sorted.map((cred, i) => {
        const k = credKey(cred.pagePath, cred.label);
        const myHash = credentialHashes?.get(k);
        const isReused = !!(myHash && reusedHashes?.has(myHash));
        return (
          <div key={`${cred.pagePath}-${cred.label}-${i}`} className={i === selectedIndex ? "border-l-2 border-l-accent" : ""}>
            <CredentialCard
              credential={cred}
              isExpanded={expanded === i}
              onToggle={() => setExpanded(expanded === i ? null : i)}
              onCopy={onCopy}
              onFill={(opts) => onFill(cred, opts)}
              copyFeedback={copyFeedback}
              isPinned={isPinned(credState, cred.pagePath, cred.label)}
              onTogglePin={() => onTogglePin(k)}
              isReused={isReused}
            />
          </div>
        );
      })}
    </div>
  );
}

// ───── Icons ─────
function IconFill() { return (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M3 4h2v8H3V4zm4 2h2v4H7V6zm4-4h2v12h-2V2z" />
  </svg>
); }
function IconFlash() { return (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M9 1L3 9h4l-1 6 6-8H8l1-6z" />
  </svg>
); }
function IconExternal() { return (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M10 3h3v3" /><path d="M13 3l-5 5" /><path d="M11 8v4a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1h4" />
  </svg>
); }
function IconLink() { return (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M6.5 8.5a3 3 0 004.24 0l2-2a3 3 0 00-4.24-4.24l-.5.5" />
    <path d="M9.5 7.5a3 3 0 00-4.24 0l-2 2a3 3 0 004.24 4.24l.5-.5" />
  </svg>
); }
function IconCopy() { return (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M3 3v8a1 1 0 001 1h1V4h6V3H3zm3 2v9a1 1 0 001 1h6a1 1 0 001-1V5a1 1 0 00-1-1H7a1 1 0 00-1 1zm1 0h6v9H7V5z" />
  </svg>
); }
function IconEye() { return (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
  </svg>
); }
function IconPin() { return (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M10 2l-1 5-4 2v2h3v4l1 1 1-1v-4h3V9l-4-2-1-5z" />
  </svg>
); }
