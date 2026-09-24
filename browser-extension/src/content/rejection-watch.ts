// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * A login the site rejected is not worth keeping. The capture is already in
 * the vault by the time the site answers, so this watches the page for a
 * short while after submit and reports a rejection the site states plainly:
 * the password field marked invalid, or an alert that names the problem.
 *
 * The rule is deliberately narrow. A wrong guess here deletes a good
 * password, while a miss only leaves one more capture for the owner to
 * discard. Navigation away ends the watch: the site accepted the login.
 */

export const REJECTION_WINDOW_MS = 8_000;

const REJECTION_WORDS =
  /incorrect|invalid|wrong|not match|doesn.t match|didn.t match|try again|not recogni[sz]ed|unrecogni[sz]ed|couldn.t find|could not find|isn.t right|not right|too short|too weak|at least \d+ characters/i;

function isShown(node: Element): boolean {
  const element = node as HTMLElement;
  if (element.hidden) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  return true;
}

/** Whether the page, as it stands, says the submitted password was refused. */
export function rejectionShown(root: ParentNode = document): boolean {
  const password = root.querySelector<HTMLInputElement>('input[type="password"]');
  if (!password) return false;
  if (password.getAttribute("aria-invalid") === "true") return true;
  const alerts = root.querySelectorAll(
    '[role="alert"], [aria-live="assertive"], [aria-live="polite"]',
  );
  for (const alert of alerts) {
    const text = (alert.textContent ?? "").trim();
    if (text && REJECTION_WORDS.test(text) && isShown(alert)) return true;
  }
  return false;
}

/**
 * Watch for a rejection for a few seconds after submit. Returns a function
 * that stops the watch early. `onRejected` fires at most once.
 */
export function watchForRejection(
  onRejected: () => void,
  options: { windowMs?: number; root?: ParentNode; href?: () => string } = {},
): () => void {
  const windowMs = options.windowMs ?? REJECTION_WINDOW_MS;
  const root = options.root ?? document;
  const href = options.href ?? (() => location.href);
  const startHref = href();
  let done = false;

  const stop = () => {
    if (done) return;
    done = true;
    observer.disconnect();
    clearTimeout(timer);
  };

  const check = () => {
    if (done) return;
    if (href() !== startHref) {
      stop();
      return;
    }
    if (rejectionShown(root)) {
      stop();
      onRejected();
    }
  };

  const observer = new MutationObserver(check);
  const target = root instanceof Document ? root.documentElement : (root as Node);
  observer.observe(target, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-invalid", "hidden", "aria-hidden", "class", "style"],
  });
  const timer = setTimeout(stop, windowMs);
  return stop;
}
