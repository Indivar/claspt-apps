// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Content-script warning banners, shared between the message-driven fill path
 * (index.ts) and the inline picker (inline-icon.ts) so BOTH surfaces enforce —
 * and explain — the same security guards (phishing/domain-mismatch and
 * insecure-origin). All UI is built with createElement + textContent inside an
 * open shadow root: no innerHTML, no untrusted data reaches an HTML parser.
 */

const WARNING_STYLE = `
  .warning { background: #dc2626; color: white; padding: 8px 16px; display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .warning-text { flex: 1; }
  .warning-text strong { font-weight: 700; }
  .warning-close { background: none; border: none; color: white; cursor: pointer; padding: 4px 8px; font-size: 18px; opacity: 0.8; line-height: 1; }
  .warning-close:hover { opacity: 1; }
  /* Advisory, not a refusal: amber rather than red, so the two read differently. */
  .warning.warning-advisory { background: #b45309; }
`;

/** Build the shared banner shell (host + shadow + styled row) and return the row to append into. */
function banner(id: string): { host: HTMLDivElement; row: HTMLDivElement } {
  const host = document.createElement("div");
  host.id = id;
  host.style.cssText =
    "all:initial; position:fixed; top:0; left:0; right:0; z-index:2147483647; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
  // Closed, like every other content-script shadow root: the page has no
  // reason to read which credential a fill was refused for.
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = WARNING_STYLE;
  shadow.appendChild(style);

  const row = document.createElement("div");
  row.className = "warning";
  shadow.appendChild(row);
  return { host, row };
}

function closeButton(host: HTMLElement): HTMLButtonElement {
  const close = document.createElement("button");
  close.className = "warning-close";
  close.textContent = "✕";
  close.addEventListener("click", () => host.remove());
  return close;
}

/** Show a phishing / domain-mismatch warning banner. */
export function showPhishingWarning(savedDomain: string, currentDomain: string): void {
  // Replace any existing banner so repeated blocked attempts don't stack.
  document.getElementById("claspt-phishing-warning")?.remove();
  const { host, row } = banner("claspt-phishing-warning");

  const icon = document.createElement("span");
  icon.textContent = "⚠️";
  row.appendChild(icon);

  const text = document.createElement("span");
  text.className = "warning-text";
  text.appendChild(document.createTextNode("Domain mismatch: This credential was saved for "));
  const savedB = document.createElement("strong");
  savedB.textContent = savedDomain;
  text.appendChild(savedB);
  text.appendChild(document.createTextNode(" but you're on "));
  const currentB = document.createElement("strong");
  currentB.textContent = currentDomain;
  text.appendChild(currentB);
  text.appendChild(document.createTextNode(". Claspt did not fill it — this could be a phishing site."));
  row.appendChild(text);

  row.appendChild(closeButton(host));
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 15000);
}

/** Warn (and skip fill) when the current page is served over insecure HTTP. */
export function showInsecureOriginWarning(currentDomain: string): void {
  document.getElementById("claspt-insecure-warning")?.remove();
  const { host, row } = banner("claspt-insecure-warning");

  const icon = document.createElement("span");
  icon.textContent = "\u{1F512}";
  row.appendChild(icon);

  const text = document.createElement("span");
  text.className = "warning-text";
  text.appendChild(document.createTextNode("Claspt won't auto-fill on "));
  const b = document.createElement("strong");
  b.textContent = currentDomain;
  text.appendChild(b);
  text.appendChild(
    document.createTextNode(" because this page is not using a secure (HTTPS) connection."),
  );
  row.appendChild(text);

  row.appendChild(closeButton(host));
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 10000);
}

/**
 * Credentials already advised on during this page load, so a vault full of
 * address-less entries does not produce a banner on every fill. Content
 * scripts are re-created per navigation, so this resets naturally.
 */
const advisedCredentials = new Set<string>();

/**
 * Advise that a credential was filled without the site being verifiable.
 *
 * A credential with no saved web address gives Claspt nothing to compare the
 * current site against, so `isDomainMismatch` cannot refuse the fill and the
 * picker offers it wherever the label happens to match a site's name. That is
 * how a look-alike domain gets a credential offered to it: a stored "google"
 * entry with no address matches `google.com.co` as readily as `google.com`.
 *
 * Blocking these outright would break every vault that stores logins by name
 * alone, so the fill goes ahead and the user is told what could not be checked
 * — once per credential per page, in a calmer colour than the refusals above,
 * because a warning shown on every fill is a warning nobody reads.
 */
export function showUnverifiedSiteWarning(credentialLabel: string, currentDomain: string): void {
  if (advisedCredentials.has(credentialLabel)) return;
  advisedCredentials.add(credentialLabel);

  document.getElementById("claspt-unverified-warning")?.remove();
  const { host, row } = banner("claspt-unverified-warning");
  row.className = "warning warning-advisory";

  const icon = document.createElement("span");
  icon.textContent = "ℹ️";
  row.appendChild(icon);

  const text = document.createElement("span");
  text.className = "warning-text";
  text.appendChild(document.createTextNode("Filled "));
  const nameB = document.createElement("strong");
  nameB.textContent = credentialLabel;
  text.appendChild(nameB);
  text.appendChild(document.createTextNode(" here. This credential has no saved web address, so Claspt could not check that "));
  const hostB = document.createElement("strong");
  hostB.textContent = currentDomain;
  text.appendChild(hostB);
  text.appendChild(
    document.createTextNode(" is the right site. Add the address in Claspt and it will be checked from then on."),
  );
  row.appendChild(text);

  row.appendChild(closeButton(host));
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 12000);
}
