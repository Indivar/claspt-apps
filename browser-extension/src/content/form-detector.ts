// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Detect login/credential forms on the page using MutationObserver.
 * Identifies username, email, password, and OTP fields using selectors,
 * ARIA attributes, placeholder text, labels, and proximity heuristics.
 */

/**
 * The personal-detail fields an identity can fill.
 *
 * Named after the HTML `autocomplete` tokens they mostly come from, because a
 * site that bothers to set `autocomplete` is telling us exactly what the field
 * is and that is worth more than any guess we could make from its name.
 */
export type IdentityFieldType =
  | "full_name"
  | "first_name"
  | "last_name"
  | "phone"
  | "street_1"
  | "street_2"
  | "city"
  | "state"
  | "postal_code"
  | "country"
  | "organization";

export interface DetectedField {
  element: HTMLInputElement;
  type:
    | "username"
    | "password"
    | "email"
    | "otp"
    | "card_number"
    | "card_expiry"
    | "card_cvv"
    | "card_name"
    | IdentityFieldType;
}

/** Whether a detected field belongs to an identity rather than a login or card. */
export function isIdentityField(type: DetectedField["type"]): type is IdentityFieldType {
  return IDENTITY_FIELD_TYPES.includes(type as IdentityFieldType);
}

const IDENTITY_FIELD_TYPES: IdentityFieldType[] = [
  "full_name",
  "first_name",
  "last_name",
  "phone",
  "street_1",
  "street_2",
  "city",
  "state",
  "postal_code",
  "country",
  "organization",
];

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

// ── Identity / address field selectors ──
//
// `autocomplete` first in every list: a site that sets it has told us what the
// field is, and no heuristic beats being told. The name/id fallbacks cover the
// large number of forms that never set it.

const IDENTITY_SELECTORS: Array<[IdentityFieldType, string[]]> = [
  [
    "full_name",
    [
      'input[autocomplete="name"]',
      'input[name="name" i]',
      'input[name="fullname" i]',
      'input[name="full_name" i]',
      'input[id="fullname" i]',
      'input[placeholder*="full name" i]',
    ],
  ],
  [
    "first_name",
    [
      'input[autocomplete="given-name"]',
      'input[name="firstname" i]',
      'input[name="first_name" i]',
      'input[name="fname" i]',
      'input[name="given-name" i]',
      'input[id="firstname" i]',
      'input[placeholder*="first name" i]',
    ],
  ],
  [
    "last_name",
    [
      'input[autocomplete="family-name"]',
      'input[name="lastname" i]',
      'input[name="last_name" i]',
      'input[name="lname" i]',
      'input[name="surname" i]',
      'input[name="family-name" i]',
      'input[id="lastname" i]',
      'input[placeholder*="last name" i]',
      'input[placeholder*="surname" i]',
    ],
  ],
  [
    "phone",
    [
      'input[autocomplete="tel"]',
      'input[autocomplete="tel-national"]',
      'input[type="tel"]',
      'input[name="phone" i]',
      'input[name="telephone" i]',
      'input[name="mobile" i]',
      'input[id="phone" i]',
      'input[placeholder*="phone" i]',
    ],
  ],
  [
    "street_1",
    [
      'input[autocomplete="street-address"]',
      'input[autocomplete="address-line1"]',
      'input[name="address" i]',
      'input[name="address1" i]',
      'input[name="address_line1" i]',
      'input[name="street" i]',
      'input[id="address1" i]',
      'input[placeholder*="street address" i]',
      'input[placeholder*="address line 1" i]',
    ],
  ],
  [
    "street_2",
    [
      'input[autocomplete="address-line2"]',
      'input[name="address2" i]',
      'input[name="address_line2" i]',
      'input[id="address2" i]',
      'input[placeholder*="apartment" i]',
      'input[placeholder*="address line 2" i]',
    ],
  ],
  [
    "city",
    [
      'input[autocomplete="address-level2"]',
      'input[name="city" i]',
      'input[name="town" i]',
      'input[name="suburb" i]',
      'input[id="city" i]',
      'input[placeholder*="city" i]',
    ],
  ],
  [
    "state",
    [
      'input[autocomplete="address-level1"]',
      'input[name="state" i]',
      'input[name="province" i]',
      'input[name="region" i]',
      'input[name="county" i]',
      'input[id="state" i]',
    ],
  ],
  [
    "postal_code",
    [
      'input[autocomplete="postal-code"]',
      'input[name="zip" i]',
      'input[name="zipcode" i]',
      'input[name="postcode" i]',
      'input[name="postal_code" i]',
      'input[id="zip" i]',
      'input[placeholder*="post code" i]',
      'input[placeholder*="postcode" i]',
      'input[placeholder*="zip" i]',
    ],
  ],
  [
    "country",
    [
      'input[autocomplete="country"]',
      'input[autocomplete="country-name"]',
      'input[name="country" i]',
      'input[id="country" i]',
    ],
  ],
  [
    "organization",
    [
      'input[autocomplete="organization"]',
      'input[name="company" i]',
      'input[name="organization" i]',
      'input[name="organisation" i]',
      'input[placeholder*="company" i]',
    ],
  ],
];

/**
 * Heuristic fallbacks, in the order they are tried.
 *
 * Order matters and is not alphabetical. `first_name` and `last_name` are
 * tested before `full_name`, because "first name" contains "name" and a form
 * with separate name boxes must not have both of them filled with the whole
 * name. `street_2` before `street_1` for the same reason.
 */
const IDENTITY_PATTERNS: Array<[IdentityFieldType, RegExp]> = [
  ["first_name", /first.?name|given.?name|forename|\bfname\b/i],
  ["last_name", /last.?name|family.?name|surname|\blname\b/i],
  ["street_2", /address.?(?:line.?)?2|apt|apartment|suite|unit\b/i],
  ["street_1", /street|address.?(?:line.?)?1|\baddress\b|addr\b/i],
  ["postal_code", /post.?code|postal|\bzip\b/i],
  ["city", /\bcity\b|\btown\b|suburb|address.?level.?2/i],
  ["state", /\bstate\b|province|\bregion\b|\bcounty\b|address.?level.?1/i],
  ["country", /\bcountry\b/i],
  ["phone", /\bphone\b|telephone|\bmobile\b|\btel\b/i],
  ["organization", /\bcompany\b|organi[sz]ation|\bemployer\b/i],
  ["full_name", /full.?name|\byour name\b|\bname\b/i],
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

  // Identity/address fields, last among the selectors: `addField` is
  // first-wins, so a field a login or card selector already claimed keeps that
  // meaning. "Name on card" is a card field, not a person's name.
  for (const [type, selectors] of IDENTITY_SELECTORS) {
    for (const sel of selectors) {
      document.querySelectorAll<HTMLInputElement>(sel).forEach((el) => addField(el, type));
    }
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
    } else {
      // Identity patterns are ordered, and the first match wins: see the
      // comment on IDENTITY_PATTERNS for why that order is not alphabetical.
      const identity = IDENTITY_PATTERNS.find(([, pattern]) => pattern.test(combinedText));
      if (identity) addField(el, identity[0]);
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
