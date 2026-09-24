// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The in-field picker for identities, on address and signup forms.
 *
 * A separate module from `inline-icon.ts` rather than another branch inside
 * it. That file is 1,700 lines of credential-specific behaviour — editing a
 * password in place, renaming an entry, patching a field, the domain-mismatch
 * warnings — and an identity needs none of it. What it needs is a list and a
 * click, so this is a list and a click.
 *
 * The icon appears only when there are identities to offer. An empty dropdown
 * on every checkout would be a nuisance with no upside, and the popup is
 * already there for someone who has not created one yet.
 */
import { LOGO_DATA_URL } from "./logo-data";
import type { DetectedField } from "./form-detector";
import { isIdentityField } from "./form-detector";
import { fillIdentityFields } from "./form-filler";

/** What the background returns for each stored identity. */
export interface InlineIdentity {
  pagePath: string;
  title: string;
  fields: Record<string, string>;
}

const ICON_CLASS = "claspt-identity-icon";
const DROPDOWN_CLASS = "claspt-identity-dropdown";

const attached = new WeakSet<HTMLInputElement>();
let cached: InlineIdentity[] | null = null;

/** Remove every identity dropdown currently open. */
export function closeIdentityDropdowns() {
  document.querySelectorAll(`.${DROPDOWN_CLASS}`).forEach((el) => el.remove());
}

/** Remove the icons and forget what was fetched. */
export function removeIdentityIcons() {
  closeIdentityDropdowns();
  document.querySelectorAll(`.${ICON_CLASS}`).forEach((el) => el.remove());
  cached = null;
}

/**
 * Put a picker on each identity field the page has.
 *
 * `getIdentities` is called at most once per page: the list is small, it
 * changes only when the user edits it in the app, and refetching on every
 * focus would mean a vault round trip per keystroke-adjacent event.
 */
export function injectIdentityIcons(
  fields: DetectedField[],
  getIdentities: () => Promise<InlineIdentity[]>,
) {
  const targets = fields.filter(
    (f) => isIdentityField(f.type) && f.element.type?.toLowerCase() !== "password",
  );
  if (targets.length === 0) return;

  for (const field of targets) {
    if (attached.has(field.element)) continue;
    attached.add(field.element);
    attachIdentityIcon(field.element, fields, getIdentities);
  }
}

function attachIdentityIcon(
  input: HTMLInputElement,
  allFields: DetectedField[],
  getIdentities: () => Promise<InlineIdentity[]>,
) {
  const parent = input.parentElement;
  if (!parent) return;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";

  const icon = document.createElement("div");
  icon.className = ICON_CLASS;
  icon.title = "Fill from a Claspt identity";
  icon.setAttribute("role", "button");
  icon.setAttribute("aria-label", "Fill from a Claspt identity");
  Object.assign(icon.style, {
    position: "absolute",
    right: "6px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "20px",
    height: "20px",
    cursor: "pointer",
    zIndex: "2147483646",
    opacity: "0.75",
  });

  const img = document.createElement("img");
  img.src = LOGO_DATA_URL;
  img.width = 20;
  img.height = 20;
  img.style.borderRadius = "3px";
  img.style.display = "block";
  icon.appendChild(img);
  parent.appendChild(icon);

  let open = false;
  icon.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (open) {
      closeIdentityDropdowns();
      open = false;
      return;
    }
    void showIdentityDropdown(icon, allFields, getIdentities, () => {
      open = false;
    });
    open = true;
  });
}

async function showIdentityDropdown(
  icon: HTMLElement,
  allFields: DetectedField[],
  getIdentities: () => Promise<InlineIdentity[]>,
  onClose: () => void,
) {
  closeIdentityDropdowns();

  if (cached === null) cached = await getIdentities();
  // The background returns them already ordered, with the one last used on
  // this site first.
  const identities = cached;

  const dropdown = document.createElement("div");
  dropdown.className = DROPDOWN_CLASS;
  Object.assign(dropdown.style, {
    position: "absolute",
    zIndex: "2147483647",
    minWidth: "240px",
    maxWidth: "340px",
    maxHeight: "260px",
    overflowY: "auto",
    background: "#1a1a26",
    color: "#ededf4",
    border: "1px solid #40405a",
    borderRadius: "10px",
    boxShadow: "0 8px 28px rgba(0,0,0,0.4)",
    font: "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "4px",
  });

  if (identities.length === 0) {
    const empty = document.createElement("div");
    empty.style.padding = "10px 12px";
    empty.style.color = "#8888a8";
    empty.textContent = "No identities saved yet";
    dropdown.appendChild(empty);
  }

  identities.forEach((identity, index) => {
    const row = document.createElement("button");
    row.type = "button";
    Object.assign(row.style, {
      display: "block",
      width: "100%",
      textAlign: "left",
      background: "transparent",
      border: "none",
      color: "inherit",
      font: "inherit",
      padding: "8px 10px",
      borderRadius: "7px",
      cursor: "pointer",
    });
    row.addEventListener("mouseenter", () => (row.style.background = "#2e2e42"));
    row.addEventListener("mouseleave", () => (row.style.background = "transparent"));

    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.textContent = identity.title;
    row.appendChild(title);

    const summary = summarise(identity.fields);
    if (summary) {
      const sub = document.createElement("div");
      sub.style.color = "#8888a8";
      sub.style.fontSize = "11.5px";
      sub.style.marginTop = "1px";
      sub.textContent = summary;
      row.appendChild(sub);
    }

    // The first row is the one used here last, when there is a record of it.
    if (index === 0 && identities.length > 1) {
      const hint = document.createElement("div");
      hint.style.color = "#8888a8";
      hint.style.fontSize = "10.5px";
      hint.style.marginTop = "2px";
      hint.textContent = "Used here last time";
      row.appendChild(hint);
    }

    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Re-detect: address forms often reveal more fields a step into a
      // checkout, after the scan that produced `allFields`.
      const filled = fillIdentityFields(allFields, identity.fields);
      if (filled > 0) {
        chrome.runtime.sendMessage({
          type: "REMEMBER_IDENTITY_FOR_SITE",
          host: window.location.hostname,
          pagePath: identity.pagePath,
        });
      }
      closeIdentityDropdowns();
      onClose();
    });

    dropdown.appendChild(row);
  });

  document.body.appendChild(dropdown);

  const rect = icon.getBoundingClientRect();
  dropdown.style.left = `${window.scrollX + rect.left - 220}px`;
  dropdown.style.top = `${window.scrollY + rect.bottom + 6}px`;

  // Close on the next click elsewhere. Registered on the next tick so the
  // click that opened it does not immediately close it again.
  setTimeout(() => {
    const away = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) {
        closeIdentityDropdowns();
        onClose();
        document.removeEventListener("click", away, true);
      }
    };
    document.addEventListener("click", away, true);
  }, 0);
}

/** A line of context under the title, so two addresses can be told apart. */
function summarise(fields: Record<string, string>): string {
  const pick = (...names: string[]) => {
    for (const n of names) {
      for (const [k, v] of Object.entries(fields)) {
        if (k.toLowerCase().replace(/[\s_-]+/g, "") === n && v) return v;
      }
    }
    return "";
  };
  const street = pick("street", "address", "address1", "addressline1");
  const city = pick("city", "town");
  return [street, city].filter(Boolean).join(", ");
}
