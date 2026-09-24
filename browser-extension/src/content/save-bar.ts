// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Save bar — slide-down notification prompting the user to save or update
 * credentials after a login/signup form submission.
 *
 * Design follows Bitwarden's patterns:
 * - Slide-in animation on appear
 * - Instant dismiss (no exit animation) for responsiveness
 * - Shadow DOM isolation to prevent host CSS interference
 * - Only shows "Update" for the same account with a changed password
 * - Closes only once the vault has answered, so the toast never lies
 *
 * All DOM is built programmatically (no innerHTML) to avoid XSS surface.
 *
 * SECURITY: every shadow root here is `mode: "closed"`, matching the inline
 * picker. With an open root the page could read `host.shadowRoot` — which
 * leaks the usernames of every credential stored for that site, since they are
 * printed on the Update buttons — and could call `.click()` on those buttons
 * to save or overwrite a vault entry without the user ever seeing the bar. A
 * closed root gives the page no handle; the `onUserClick` guard below is the
 * second layer, so a synthetic click is refused even if a handle is obtained.
 */

import type { Credential } from "@/shared/types";

export type DismissReason = "closed" | "expired";

export interface SaveBarOptions {
  username: string;
  password: string;
  url: string;
  /** Confirmed credentials for this site; captures still waiting are not among them. */
  existing: Credential[];
  /** The capture could not reach the desktop and waits in the extension until it can. */
  parked?: boolean;
  /** Keep the capture as an ordinary login. Resolves false when the vault could not be reached. */
  onSave: () => Promise<boolean>;
  /** Put the new password onto this credential and drop the capture. */
  onUpdate: (credential: Credential) => Promise<boolean>;
  onNever: () => void;
  /** Closed by hand, or left unanswered until the bar went away on its own. */
  onDismiss: (reason: DismissReason) => void;
}

let currentBar: HTMLElement | null = null;
let autoDismissTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Bind a click handler that only fires for a real user click.
 *
 * `isTrusted` is false for any click synthesised by script, so this refuses a
 * page calling `.click()` on a button it should not be able to reach in the
 * first place. Genuine input — mouse, keyboard Enter on a focused button, or an
 * assistive technology — is always trusted, so nothing legitimate is lost.
 */
function onUserClick(element: HTMLElement, handler: () => void): void {
  element.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    handler();
  });
}

/** Remove any existing save bar instantly (Bitwarden pattern: no exit animation). */
export function dismissSaveBar() {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
  if (currentBar) {
    currentBar.remove();
    currentBar = null;
  }
}

/** Show a brief success toast after saving/updating. */
function showSuccessToast(message: string, kind: "success" | "info" = "success") {
  document.getElementById("claspt-toast-host")?.remove();
  const host = document.createElement("div");
  host.id = "claspt-toast-host";
  host.style.cssText = "all:initial; position:fixed; top:12px; right:16px; z-index:2147483647; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = TOAST_CSS;
  shadow.appendChild(style);

  const toast = el("div", "claspt-toast");
  const check = el("span", "toast-check");
  check.textContent = kind === "success" ? "\u2713" : "\u2139";
  if (kind === "info") check.classList.add("toast-info");
  toast.appendChild(check);
  const text = el("span", "toast-text");
  text.textContent = message;
  toast.appendChild(text);
  shadow.appendChild(toast);

  document.documentElement.appendChild(host);
  requestAnimationFrame(() => toast.classList.add("visible"));

  setTimeout(() => host.remove(), 3000);
}

/** Show the save bar at the top of the page. */
/** How long the bar stays before it counts as unanswered. */
const AUTO_DISMISS_MS = 30_000;

function storedUsername(cred: Credential): string {
  return (
    cred.fields["username"] ||
    cred.fields["user"] ||
    cred.fields["login"] ||
    cred.fields["email"] ||
    ""
  );
}

function storedPassword(cred: Credential): string {
  return cred.fields["password"] || cred.fields["pass"] || "";
}

/**
 * The credentials the submission may update: the same account, with a
 * different password. Another account on the same site is never offered an
 * Update; a second Google account is a new login, not a password change.
 */
export function updatableCredentials(
  existing: Credential[],
  username: string,
  password: string,
): Credential[] {
  const wanted = username.trim().toLowerCase();
  return existing.filter((cred) => {
    if (storedPassword(cred) === password) return false;
    const stored = storedUsername(cred).trim().toLowerCase();
    // A password-only credential carries no account to compare; with no
    // submitted username either, it is the one thing on the site to update.
    if (!stored && !wanted) return true;
    return stored === wanted;
  });
}

export function showSaveBar(options: SaveBarOptions) {
  dismissSaveBar();

  const host = document.createElement("div");
  host.id = "claspt-save-bar-host";
  host.style.cssText = "all:initial; position:fixed; top:0; left:0; right:0; z-index:2147483647; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = SAVE_BAR_CSS;
  shadow.appendChild(style);

  const needsUpdate = updatableCredentials(options.existing, options.username, options.password);
  const sameAccountUnchanged = options.existing.some(
    (cred) =>
      storedPassword(cred) === options.password &&
      storedUsername(cred).trim().toLowerCase() === options.username.trim().toLowerCase(),
  );
  if (sameAccountUnchanged) {
    return; // Nothing changed for this account — nothing to ask.
  }

  const hasUpdatable = needsUpdate.length > 0;
  const account = options.username || "this login";

  // Build bar DOM
  const bar = el("div", "claspt-save-bar");
  bar.id = "bar";
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", hasUpdatable ? "Update password" : "Save login");

  const inner = el("div", "bar-inner");

  const iconWrap = el("div", "bar-icon");
  iconWrap.appendChild(lockIcon());
  inner.appendChild(iconWrap);

  const textWrap = el("div", "bar-text");
  const title = el("span", "bar-title");
  title.textContent = hasUpdatable
    ? `Update the password for ${account}?`
    : `Save ${account} in Claspt?`;
  const sub = el("span", "bar-sub");
  sub.textContent = options.parked
    ? "Claspt is not running. This login is kept and will be saved when it is back."
    : hasUpdatable
      ? "The password you just used is different from the one saved."
      : "It is already kept safe. Save it to fill it next time.";
  textWrap.appendChild(title);
  textWrap.appendChild(sub);
  inner.appendChild(textWrap);

  const actions = el("div", "bar-actions");
  const buttons: HTMLButtonElement[] = [];

  /**
   * Run one action with the bar showing it is busy. The bar only closes once
   * the vault has answered, so "Saved" is never said before it is true.
   */
  const run = (button: HTMLButtonElement, busyText: string, action: () => Promise<boolean>, done: string) => {
    const idle = button.textContent ?? "";
    button.textContent = busyText;
    buttons.forEach((b) => (b.disabled = true));
    bar.classList.add("is-busy");
    void action().then((ok) => {
      if (ok) {
        dismissSaveBar();
        showSuccessToast(done);
        return;
      }
      dismissSaveBar();
      showSuccessToast(
        options.parked
          ? "Kept. It will be saved when Claspt is back."
          : "Could not reach Claspt. This login is kept in the waiting list.",
        "info",
      );
      button.textContent = idle;
    });
  };

  if (hasUpdatable) {
    needsUpdate.slice(0, 2).forEach((cred) => {
      const btn = el("button", "bar-btn bar-btn-primary") as HTMLButtonElement;
      btn.textContent = needsUpdate.length === 1 ? "Update" : `Update ${cred.label}`;
      btn.title = `Update the password saved for ${cred.label}`;
      onUserClick(btn, () => run(btn, "Updating…", () => options.onUpdate(cred), "Password updated"));
      buttons.push(btn);
      actions.appendChild(btn);
    });

    const saveNewBtn = el("button", "bar-btn bar-btn-secondary") as HTMLButtonElement;
    saveNewBtn.textContent = "Save as new";
    saveNewBtn.title = "Keep this as a separate login";
    onUserClick(saveNewBtn, () => run(saveNewBtn, "Saving…", options.onSave, "Saved as a new login"));
    buttons.push(saveNewBtn);
    actions.appendChild(saveNewBtn);
  } else {
    const saveBtn = el("button", "bar-btn bar-btn-primary") as HTMLButtonElement;
    saveBtn.textContent = "Save";
    onUserClick(saveBtn, () => run(saveBtn, "Saving…", options.onSave, "Saved in Claspt"));
    buttons.push(saveBtn);
    actions.appendChild(saveBtn);
  }

  const neverBtn = el("button", "bar-btn bar-btn-ghost") as HTMLButtonElement;
  neverBtn.textContent = "Never for this site";
  neverBtn.title = "Do not offer to save logins on this site";
  onUserClick(neverBtn, () => {
    options.onNever();
    dismissSaveBar();
  });
  buttons.push(neverBtn);
  actions.appendChild(neverBtn);

  const closeBtn = el("button", "bar-close") as HTMLButtonElement;
  closeBtn.appendChild(closeIcon());
  closeBtn.title = "Not now";
  closeBtn.setAttribute("aria-label", "Not now");
  onUserClick(closeBtn, () => {
    options.onDismiss("closed");
    dismissSaveBar();
  });
  buttons.push(closeBtn);
  actions.appendChild(closeBtn);

  inner.appendChild(actions);
  bar.appendChild(inner);
  shadow.appendChild(bar);

  document.documentElement.appendChild(host);
  currentBar = host;

  requestAnimationFrame(() => bar.classList.add("claspt-save-bar-visible"));

  autoDismissTimer = setTimeout(() => {
    options.onDismiss("expired");
    dismissSaveBar();
  }, AUTO_DISMISS_MS);
}

// ── Helpers ──────────────────────────────────────

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function lockIcon(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "#d4930a");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "3"); rect.setAttribute("y", "11");
  rect.setAttribute("width", "18"); rect.setAttribute("height", "11");
  rect.setAttribute("rx", "2");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M7 11V7a5 5 0 0 1 10 0v4");
  svg.appendChild(rect);
  svg.appendChild(path);
  return svg;
}

function closeIcon(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  const l1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  l1.setAttribute("x1", "18"); l1.setAttribute("y1", "6");
  l1.setAttribute("x2", "6"); l1.setAttribute("y2", "18");
  const l2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  l2.setAttribute("x1", "6"); l2.setAttribute("y1", "6");
  l2.setAttribute("x2", "18"); l2.setAttribute("y2", "18");
  svg.appendChild(l1);
  svg.appendChild(l2);
  return svg;
}

const SAVE_BAR_CSS = `
  .claspt-save-bar {
    transform: translateY(-100%);
    transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    background: linear-gradient(180deg, #1e1e26 0%, #1c1c22 100%);
    border-bottom: 1px solid #3d434b;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(167,139,250,0.06);
    color: #e6edf3;
    font-size: 13px;
  }
  .claspt-save-bar-visible {
    transform: translateY(0);
  }
  @media (prefers-reduced-motion: reduce) {
    .claspt-save-bar { transition: none; }
  }
  @media (max-width: 640px) {
    .bar-inner { flex-wrap: wrap; }
    .bar-actions { width: 100%; justify-content: flex-end; }
  }
  .bar-inner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    max-width: 100%;
  }
  .bar-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: rgba(167,139,250,0.1);
  }
  .bar-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .bar-title {
    font-weight: 600;
    font-size: 13px;
    color: #e6edf3;
  }
  .bar-sub {
    font-size: 11px;
    color: #8b949e;
    margin-top: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 520px;
  }
  .bar-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .bar-btn {
    border: none;
    border-radius: 6px;
    padding: 7px 16px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.1s, opacity 0.1s;
    font-family: inherit;
    line-height: 1;
  }
  .bar-btn:active { opacity: 0.8; }
  .bar-btn:focus-visible {
    outline: 2px solid #d4930a;
    outline-offset: 2px;
  }
  .bar-btn-primary {
    background: #d4930a;
    color: #0f0f12;
  }
  .bar-btn-primary:hover { background: #e2a318; }
  .bar-btn:disabled { cursor: default; opacity: 0.7; }
  .is-busy .bar-close { pointer-events: none; opacity: 0.5; }
  .bar-btn-secondary {
    background: #2d333b;
    color: #e6edf3;
    border: 1px solid #3d434b;
  }
  .bar-btn-secondary:hover { background: #3d434b; }
  .bar-btn-ghost {
    background: transparent;
    color: #6e7681;
  }
  .bar-btn-ghost:hover {
    color: #8b949e;
    background: #2d333b;
  }
  .bar-close {
    border: none;
    background: transparent;
    color: #6e7681;
    cursor: pointer;
    padding: 6px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.1s, background 0.1s;
    margin-left: 2px;
  }
  .bar-close:hover {
    color: #e6edf3;
    background: #2d333b;
  }
  .bar-close:focus-visible {
    outline: 2px solid #d4930a;
    outline-offset: 2px;
  }
`;

const TOAST_CSS = `
  .claspt-toast {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #1c1c22;
    border: 1px solid #3d434b;
    border-radius: 8px;
    padding: 8px 14px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    color: #e6edf3;
    font-size: 12px;
    opacity: 0;
    transform: translateY(-8px);
    transition: opacity 0.2s, transform 0.2s;
  }
  .claspt-toast.visible {
    opacity: 1;
    transform: translateY(0);
  }
  .toast-check {
    color: #4ade80;
    font-weight: 700;
    font-size: 14px;
  }
  .toast-check.toast-info {
    color: #d4930a;
  }
  .toast-text {
    color: #e6edf3;
  }
`;
