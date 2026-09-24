// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Detect login AND signup form submissions and capture credentials.
 *
 * Handles:
 * - Standard login forms (username + password on same page)
 * - Multi-step login (Google, Microsoft, etc. — email on page 1, password on page 2)
 * - Signup forms: autocomplete="new-password" or 2+ password fields
 * - SPA forms without <form> tags
 *
 * After capture, the content script shows a save bar (instead of
 * silently saving) so the user can choose save/update/never.
 */

import type { Message } from "@/shared/types";

const SIGNUP_PASSWORD_SELECTORS = [
  'input[autocomplete="new-password"]',
  'input[name="new-password"]',
  'input[name="password_confirmation"]',
  'input[name="confirm_password"]',
  'input[name="password2"]',
];

export interface CapturedCredentials {
  username: string;
  password: string;
  url: string;
  domain: string;
  /** Whether this looks like a signup form (vs login). */
  isSignup: boolean;
}

// ── Multi-step login support ──
// Google, Microsoft, Apple, etc. show email on page 1 and password on page 2.
// The email from step 1 is kept by the background worker, bound to this host,
// until step 2 submits (see background/session-store.ts).

function sendSession(message: Message, cb?: (response: unknown) => void): void {
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(message, (response: unknown) => {
      if (chrome.runtime.lastError) {
        cb?.(null);
        return;
      }
      cb?.(response);
    });
  } catch {
    cb?.(null);
  }
}

function storeStepUsername(username: string): void {
  sendSession({ type: "STEP_USERNAME_SET", value: username });
}

async function getStepUsername(): Promise<string | null> {
  return new Promise((resolve) => {
    sendSession({ type: "STEP_USERNAME_GET" }, (response) => {
      const res = response as { type?: string; value?: string | null } | null;
      resolve(res?.type === "STEP_USERNAME_RESULT" ? (res.value ?? null) : null);
    });
    setTimeout(() => resolve(null), 3000);
  });
}

function clearStepUsername(): void {
  sendSession({ type: "STEP_USERNAME_CLEAR" });
}

// ── Username detection from page context (for multi-step flows) ──

/** Try to find the email/username displayed on a password-only page.
 *  Google shows "user@gmail.com" in the page when asking for password. */
function findDisplayedUsername(): string | null {
  // Google-specific: email shown in a data attribute or identifiable element
  const googleIdentifier = document.querySelector<HTMLElement>(
    '[data-identifier], [data-email], #profileIdentifier'
  );
  if (googleIdentifier) {
    const text = googleIdentifier.textContent?.trim()
      ?? googleIdentifier.getAttribute("data-identifier")
      ?? googleIdentifier.getAttribute("data-email");
    if (text && text.includes("@")) return text;
  }

  // Microsoft-specific: display name element
  const msDisplay = document.querySelector<HTMLElement>(
    '#displayName, [data-bind*="displayName"]'
  );
  if (msDisplay?.textContent?.includes("@")) return msDisplay.textContent.trim();

  // Generic: look for a visible element containing an email near the password field
  const passwordField = document.querySelector('input[type="password"]');
  if (!passwordField) return null;

  const container = passwordField.closest("form")
    ?? passwordField.closest('[class*="login" i], [class*="signin" i], [class*="auth" i], [role="main"], main')
    ?? document.body;

  // Search for text nodes containing email patterns
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const text = node.textContent?.trim() ?? "";
      // Must look like an email
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return NodeFilter.FILTER_REJECT;
      // Must be in a visible element
      const parent = node.parentElement;
      if (!parent || parent.offsetParent === null) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const emailNode = walker.nextNode();
  if (emailNode?.textContent) return emailNode.textContent.trim();

  return null;
}

/** Watch for form submissions and capture credentials. */
export function observeSignupForms(
  onCapture: (creds: CapturedCredentials) => void
) {
  // Track recent captures to avoid duplicates
  let lastCapture = "";

  const dedup = (captured: CapturedCredentials) => {
    const key = `${captured.username}:${captured.password}:${captured.domain}`;
    if (key === lastCapture) return;
    lastCapture = key;
    setTimeout(() => { lastCapture = ""; }, 5000);
    onCapture(captured);
  };

  // ── Capture username from email-only forms (step 1 of multi-step) ──
  // When a form has email/username but no password, save the username for step 2.
  function captureUsernameStep(element: HTMLElement) {
    const container = element.closest("form") ?? element.closest("div, section") ?? document.body;
    const passwordField = container.querySelector<HTMLInputElement>('input[type="password"]');
    if (passwordField) return; // Has password — not a username-only step

    const usernameSelectors = [
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[autocomplete="email"]',
      'input[name="identifier"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[name="loginfmt"]', // Microsoft
      'input[name="login_email"]',
      'input[type="text"]',
    ];
    for (const sel of usernameSelectors) {
      const field = container.querySelector<HTMLInputElement>(sel);
      if (field?.value) {
        storeStepUsername(field.value);
        return;
      }
    }
  }

  // Standard form submit
  document.addEventListener("submit", (e) => {
    const form = e.target as HTMLFormElement;
    if (!form || form.tagName !== "FORM") return;

    const captured = captureFromForm(form, dedup);
    if (captured) {
      clearStepUsername();
      dedup(captured);
    } else {
      // No password in form — might be step 1 of multi-step
      captureUsernameStep(form);
    }
  });

  // JS-driven form submissions (click on submit button)
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const button = target.closest<HTMLElement>(
      'button[type="submit"], input[type="submit"], button[name="login"], ' +
      'button[data-testid*="login"], button[data-testid*="submit"], ' +
      'div[role="button"][data-is-focusable], ' +   // Microsoft
      'div[jsaction*="click"][role="button"]'         // Google
    );
    if (!button) return;

    const form = button.closest("form");
    if (form) {
      const captured = captureFromForm(form, dedup);
      if (captured) {
        setTimeout(() => { clearStepUsername(); dedup(captured); }, 100);
      } else {
        captureUsernameStep(form);
      }
      return;
    }

    // No <form> wrapper — SPA fallback
    const captured = captureFromContext(button, dedup);
    if (captured) {
      setTimeout(() => { clearStepUsername(); dedup(captured); }, 100);
    } else {
      captureUsernameStep(button);
    }
  });

  // Enter key on password field
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const target = e.target as HTMLInputElement;

    // Enter on email-only field (no password on page) → store username
    if ((target.type === "email" || target.type === "text") && target.value) {
      const form = target.closest("form") ?? target.closest("div, section") ?? document.body;
      const passwordField = form.querySelector<HTMLInputElement>('input[type="password"]');
      if (!passwordField) {
        storeStepUsername(target.value);
        return;
      }
    }

    if (target.type !== "password" || !target.value) return;

    const form = target.closest("form");
    if (form) {
      const captured = captureFromForm(form, dedup);
      if (captured) setTimeout(() => { clearStepUsername(); dedup(captured); }, 100);
    } else {
      const captured = captureFromContext(target, dedup);
      if (captured) setTimeout(() => { clearStepUsername(); dedup(captured); }, 100);
    }
  });
}

/**
 * Capture credentials from a formless context (SPA), including the async
 * step-username lookup that the synchronous path cannot await.
 */
async function captureFromContextAsync(element: HTMLElement): Promise<CapturedCredentials | null> {
  const container = element.closest("div, section, main, article") || document.body;

  const passwordField = container.querySelector<HTMLInputElement>('input[type="password"]');
  if (!passwordField?.value) return null;

  let username = findUsernameInContainer(container);

  // Multi-step fallback: check displayed username on page, or session storage
  if (!username) username = findDisplayedUsername();
  if (!username) username = await getStepUsername();

  if (!username) return null;

  return {
    username,
    password: passwordField.value,
    url: window.location.href,
    domain: window.location.hostname,
    isSignup: false,
  };
}

function captureFromContext(
  element: HTMLElement,
  onAsyncCapture: (creds: CapturedCredentials) => void,
): CapturedCredentials | null {
  const container = element.closest("div, section, main, article") || document.body;

  const passwordField = container.querySelector<HTMLInputElement>('input[type="password"]');
  if (!passwordField?.value) return null;

  let username = findUsernameInContainer(container);

  // Multi-step: check displayed username on page
  if (!username) username = findDisplayedUsername();

  // Synchronous path can't await getStepUsername, so finish on the async path
  // and hand the result straight back through the callback.
  //
  // SECURITY: this used to travel as a CustomEvent dispatched on `document`.
  // That is a shared node, so the page could both read the event (it carries
  // the user's cleartext password) and forge one of its own to drive the save
  // bar with attacker-chosen values. A callback stays inside the isolated
  // world and gives the page no handle at all.
  if (!username) {
    void captureFromContextAsync(element).then((captured) => {
      if (captured) onAsyncCapture(captured);
    });
    return null;
  }

  return {
    username,
    password: passwordField.value,
    url: window.location.href,
    domain: window.location.hostname,
    isSignup: false,
  };
}

function captureFromForm(
  form: HTMLFormElement,
  onAsyncCapture: (creds: CapturedCredentials) => void,
): CapturedCredentials | null {
  const passwordFields = form.querySelectorAll<HTMLInputElement>('input[type="password"]');
  if (passwordFields.length === 0) return null;

  const hasNewPassword = SIGNUP_PASSWORD_SELECTORS.some(
    (sel) => form.querySelector(sel) !== null
  );
  const isSignup = hasNewPassword || passwordFields.length >= 2;

  let password = "";
  for (const field of passwordFields) {
    if (field.value) {
      password = field.value;
      break;
    }
  }
  if (!password) return null;

  let username = findUsernameInContainer(form);

  // Multi-step fallback: check displayed username on page
  if (!username) username = findDisplayedUsername();

  // If still no username, try session storage. Same reasoning as
  // captureFromContext: the result comes back through the callback, never
  // through a DOM event the page can see or forge.
  if (!username) {
    void getStepUsername().then((stepUser) => {
      if (stepUser) {
        onAsyncCapture({
          username: stepUser,
          password,
          url: window.location.href,
          domain: window.location.hostname,
          isSignup,
        });
      }
    });
    return null;
  }

  return {
    username,
    password,
    url: window.location.href,
    domain: window.location.hostname,
    isSignup,
  };
}

function findUsernameInContainer(container: Element): string | null {
  const usernameSelectors = [
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="user"]',
    'input[name="login"]',
    'input[name="identifier"]',
    'input[name="loginfmt"]',     // Microsoft
    'input[name="login_email"]',
    'input[type="text"]',
  ];
  for (const sel of usernameSelectors) {
    const field = container.querySelector<HTMLInputElement>(sel);
    if (field?.value) return field.value;
  }
  return null;
}
