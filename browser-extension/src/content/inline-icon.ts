// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { DetectedField } from "./form-detector";
import type { Credential, Message } from "@/shared/types";
import { fillFields, isFillableOrigin } from "./form-filler";
import { isDomainMismatch } from "@/shared/url-matching";
import { buildFieldPatch } from "@/shared/patch-field";
import {
  showPhishingWarning,
  showInsecureOriginWarning,
  showUnverifiedSiteWarning,
} from "./warnings";
import { generateTotp } from "@/shared/totp";
import {
  generatePassword,
  generatePassphrase,
  generateMemorable,
  generatePin,
  generateUuid,
  estimateStrength,
} from "@/shared/generator";
import { STORAGE_KEY_INLINE_GEN_PREFS } from "@/shared/constants";
import {
  recordGeneratedPassword,
  markGeneratedPasswordUsed,
  type RecordedAt,
} from "@/shared/record-generated";
import { credKey, loadCredState, markUsed, togglePin, sortByPinAndRecency, type CredState } from "@/shared/cred-state";
import { isPrimary, isDeprecated, statusBucket, labelShowsUsername } from "@/shared/cred-flags";
// Vite resolves `?inline` to the CSS file's text contents at build time so we
// can inject the same stylesheet into a closed shadow root for clickjacking
// hardening. Page CSS can't reach inside the shadow tree.
// eslint-disable-next-line import/no-unresolved
import dropdownCss from "./styles.css?inline";

/**
 * True when this content script is running inside a cross-origin iframe.
 * Cross-origin iframes are a common clickjacking vector — a malicious top
 * page can embed a real site and trick the user into autofilling. Refuse
 * to render the inline picker in that environment.
 */
function inCrossOriginIframe(): boolean {
  if (window === window.top) return false;
  try {
    void window.top?.location.href;
    return false;
  } catch {
    return true;
  }
}

type GenMode = "password" | "passphrase" | "memorable" | "pin" | "uuid";

interface InlineGenPrefs {
  mode: GenMode;
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
  excludeProblematic: boolean;
  maxSymbols: number;
  // Passphrase-specific.
  wordCount: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
  // Memorable-specific.
  memStyle: "pronounceable" | "pattern";
  syllableCount: number;
  memWordCount: number;
  // PIN-specific.
  pinLength: number;
}

const DEFAULT_GEN_PREFS: InlineGenPrefs = {
  mode: "password",
  length: 20,
  uppercase: true,
  lowercase: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
  excludeProblematic: false,
  maxSymbols: 2,
  wordCount: 5,
  separator: "-",
  capitalize: true,
  includeNumber: false,
  memStyle: "pronounceable",
  syllableCount: 4,
  memWordCount: 3,
  pinLength: 6,
};

function loadGenPrefs(): Promise<InlineGenPrefs> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(STORAGE_KEY_INLINE_GEN_PREFS, (data) => {
        const stored = data?.[STORAGE_KEY_INLINE_GEN_PREFS] as Partial<InlineGenPrefs> | undefined;
        resolve({ ...DEFAULT_GEN_PREFS, ...(stored ?? {}) });
      });
    } catch {
      resolve({ ...DEFAULT_GEN_PREFS });
    }
  });
}

function saveGenPrefs(prefs: InlineGenPrefs) {
  try { chrome.storage.local.set({ [STORAGE_KEY_INLINE_GEN_PREFS]: prefs }); } catch { /* ignore */ }
}

const ICON_CLASS = "claspt-inline-icon";
const DROPDOWN_CLASS = "claspt-inline-dropdown";
const HOST_CLASS = "claspt-inline-dropdown-host";

const attachedFields = new WeakSet<HTMLInputElement>();
let cachedCredentials: Credential[] | null = null;
let credentialsFetched = false;

export function injectInlineIcons(
  fields: DetectedField[],
  getCredentials: () => Promise<Credential[]>
) {
  // Refuse to render inside cross-origin iframes. A malicious top frame can
  // overlay/click-bait the autofill icon to harvest credentials otherwise.
  if (inCrossOriginIframe()) return;
  const targetFields = fields.filter(
    (f) => f.type === "password" || f.type === "username" || f.type === "email"
  );
  if (!credentialsFetched) {
    credentialsFetched = true;
    getCredentials().then((creds) => {
      cachedCredentials = creds;
      document.querySelectorAll(`.${ICON_CLASS}`).forEach((el) => {
        updateIconColor(el as HTMLElement, creds.length > 0, creds.length);
      });
    });
  }
  for (const field of targetFields) {
    if (attachedFields.has(field.element)) continue;
    attachedFields.add(field.element);
    attachIcon(field.element, fields, getCredentials);
  }
}

export function removeInlineIcons() {
  document.querySelectorAll(`.${DROPDOWN_CLASS}`).forEach((el) => el.remove());
  document.querySelectorAll(`.${ICON_CLASS}`).forEach((el) => el.remove());
  cachedCredentials = null;
  credentialsFetched = false;
}

function updateIconColor(icon: HTMLElement, hasCredentials: boolean, count?: number) {
  // Add green ring around logo when credentials found
  const img = icon.querySelector("img");
  if (img) {
    img.style.outline = hasCredentials ? "2px solid #16a34a" : "none";
    img.style.outlineOffset = "1px";
  }
  icon.title = hasCredentials ? `Claspt — ${count ?? ""} credential${(count ?? 0) !== 1 ? "s" : ""} found` : "Claspt — Generate password";

  // Add/update count badge
  let badge = icon.querySelector(".claspt-icon-badge") as HTMLElement | null;
  if (hasCredentials && count && count > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "claspt-icon-badge";
      icon.appendChild(badge);
    }
    badge.textContent = String(count);
  } else if (badge) {
    badge.remove();
  }
}

function createSearchSvg(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "7");
  circle.setAttribute("cy", "7");
  circle.setAttribute("r", "5");
  circle.setAttribute("stroke", "currentColor");
  circle.setAttribute("stroke-width", "1.5");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("d", "M11 11l3.5 3.5");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linecap", "round");
  svg.appendChild(circle);
  svg.appendChild(line);
  return svg;
}

function createIconElement(): HTMLElement {
  // Use the actual Claspt logo image instead of a generic lock SVG
  const img = document.createElement("img");
  img.src = chrome.runtime.getURL("assets/logo-claspt.png");
  img.width = 20;
  img.height = 20;
  img.style.borderRadius = "3px";
  img.style.display = "block";
  return img;
}

function attachIcon(input: HTMLInputElement, allFields: DetectedField[], getCredentials: () => Promise<Credential[]>) {
  const parent = input.parentElement;
  if (!parent) return;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";

  const icon = document.createElement("div");
  icon.className = ICON_CLASS;
  icon.title = "Claspt";
  icon.appendChild(createIconElement());
  if (cachedCredentials !== null) updateIconColor(icon, cachedCredentials.length > 0, cachedCredentials.length);
  parent.appendChild(icon);

  let isOpen = false;
  icon.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isOpen) {
      showDropdown(icon, input, allFields, getCredentials, () => { isOpen = false; });
      isOpen = true;
    } else {
      closeAllDropdowns();
      isOpen = false;
    }
  });
}

async function showDropdown(icon: HTMLElement, input: HTMLInputElement, allFields: DetectedField[], getCredentials: () => Promise<Credential[]>, onClose: () => void) {
  closeAllDropdowns();
  if (cachedCredentials === null) {
    cachedCredentials = await getCredentials();
    updateIconColor(icon, cachedCredentials.length > 0, cachedCredentials.length);
  }

  const credState = await loadCredState();
  const dropdown = createRichDropdown(cachedCredentials, input, allFields, onClose, credState);

  // Closed shadow DOM host — page CSS / JS can't reach inside, so an
  // attacker can't restyle, hide, or interact with the picker via the
  // page DOM. `all: initial` neutralises any inherited styles.
  const host = document.createElement("div");
  host.className = HOST_CLASS;
  host.style.cssText = "all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const styleEl = document.createElement("style");
  styleEl.textContent = dropdownCss;
  root.appendChild(styleEl);
  root.appendChild(dropdown);
  document.body.appendChild(host);
  positionDropdown(dropdown, icon);

  const closeHandler = (ev: MouseEvent) => {
    // composedPath() called from a document-level listener on a CLOSED
    // shadow root has the shadow internals redacted, so `path.includes(dropdown)`
    // is always false and would close the picker on every click. Instead
    // check the host (which lives in light DOM and IS in the path), the
    // icon, and any popover row menu we may have spawned at body-level.
    const path = ev.composedPath();
    const target = ev.target as Node | null;
    const inRowMenu = target && (target as Element).closest?.(".claspt-dd-row-menu");
    if (path.includes(host) || path.includes(icon) || inRowMenu) return;
    host.remove();
    cleanup();
  };
  const keyHandler = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") { host.remove(); cleanup(); }
  };
  function cleanup() {
    document.removeEventListener("mousedown", closeHandler, true);
    document.removeEventListener("keydown", keyHandler);
    onClose();
  }
  setTimeout(() => {
    document.addEventListener("mousedown", closeHandler, true);
    document.addEventListener("keydown", keyHandler);
  }, 0);
}

function positionDropdown(dropdown: HTMLElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const maxW = 460;
  const minW = 320;
  const available = Math.max(window.innerWidth - 16, minW);
  const w = Math.min(maxW, available);
  let left = rect.right - w;
  if (left < 8) left = 8;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  dropdown.style.top = `${rect.bottom + 6}px`;
  dropdown.style.left = `${left}px`;
  dropdown.style.width = `${w}px`;
}

function createRichDropdown(credentials: Credential[], input: HTMLInputElement, allFields: DetectedField[], onClose: () => void, credState: CredState): HTMLElement {
  const dropdown = mk("div", DROPDOWN_CLASS);
  // Live state — re-rendered when a row toggles pin or fill happens.
  let activeState: CredState = credState;

  // ── Header: logo + Claspt + plan pill + domain (matches Claude Design
  //    "Claspt Inline" mockup). Real app logo, no dummy gradient. ──
  const header = mk("div", "claspt-dd-fly-head");
  const logoImg = document.createElement("img");
  logoImg.src = chrome.runtime.getURL("assets/logo-claspt.png");
  logoImg.width = 22; logoImg.height = 22;
  logoImg.className = "claspt-dd-fly-logo";
  header.appendChild(logoImg);
  const nameEl = mk("span", "claspt-dd-fly-name");
  nameEl.textContent = "Claspt";
  header.appendChild(nameEl);
  // Plan pill — fetched via background's last-known status; empty if unknown.
  const pillEl = mk("span", "claspt-dd-fly-pill");
  pillEl.style.display = "none";
  header.appendChild(pillEl);
  const domainEl = mk("span", "claspt-dd-fly-domain");
  domainEl.textContent = location.hostname;
  header.appendChild(domainEl);
  dropdown.appendChild(header);

  // Best-effort lookup of the cached plan + sync version. Don't block render —
  // the header renders fine without these.
  try {
    chrome.runtime.sendMessage({ type: "GET_STATUS" } as Message, (res: Message) => {
      if (res?.type === "STATUS_RESULT") {
        if (res.plan) {
          pillEl.textContent = res.plan === "pro_plus" ? "Pro+" : res.plan === "pro" ? "Pro" : res.plan;
          pillEl.style.display = "";
          if (res.plan === "Free" || res.plan === "Trial") pillEl.classList.add("is-muted");
        }
      }
    });
  } catch { /* extension context invalidated — ignore */ }

  // ── Search ──
  const searchWrap = mk("div", "claspt-dd-search-wrap");
  const searchIconEl = mk("span", "claspt-dd-search-icon");
  searchIconEl.appendChild(createSearchSvg());
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search credentials...";
  searchInput.className = "claspt-dd-search-input";
  searchWrap.appendChild(searchIconEl);
  searchWrap.appendChild(searchInput);
  dropdown.appendChild(searchWrap);

  // ── Credentials ──
  const credsSection = mk("div", "claspt-dd-creds-section");
  // Combined sort: primary > normal > deprecated, then pin/recency within each
  // bucket. Stable, so ordering is intuitive when the user toggles a flag.
  const fullSort = (list: Credential[]): Credential[] => {
    const ranked = sortByPinAndRecency(list, activeState);
    return [...ranked].sort((a, b) => statusBucket(a) - statusBucket(b));
  };
  const rerender = (list: Credential[]) => renderCredentials(credsSection, fullSort(list), allFields, onClose, activeState, async (key) => {
    activeState = await togglePin(key);
    rerender(list);
  });
  rerender(credentials);
  dropdown.appendChild(credsSection);

  // Client-side filter on the already-loaded credentials. Falls back to the
  // backend search when there are no domain matches at all.
  let vaultSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let zeroMatchCloseTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelZeroClose = () => {
    if (zeroMatchCloseTimer) { clearTimeout(zeroMatchCloseTimer); zeroMatchCloseTimer = null; }
  };
  searchInput.addEventListener("input", () => {
    cancelZeroClose();
    if (vaultSearchTimer) { clearTimeout(vaultSearchTimer); vaultSearchTimer = null; }
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { rerender(credentials); return; }

    const local = filterCredentials(credentials, q);
    rerender(local);

    // Only fall back to a vault-wide search if local results are empty AND
    // there's a non-trivial query — debounced to avoid flooding the API.
    if (local.length === 0 && q.length >= 2) {
      vaultSearchTimer = setTimeout(() => {
        chrome.runtime.sendMessage({ type: "SEARCH_CREDENTIALS", query: q } as Message, (res: Message) => {
          if (searchInput.value.trim().toLowerCase() !== q) return; // stale
          if (res?.type === "SEARCH_RESULT" && res.credentials.length > 0) {
            rerender(res.credentials);
          } else {
            // 1Password pattern — when filter genuinely matches nothing, fade
            // the picker out so we don't visually harass the page.
            zeroMatchCloseTimer = setTimeout(() => {
              if (searchInput.value.trim().toLowerCase() === q) {
                dropdown.style.transition = "opacity 0.2s";
                dropdown.style.opacity = "0";
                setTimeout(() => { dropdown.remove(); onClose(); }, 200);
              }
            }, 800);
          }
        });
      }, 250);
    }
  });

  // ── Generator (collapsed by default) + Footer (Generate / Open vault) ──
  // Matches the Claude Design "Claspt Inline" mockup: a footer with two
  // buttons sits at the bottom; clicking "Generate password" expands the
  // generator panel above it (replacing the row list). The footer's
  // "Open vault" button opens the popup-equivalent view in a new tab.
  let genExpanded = false;
  const genContainer = mk("div", "claspt-dd-gen-container");
  genContainer.style.display = "none";
  genContainer.appendChild(createGeneratorSection(input, allFields, onClose));
  dropdown.appendChild(genContainer);

  const foot = mk("div", "claspt-dd-fly-foot");
  const genBtn = mk("button", "claspt-dd-fly-gen") as HTMLButtonElement;
  genBtn.type = "button";
  // Lightning bolt icon (Lucide-style, 14x14)
  const boltSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  boltSvg.setAttribute("width", "14"); boltSvg.setAttribute("height", "14");
  boltSvg.setAttribute("viewBox", "0 0 24 24"); boltSvg.setAttribute("fill", "currentColor");
  const boltPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  boltPath.setAttribute("d", "M13 2 3 14h7l-1 8 10-12h-7l1-8z");
  boltSvg.appendChild(boltPath);
  genBtn.appendChild(boltSvg);
  const genLabelSpan = mk("span", "claspt-dd-fly-gen-label");
  genLabelSpan.textContent = "Generate password";
  genBtn.appendChild(genLabelSpan);
  genBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    genExpanded = !genExpanded;
    genContainer.style.display = genExpanded ? "block" : "none";
    credsSection.style.display = genExpanded ? "none" : "";
    searchWrap.style.display = genExpanded ? "none" : "";
    genLabelSpan.textContent = genExpanded ? "Hide generator" : "Generate password";
  });

  const vaultBtn = mkIconBtn(
    "M14 4h6v6|M20 4 10 14|M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5",
    "Open vault",
    "#6b7280",
  );
  vaultBtn.classList.add("claspt-dd-fly-vault");
  vaultBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    // Open the popup's full UI in a new tab — Chrome extensions can target
    // their own popup html as a regular tab.
    try {
      const url = chrome.runtime.getURL("src/popup/index.html");
      chrome.tabs?.create?.({ url, active: true });
    } catch { /* ignore */ }
  });

  foot.appendChild(genBtn);
  foot.appendChild(vaultBtn);
  dropdown.appendChild(foot);

  return dropdown;
}

// ── SVG icon paths (Lucide-style, 24x24 viewBox) ──
const ICON_EYE_OPEN = "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z|M12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0";
const ICON_EYE_CLOSED = "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24|M1 1 23 23";
const ICON_FILL = "M15 3h6v6|M10 14 21 3|M21 3v18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6";
const ICON_COPY = "M9 9V4.5A1.5 1.5 0 0 1 10.5 3h9A1.5 1.5 0 0 1 21 4.5v9a1.5 1.5 0 0 1-1.5 1.5H15|M15 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3";
const ICON_CHECK = "M20 6 9 17l-5-5";
// Field-type icons
const ICON_USER = "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2|M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8";
const ICON_KEY = "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4";
const ICON_LINK = "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71|M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71";
const ICON_MAIL = "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z|M22 6l-10 7L2 6";
const ICON_FIELD = "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z";

/** Map field key names to { icon, color } */
function fieldIconInfo(key: string): { icon: string; color: string } {
  const k = key.toLowerCase();
  if (k === "username" || k === "user" || k === "login" || k === "account") return { icon: ICON_USER, color: "#3b82f6" };     // blue
  if (k === "password" || k === "pass" || k === "secret" || k === "key" || k === "api key" || k === "api_key") return { icon: ICON_KEY, color: "#f59e0b" };      // amber
  if (k === "url" || k === "site" || k === "website" || k === "host" || k === "hostname") return { icon: ICON_LINK, color: "#10b981" };    // green
  if (k === "email" || k === "e-mail") return { icon: ICON_MAIL, color: "#8b5cf6" };     // purple
  return { icon: ICON_FIELD, color: "#6b7280" };  // gray
}

function mkSvg(pathData: string, size = 14): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of pathData.split("|")) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d.trim());
    svg.appendChild(p);
  }
  return svg;
}

/** Attach a fast tooltip (0.3s delay) to an element. Replaces native title which has ~2s delay. */
function fastTooltip(el: HTMLElement, text: string) {
  let tip: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  el.removeAttribute("title"); // Remove native tooltip
  el.addEventListener("mouseenter", () => {
    timer = setTimeout(() => {
      tip = document.createElement("div");
      tip.textContent = text;
      tip.style.cssText = "position:fixed; z-index:2147483647; background:#1c2128; color:#e6edf3; font-size:10px; padding:3px 7px; border-radius:4px; pointer-events:none; white-space:nowrap; box-shadow:0 2px 8px rgba(0,0,0,0.3);";
      document.body.appendChild(tip);
      const rect = el.getBoundingClientRect();
      tip.style.top = `${rect.top - 26}px`;
      tip.style.left = `${rect.left + rect.width / 2 - tip.offsetWidth / 2}px`;
    }, 300);
  });
  el.addEventListener("mouseleave", () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (tip) { tip.remove(); tip = null; }
  });
}

function mkIconBtn(iconPath: string, title: string, color: string, size = 14): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.style.cssText = `border:1px solid #c0c4cc; background:none; border-radius:5px; width:24px; height:22px; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all 0.1s; color:${color};`;
  btn.appendChild(mkSvg(iconPath, size));
  btn.addEventListener("mouseenter", () => { btn.style.borderColor = color; });
  btn.addEventListener("mouseleave", () => { btn.style.borderColor = "#c0c4cc"; });
  fastTooltip(btn, title);
  return btn;
}

function filterCredentials(credentials: Credential[], q: string): Credential[] {
  if (!q) return credentials;
  return credentials.filter((cred) => {
    if (cred.label.toLowerCase().includes(q)) return true;
    if (cred.pageTitle && cred.pageTitle.toLowerCase().includes(q)) return true;
    if (cred.url && cred.url.toLowerCase().includes(q)) return true;
    for (const [k, v] of Object.entries(cred.fields)) {
      if (k === "password" || k === "pass" || k === "secret") continue;
      if (v && v.toLowerCase().includes(q)) return true;
    }
    return false;
  });
}

// Username obfuscation was removed in 1.8.0 (post-release feedback): masking
// the username on a picker the user opened themselves to pick their own
// account just makes the right row harder to spot. Passwords and other
// sensitive fields in the detail panel still require the eye toggle.
//
// The letter / favicon avatar that previously prefixed each row was also
// removed in 1.8.0 — it ate ~22px of horizontal space and didn't help users
// pick the right account. Real favicons would have been better, but loading
// them either (a) gets blocked by strict page CSPs (AWS Console, banks)
// when injected via <img>, or (b) requires adding https://www.google.com/*
// to host_permissions which adds an install-time warning and triggers the
// Chrome Web Store in-depth review queue — exactly the queue we just escaped
// in 1.7.26. Pin / primary state is now shown as inline glyphs next to the
// label.

function doFill(
  allFields: DetectedField[],
  cred: Credential,
  onClose: () => void,
  options?: { submit?: boolean },
) {
  // Enforce the same guards the message-driven fill path uses, so the inline
  // picker can't be a weaker door: refuse to fill on an insecure origin or when
  // the credential's saved domain doesn't match the current site (phishing),
  // and tell the user why. fillFields() also hard-blocks both cases, so this is
  // belt-and-braces — but doing the check here lets us surface the warning AND,
  // critically, skip the auto-submit when the fill was refused.
  if (!isFillableOrigin()) {
    showInsecureOriginWarning(window.location.hostname);
    closeAllDropdowns();
    onClose();
    return;
  }
  if (isDomainMismatch(cred.url, window.location.hostname)) {
    let savedDomain = cred.url ?? "";
    try {
      savedDomain = new URL(cred.url as string).hostname;
    } catch {
      /* keep raw */
    }
    showPhishingWarning(savedDomain, window.location.hostname);
    closeAllDropdowns();
    onClose();
    return;
  }
  const filled = fillFields(allFields, cred);
  if (filled) {
    // No saved address means the domain check had nothing to compare against.
    // Say so rather than letting the fill look verified.
    if (!cred.url) showUnverifiedSiteWarning(cred.label, window.location.hostname);
    void markUsed(credKey(cred.pagePath, cred.label));
    // Only submit when the fill actually succeeded — never submit a form we
    // refused (or failed) to fill into.
    if (options?.submit) {
      const pwField = allFields.find((f) => f.type === "password");
      const form = pwField?.element.closest("form") as HTMLFormElement | null;
      if (form) {
        try {
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
        } catch {
          /* ignore */
        }
      }
    }
  }
  closeAllDropdowns();
  onClose();
}

function copyText(text: string, autoClear = true) {
  chrome.runtime.sendMessage({ type: "COPY_TO_CLIPBOARD", text, autoClear } as Message);
}

function patchCredField(cred: Credential, key: string, value: string) {
  // Fire-and-forget — the cache invalidates on success and the picker will
  // refresh next time it's opened. We close the dropdown after toggling so
  // the user immediately sees the result on the next click.
  chrome.runtime.sendMessage(
    buildFieldPatch(cred.pagePath, cred.label, key, value),
    () => {
      closeAllDropdowns();
    },
  );
}

/**
 * Hide every visible child of `wrapper` and render an inline form panel in
 * its place. Returns a `removeForm()` callback the form's actions should
 * call to dismiss the form and restore the original row.
 *
 * Used by Edit / Rename / Move / Delete so credential management happens
 * inside the dropdown — `window.prompt` and `window.confirm` are unusable
 * inside a content-script overlay (they steal focus and on some sites
 * never render at all).
 */
function showInlineForm(
  wrapper: HTMLElement,
  build: (panel: HTMLElement, removeForm: () => void, setError: (msg: string) => void) => void,
): void {
  const hidden: HTMLElement[] = [];
  for (const child of Array.from(wrapper.children) as HTMLElement[]) {
    if (child.style.display !== "none") {
      hidden.push(child);
      child.style.display = "none";
    }
  }
  const panel = mk("div", "claspt-dd-inline-form");
  const removeForm = () => {
    panel.remove();
    for (const el of hidden) el.style.display = "";
  };
  let errEl: HTMLElement | null = null;
  const setError = (msg: string) => {
    if (!errEl) {
      errEl = mk("div", "claspt-dd-form-error");
      panel.appendChild(errEl);
    }
    errEl.textContent = msg;
  };
  build(panel, removeForm, setError);
  wrapper.appendChild(panel);
  // Auto-focus the first text-like input so the user can type immediately.
  setTimeout(() => {
    const first = panel.querySelector<HTMLInputElement>("input[type='text'], input[type='password'], input:not([type])");
    if (first) { first.focus(); first.select?.(); }
  }, 0);
}

function mkFormButton(label: string, primary?: boolean, danger?: boolean): HTMLButtonElement {
  const btn = mk("button", "claspt-dd-form-btn") as HTMLButtonElement;
  if (primary) btn.classList.add("is-primary");
  if (danger) btn.classList.add("is-danger");
  btn.type = "button";
  btn.textContent = label;
  return btn;
}

function mkFormInput(type: "text" | "password", placeholder: string, value: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = type;
  i.placeholder = placeholder;
  i.value = value;
  i.className = "claspt-dd-form-input";
  return i;
}

/**
 * Inline edit form for a single credential. Replaces window.prompt-based
 * edit. Routes through PATCH_SECRET_BLOCK so notes / TOTP / URL / primary /
 * deprecated stay intact.
 */
function editCredentialInline(
  wrapper: HTMLElement,
  cred: Credential,
  currentUser: string | undefined,
  currentPass: string | undefined,
) {
  showInlineForm(wrapper, (panel, removeForm, setError) => {
    const title = mk("div", "claspt-dd-form-title");
    title.textContent = `Edit credential`;
    const sub = mk("div", "claspt-dd-form-sub");
    sub.textContent = cred.label;

    const userLbl = mk("label", "claspt-dd-form-label"); userLbl.textContent = "Username";
    const userInp = mkFormInput("text", "username", currentUser ?? "");

    const passLbl = mk("label", "claspt-dd-form-label"); passLbl.textContent = "Password";
    const passWrap = mk("div", "claspt-dd-form-input-wrap");
    const passInp = mkFormInput("password", "password", currentPass ?? "");
    const eyeBtn = mkIconBtn(ICON_EYE_OPEN, "Reveal", "#6b7280", 13);
    eyeBtn.classList.add("claspt-dd-form-eye");
    eyeBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const showing = passInp.type === "text";
      passInp.type = showing ? "password" : "text";
      eyeBtn.replaceChildren(); eyeBtn.appendChild(mkSvg(showing ? ICON_EYE_OPEN : ICON_EYE_CLOSED, 13));
    });
    passWrap.appendChild(passInp); passWrap.appendChild(eyeBtn);

    const actions = mk("div", "claspt-dd-form-actions");
    const cancelBtn = mkFormButton("Cancel");
    const saveBtn = mkFormButton("Save", true);
    cancelBtn.addEventListener("click", removeForm);
    saveBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const fields: Record<string, string> = {};
      const u = userInp.value.trim();
      const p = passInp.value;
      if (u !== (currentUser ?? "")) fields.username = u;
      if (p !== (currentPass ?? "")) fields.password = p;
      if (Object.keys(fields).length === 0) { removeForm(); return; }
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      chrome.runtime.sendMessage(
        { type: "PATCH_SECRET_BLOCK", pagePath: cred.pagePath, label: cred.label, fields } as Message,
        (res: Message) => {
          if (res?.type === "PATCH_SECRET_BLOCK_RESULT" && res.success) {
            // Easiest way to reflect the change is a clean reopen — credentials
            // get re-fetched from the desktop on next click of the icon.
            closeAllDropdowns();
          } else {
            saveBtn.disabled = false; saveBtn.textContent = "Save";
            setError(res?.type === "PATCH_SECRET_BLOCK_RESULT"
              ? (res.errorMessage ?? res.errorCode ?? "Unknown error")
              : "No response from desktop");
          }
        },
      );
    });
    actions.appendChild(cancelBtn); actions.appendChild(saveBtn);

    panel.appendChild(title);
    panel.appendChild(sub);
    panel.appendChild(userLbl); panel.appendChild(userInp);
    panel.appendChild(passLbl); panel.appendChild(passWrap);
    panel.appendChild(actions);
  });
}

function renameCredentialInline(wrapper: HTMLElement, cred: Credential) {
  showInlineForm(wrapper, (panel, removeForm, setError) => {
    const title = mk("div", "claspt-dd-form-title");
    title.textContent = "Rename label";
    const sub = mk("div", "claspt-dd-form-sub");
    sub.textContent = cred.label;

    const lbl = mk("label", "claspt-dd-form-label"); lbl.textContent = "New label";
    const inp = mkFormInput("text", "label", cred.label);

    const actions = mk("div", "claspt-dd-form-actions");
    const cancelBtn = mkFormButton("Cancel");
    const saveBtn = mkFormButton("Rename", true);
    cancelBtn.addEventListener("click", removeForm);
    saveBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const next = inp.value.trim();
      if (!next || next === cred.label) { removeForm(); return; }
      saveBtn.disabled = true; saveBtn.textContent = "Renaming…";
      chrome.runtime.sendMessage(
        { type: "RENAME_SECRET_BLOCK", pagePath: cred.pagePath, oldLabel: cred.label, newLabel: next } as Message,
        (res: Message) => {
          if (res?.type === "RENAME_SECRET_BLOCK_RESULT" && res.success) {
            closeAllDropdowns();
          } else {
            saveBtn.disabled = false; saveBtn.textContent = "Rename";
            setError(res?.type === "RENAME_SECRET_BLOCK_RESULT"
              ? (res.errorCode === "LABEL_CONFLICT"
                  ? "That label is already used on this page."
                  : (res.errorMessage ?? res.errorCode ?? "Unknown error"))
              : "No response from desktop");
          }
        },
      );
    });
    actions.appendChild(cancelBtn); actions.appendChild(saveBtn);

    panel.appendChild(title);
    panel.appendChild(sub);
    panel.appendChild(lbl); panel.appendChild(inp);
    panel.appendChild(actions);
  });
}

function moveCredentialInline(wrapper: HTMLElement, cred: Credential) {
  showInlineForm(wrapper, (panel, removeForm, setError) => {
    const title = mk("div", "claspt-dd-form-title");
    title.textContent = "Move to folder";
    const sub = mk("div", "claspt-dd-form-sub");
    sub.textContent = cred.label;

    const lbl = mk("label", "claspt-dd-form-label"); lbl.textContent = "Folder path";
    const inp = mkFormInput("text", "credentials", "");
    const hint = mk("div", "claspt-dd-form-hint");
    hint.textContent = "Examples: credentials · work · archive/old";

    const actions = mk("div", "claspt-dd-form-actions");
    const cancelBtn = mkFormButton("Cancel");
    const saveBtn = mkFormButton("Move", true);
    cancelBtn.addEventListener("click", removeForm);
    saveBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const next = inp.value.trim();
      if (!next) { removeForm(); return; }
      saveBtn.disabled = true; saveBtn.textContent = "Moving…";
      chrome.runtime.sendMessage(
        { type: "MOVE_PAGE", pagePath: cred.pagePath, folder: next } as Message,
        (res: Message) => {
          if (res?.type === "MOVE_PAGE_RESULT" && res.success) {
            closeAllDropdowns();
          } else {
            saveBtn.disabled = false; saveBtn.textContent = "Move";
            setError(res?.type === "MOVE_PAGE_RESULT"
              ? (res.errorMessage ?? res.errorCode ?? "Unknown error")
              : "No response from desktop");
          }
        },
      );
    });
    actions.appendChild(cancelBtn); actions.appendChild(saveBtn);

    panel.appendChild(title);
    panel.appendChild(sub);
    panel.appendChild(lbl); panel.appendChild(inp); panel.appendChild(hint);
    panel.appendChild(actions);
  });
}

function deleteCredentialInline(wrapper: HTMLElement, cred: Credential) {
  showInlineForm(wrapper, (panel, removeForm, setError) => {
    const title = mk("div", "claspt-dd-form-title");
    title.textContent = `Delete credential?`;
    const sub = mk("div", "claspt-dd-form-sub");
    sub.textContent = cred.label;
    const body = mk("div", "claspt-dd-form-body");
    body.textContent =
      "This removes the credential from the vault. If it's the only one on " +
      "this page, the page will be deleted too. This can't be undone from " +
      "the extension.";

    const actions = mk("div", "claspt-dd-form-actions");
    const cancelBtn = mkFormButton("Cancel");
    const deleteBtn = mkFormButton("Delete", false, true);
    cancelBtn.addEventListener("click", removeForm);
    deleteBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      deleteBtn.disabled = true; deleteBtn.textContent = "Deleting…";
      chrome.runtime.sendMessage(
        {
          type: "DELETE_SECRET_BLOCK",
          pagePath: cred.pagePath,
          label: cred.label,
          deletePageIfEmpty: true,
        } as Message,
        (res: Message) => {
          if (res?.type === "DELETE_SECRET_BLOCK_RESULT" && res.success) {
            closeAllDropdowns();
          } else {
            deleteBtn.disabled = false; deleteBtn.textContent = "Delete";
            setError(res?.type === "DELETE_SECRET_BLOCK_RESULT"
              ? (res.errorMessage ?? res.errorCode ?? "Unknown error")
              : "No response from desktop");
          }
        },
      );
    });
    actions.appendChild(cancelBtn); actions.appendChild(deleteBtn);

    panel.appendChild(title);
    panel.appendChild(sub);
    panel.appendChild(body);
    panel.appendChild(actions);
  });
}

interface RowMenuItem { label: string; danger?: boolean; onClick: () => void; }

function showRowMenu(anchor: HTMLElement, items: RowMenuItem[]) {
  // Close any existing row menu first.
  document.querySelectorAll(`.claspt-dd-row-menu`).forEach((el) => el.remove());

  const menu = mk("div", "claspt-dd-row-menu");
  for (const it of items) {
    const btn = document.createElement("button");
    btn.className = `claspt-dd-row-menu-item${it.danger ? " is-danger" : ""}`;
    btn.textContent = it.label;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      menu.remove();
      it.onClick();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  let left = rect.right - menu.offsetWidth;
  let top = rect.bottom + 4;
  if (left < 8) left = 8;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = rect.top - menu.offsetHeight - 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  const close = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close, true), 0);
}

function renderCredentials(container: HTMLElement, credentials: Credential[], allFields: DetectedField[], onClose: () => void, credState: CredState, onTogglePin: (key: string) => void) {
  while (container.firstChild) container.removeChild(container.firstChild);

  if (credentials.length === 0) {
    const empty = mk("div", "claspt-dd-empty");
    empty.textContent = "No matching credentials — try searching";
    container.appendChild(empty);
    return;
  }

  // Count header
  const countHeader = mk("div", "claspt-dropdown-header claspt-dropdown-header--found");
  countHeader.textContent = `${credentials.length} credential${credentials.length !== 1 ? "s" : ""} found`;
  container.appendChild(countHeader);

  // Only one detail panel may be open at a time — collapse the previous when
  // a new one expands. Keeps the list from jumping around as users explore.
  const expanded: { close: () => void } = { close: () => {} };

  // Match-tier sectioning ("For this site" / "Other matches") — drives the
  // mockup's grouped list. Tier 1 (score === 100) is an exact-domain or
  // exact-label match; everything else is a weaker similar match. When all
  // visible credentials are exact matches OR there are zero exact matches,
  // we skip the heading entirely (one bucket — no need to label it).
  const tierOf = (c: Credential): "exact" | "similar" => (c.score ?? 0) >= 100 ? "exact" : "similar";
  const tiers = new Set(credentials.map(tierOf));
  const showTierHeaders = tiers.size >= 2;
  let lastTier: "exact" | "similar" | null = null;

  const list = mk("div", "claspt-dropdown-list");
  for (const cred of credentials) {
    const tier = tierOf(cred);
    if (showTierHeaders && tier !== lastTier) {
      const header = mk("div", "claspt-dd-section-header");
      header.textContent = tier === "exact" ? "For this site" : "Other matches";
      list.appendChild(header);
      lastTier = tier;
    }
    const ckey = credKey(cred.pagePath, cred.label);
    const isPinned = !!credState.pinned[ckey];
    const isPrim = isPrimary(cred);
    const isDep = isDeprecated(cred);
    const username = cred.fields["username"] || cred.fields["user"] || cred.fields["email"] || cred.fields["login"] || "";
    const password = cred.fields["password"] || cred.fields["pass"] || cred.fields["secret"] || "";
    const totp = cred.fields["totp"] || cred.fields["otp"] || cred.fields["2fa"] || "";
    const wrapper = mk("div", "claspt-dd-item-wrapper");

    // Single-line row: [label · username] [view] [fill] [⋯]
    const item = mk("div", "claspt-dd-row");
    if (isDep) item.classList.add("is-deprecated");
    if (isPrim) item.classList.add("is-primary");

    const info = mk("div", "claspt-dd-row-info");
    info.title = `${cred.label}${username ? " — " + username : ""}`;
    info.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      doFill(allFields, cred, onClose);
    });
    // Pin / primary glyphs as small inline prefix next to the label —
    // replaces the old letter-avatar box.
    if (isPinned) {
      const star = mk("span", "claspt-dd-inline-pin");
      star.textContent = "★";
      star.title = "Pinned";
      info.appendChild(star);
    }
    if (isPrim) {
      const dot = mk("span", "claspt-dd-inline-primary");
      dot.title = "Primary";
      info.appendChild(dot);
    }
    const labelEl = mk("span", "claspt-dropdown-label");
    labelEl.textContent = cred.label;
    info.appendChild(labelEl);
    // Most saved credentials are named after the account they hold, so the
    // label usually already ends in the address. Printing it again on the
    // second line spends a whole line repeating what is directly above it.
    if (username && !labelShowsUsername(cred.label, username)) {
      const sub = mk("span", "claspt-dropdown-sub");
      sub.textContent = username;
      info.appendChild(sub);
    }

    // Detail panel (revealed by eye) — shows full field list with copy buttons.
    let detailVisible = false;
    const detailPanel = mk("div", "claspt-dd-detail-panel");

    const setDetail = (visible: boolean) => {
      detailVisible = visible;
      detailPanel.style.display = visible ? "block" : "none";
      viewBtn.replaceChildren(); viewBtn.appendChild(mkSvg(visible ? ICON_EYE_CLOSED : ICON_EYE_OPEN));
      viewBtn.title = visible ? "Hide credentials" : "View credentials";
    };

    const viewBtn = mkIconBtn(ICON_EYE_OPEN, "View credentials", "#6b7280");
    viewBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const wasOpen = detailVisible;
      // Close whichever row is currently expanded — keeps the list height stable.
      expanded.close();
      if (!wasOpen) {
        setDetail(true);
        expanded.close = () => setDetail(false);
      } else {
        expanded.close = () => {};
      }
    });

    const fillBtn = mkIconBtn(ICON_FILL, "Fill form", "#a06b00");
    fillBtn.style.cssText += "background:#a06b00; border-color:#a06b00;";
    fillBtn.querySelector("svg")?.setAttribute("stroke", "#fff");
    fillBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      doFill(allFields, cred, onClose);
    });

    // ⋯ menu button — Pin/Unpin, Copy username/password/TOTP, Edit in desktop
    const menuBtn = mkIconBtn("M5 12h.01|M12 12h.01|M19 12h.01", "More actions", "#6b7280");
    menuBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const menuItems: RowMenuItem[] = [
        { label: isPinned ? "Unpin" : "Pin to top", onClick: () => onTogglePin(ckey) },
        { label: "Fill form", onClick: () => doFill(allFields, cred, onClose) },
        { label: "Fill & submit", onClick: () => doFill(allFields, cred, onClose, { submit: true }) },
      ];
      if (username) menuItems.push({ label: "Copy username", onClick: () => copyText(username, false) });
      if (password) menuItems.push({ label: "Copy password", onClick: () => copyText(password, true) });
      if (totp)
        menuItems.push({
          label: "Copy TOTP",
          // Copy the current 6-digit CODE, not the raw seed. Putting the
          // long-lived TOTP secret on the clipboard would let anything that
          // reads the clipboard mint codes forever; the code expires in ~30s.
          // generateTotp runs on Web Crypto locally (no privileged message).
          onClick: () => {
            void generateTotp(totp)
              .then(({ code }) => copyText(code, true))
              .catch(() => {
                /* malformed seed — copy nothing rather than leak the seed */
              });
          },
        });
      menuItems.push({
        label: isPrim ? "Unmark primary" : "Mark as primary",
        onClick: () => patchCredField(cred, "primary", isPrim ? "" : "true"),
      });
      menuItems.push({
        label: isDep ? "Restore (un-deprecate)" : "Mark as deprecated",
        onClick: () => patchCredField(cred, "deprecated", isDep ? "" : "true"),
      });
      // ── v2.1.0: Full credential management — inline forms inside the
      // dropdown (no window.prompt / window.confirm — those are unusable
      // inside a content-script overlay; on many sites they steal focus
      // or never render). Each form takes over the row's wrapper.
      menuItems.push({
        label: "Edit credential…",
        onClick: () => editCredentialInline(wrapper, cred, username, password),
      });
      menuItems.push({
        label: "Rename label…",
        onClick: () => renameCredentialInline(wrapper, cred),
      });
      menuItems.push({
        label: "Move to folder…",
        onClick: () => moveCredentialInline(wrapper, cred),
      });
      menuItems.push({
        label: "Delete credential…",
        danger: true,
        onClick: () => deleteCredentialInline(wrapper, cred),
      });
      showRowMenu(menuBtn, menuItems);
    });

    item.appendChild(info);
    item.appendChild(viewBtn);
    item.appendChild(fillBtn);
    item.appendChild(menuBtn);

    // Detail panel — each field with icon buttons
    for (const [key, value] of Object.entries(cred.fields)) {
      if (!value) continue;
      const row = mk("div", "claspt-dd-detail-row");

      const fi = fieldIconInfo(key);
      const keyEl = mk("span", "claspt-dd-detail-key");
      keyEl.appendChild(mkSvg(fi.icon, 13));
      keyEl.style.color = fi.color;
      fastTooltip(keyEl, key);

      const valEl = mk("span", "claspt-dd-detail-val");
      const isSecret = key === "password" || key === "pass" || key === "secret";
      valEl.textContent = isSecret ? "••••••••" : value;
      if (isSecret) valEl.classList.add("is-secret");

      if (isSecret) {
        const showBtn = mkIconBtn(ICON_EYE_OPEN, "Show password", "#6b7280", 12);
        let shown = false;
        showBtn.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          shown = !shown;
          valEl.textContent = shown ? value : "••••••••";
          valEl.classList.toggle("is-secret", !shown);
          showBtn.replaceChildren(); showBtn.appendChild(mkSvg(shown ? ICON_EYE_CLOSED : ICON_EYE_OPEN, 12));
        });
        row.appendChild(keyEl); row.appendChild(valEl); row.appendChild(showBtn);
      } else {
        row.appendChild(keyEl); row.appendChild(valEl);
      }

      // Copy icon (clipboard)
      const copyBtn = mkIconBtn(ICON_COPY, "Copy", "#a06b00", 12);
      copyBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        navigator.clipboard.writeText(value);
        copyBtn.replaceChildren(); copyBtn.appendChild(mkSvg(ICON_CHECK, 12));
        setTimeout(() => { copyBtn.replaceChildren(); copyBtn.appendChild(mkSvg(ICON_COPY, 12)); }, 1200);
        if (isSecret) setTimeout(() => { navigator.clipboard.writeText("").catch(() => {}); }, 30_000);
      });
      row.appendChild(copyBtn);
      detailPanel.appendChild(row);
    }

    wrapper.appendChild(item);
    wrapper.appendChild(detailPanel);
    list.appendChild(wrapper);
  }
  container.appendChild(list);
}

function createGeneratorSection(input: HTMLInputElement, allFields: DetectedField[], onClose: () => void): HTMLElement {
  const section = mk("div", "claspt-dd-gen-section");

  const title = mk("div", "claspt-dd-gen-title");
  title.textContent = "Generate";
  section.appendChild(title);

  // Live, mutable preferences (loaded async from chrome.storage.local).
  const prefs: InlineGenPrefs = { ...DEFAULT_GEN_PREFS };
  const persist = () => saveGenPrefs(prefs);

  // ── Mode tabs (Password / Passphrase / PIN) ────────────────────
  // Mirrors the popup's Generator tab so the inline picker offers full
  // feature parity. Each mode swaps the option panel below.
  const modeTabs = mk("div", "claspt-dd-gen-mode-tabs");
  const modeTabBtns: Record<GenMode, HTMLButtonElement> = {} as Record<GenMode, HTMLButtonElement>;
  const modeLabels: Record<GenMode, string> = {
    password: "Password",
    passphrase: "Passphrase",
    memorable: "Memorable",
    pin: "PIN",
    uuid: "UUID",
  };
  (Object.keys(modeLabels) as GenMode[]).forEach((m) => {
    const btn = mk("button", "claspt-dd-gen-mode-tab") as HTMLButtonElement;
    btn.textContent = modeLabels[m];
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      prefs.mode = m;
      syncModeUi();
      regen();
      persist();
    });
    modeTabBtns[m] = btn;
    modeTabs.appendChild(btn);
  });
  section.appendChild(modeTabs);

  function gen(): string {
    if (prefs.mode === "passphrase") {
      return generatePassphrase({
        wordCount: prefs.wordCount,
        separator: prefs.separator,
        capitalize: prefs.capitalize,
        includeNumber: prefs.includeNumber,
      });
    }
    if (prefs.mode === "memorable") {
      return generateMemorable({
        style: prefs.memStyle,
        syllableCount: prefs.syllableCount,
        wordCount: prefs.memWordCount,
      });
    }
    if (prefs.mode === "pin") {
      return generatePin(prefs.pinLength);
    }
    if (prefs.mode === "uuid") {
      return generateUuid();
    }
    return generatePassword({
      length: prefs.length,
      uppercase: prefs.uppercase,
      lowercase: prefs.lowercase,
      digits: prefs.digits,
      symbols: prefs.symbols,
      excludeAmbiguous: prefs.excludeAmbiguous,
      excludeProblematic: prefs.excludeProblematic,
      maxSymbols: prefs.symbols ? prefs.maxSymbols : undefined,
    });
  }

  let pw = gen();

  // ── Preview row: password text + inline action buttons ──
  const preview = mk("div", "claspt-dd-gen-preview");
  const pwRow = mk("div", "claspt-dd-gen-pw-row");
  const pwText = mk("code", "claspt-dd-gen-password");
  pwText.textContent = pw;
  pwRow.appendChild(pwText);

  const inlineBtns = mk("div", "claspt-dd-gen-inline-btns");
  const regenBtn = mkIconBtn("M21 12a9 9 0 1 1-3.51-7.13|M21 4v5h-5", "Regenerate", "#6b7280");
  regenBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    pw = gen();
    pwText.textContent = pw;
    updateStr(pw);
    keepCurrent();
  });
  const copyBtn = mkIconBtn(ICON_COPY, "Copy", "#6b7280");
  copyBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    chrome.runtime.sendMessage({ type: "COPY_TO_CLIPBOARD", text: pw, autoClear: true } as Message);
    copyBtn.replaceChildren(); copyBtn.appendChild(mkSvg(ICON_CHECK));
    setTimeout(() => { copyBtn.replaceChildren(); copyBtn.appendChild(mkSvg(ICON_COPY)); }, 1200);
    void keepAndMarkUsed();
  });
  inlineBtns.appendChild(regenBtn);
  inlineBtns.appendChild(copyBtn);
  pwRow.appendChild(inlineBtns);
  preview.appendChild(pwRow);

  // Use button — full-width, primary action
  const useRow = mk("div", "claspt-dd-gen-use-row");
  const useBtn = mk("button", "claspt-dd-gen-use-btn");
  useBtn.textContent = "Use this password ↵";
  useBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const pwFields = allFields.filter((f) => f.type === "password");
    for (const pf of (pwFields.length > 0 ? pwFields : [{ element: input, type: "password" as const }])) {
      setInputValue(pf.element, pw);
    }
    chrome.runtime.sendMessage({ type: "COPY_TO_CLIPBOARD", text: pw, autoClear: true } as Message);
    void keepAndMarkUsed();
    closeAllDropdowns();
    onClose();
  });
  useRow.appendChild(useBtn);
  preview.appendChild(useRow);
  section.appendChild(preview);

  // ── Strength ──
  const strRow = mk("div", "claspt-dd-gen-strength");
  const strBar = mk("div", "claspt-dd-gen-strength-bar");
  const strLabel = mk("span", "claspt-dd-gen-strength-label");
  strRow.appendChild(strBar);
  strRow.appendChild(strLabel);
  section.appendChild(strRow);

  function updateStr(p: string) {
    const s = estimateStrength(p);
    const colors = ["#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#059669"];
    while (strBar.firstChild) strBar.removeChild(strBar.firstChild);
    for (let i = 0; i < 5; i++) {
      const seg = mk("div", "claspt-dd-gen-seg");
      seg.style.background = i <= s.score ? (colors[s.score] ?? "#9ca3af") : "#d1d5db";
      strBar.appendChild(seg);
    }
    // Show "Very Strong · 131 bits · centuries" — the same triple shown in
    // the popup generator, so the inline picker conveys equivalent info.
    const bits = Math.round(s.entropy);
    strLabel.textContent = `${s.label} · ${bits} bits · ${s.crackTime}`;
    strLabel.style.color = colors[s.score] ?? "#9ca3af";
  }
  updateStr(pw);

  /**
   * Where the value currently on screen was saved in the vault, so Copy and
   * Use can mark that same entry rather than writing a second copy.
   * `null` while a save is in flight or after one failed.
   */
  let savedAt: RecordedAt | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Keep the value on screen, a moment after it stops changing.
   *
   * Every regeneration is kept, including ones the user rejects — losing a
   * password because it was regenerated once more is the whole complaint this
   * answers. The delay exists because dragging the length slider fires `regen`
   * on every input event, and a vault write per pixel would be one commit per
   * pixel; a pause of this length means the value the user settled on is the
   * one written.
   */
  function keepCurrent() {
    if (saveTimer) clearTimeout(saveTimer);
    const value = pw;
    savedAt = null;
    saveTimer = setTimeout(() => {
      void recordGeneratedPassword(value, location.hostname).then((at) => {
        // Ignore a late result for a value that has since been regenerated.
        if (pw === value) savedAt = at;
      });
    }, 700);
  }

  /** Flush the pending save now and mark the entry as taken up. */
  async function keepAndMarkUsed() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const at = savedAt ?? (await recordGeneratedPassword(pw, location.hostname));
    if (at) {
      savedAt = at;
      await markGeneratedPasswordUsed(at);
    }
  }

  function regen() { pw = gen(); pwText.textContent = pw; updateStr(pw); persist(); keepCurrent(); }

  // ── Password-mode panel (existing UI, now wrapped in a container so we
  //    can hide it when switching to Passphrase / PIN) ────────────────
  const passwordPanel = mk("div", "claspt-dd-gen-mode-panel");

  // ── Length row: label + numeric value + slider ──
  const sliderRow = mk("div", "claspt-dd-gen-slider-row");
  const sliderLbl = mk("span", "claspt-dd-gen-slider-label");
  sliderLbl.textContent = `Length: ${prefs.length}`;
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "8";
  slider.max = "64";
  slider.value = String(prefs.length);
  slider.className = "claspt-dd-gen-slider";
  slider.addEventListener("input", () => {
    prefs.length = parseInt(slider.value);
    sliderLbl.textContent = `Length: ${prefs.length}`;
    regen();
  });
  sliderRow.appendChild(sliderLbl);
  sliderRow.appendChild(slider);
  passwordPanel.appendChild(sliderRow);

  // ── Charset toggles (2x2 grid) ──
  const optsGrid = mk("div", "claspt-dd-gen-opts-grid");
  const charsetBoxes: Array<{ key: keyof InlineGenPrefs; label: string }> = [
    { key: "uppercase", label: "Uppercase (A-Z)" },
    { key: "lowercase", label: "Lowercase (a-z)" },
    { key: "digits", label: "Numbers (0-9)" },
    { key: "symbols", label: "Symbols (!@#$)" },
  ];
  for (const { key, label } of charsetBoxes) {
    const lbl = mk("label", "claspt-dd-gen-checkbox") as HTMLLabelElement;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!prefs[key];
    cb.addEventListener("change", () => {
      // Don't allow turning every charset off.
      const willBeAllOff = !cb.checked && !charsetBoxes
        .filter((o) => o.key !== key)
        .some((o) => !!prefs[o.key]);
      if (willBeAllOff) { cb.checked = true; return; }
      (prefs as unknown as Record<string, unknown>)[key as string] = cb.checked;
      maxSymRow.style.display = prefs.symbols ? "" : "none";
      regen();
    });
    const span = mk("span", "");
    span.textContent = label;
    lbl.appendChild(cb);
    lbl.appendChild(span);
    optsGrid.appendChild(lbl);
  }
  passwordPanel.appendChild(optsGrid);

  // ── Exclude ambiguous toggle ──
  const ambRow = mk("label", "claspt-dd-gen-checkbox-row") as HTMLLabelElement;
  const ambCb = document.createElement("input");
  ambCb.type = "checkbox";
  ambCb.checked = prefs.excludeAmbiguous;
  ambCb.addEventListener("change", () => {
    prefs.excludeAmbiguous = ambCb.checked;
    regen();
  });
  const ambSpan = mk("span", "");
  ambSpan.textContent = "Exclude ambiguous (0O, 1lI)";
  ambRow.appendChild(ambCb);
  ambRow.appendChild(ambSpan);
  passwordPanel.appendChild(ambRow);

  // ── Exclude problematic toggle (\ ' " ` { } < >) ──
  const probRow = mk("label", "claspt-dd-gen-checkbox-row") as HTMLLabelElement;
  const probCb = document.createElement("input");
  probCb.type = "checkbox";
  probCb.checked = prefs.excludeProblematic;
  probCb.addEventListener("change", () => {
    prefs.excludeProblematic = probCb.checked;
    regen();
  });
  const probSpan = mk("span", "");
  probSpan.textContent = "Exclude problematic (\\ ' \" ` { } < >)";
  probRow.appendChild(probCb);
  probRow.appendChild(probSpan);
  passwordPanel.appendChild(probRow);

  // ── Max symbols slider — only meaningful when symbols are enabled ──
  const maxSymRow = mk("div", "claspt-dd-gen-slider-row");
  const maxSymLbl = mk("span", "claspt-dd-gen-slider-label");
  maxSymLbl.textContent = `Max symbols: ${prefs.maxSymbols}`;
  const maxSym = document.createElement("input");
  maxSym.type = "range";
  maxSym.min = "0";
  maxSym.max = "8";
  maxSym.value = String(prefs.maxSymbols);
  maxSym.className = "claspt-dd-gen-slider";
  maxSym.addEventListener("input", () => {
    prefs.maxSymbols = parseInt(maxSym.value);
    maxSymLbl.textContent = `Max symbols: ${prefs.maxSymbols}`;
    regen();
  });
  maxSymRow.appendChild(maxSymLbl);
  maxSymRow.appendChild(maxSym);
  maxSymRow.style.display = prefs.symbols ? "" : "none";
  passwordPanel.appendChild(maxSymRow);

  section.appendChild(passwordPanel);

  // ── Passphrase-mode panel ────────────────────────────────────────
  const passphrasePanel = mk("div", "claspt-dd-gen-mode-panel");
  passphrasePanel.style.display = "none";

  const wcRow = mk("div", "claspt-dd-gen-slider-row");
  const wcLbl = mk("span", "claspt-dd-gen-slider-label");
  wcLbl.textContent = `Words: ${prefs.wordCount}`;
  const wcSlider = document.createElement("input");
  wcSlider.type = "range";
  wcSlider.min = "3";
  wcSlider.max = "8";
  wcSlider.value = String(prefs.wordCount);
  wcSlider.className = "claspt-dd-gen-slider";
  wcSlider.addEventListener("input", () => {
    prefs.wordCount = parseInt(wcSlider.value);
    wcLbl.textContent = `Words: ${prefs.wordCount}`;
    regen();
  });
  wcRow.appendChild(wcLbl);
  wcRow.appendChild(wcSlider);
  passphrasePanel.appendChild(wcRow);

  const sepRow = mk("div", "claspt-dd-gen-slider-row");
  const sepLbl = mk("span", "claspt-dd-gen-slider-label");
  sepLbl.textContent = "Separator:";
  const sepInput = document.createElement("input");
  sepInput.type = "text";
  sepInput.maxLength = 3;
  sepInput.value = prefs.separator;
  sepInput.className = "claspt-dd-gen-sep-input";
  sepInput.addEventListener("input", () => {
    prefs.separator = sepInput.value;
    regen();
  });
  sepRow.appendChild(sepLbl);
  sepRow.appendChild(sepInput);
  passphrasePanel.appendChild(sepRow);

  for (const opt of [
    { key: "capitalize" as const, label: "Capitalize each word" },
    { key: "includeNumber" as const, label: "Include a number" },
  ]) {
    const lbl = mk("label", "claspt-dd-gen-checkbox-row") as HTMLLabelElement;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!prefs[opt.key];
    cb.addEventListener("change", () => {
      prefs[opt.key] = cb.checked;
      regen();
    });
    const span = mk("span", "");
    span.textContent = opt.label;
    lbl.appendChild(cb);
    lbl.appendChild(span);
    passphrasePanel.appendChild(lbl);
  }

  section.appendChild(passphrasePanel);

  // ── PIN-mode panel ────────────────────────────────────────────────
  const pinPanel = mk("div", "claspt-dd-gen-mode-panel");
  pinPanel.style.display = "none";

  const pinRow = mk("div", "claspt-dd-gen-slider-row");
  const pinLbl = mk("span", "claspt-dd-gen-slider-label");
  pinLbl.textContent = `PIN length: ${prefs.pinLength}`;
  const pinSlider = document.createElement("input");
  pinSlider.type = "range";
  pinSlider.min = "4";
  pinSlider.max = "12";
  pinSlider.value = String(prefs.pinLength);
  pinSlider.className = "claspt-dd-gen-slider";
  pinSlider.addEventListener("input", () => {
    prefs.pinLength = parseInt(pinSlider.value);
    pinLbl.textContent = `PIN length: ${prefs.pinLength}`;
    regen();
  });
  pinRow.appendChild(pinLbl);
  pinRow.appendChild(pinSlider);
  pinPanel.appendChild(pinRow);

  section.appendChild(pinPanel);

  // ── Memorable panel ───────────────────────────────────────────────
  const memorablePanel = mk("div", "claspt-dd-gen-mode-panel");
  memorablePanel.style.display = "none";

  const memStyleRow = mk("div", "claspt-dd-gen-mode-tabs");
  const memStyleBtns: Record<"pronounceable" | "pattern", HTMLElement> = {
    pronounceable: mk("button", "claspt-dd-gen-mode-tab"),
    pattern: mk("button", "claspt-dd-gen-mode-tab"),
  };
  const memCountRow = mk("div", "claspt-dd-gen-slider-row");
  const memCountLbl = mk("span", "claspt-dd-gen-slider-label");
  const memCountSlider = document.createElement("input");
  memCountSlider.type = "range";
  memCountSlider.className = "claspt-dd-gen-slider";

  /** The slider means syllables in one style and words in the other. */
  function syncMemorableControls() {
    const pronounceable = prefs.memStyle === "pronounceable";
    memCountSlider.min = pronounceable ? "2" : "2";
    memCountSlider.max = pronounceable ? "8" : "6";
    memCountSlider.value = String(pronounceable ? prefs.syllableCount : prefs.memWordCount);
    memCountLbl.textContent = pronounceable
      ? `Syllables: ${prefs.syllableCount}`
      : `Words: ${prefs.memWordCount}`;
    (Object.keys(memStyleBtns) as Array<"pronounceable" | "pattern">).forEach((k) => {
      memStyleBtns[k].classList.toggle("is-active", prefs.memStyle === k);
    });
  }

  (Object.keys(memStyleBtns) as Array<"pronounceable" | "pattern">).forEach((style) => {
    const btn = memStyleBtns[style];
    btn.textContent = style === "pronounceable" ? "Pronounceable" : "Pattern";
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      prefs.memStyle = style;
      syncMemorableControls();
      regen();
      persist();
    });
    memStyleRow.appendChild(btn);
  });

  memCountSlider.addEventListener("input", () => {
    const value = parseInt(memCountSlider.value);
    if (prefs.memStyle === "pronounceable") prefs.syllableCount = value;
    else prefs.memWordCount = value;
    syncMemorableControls();
    regen();
  });
  memCountRow.appendChild(memCountLbl);
  memCountRow.appendChild(memCountSlider);
  memorablePanel.appendChild(memStyleRow);
  memorablePanel.appendChild(memCountRow);
  section.appendChild(memorablePanel);

  // ── UUID panel — nothing to configure, so it says so. ─────────────
  const uuidPanel = mk("div", "claspt-dd-gen-mode-panel");
  uuidPanel.style.display = "none";
  const uuidNote = mk("div", "claspt-dd-gen-slider-label");
  uuidNote.textContent = "A random version 4 UUID. No options.";
  uuidPanel.appendChild(uuidNote);
  section.appendChild(uuidPanel);

  // ── Presets — per-mode set, swapped in syncModeUi() ───────────────
  const presets = mk("div", "claspt-dd-gen-presets");
  section.appendChild(presets);

  type Preset = { l: string; apply: () => void };
  const presetsByMode: Record<GenMode, Preset[]> = {
    password: [
      { l: "Easy 12", apply: () => { prefs.length = 12; } },
      { l: "Strong 20", apply: () => { prefs.length = 20; } },
      { l: "Long 32", apply: () => { prefs.length = 32; } },
      { l: "Memorable", apply: () => { prefs.length = 16; prefs.symbols = false; prefs.excludeAmbiguous = true; } },
    ],
    memorable: [
      { l: "Short", apply: () => { prefs.memStyle = "pronounceable"; prefs.syllableCount = 3; } },
      { l: "Standard", apply: () => { prefs.memStyle = "pronounceable"; prefs.syllableCount = 4; } },
      { l: "Long", apply: () => { prefs.memStyle = "pronounceable"; prefs.syllableCount = 6; } },
      { l: "Pattern", apply: () => { prefs.memStyle = "pattern"; prefs.memWordCount = 3; } },
    ],
    // A v4 UUID has nothing to configure, so there is nothing to preset.
    uuid: [],
    passphrase: [
      { l: "4 words", apply: () => { prefs.wordCount = 4; } },
      { l: "5 words", apply: () => { prefs.wordCount = 5; } },
      { l: "6 words", apply: () => { prefs.wordCount = 6; } },
    ],
    pin: [
      { l: "PIN 4", apply: () => { prefs.pinLength = 4; } },
      { l: "PIN 6", apply: () => { prefs.pinLength = 6; } },
      { l: "PIN 8", apply: () => { prefs.pinLength = 8; } },
    ],
  };

  function renderPresets() {
    while (presets.firstChild) presets.removeChild(presets.firstChild);
    for (const p of presetsByMode[prefs.mode]) {
      const btn = mk("button", "claspt-dd-gen-preset");
      btn.textContent = p.l;
      btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        p.apply();
        // Re-sync any visible controls so the slider/checkboxes match prefs.
        slider.value = String(prefs.length);
        sliderLbl.textContent = `Length: ${prefs.length}`;
        wcSlider.value = String(prefs.wordCount);
        wcLbl.textContent = `Words: ${prefs.wordCount}`;
        pinSlider.value = String(prefs.pinLength);
        pinLbl.textContent = `PIN length: ${prefs.pinLength}`;
        // Re-render password-panel checkboxes so a preset that flips
        // `symbols` or `excludeAmbiguous` (e.g. Memorable) is reflected
        // in the visible UI.
        syncPasswordCheckboxes();
        regen();
        persist();
      });
      presets.appendChild(btn);
    }
  }

  function syncPasswordCheckboxes() {
    const cbs = passwordPanel.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    // Order matches build order: uppercase, lowercase, digits, symbols,
    // excludeAmbiguous, excludeProblematic.
    const order: Array<keyof InlineGenPrefs> = [
      "uppercase", "lowercase", "digits", "symbols",
      "excludeAmbiguous", "excludeProblematic",
    ];
    order.forEach((key, i) => {
      if (cbs[i]) cbs[i].checked = !!prefs[key];
    });
    maxSymRow.style.display = prefs.symbols ? "" : "none";
  }

  function syncModeUi() {
    passwordPanel.style.display = prefs.mode === "password" ? "" : "none";
    passphrasePanel.style.display = prefs.mode === "passphrase" ? "" : "none";
    memorablePanel.style.display = prefs.mode === "memorable" ? "" : "none";
    pinPanel.style.display = prefs.mode === "pin" ? "" : "none";
    uuidPanel.style.display = prefs.mode === "uuid" ? "" : "none";
    syncMemorableControls();
    (Object.keys(modeTabBtns) as GenMode[]).forEach((m) => {
      modeTabBtns[m].classList.toggle("is-active", prefs.mode === m);
    });
    renderPresets();
  }
  syncModeUi();

  // Hydrate from storage (async). Once loaded, sync UI controls and regen.
  loadGenPrefs().then((stored) => {
    Object.assign(prefs, stored);
    // Sync password-mode controls
    slider.value = String(prefs.length);
    sliderLbl.textContent = `Length: ${prefs.length}`;
    maxSym.value = String(prefs.maxSymbols);
    maxSymLbl.textContent = `Max symbols: ${prefs.maxSymbols}`;
    maxSymRow.style.display = prefs.symbols ? "" : "none";
    ambCb.checked = prefs.excludeAmbiguous;
    probCb.checked = prefs.excludeProblematic;
    const checkboxes = optsGrid.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    checkboxes.forEach((cb, i) => {
      const key = charsetBoxes[i]?.key;
      if (key) cb.checked = !!prefs[key];
    });
    // Sync passphrase / pin controls
    wcSlider.value = String(prefs.wordCount);
    wcLbl.textContent = `Words: ${prefs.wordCount}`;
    sepInput.value = prefs.separator;
    pinSlider.value = String(prefs.pinLength);
    pinLbl.textContent = `PIN length: ${prefs.pinLength}`;
    // Reflect persisted mode in the UI (active tab + visible panel).
    syncModeUi();
    pw = gen();
    pwText.textContent = pw;
    updateStr(pw);
    // The value the panel actually opens with. The one built at construction
    // time is replaced here before it is ever shown, so only this one is kept.
    keepCurrent();
  });

  return section;
}

function mk(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (nativeSet) nativeSet.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function closeAllDropdowns() {
  // Remove both the new shadow-DOM hosts and any legacy bare dropdowns
  // that other code paths may still create.
  document.querySelectorAll(`.${HOST_CLASS}, .${DROPDOWN_CLASS}`).forEach((el) => el.remove());
}
