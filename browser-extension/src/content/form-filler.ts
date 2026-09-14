// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { Credential } from "@/shared/types";
import type { DetectedField } from "./form-detector";
import { isDomainMismatch } from "@/shared/url-matching";
import { generateTotp } from "@/shared/totp";

/**
 * Tracks the credential most recently filled into THIS document. Used by
 * the password-change auto-detect flow: if the user filled credential X
 * here and then submits the form with a different password value, we know
 * it's a rotation rather than a brand-new credential. Cleared when the
 * inline icon's dropdown closes or the document tab navigates away.
 */
interface LastFilled {
  credential: Credential;
  /** The password value we wrote — used to detect "user changed it after fill". */
  filledPasswordValue: string;
  /** Element refs so we can validate the same fields are still present at submit time. */
  passwordElement: WeakRef<HTMLInputElement> | null;
  /** When the fill happened (ms epoch). Stale fills (>10 min) are ignored. */
  timestamp: number;
}

let lastFilled: LastFilled | null = null;

/**
 * Whether the current top-level origin is safe to auto-fill credentials into.
 * Secrets must never be typed into a page served over plaintext HTTP, where a
 * network attacker can both inject the login form and read the submitted
 * password. HTTPS is required, with a localhost exception for local dev
 * (127.0.0.1 / ::1 / localhost) where there is no network path to sniff.
 */
export function isFillableOrigin(loc: Location = window.location): boolean {
  if (loc.protocol === "https:") return true;
  if (loc.protocol === "http:") {
    const host = loc.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  }
  // file:, ftp:, data:, etc. — never fill.
  return false;
}

/** Clear the tracked last-filled credential (call when the user closes the picker without filling). */
export function clearLastFilled() {
  lastFilled = null;
}

/** Returns the most-recently-filled credential if it's still fresh (<10 min). */
export function getLastFilled(): LastFilled | null {
  if (!lastFilled) return null;
  if (Date.now() - lastFilled.timestamp > 10 * 60 * 1000) {
    lastFilled = null;
    return null;
  }
  return lastFilled;
}

/**
 * Fill credential values into form fields.
 *
 * Uses React-compatible event dispatch: sets the value via the native
 * input value setter (bypassing React's synthetic event system), then
 * dispatches input/change events so frameworks pick up the change.
 */
export function fillFields(
  fields: DetectedField[],
  credential: Credential,
  options?: { showFlash?: boolean; autoFillTotp?: boolean },
): boolean {
  // Hard defense-in-depth guard: never write secrets into an insecure origin,
  // regardless of which path (auto or manual) reached us. Callers own the UX
  // (silent skip vs. warning); this just guarantees no fill slips through.
  if (!isFillableOrigin()) {
    console.warn("[Claspt] Blocked fill on non-HTTPS origin");
    return false;
  }

  // Hard defense-in-depth guard: never fill a credential onto a site whose
  // registrable domain differs from the one the credential was saved for. The
  // message-driven fill path (popup / keyboard / context menu) checks this and
  // shows a phishing warning, but the inline in-page picker used to call us
  // directly and skip it — so a weakly-matched credential could be typed (and
  // auto-submitted) onto an attacker's look-alike form. Enforcing it HERE makes
  // every fill path honor the guard. Credentials with no saved URL are not
  // blocked (isDomainMismatch returns false) since there is nothing to compare;
  // callers surface the UX warning.
  if (isDomainMismatch(credential.url, window.location.hostname)) {
    console.warn("[Claspt] Blocked fill: credential domain does not match current site");
    return false;
  }

  let filled = false;
  const showFlash = options?.showFlash ?? true;

  const username = credential.fields["username"] || credential.fields["user"] || credential.fields["login"] || credential.fields["email"];
  const password = credential.fields["password"] || credential.fields["pass"];
  const totp = credential.fields["otp"] || credential.fields["totp"] || credential.fields["otp_secret"];

  for (const field of fields) {
    let value: string | undefined;

    // Determine value based on detected field type
    switch (field.type) {
      case "username":
      case "email":
        value = username;
        break;
      case "password":
        value = password;
        break;
      case "otp":
        value = totp;
        break;
    }

    // Safety: never fill a type="password" HTML input with the username value.
    // Some sites have unusual form structures where the detector may misclassify.
    const htmlType = field.element.type?.toLowerCase();
    if (htmlType === "password" && value === username && password) {
      value = password;
    }
    // Also: never fill a type="text"/"email" input with the password
    if ((htmlType === "text" || htmlType === "email" || htmlType === "") && value === password && username) {
      value = username;
    }

    if (value) {
      // Check iframe protection
      if (field.element.ownerDocument !== document) {
        console.warn("[Claspt] Blocked fill in cross-origin iframe");
        continue;
      }

      setInputValue(field.element, value);
      if (showFlash) flashField(field.element);
      filled = true;
    }
  }

  // Auto-fill TOTP: if we filled password and there's a TOTP secret but no OTP field
  // detected yet, watch for it to appear (common after password submission)
  if (filled && options?.autoFillTotp && totp && !fields.some((f) => f.type === "otp")) {
    watchForOtpField(totp);
  }

  // Track this fill so the password-change auto-detect can later compare
  // the submitted form's password against what we wrote. Only when an
  // actual password got filled — pre-fill of just username doesn't count
  // as "we know which credential is in play".
  if (filled && password) {
    const passwordField = fields.find((f) => f.type === "password");
    lastFilled = {
      credential,
      filledPasswordValue: password,
      passwordElement: passwordField ? new WeakRef(passwordField.element) : null,
      timestamp: Date.now(),
    };
  }

  return filled;
}

/** Watch for OTP field to appear (e.g., after password step) and auto-fill it. */
function watchForOtpField(totpSecret: string) {
  let attempts = 0;
  const maxAttempts = 20; // 10 seconds
  const interval = setInterval(() => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      return;
    }

    const otpFields = document.querySelectorAll<HTMLInputElement>(
      'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="totp" i], ' +
      'input[name*="code" i], input[name*="verification" i], input[name*="2fa" i], ' +
      'input[aria-label*="verification" i], input[placeholder*="code" i]'
    );

    for (const field of otpFields) {
      if (field.offsetParent !== null && !field.value) {
        clearInterval(interval);
        // Generate the CURRENT 6-digit code from the seed and fill that —
        // never type the raw TOTP secret into a form field (the old code did,
        // which both failed the login and leaked the long-lived seed). If the
        // value isn't a valid seed, generateTotp rejects and we fill nothing.
        void generateTotp(totpSecret)
          .then(({ code }) => {
            if (code && !field.value) {
              setInputValue(field, code);
              flashField(field);
            }
          })
          .catch(() => {
            /* not a valid TOTP seed — do not fill anything */
          });
        return;
      }
    }
  }, 500);
}

/**
 * Set an input's value in a way that works with React, Vue, Angular, etc.
 */
function setInputValue(input: HTMLInputElement, value: string): void {
  input.focus();

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
}

/** Flash the field with a gold highlight to confirm fill. */
function flashField(element: HTMLInputElement): void {
  const originalOutline = element.style.outline;
  const originalTransition = element.style.transition;
  const originalBoxShadow = element.style.boxShadow;

  element.style.transition = "outline 0.15s, box-shadow 0.15s";
  element.style.outline = "2px solid #d4930a";
  element.style.boxShadow = "0 0 8px rgba(212, 147, 10, 0.4)";

  setTimeout(() => {
    element.style.transition = "outline 0.4s, box-shadow 0.4s";
    element.style.outline = originalOutline;
    element.style.boxShadow = originalBoxShadow;
    setTimeout(() => {
      element.style.transition = originalTransition;
    }, 400);
  }, 800);
}
