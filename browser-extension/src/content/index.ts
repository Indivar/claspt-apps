// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { detectFields, observeForms, type DetectedField } from "./form-detector";
import { urlMatchPolicyOf } from "@claspt/shared/credential-fields";
import { dbg, loadDebugState } from "@/shared/debug";
import {
  fillFields,
  fillIdentityFields,
  getLastFilled,
  isFillableOrigin,
} from "./form-filler";
import { injectInlineIcons, removeInlineIcons, setEmptyReason } from "./inline-icon";
import {
  injectIdentityIcons,
  removeIdentityIcons,
  type InlineIdentity,
} from "./inline-identity";
import { observeSignupForms, type CapturedCredentials } from "./signup-detector";
import { showSaveBar, dismissSaveBar } from "./save-bar";
import { watchForRejection } from "./rejection-watch";
import { isAutofillSafe, isDomainMismatch } from "@/shared/url-matching";
import {
  showPhishingWarning,
  showInsecureOriginWarning,
  showUnverifiedSiteWarning,
} from "./warnings";
import { isExcludedDomain } from "@/shared/domain-prefs";
import type { CaptureOutcome, Credential, Message, PendingSave } from "@/shared/types";

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
document.addEventListener(
  "contextmenu",
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
      lastFocusedInput = t as HTMLInputElement | HTMLTextAreaElement;
    }
  },
  true,
);
document.addEventListener(
  "focusin",
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
      lastFocusedInput = t as HTMLInputElement | HTMLTextAreaElement;
    }
  },
  true,
);

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
    safeSendMessage({ type: "GET_CREDENTIALS", domain: "" }, (response: unknown) => {
      const res = response as Partial<Extract<Message, { type: "CREDENTIALS_RESULT" }>>;
      if (res?.type === "CREDENTIALS_RESULT") {
        setEmptyReason(res.reason);
        resolve(res.credentials ?? []);
      } else {
        resolve([]);
      }
    });
    // Resolve after 3s if no response (context may be dead)
    setTimeout(() => resolve([]), 3000);
  });
}

async function checkExisting(): Promise<Credential[]> {
  return new Promise((resolve) => {
    safeSendMessage({ type: "CHECK_EXISTING", domain: "" }, (response: unknown) => {
      const res = response as { type?: string; credentials?: Credential[] };
      if (res?.type === "CHECK_EXISTING_RESULT") {
        resolve(res.credentials ?? []);
      } else {
        resolve([]);
      }
    });
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
    safeSendMessage({ type: "GET_DOMAIN_PREF", domain: "" }, (response: unknown) => {
      const res = response as { type?: string; pref?: { neverSave?: boolean } };
      if (res?.type === "DOMAIN_PREF_RESULT" && res.pref?.neverSave) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    setTimeout(() => resolve(false), 3000);
  });
}

/** Where a capture went: a vault page, or the outbox while Claspt is away. */
interface CaptureHandle {
  pagePath?: string;
  parked: boolean;
}

type CaptureResult = Extract<Message, { type: "CAPTURE_RESULT" }>;

/**
 * Take the submitted login into the vault right now. Whatever the page does
 * next, a redirect, a second factor, a crash, the password is already kept.
 */
async function captureLogin(creds: CapturedCredentials): Promise<CaptureHandle | null> {
  const res = await sessionRequest<CaptureResult>(
    {
      type: "CAPTURE_LOGIN",
      username: creds.username,
      password: creds.password,
      url: creds.url,
      isSignup: creds.isSignup,
    },
    CAPTURE_TIMEOUT_MS,
  );
  if (res?.type !== "CAPTURE_RESULT" || !res.success) return null;
  return { pagePath: res.pagePath, parked: res.parked === true };
}

/** The owner said Save: the capture becomes an ordinary login. */
async function confirmCapture(handle: CaptureHandle, creds: CapturedCredentials): Promise<boolean> {
  const res = await sessionRequest<Extract<Message, { type: "CONFIRM_CAPTURE_RESULT" }>>(
    { type: "CONFIRM_CAPTURE", pagePath: handle.pagePath, username: creds.username },
    CAPTURE_TIMEOUT_MS,
  );
  const ok = res?.type === "CONFIRM_CAPTURE_RESULT" && res.success;
  if (ok) clearPendingSave();
  return ok;
}

/** The capture is not wanted: to the trash, or out of the outbox. */
async function discardCapture(handle: CaptureHandle, creds: CapturedCredentials): Promise<boolean> {
  const res = await sessionRequest<Extract<Message, { type: "DISCARD_CAPTURE_RESULT" }>>(
    { type: "DISCARD_CAPTURE", pagePath: handle.pagePath, username: creds.username },
    CAPTURE_TIMEOUT_MS,
  );
  clearPendingSave();
  return res?.type === "DISCARD_CAPTURE_RESULT" && res.success;
}

/**
 * Update an existing credential from the save bar, then drop the capture
 * that was taken for the same submission.
 *
 * Patches only the fields the user actually re-entered, so `totp`, `note`,
 * `url_match`, `primary`, `deprecated` and every custom field survive.
 */
async function updateCredential(
  creds: CapturedCredentials,
  existing: Credential,
  handle: CaptureHandle,
): Promise<boolean> {
  const passwordKey = "pass" in existing.fields ? "pass" : "password";
  const fields: Record<string, string> = { [passwordKey]: creds.password };
  if (creds.username) {
    const usernameKey =
      ["username", "user", "login", "email"].find((k) => k in existing.fields) ??
      "username";
    fields[usernameKey] = creds.username;
  }
  const res = await sessionRequest<Extract<Message, { type: "PATCH_SECRET_BLOCK_RESULT" }>>(
    {
      type: "PATCH_SECRET_BLOCK",
      pagePath: existing.pagePath,
      label: existing.label,
      fields,
    } as Message,
    CAPTURE_TIMEOUT_MS,
  );
  if (res?.type !== "PATCH_SECRET_BLOCK_RESULT" || !res.success) {
    dbg("updateCredential failed:", res?.errorMessage ?? "no response");
    return false;
  }
  await discardCapture(handle, creds);
  return true;
}

function setNeverSave(): void {
  safeSendMessage(
    {
      type: "SET_DOMAIN_PREF",
      domain: "",
      pref: { autoFillEnabled: true, neverSave: true },
    },
    () => {},
  );
  clearPendingSave();
}

/** Tell the popup what became of the last submission on this site. */
function recordOutcome(outcome: CaptureOutcome, username: string, pagePath?: string): void {
  void sessionRequest({ type: "LAST_CAPTURE_SET", capture: { outcome, username, pagePath } });
}

// ── Pending save persistence (survives navigation) ──
//
// The capture itself is in the vault. What lives with the background worker
// is only the handoff that lets the bar come back on the next page of this
// site, bound to the site by the worker (see background/session-store.ts).
// This file never touches session storage.

/** A vault write can take longer than a session lookup. */
const CAPTURE_TIMEOUT_MS = 15_000;

function sessionRequest<T extends Message>(
  message: Message,
  timeoutMs = 3000,
): Promise<T | null> {
  return new Promise((resolve) => {
    safeSendMessage(message, (response: unknown) => {
      resolve((response as T | undefined) ?? null);
    });
    setTimeout(() => resolve(null), timeoutMs);
  });
}

function storePendingSave(creds: CapturedCredentials, pagePath?: string): void {
  void sessionRequest({
    type: "PENDING_SAVE_SET",
    credentials: {
      username: creds.username,
      password: creds.password,
      url: creds.url,
      isSignup: creds.isSignup,
      pagePath,
    },
  });
}

function clearPendingSave(): void {
  void sessionRequest({ type: "PENDING_SAVE_CLEAR" });
}

async function getPendingSave(): Promise<PendingSave | null> {
  const res = await sessionRequest<Extract<Message, { type: "PENDING_SAVE_RESULT" }>>({
    type: "PENDING_SAVE_GET",
  });
  return res?.type === "PENDING_SAVE_RESULT" ? res.pending : null;
}

/** The bar was closed by hand: stop asking on this site. The capture stays listed. */
function parkPendingSave(): void {
  void sessionRequest({ type: "PENDING_SAVE_PARK" });
}

// ── Inline icons ──────────────────────────────────

function updateInlineIcons(fields: DetectedField[]) {
  try {
    chrome.storage.local.get("claspt_config", (result) => {
      if (chrome.runtime.lastError) return;
      const config = result["claspt_config"];
      if (isExcludedDomain(window.location.hostname, config?.excludedDomains ?? []))
        return;
      if (!config || config.autoFillEnabled !== false) {
        injectInlineIcons(fields, getCredentialsForCurrentPage);
        injectIdentityIcons(fields, getIdentitiesForCurrentPage);
      }
    });
  } catch {
    // Storage not available — still inject icons with defaults
    injectInlineIcons(fields, getCredentialsForCurrentPage);
    injectIdentityIcons(fields, getIdentitiesForCurrentPage);
  }
}

/**
 * The stored identities, ordered with the one last used on this site first.
 *
 * Ordering happens in the background because that is where the per-site record
 * lives; the content script has no business holding browsing preferences.
 */
function getIdentitiesForCurrentPage(): Promise<InlineIdentity[]> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "LIST_IDENTITIES_FOR_SITE", host: window.location.hostname },
        (res: { type?: string; items?: InlineIdentity[] }) => {
          if (
            chrome.runtime.lastError ||
            res?.type !== "LIST_IDENTITIES_FOR_SITE_RESULT"
          ) {
            resolve([]);
            return;
          }
          resolve(res.items ?? []);
        },
      );
    } catch {
      // Extension context invalidated mid-navigation; no icons is the right
      // outcome, not an exception into the page.
      resolve([]);
    }
  });
}

// ── Save bar flow ────────────────────────────────

async function handleCapture(captured: CapturedCredentials) {
  if (await isExcludedSite()) {
    recordOutcome("excluded", captured.username);
    return;
  }
  if (await isNeverSave()) {
    recordOutcome("never_save", captured.username);
    return;
  }

  // Captures still waiting for a decision are not "existing logins" to
  // update; they are the thing being decided.
  const existing = (await checkExisting()).filter((c) => !c.captured);

  // A credential filled on this page and submitted with a new password is
  // an update of that credential, whether or not the site lookup found it.
  const lastFilled = getLastFilled();
  if (
    lastFilled &&
    !existing.some(
      (c) =>
        c.pagePath === lastFilled.credential.pagePath &&
        c.label === lastFilled.credential.label,
    )
  ) {
    existing.unshift(lastFilled.credential);
  }

  // An unchanged, already-stored login needs nothing: no write, no bar.
  if (existing.some((c) => credentialMatches(c, captured))) {
    clearPendingSave();
    recordOutcome("already_saved", captured.username);
    return;
  }

  const handle = await captureLogin(captured);
  if (!handle) {
    recordOutcome("failed", captured.username);
    return;
  }
  recordOutcome(handle.parked ? "parked" : "captured", captured.username, handle.pagePath);
  storePendingSave(captured, handle.pagePath);

  // If the site now says the password was wrong, the capture is not worth
  // keeping. Only a rejection the site states plainly counts.
  watchForRejection(() => {
    dismissSaveBar();
    void discardCapture(handle, captured);
    recordOutcome("failed", captured.username);
  });

  presentCapture(captured, handle, existing);
}

/** The bar, wired the same way whether shown at submit or after a redirect. */
function presentCapture(
  captured: CapturedCredentials,
  handle: CaptureHandle,
  existing: Credential[],
) {
  showSaveBar({
    username: captured.username,
    password: captured.password,
    url: captured.url,
    existing,
    parked: handle.parked,
    onSave: () => confirmCapture(handle, captured),
    onUpdate: (cred) => updateCredential(captured, cred, handle),
    onNever: () => {
      void discardCapture(handle, captured);
      setNeverSave();
    },
    onDismiss: (reason) => {
      // Closed by hand: stop asking on this site; the popup still lists it.
      // Timed out: not answered yet, so the next page of the site asks again.
      if (reason === "closed") parkPendingSave();
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
  const storedUser = f["username"] || f["user"] || f["login"] || f["email"] || "";
  const storedPass = f["password"] || f["pass"] || "";
  // Password must match exactly (and be non-empty), and the usernames must
  // line up — treating "absent on both sides" as equal so a password-only
  // secret still counts as unchanged. If the page supplied a username the
  // stored credential lacks, that's not a match — let the bar offer to save.
  if (!captured.password || storedPass !== captured.password) return false;
  return storedUser === (captured.username || "");
}

/** Bring the bar back after a redirect, for a capture not yet answered. */
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

  const existing = (await checkExisting()).filter((c) => !c.captured);
  const handle: CaptureHandle = { pagePath: pending.pagePath, parked: !pending.pagePath };
  presentCapture(
    {
      username: pending.username,
      password: pending.password,
      url: pending.url,
      domain: pending.domain,
      isSignup: pending.isSignup,
    },
    handle,
    existing,
  );
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
  } catch {
    return;
  }

  await loadDebugState();
  detectedFields = detectFields();
  dbg(
    "Detected fields:",
    detectedFields.length,
    detectedFields.map(
      (f) => `${f.type}:${f.element.name || f.element.id || f.element.type}`,
    ),
  );

  updateInlineIcons(detectedFields);

  // Watch for dynamic form additions (SPAs)
  observeForms((fields) => {
    try {
      if (!chrome.runtime?.id) return;
    } catch {
      return;
    }
    detectedFields = fields;
    updateInlineIcons(fields);
  });

  // Capturing what was typed, offering to save it, surfacing a pending save
  // and filling on load all belong to the page the person is looking at. In
  // an iframe they belonged to whoever embedded the frame, and the worker
  // answered for the outer site.
  if (window !== window.top) return;

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
function matchPolicyOf(
  cred: Credential,
): "base_domain" | "host" | "exact" | "never" | undefined {
  return urlMatchPolicyOf(cred.fields);
}

/** Auto-fill the first matching credential on page load (if enabled). */
async function autoFillOnLoad() {
  let stored;
  try {
    if (!chrome.runtime?.id) return;
    stored = await chrome.storage.local.get("claspt_config");
  } catch {
    return;
  }
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
    (c) =>
      (c.score ?? 0) >= 100 && isAutofillSafe(window.location.href, c, matchPolicyOf(c)),
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
        // Widened by hand rather than using the Message union, which is what
        // it was before: a message the popup sends and this file does not
        // handle produces no error anywhere, which is how FILL_IDENTITY came
        // to be sent for months with nothing listening.
        message: {
          type: string;
          credential?: Credential;
          text?: string;
          submit?: boolean;
          identity?: Record<string, string>;
          pagePath?: string;
        },
        _sender,
        sendResponse,
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
              try {
                savedDomain = new URL(cred.url as string).hostname;
              } catch {
                /* keep raw */
              }
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

          case "FILL_IDENTITY": {
            // The popup has sent this since identities were added; nothing
            // listened for it, so the Fill button did nothing.
            if (window !== window.top) {
              sendResponse({ type: "FILL_IDENTITY_RESULT", filled: 0 });
              break;
            }
            if (!isFillableOrigin()) {
              showInsecureOriginWarning(window.location.hostname);
              sendResponse({ type: "FILL_IDENTITY_RESULT", filled: 0 });
              break;
            }
            // Detect afresh rather than trusting a cached scan: address forms
            // are commonly revealed a step into a checkout, after the last one.
            const filled = fillIdentityFields(detectFields(), message.identity ?? {});
            if (filled > 0 && message.pagePath) {
              // Remember the choice for this site, so the next visit offers
              // this identity first. The path is a reference, never a value.
              chrome.runtime.sendMessage({
                type: "REMEMBER_IDENTITY_FOR_SITE",
                host: window.location.hostname,
                pagePath: message.pagePath,
              });
            }
            sendResponse({ type: "FILL_IDENTITY_RESULT", filled });
            break;
          }

          case "CLIPBOARD_WRITE": {
            if (message.text !== undefined) {
              // Say whether it worked, so the worker can try again elsewhere
              // when this document is not focused.
              navigator.clipboard
                .writeText(message.text)
                .then(() => sendResponse({ type: "CLIPBOARD_WRITTEN", ok: true }))
                .catch(() => sendResponse({ type: "CLIPBOARD_WRITTEN", ok: false }));
              return true;
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
                target.tagName === "TEXTAREA"
                  ? HTMLTextAreaElement.prototype
                  : HTMLInputElement.prototype,
                "value",
              )?.set;
              if (setter) setter.call(target, value);
              else target.value = value;
              target.dispatchEvent(new Event("input", { bubbles: true }));
              target.dispatchEvent(new Event("change", { bubbles: true }));
              target.focus();
            }
            navigator.clipboard.writeText(value).catch(() => {});
            break;
          }
        }
      },
    );
  }
} catch {
  // Extension context invalidated — content script is orphaned, silently ignore
}

// Clean up when navigating away
window.addEventListener("beforeunload", () => {
  try {
    removeInlineIcons();
    removeIdentityIcons();
    dismissSaveBar();
  } catch {
    // Context may be invalidated
  }
});

// Run on load — wrapped to catch any initialization errors from dead context
try {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      try {
        init();
      } catch (e) {
        // A failed start must not take the page down, but silence hid it.
        console.warn("[Claspt] content script failed to start", e);
      }
    });
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
    } catch {
      /* fall through */
    }

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
      new KeyboardEvent(evType, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }),
    );
  }
}
