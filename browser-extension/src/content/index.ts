// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { detectFields, observeForms, type DetectedField } from "./form-detector";
import { dbg, loadDebugState } from "@/shared/debug";
import { fillFields, getLastFilled, isFillableOrigin } from "./form-filler";
import { injectInlineIcons, removeInlineIcons } from "./inline-icon";
import { observeSignupForms, type CapturedCredentials } from "./signup-detector";
import { showSaveBar, dismissSaveBar } from "./save-bar";
import { isAutofillSafe, isDomainMismatch } from "@/shared/url-matching";
import {
  showPhishingWarning,
  showInsecureOriginWarning,
  showUnverifiedSiteWarning,
} from "./warnings";
import { STORAGE_KEY_UNSAVED } from "@/shared/constants";
import { isExcludedDomain } from "@/shared/domain-prefs";
import type { Credential, Message } from "@/shared/types";

/**
 * Content script — runs in the page's isolated world.
 *
 * SECURITY MODEL:
 * - Content scripts share the DOM with the page but have an isolated JS world.
 * - We NEVER trust DOM-derived data for security decisions — the background
 *   service worker derives the domain from sender.tab.url, not from messages.
 * - We NEVER write secrets into the shared DOM (no textarea clipboard fallback).
 * - Privileged operations (config, search, password gen, TOTP) are blocked
 *   from content scripts by the background message handler.
 */

let detectedFields: DetectedField[] = [];
/**
 * Track the last input the user right-clicked / focused so the context-menu
 * "Generate password" item can drop the value into the right field instead
 * of just the clipboard.
 */
let lastFocusedInput: HTMLInputElement | HTMLTextAreaElement | null = null;
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
    lastFocusedInput = t as HTMLInputElement | HTMLTextAreaElement;
  }
}, true);
document.addEventListener("focusin", (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
    lastFocusedInput = t as HTMLInputElement | HTMLTextAreaElement;
  }
}, true);

// ── Message helpers ──────────────────────────────

/** Safely send a message — returns null if extension context is invalidated. */
function safeSendMessage(message: unknown, callback: (response: unknown) => void): void {
  try {
    if (!chrome.runtime?.id) return; // Context invalidated
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        // Extension was reloaded/updated — context invalidated
        return;
      }
      callback(response);
    });
  } catch {
    // "Extension context invalidated" — silently ignore
  }
}

async function getCredentialsForCurrentPage(): Promise<Credential[]> {
  return new Promise((resolve) => {
    safeSendMessage(
      { type: "GET_CREDENTIALS", domain: "" },
      (response: unknown) => {
        const res = response as { type?: string; credentials?: Credential[] };
        if (res?.type === "CREDENTIALS_RESULT") {
          resolve(res.credentials ?? []);
        } else {
          resolve([]);
        }
      }
    );
    // Resolve after 3s if no response (context may be dead)
    setTimeout(() => resolve([]), 3000);
  });
}

async function checkExisting(): Promise<Credential[]> {
  return new Promise((resolve) => {
    safeSendMessage(
      { type: "CHECK_EXISTING", domain: "" },
      (response: unknown) => {
        const res = response as { type?: string; credentials?: Credential[] };
        if (res?.type === "CHECK_EXISTING_RESULT") {
          resolve(res.credentials ?? []);
        } else {
          resolve([]);
        }
      }
    );
    setTimeout(() => resolve([]), 3000);
  });
}

/** True when the user has excluded this site in settings. */
async function isExcludedSite(): Promise<boolean> {
  try {
    if (!chrome.runtime?.id) return true;
    const stored = await chrome.storage.local.get("claspt_config");
    const excluded = stored["claspt_config"]?.excludedDomains ?? [];
    return isExcludedDomain(window.location.hostname, excluded);
  } catch {
    return true; // Can't read the setting — stay out of the page.
  }
}

async function isNeverSave(): Promise<boolean> {
  return new Promise((resolve) => {
    safeSendMessage(
      { type: "GET_DOMAIN_PREF", domain: "" },
      (response: unknown) => {
        const res = response as { type?: string; pref?: { neverSave?: boolean } };
        if (res?.type === "DOMAIN_PREF_RESULT" && res.pref?.neverSave) {
          resolve(true);
        } else {
          resolve(false);
        }
      }
    );
    setTimeout(() => resolve(false), 3000);
  });
}

function saveCredential(creds: CapturedCredentials): void {
  safeSendMessage({
    type: "SAVE_CREDENTIAL",
    username: creds.username,
    password: creds.password,
    url: creds.url,
    domain: creds.domain,
  }, () => {});
  clearPendingSave();
}

/**
 * Update an existing credential from the save bar.
 *
 * Patches only the fields the user actually re-entered. The previous
 * implementation sent UPDATE_CREDENTIAL, which fetched the page and rewrote
 * its first secret block from scratch — silently discarding `totp`, `note`,
 * `url_match`, `primary`, `deprecated` and every custom field on it.
 */
function updateCredential(creds: CapturedCredentials, existing: Credential): void {
  const passwordKey = "pass" in existing.fields ? "pass" : "password";
  const fields: Record<string, string> = { [passwordKey]: creds.password };
  if (creds.username) {
    const usernameKey = ["username", "user", "login", "email"].find((k) => k in existing.fields) ?? "username";
    fields[usernameKey] = creds.username;
  }
  safeSendMessage({
    type: "PATCH_SECRET_BLOCK",
    pagePath: existing.pagePath,
    label: existing.label,
    fields,
  } as Message, () => {});
  clearPendingSave();
}

function setNeverSave(): void {
  safeSendMessage({
    type: "SET_DOMAIN_PREF",
    domain: "",
    pref: { autoFillEnabled: true, neverSave: true },
  }, () => {});
  clearPendingSave();
}

// ── Pending save persistence (survives navigation) ──

interface PendingSave {
  username: string;
  password: string;
  url: string;
  domain: string;
  isSignup: boolean;
  timestamp: number;
}

function storePendingSave(creds: CapturedCredentials): void {
  const pending: PendingSave = {
    ...creds,
    timestamp: Date.now(),
  };
  try {
    chrome.storage.session.set({ claspt_pending_save: pending });
  } catch {
    // Storage not available on this page (e.g., chrome:// pages)
  }
}

function clearPendingSave(): void {
  try {
    chrome.storage.session.remove("claspt_pending_save");
  } catch {
    // Storage not available
  }
}

async function getPendingSave(): Promise<PendingSave | null> {
  try {
    const result = await chrome.storage.session.get("claspt_pending_save");
    const pending = result["claspt_pending_save"] as PendingSave | undefined;
    if (!pending) return null;
    if (Date.now() - pending.timestamp > 300_000) {
      await addToUnsavedQueue(pending);
      clearPendingSave();
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

// ── Unsaved credentials queue (in-memory only — cleared on browser close) ──
//
// SECURITY: these entries contain cleartext passwords the user hasn't yet
// committed to the vault. They live in chrome.storage.session (memory-backed,
// wiped when the browser closes) — NEVER chrome.storage.local, which persists
// plaintext to disk. The background worker also wipes this key on auto-lock
// (see lockExtension). Reading it back from the popup works because the
// background worker raises the session-storage access level to include
// untrusted (content-script) contexts on startup.

export interface UnsavedCredential {
  username: string;
  password: string;
  url: string;
  domain: string;
  timestamp: number;
}

const UNSAVED_KEY = STORAGE_KEY_UNSAVED;
const MAX_UNSAVED = 50;

async function addToUnsavedQueue(creds: PendingSave | CapturedCredentials): Promise<void> {
  let result;
  try {
    result = await chrome.storage.session.get(UNSAVED_KEY);
  } catch {
    return; // Storage not available
  }
  const queue: UnsavedCredential[] = result[UNSAVED_KEY] ?? [];

  // Don't add duplicates (same domain + username)
  const isDuplicate = queue.some(
    (q) => q.domain === creds.domain && q.username === creds.username && q.password === creds.password
  );
  if (isDuplicate) return;

  const entry: UnsavedCredential = {
    username: creds.username,
    password: creds.password,
    url: creds.url,
    domain: creds.domain,
    timestamp: Date.now(),
  };
  const updated = [entry, ...queue].slice(0, MAX_UNSAVED);
  await chrome.storage.session.set({ [UNSAVED_KEY]: updated });
}

/** Move credentials to the unsaved queue when dismissed without saving. */
async function movePendingToUnsaved(): Promise<void> {
  const pending = await getPendingSaveRaw();
  if (pending) {
    await addToUnsavedQueue(pending);
    clearPendingSave();
  }
}

/** Get pending save without expiry check (for moving to unsaved). */
async function getPendingSaveRaw(): Promise<PendingSave | null> {
  try {
    const result = await chrome.storage.session.get("claspt_pending_save");
    return (result["claspt_pending_save"] as PendingSave) ?? null;
  } catch {
    return null;
  }
}

// ── Inline icons ──────────────────────────────────

function updateInlineIcons(fields: DetectedField[]) {
  try {
    chrome.storage.local.get("claspt_config", (result) => {
      if (chrome.runtime.lastError) return;
      const config = result["claspt_config"];
      if (isExcludedDomain(window.location.hostname, config?.excludedDomains ?? [])) return;
      if (!config || config.autoFillEnabled !== false) {
        injectInlineIcons(fields, getCredentialsForCurrentPage);
      }
    });
  } catch {
    // Storage not available — still inject icons with defaults
    injectInlineIcons(fields, getCredentialsForCurrentPage);
  }
}

// ── Save bar flow ────────────────────────────────

async function handleCapture(captured: CapturedCredentials) {
  if (await isExcludedSite()) return;
  const never = await isNeverSave();
  if (never) return;

  // ── Password-change auto-detect ─────────────────────────
  // If the user filled credential X here and submitted with a different
  // password, route through the v2.0.0 PATCH_SECRET_BLOCK endpoint to
  // rotate the saved password — non-destructive, preserves all other
  // fields (note, totp, url_match, primary, deprecated).
  const lastFilled = getLastFilled();
  if (
    lastFilled &&
    captured.username &&
    lastFilled.credential.fields["username"] === captured.username &&
    captured.password &&
    captured.password !== lastFilled.filledPasswordValue
  ) {
    const cred = lastFilled.credential;
    showSaveBar({
      username: captured.username,
      password: captured.password,
      url: captured.url,
      existing: [cred],
      onSave: () => rotatePassword(cred, captured.password),
      onUpdate: (target) => rotatePassword(target, captured.password),
      onNever: () => setNeverSave(),
      onDismiss: () => movePendingToUnsaved(),
    });
    storePendingSave(captured);
    return;
  }

  // Store in session storage so it persists across redirect/2FA
  storePendingSave(captured);

  // Check for existing credentials on this domain
  const existing = await checkExisting();

  // ── Suppress the bar for an unchanged, already-stored login ──────────
  // If the submitted username+password EXACTLY matches a credential we
  // already have, there is nothing to save or update — offering "Update"
  // here is noise (and confusing: the user just logged in successfully with
  // the stored value). Only fall through to the bar when the credential is
  // genuinely new, or the username matches but the password differs (a real
  // rotation the user should be prompted about).
  if (existing.some((c) => credentialMatches(c, captured))) {
    clearPendingSave();
    return;
  }

  showSaveBar({
    username: captured.username,
    password: captured.password,
    url: captured.url,
    existing,
    onSave: () => saveCredential(captured),
    onUpdate: (cred) => updateCredential(captured, cred),
    onNever: () => setNeverSave(),
    onDismiss: () => {
      // Don't delete — move to persistent unsaved queue so user can save later
      movePendingToUnsaved();
    },
  });
}

/**
 * True when a stored credential already holds exactly the submitted
 * username AND password — i.e. nothing changed. Uses the same field-key
 * fallbacks as the auto-filler so it matches whatever keys the secret block
 * happens to use (username/user/login/email, password/pass).
 */
function credentialMatches(cred: Credential, captured: CapturedCredentials): boolean {
  const f = cred.fields;
  const storedUser =
    f["username"] || f["user"] || f["login"] || f["email"] || "";
  const storedPass = f["password"] || f["pass"] || "";
  // Password must match exactly (and be non-empty), and the usernames must
  // line up — treating "absent on both sides" as equal so a password-only
  // secret still counts as unchanged. If the page supplied a username the
  // stored credential lacks, that's not a match — let the bar offer to save.
  if (!captured.password || storedPass !== captured.password) return false;
  return storedUser === (captured.username || "");
}

/**
 * Non-destructive password rotation via the v2.0.0 PATCH_SECRET_BLOCK
 * endpoint. Preserves every other field on the credential — note, totp,
 * url_match, primary, deprecated, custom fields all survive.
 */
function rotatePassword(credential: Credential, newPassword: string): void {
  const passwordKey = ["password", "pass"].find((k) => k in credential.fields) ?? "password";
  safeSendMessage(
    {
      type: "PATCH_SECRET_BLOCK",
      pagePath: credential.pagePath,
      label: credential.label,
      fields: { [passwordKey]: newPassword },
    } as Message,
    (response) => {
      const res = response as { type?: string; success?: boolean; errorMessage?: string };
      if (res?.type === "PATCH_SECRET_BLOCK_RESULT" && res.success) {
        clearPendingSave();
        dismissSaveBar();
      } else {
        // Surface the error as a banner — don't silently swallow.
        const msg = res?.errorMessage ?? "password rotation failed";
        dbg("rotatePassword failed:", msg);
      }
    },
  );
}

/** Check for a pending save from a previous page (login redirect). */
async function checkPendingSave() {
  const pending = await getPendingSave();
  if (!pending) return;

  // Only show if we're on a different page now (redirect happened)
  if (pending.url === window.location.href) return;

  const never = await isNeverSave();
  if (never) {
    clearPendingSave();
    return;
  }

  const existing = await checkExisting();

  showSaveBar({
    username: pending.username,
    password: pending.password,
    url: pending.url,
    existing,
    onSave: () => saveCredential(pending as CapturedCredentials),
    onUpdate: (cred) => updateCredential(pending as CapturedCredentials, cred),
    onNever: () => setNeverSave(),
    onDismiss: () => movePendingToUnsaved(),
  });
}

// ── DOM removal detection (SPA submission signal) ──

function observePasswordFieldRemoval(onRemoval: () => void) {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        // Check if a password field was removed (form submitted in SPA)
        if (
          node.querySelector?.('input[type="password"]') ||
          (node instanceof HTMLInputElement && node.type === "password")
        ) {
          onRemoval();
          return;
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}

// ── Init ──────────────────────────────────────────

let lastCaptured: CapturedCredentials | null = null;

async function init() {
  // Bail early if extension context is already dead
  try {
    if (!chrome.runtime?.id) return;
  } catch { return; }

  await loadDebugState();
  detectedFields = detectFields();
  dbg("Detected fields:", detectedFields.length, detectedFields.map((f) => `${f.type}:${f.element.name || f.element.id || f.element.type}`));

  updateInlineIcons(detectedFields);

  // Watch for dynamic form additions (SPAs)
  observeForms((fields) => {
    try { if (!chrome.runtime?.id) return; } catch { return; }
    detectedFields = fields;
    updateInlineIcons(fields);
  });

  // Watch for ALL form submissions (login + signup)
  observeSignupForms((captured) => {
    lastCaptured = captured;
    handleCapture(captured);
  });

  // Watch for password field removal (SPA submission signal)
  observePasswordFieldRemoval(() => {
    if (lastCaptured) {
      // The form was removed — likely submitted. Show save bar if not already shown.
      handleCapture(lastCaptured);
      lastCaptured = null;
    }
  });

  // Check for pending save from redirect
  checkPendingSave();

  // Auto-fill on page load (if enabled and credentials available)
  autoFillOnLoad();
}

/** Per-credential URL matching policy, read from the secret block fields. */
function matchPolicyOf(cred: Credential): "base_domain" | "host" | "exact" | "never" | undefined {
  const raw = (cred.fields["url_match"] || cred.fields["url match"] || "").toLowerCase().trim();
  if (raw === "never" || raw === "exact" || raw === "host" || raw === "base_domain") return raw;
  return undefined;
}

/** Auto-fill the first matching credential on page load (if enabled). */
async function autoFillOnLoad() {
  let stored;
  try {
    if (!chrome.runtime?.id) return;
    stored = await chrome.storage.local.get("claspt_config");
  } catch { return; }
  const cfg = stored["claspt_config"];
  if (!cfg?.autoFillOnPageLoad) return;
  if (isExcludedDomain(window.location.hostname, cfg.excludedDomains ?? [])) return;
  if (detectedFields.length === 0) return;
  if (window !== window.top) return; // Never auto-fill in iframes

  // Never silently auto-fill into a non-HTTPS origin (plaintext-sniffable).
  // Localhost is exempted inside isFillableOrigin(). Silent skip on http.
  if (!isFillableOrigin()) return;

  const credentials = await getCredentialsForCurrentPage();
  if (credentials.length === 0) return;

  // Require POSITIVE, URL-backed domain evidence before typing a password into
  // a page the user never interacted with. A high score alone is NOT enough:
  // the label-token heuristic (no stored URL) can be spoofed, so isAutofillSafe
  // demands an exact-host or registrable-domain match against the credential's
  // saved URL. This is the blocking anti-phishing gate for auto-fill.
  const topMatch = credentials.find(
    (c) => (c.score ?? 0) >= 100 && isAutofillSafe(window.location.href, c, matchPolicyOf(c)),
  );
  if (!topMatch) return;

  fillFields(detectedFields, topMatch, {
    showFlash: cfg.showFillFlash ?? true,
    autoFillTotp: cfg.autoFillTotp ?? true,
  });
}

// Listen for messages from background service worker
// Guard the entire listener — if context is invalidated, addListener itself can throw
try {
  if (chrome.runtime?.id) {
    chrome.runtime.onMessage.addListener(
      (
        message: { type: string; credential?: Credential; text?: string; submit?: boolean },
        _sender,
        sendResponse
      ) => {
        // Check context is still valid before processing
        if (!chrome.runtime?.id) return;

        switch (message.type) {
          case "FILL_CREDENTIAL": {
            if (!message.credential) {
              sendResponse({ type: "FILL_RESULT", success: false });
              break;
            }

            if (window !== window.top) {
              sendResponse({ type: "FILL_RESULT", success: false });
              break;
            }

            const cred = message.credential;

            // Refuse to fill secrets into a non-HTTPS origin. Warn + skip
            // (localhost is exempted inside isFillableOrigin()).
            if (!isFillableOrigin()) {
              showInsecureOriginWarning(window.location.hostname);
              sendResponse({ type: "FILL_RESULT", success: false });
              break;
            }

            // BLOCKING phishing/mismatch check: if the credential carries a URL
            // whose registrable domain differs from the current site, do NOT
            // fill — show the warning and bail. (Registrable-domain comparison
            // keeps legitimate subdomains like accounts.google.com working.)
            if (isDomainMismatch(cred.url, window.location.hostname)) {
              let savedDomain = cred.url ?? "";
              try { savedDomain = new URL(cred.url as string).hostname; } catch { /* keep raw */ }
              showPhishingWarning(savedDomain, window.location.hostname);
              sendResponse({ type: "FILL_RESULT", success: false });
              break;
            }

            detectedFields = detectFields();
            try {
              chrome.storage.local.get("claspt_config", (result) => {
                if (chrome.runtime.lastError) {
                  sendResponse({ type: "FILL_RESULT", success: false });
                  return;
                }
                const cfg = result["claspt_config"] ?? {};
                const success = fillFields(detectedFields, cred, {
                  showFlash: cfg.showFillFlash ?? true,
                  autoFillTotp: cfg.autoFillTotp ?? true,
                });
                // Same advisory as the inline picker: a credential with no
                // saved address could not be checked against this site.
                if (success && !cred.url) {
                  showUnverifiedSiteWarning(cred.label, window.location.hostname);
                }
                if (success && message.submit) {
                  // Give React/Vue/etc a tick to see the value change before submitting
                  setTimeout(() => submitFilledForm(detectedFields), 50);
                }
                sendResponse({ type: "FILL_RESULT", success });
              });
            } catch {
              sendResponse({ type: "FILL_RESULT", success: false });
            }
            return true;
          }

          case "CLIPBOARD_WRITE": {
            if (message.text !== undefined) {
              navigator.clipboard.writeText(message.text).catch(() => {});
            }
            break;
          }

          case "GENERATE_INTO_FIELD": {
            // Drop a freshly-generated password into the most recently
            // right-clicked / focused input. Keeps clipboard as a fallback.
            const value = message.text as string;
            const target = lastFocusedInput;
            if (target && document.contains(target)) {
              const setter = Object.getOwnPropertyDescriptor(
                target.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
                "value"
              )?.set;
              if (setter) setter.call(target, value); else target.value = value;
              target.dispatchEvent(new Event("input", { bubbles: true }));
              target.dispatchEvent(new Event("change", { bubbles: true }));
              target.focus();
            }
            navigator.clipboard.writeText(value).catch(() => {});
            break;
          }
        }
      }
    );
  }
} catch {
  // Extension context invalidated — content script is orphaned, silently ignore
}

// Clean up when navigating away
window.addEventListener("beforeunload", () => {
  try {
    removeInlineIcons();
    dismissSaveBar();
  } catch {
    // Context may be invalidated
  }
});

// Run on load — wrapped to catch any initialization errors from dead context
try {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { try { init(); } catch {} });
  } else {
    init();
  }
} catch {
  // Extension context invalidated at load time
}

/**
 * Submit a form after auto-fill. Tries three strategies in order:
 *  1. The <form> that contains the filled fields → requestSubmit() (fires
 *     submit event; respects validation; React-friendly).
 *  2. A nearby button[type=submit] inside the same form.
 *  3. Enter keydown+keyup on the last filled field (covers SPA login flows
 *     that don't use a real <form>).
 */
function submitFilledForm(fields: DetectedField[]): void {
  if (fields.length === 0) return;
  const lastField = fields[fields.length - 1]?.element;
  if (!lastField) return;

  const form = lastField.closest("form");
  if (form) {
    try {
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
        return;
      }
    } catch { /* fall through */ }

    const submitBtn = form.querySelector<HTMLButtonElement | HTMLInputElement>(
      'button[type="submit"], input[type="submit"], button:not([type])',
    );
    if (submitBtn && !submitBtn.disabled) {
      submitBtn.click();
      return;
    }
  }

  // Fallback: synthesize Enter on the last filled field
  for (const evType of ["keydown", "keypress", "keyup"] as const) {
    lastField.dispatchEvent(
      new KeyboardEvent(evType, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }),
    );
  }
}
