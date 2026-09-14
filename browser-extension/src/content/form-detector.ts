// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Detect login/credential forms on the page using MutationObserver.
 * Identifies username, email, password, and OTP fields using selectors,
 * ARIA attributes, placeholder text, labels, and proximity heuristics.
 */

export interface DetectedField {
  element: HTMLInputElement;
  type: "username" | "password" | "email" | "otp" | "card_number" | "card_expiry" | "card_cvv" | "card_name";
}

// ── Selectors ───────────────────────────────────

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[name="username"]',
  'input[name="user"]',
  'input[name="login"]',
  'input[name="userid"]',
  'input[name="user_id"]',
  'input[name="loginId"]',
  'input[name="account"]',
  'input[name="signin"]',
  'input[id="username"]',
  'input[id="user"]',
  'input[id="login"]',
  'input[id="loginId"]',
  'input[id="userid"]',
  'input[id="account"]',
  'input[aria-label*="username" i]',
  'input[aria-label*="user name" i]',
  'input[placeholder*="username" i]',
  'input[placeholder*="user name" i]',
];

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[autocomplete="email"]',
  'input[name="email"]',
  'input[name="userEmail"]',
  'input[name="emailAddress"]',
  'input[name="login_email"]',
  'input[id="email"]',
  'input[id="userEmail"]',
  'input[aria-label*="email" i]',
  'input[placeholder*="email" i]',
  'input[placeholder*="e-mail" i]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
];

const OTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name="otp"]',
  'input[name="totp"]',
  'input[name="code"]',
  'input[name="verification"]',
  'input[name="verificationCode"]',
  'input[name="mfaCode"]',
  'input[name="twoFactorCode"]',
  'input[name="2fa"]',
  'input[id="otp"]',
  'input[id="totp"]',
  'input[id="mfaCode"]',
  'input[aria-label*="verification code" i]',
  'input[aria-label*="one-time" i]',
  'input[aria-label*="2fa" i]',
  'input[placeholder*="verification code" i]',
  'input[placeholder*="one-time" i]',
  'input[placeholder*="6-digit" i]',
];

// ── Credit Card / Payment Field Selectors ──

const CARD_NUMBER_SELECTORS = [
  'input[autocomplete="cc-number"]',
  'input[name="cardnumber" i]',
  'input[name="card_number" i]',
  'input[name="cardNumber" i]',
  'input[name="cc-number" i]',
  'input[placeholder*="card number" i]',
  'input[aria-label*="card number" i]',
];

const CARD_EXPIRY_SELECTORS = [
  'input[autocomplete="cc-exp"]',
  'input[name="cc-exp" i]',
  'input[name="expiry" i]',
  'input[name="exp-date" i]',
  'input[placeholder*="MM" i]',
  'input[placeholder*="expir" i]',
];

const CARD_CVV_SELECTORS = [
  'input[autocomplete="cc-csc"]',
  'input[name="cvc" i]',
  'input[name="cvv" i]',
  'input[name="cc-csc" i]',
  'input[name="security-code" i]',
  'input[placeholder*="CVV" i]',
  'input[placeholder*="CVC" i]',
  'input[aria-label*="security code" i]',
];

const CARD_NAME_SELECTORS = [
  'input[autocomplete="cc-name"]',
  'input[name="ccname" i]',
  'input[name="cc-name" i]',
  'input[name="cardName" i]',
  'input[placeholder*="cardholder" i]',
  'input[placeholder*="name on card" i]',
];

// ── Heuristic patterns (checked against name, id, placeholder, aria-label) ──

const USERNAME_PATTERNS = /user(?:name|id|_name)?|login|signin|account|identifier/i;
const EMAIL_PATTERNS = /e[-_]?mail|correo|courriel/i;
const OTP_PATTERNS = /otp|totp|mfa|2fa|two.?factor|verif(?:y|ication)|one.?time|auth.?code|security.?code|6.?digit/i;

/** Check if an input matches heuristic patterns based on its attributes. */
function matchesPattern(el: HTMLInputElement, pattern: RegExp): boolean {
  const attrs = [
    el.name,
    el.id,
    el.placeholder,
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("data-testid") ?? "",
  ];
  return attrs.some((a) => pattern.test(a));
}

/** Get the associated label text for an input (via `for` attribute or parent label). */
function getLabelText(el: HTMLInputElement): string {
  if (el.id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return label.textContent?.trim() ?? "";
  }
  const parentLabel = el.closest("label");
  if (parentLabel) return parentLabel.textContent?.trim() ?? "";
  return "";
}

/** Check if an element is visible (not hidden, not display:none, has dimensions). */
function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  // offsetParent === null for display:none elements (except position:fixed)
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  const rect = el.getBoundingClientRect();
  // Skip extremely tiny elements (likely hidden decorators)
  if (rect.width < 10 || rect.height < 10) return false;
  return true;
}

/** Find all credential-related input fields on the page. */
export function detectFields(): DetectedField[] {
  const fields: DetectedField[] = [];
  const seen = new WeakSet<HTMLInputElement>();

  function addField(el: HTMLInputElement, type: DetectedField["type"]) {
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    fields.push({ element: el, type });
  }

  // ── Phase 1: Selector-based detection (high confidence) ──

  for (const sel of PASSWORD_SELECTORS) {
    document.querySelectorAll<HTMLInputElement>(sel).forEach((el) => addField(el, "password"));
  }
  for (const sel of USERNAME_SELECTORS) {
    document.querySelectorAll<HTMLInputElement>(sel).forEach((el) => addField(el, "username"));
  }
  for (const sel of EMAIL_SELECTORS) {
    document.querySelectorAll<HTMLInputElement>(sel).forEach((el) => addField(el, "email"));
  }
  for (const sel of OTP_SELECTORS) {
    document.querySelectorAll<HTMLInputElement>(sel).forEach((el) => addField(el, "otp"));
  }

  // Card/payment fields
  for (const sel of CARD_NUMBER_SELECTORS) {
    document.querySelectorAll<HTMLInputElement>(sel).forEach((el) => addField(el, "card_number"));
  }
  for (const sel of CARD_EXPIRY_SELECTORS) {
    document.querySelectorAll<HTMLInputElement>(sel).forEach((el) => addField(el, "card_expiry"));
  }
  for (const sel of CARD_CVV_SELECTORS) {
    document.querySelectorAll<HTMLInputElement>(sel).forEach((el) => addField(el, "card_cvv"));
  }
  for (const sel of CARD_NAME_SELECTORS) {
    document.querySelectorAll<HTMLInputElement>(sel).forEach((el) => addField(el, "card_name"));
  }

  // ── Phase 2: Heuristic detection on unmatched text inputs ──
  // Search all text/tel/number inputs that weren't caught by selectors

  const allInputs = document.querySelectorAll<HTMLInputElement>(
    'input[type="text"], input[type="tel"], input[type="number"], input:not([type])'
  );

  for (const el of allInputs) {
    if (seen.has(el) || !isVisible(el)) continue;

    // Check attributes + label text against patterns
    const labelText = getLabelText(el);
    const combinedText = `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") ?? ""} ${labelText}`;

    if (OTP_PATTERNS.test(combinedText)) {
      addField(el, "otp");
    } else if (EMAIL_PATTERNS.test(combinedText)) {
      addField(el, "email");
    } else if (USERNAME_PATTERNS.test(combinedText)) {
      addField(el, "username");
    }
  }

  // ── Phase 3: Proximity heuristic — text input near password field ──
  // If we found password fields but no username/email, the first visible
  // text input before the password in the same form is likely the username.

  const hasPassword = fields.some((f) => f.type === "password");
  const hasIdentity = fields.some((f) => f.type === "username" || f.type === "email");

  if (hasPassword && !hasIdentity) {
    const passwordField = fields.find((f) => f.type === "password")!;
    // Search within the form, or within the closest container if no form
    const container = passwordField.element.closest("form")
      ?? passwordField.element.closest("[class*='login' i], [class*='signin' i], [class*='auth' i], [id*='login' i], [id*='signin' i]")
      ?? passwordField.element.parentElement?.parentElement;

    if (container) {
      const textInputs = container.querySelectorAll<HTMLInputElement>(
        'input[type="text"], input[type="email"], input:not([type])'
      );
      for (const input of textInputs) {
        if (!seen.has(input) && isVisible(input)) {
          // Check if this input comes before the password field in DOM order
          if (input.compareDocumentPosition(passwordField.element) & Node.DOCUMENT_POSITION_FOLLOWING) {
            addField(input, "username");
            break;
          }
        }
      }
    }
  }

  // ── Phase 4: Shadow DOM traversal ──
  // Some sites use shadow DOM for login forms (e.g., web components).
  // Walk open shadow roots to find password fields we might have missed.

  if (!hasPassword) {
    const shadowHosts = document.querySelectorAll("*");
    for (const host of shadowHosts) {
      if (!host.shadowRoot) continue;
      const shadowPasswords = host.shadowRoot.querySelectorAll<HTMLInputElement>('input[type="password"]');
      for (const el of shadowPasswords) {
        if (isVisible(el)) addField(el, "password");
      }
      // If we found a password in shadow DOM, look for username too
      if (fields.some((f) => f.type === "password")) {
        const shadowTexts = host.shadowRoot.querySelectorAll<HTMLInputElement>(
          'input[type="text"], input[type="email"], input:not([type])'
        );
        for (const el of shadowTexts) {
          if (!seen.has(el) && isVisible(el)) {
            if (matchesPattern(el, USERNAME_PATTERNS) || matchesPattern(el, EMAIL_PATTERNS)) {
              addField(el, matchesPattern(el, EMAIL_PATTERNS) ? "email" : "username");
            }
          }
        }
        break; // Only check first shadow root with password fields
      }
    }
  }

  return fields;
}

/** Watch for dynamically added forms (SPA login pages). */
export function observeForms(callback: (fields: DetectedField[]) => void): MutationObserver {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const observer = new MutationObserver(() => {
    // Debounce: SPA frameworks often make multiple rapid DOM changes
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const fields = detectFields();
      if (fields.length > 0) {
        callback(fields);
      }
    }, 150);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return observer;
}
