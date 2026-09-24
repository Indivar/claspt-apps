// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { Message, IdentityItem, ExtensionConfig } from "@/shared/types";
import type { PasskeyCandidate } from "@/shared/passkey-codec";
import { passkeyOriginFrom, rpIdAllowedForHost } from "@/shared/passkey-codec";
import { isAutofillSafe } from "@/shared/url-matching";
import { urlMatchPolicyOf } from "@claspt/shared/credential-fields";
import { STORAGE_KEY_CONFIG, CLIPBOARD_CLEAR_ALARM } from "@/shared/constants";
import { generateTotp } from "@claspt/shared/totp";
import { scanTabForTotp } from "./qr-scan";
import { getDomainPref, setDomainPref, isExcludedDomain } from "@/shared/domain-prefs";
import { extractSecretBlocks } from "@claspt/shared/secret-parser";
import { requestPairing } from "./pairing";
import { isDesktopTooOld } from "@/shared/desktop-version";
import {
  recordGenerated,
  markGeneratedUsed,
  listGenerated,
  clearUnusedGenerated,
} from "./generated-history-store";
import { HISTORY_FOLDER } from "@claspt/shared/generated-history";
import type { ApiClient } from "./api-client";
import type { CredentialCache } from "./credential-cache";
import type { HealthCheck } from "./health-check";
import { identityForSite, rememberIdentityForSite } from "@/shared/identity-prefs";
import { flushGeneratedOutbox, parkGenerated } from "./generated-outbox";
import {
  clearPendingSave,
  clearStepUsername,
  getLastCapture,
  getPendingSave,
  getStepUsername,
  parkPendingSave,
  senderSite,
  setLastCapture,
  setPendingSave,
  setStepUsername,
} from "./session-store";
import {
  captureToVault,
  capturedPageBelongsTo,
  confirmCapture,
  confirmParkedCapture,
  discardCapture,
  discardParkedCapture,
  findWaitingCapture,
  listCaptured,
  parkCapture,
  parkedCaptureCount,
} from "./capture-store";
import { getRegistrableDomain } from "@/shared/url-matching";

/**
 * Messages that are ONLY allowed from the popup or options page (extension
 * origin), never from content scripts running on arbitrary web pages.
 *
 * PATCH_SECRET_BLOCK is deliberately NOT in this set. It is the one write a
 * content script legitimately needs — the save bar's "Update password" and the
 * inline picker's edit form both run in the page — so it is authorised per
 * request instead, by `contentScriptMayPatch` below. Blanket-blocking it was
 * the previous behaviour and it silently broke both features, which pushed the
 * save bar onto a legacy full-page-rewrite path that destroyed every other
 * field in the block.
 */
const PRIVILEGED_MESSAGES = new Set<Message["type"]>([
  "GET_CONFIG",
  "SAVE_CONFIG",
  "SEARCH_CREDENTIALS",
  "GENERATE_PASSWORD",
  "GENERATE_TOTP",
  "SAVE_IDENTITY",
  "UPDATE_IDENTITY",
  "LIST_IDENTITIES",
  "CHECK_HOST_PERMISSION",
  "PAIR_WITH_APP",
  // Enumerating or sweeping every generated password is a whole-vault
  // operation; a web page has no business doing either.
  "LIST_GENERATED_PASSWORDS",
  "CLEAR_UNUSED_GENERATED",
  // ── v2.0.0 granular CRUD — popup-only ──
  "DELETE_SECRET_BLOCK",
  "RENAME_SECRET_BLOCK",
  "MOVE_PAGE",
  "GET_PAGE_WITH_ETAG",
  "LIST_FOLDERS",
  // A screenshot of the tab, and the list of accounts with a passkey on a
  // site, are answers only the popup has any business asking for.
  "SCAN_QR",
  "GET_PASSKEYS",
]);

/**
 * Secret-block fields a content script is allowed to write.
 *
 * These are exactly the fields the in-page UI edits: the save bar rotates a
 * password, and the inline picker edits the username/password pair and toggles
 * the primary/deprecated marks. `url` and `url_match` are absent on purpose —
 * they decide which sites a credential will later be offered on, so letting a
 * page rewrite them would turn a write into a cross-domain escalation.
 */
const CONTENT_SCRIPT_WRITABLE_FIELDS = new Set([
  "username",
  "password",
  "pass",
  "primary",
  "deprecated",
]);

/**
 * Whether a content script may patch this specific secret block.
 *
 * The credential must be one the sender's own page could already see: we
 * re-resolve the credential list for the sender tab's hostname and require an
 * exact (pagePath, label) hit. That grants a page no reach it did not already
 * have, and denies it any page in the vault it was never shown. Fails closed on
 * a missing tab URL or any lookup error.
 */
async function contentScriptMayPatch(
  sender: chrome.runtime.MessageSender,
  getCache: () => CredentialCache,
  pagePath: string,
  label: string,
): Promise<boolean> {
  const host = contentScriptHost(sender);
  if (!host) return false;
  try {
    const tabUrl = `https://${host}`;
    const visible = await getCache().getCredentialsForUrl(tabUrl);
    // Being offered in the picker is not the same as belonging to this site:
    // a label that merely mentions the site's name scores above zero. A
    // write from a page needs a saved URL that actually matches it, or a
    // lookalike domain could rewrite an unrelated credential's password
    // after one steered click.
    return visible.some(
      (c) =>
        c.pagePath === pagePath &&
        c.label === label &&
        isAutofillSafe(
          tabUrl,
          { url: c.url ?? c.fields["url"] ?? c.fields["URL"] },
          urlMatchPolicyOf(c.fields),
        ),
    );
  } catch {
    return false;
  }
}

/**
 * The host of the page a content script is running in, or null when the
 * sender is not a top-level frame of a real tab.
 *
 * Authorising by the tab's URL let a cross-origin iframe obtain, and write to,
 * the credentials of the site that embedded it: the widget's content script
 * asked, the worker looked at the tab, and answered for the outer site.
 * `sender.url` is the frame's own URL and `frameId` 0 is the top frame; the
 * browser sets both and a page cannot forge either.
 */
/**
 * How many generated passwords one site may file per window.
 *
 * A page's own script cannot reach the extension, but a content-script bug
 * could, and every accepted message is a write to the vault. Thirty an hour
 * is far beyond what a person generates on one site and a ceiling for
 * anything else.
 */
const GENERATED_PER_HOST = 30;
const GENERATED_WINDOW_MS = 60 * 60 * 1000;
const generatedByHost = new Map<string, number[]>();

/** True when `host` may file another generated password now. */
export function allowGeneratedFromHost(host: string, now = Date.now()): boolean {
  const cutoff = now - GENERATED_WINDOW_MS;
  const recent = (generatedByHost.get(host) ?? []).filter((t) => t > cutoff);
  if (recent.length >= GENERATED_PER_HOST) {
    generatedByHost.set(host, recent);
    return false;
  }
  recent.push(now);
  generatedByHost.set(host, recent);
  return true;
}

function contentScriptHost(sender: chrome.runtime.MessageSender): string | null {
  if (!sender.tab || sender.frameId !== 0) return null;
  return hostnameFromUrl(sender.url ?? sender.tab.url);
}

/**
 * Captures per site per hour. A page's own script cannot reach the worker,
 * but a form that fires submit in a loop should not be able to fill the
 * vault with pages either. Retyping the same account patches one page and
 * is not counted.
 */
const CAPTURES_PER_SITE = 20;
const CAPTURE_WINDOW_MS = 3_600_000;
const capturesBySite = new Map<string, number[]>();

function captureAllowed(site: string): boolean {
  const now = Date.now();
  const recent = (capturesBySite.get(site) ?? []).filter((t) => now - t < CAPTURE_WINDOW_MS);
  if (recent.length >= CAPTURES_PER_SITE) {
    capturesBySite.set(site, recent);
    return false;
  }
  recent.push(now);
  capturesBySite.set(site, recent);
  return true;
}

/**
 * True when a page path is inside the generated-password history folder.
 *
 * The history messages accept a page path, and a content script is allowed to
 * send them, so the path is checked rather than trusted: a page can mark its
 * own generated entry as used, and nothing else in the vault.
 */
function isHistoryPagePath(pagePath: string): boolean {
  return pagePath.startsWith(`${HISTORY_FOLDER}/`);
}

/** Extract the hostname from a tab URL, returning null if invalid. */
function hostnameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Returns true if the sender is an extension page (popup, options). */
/**
 * The origin a passkey request is really from, or null if it may not proceed.
 * Only a content script in a top-level frame on a secure origin qualifies;
 * `sender.url` is set by the browser and cannot be forged by the page.
 */
function passkeyOriginForSender(sender: chrome.runtime.MessageSender): string | null {
  if (!sender.tab || sender.frameId !== 0) return null;
  return passkeyOriginFrom(sender.url);
}

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  // Extension pages carry the extension's own origin. On Chrome that is
  // chrome-extension://<id>/; on Firefox it is moz-extension://<uuid>/ where
  // the uuid is per install and unrelated to runtime.id, so a check written
  // against the Chrome form refused the Firefox popup every time and the
  // Firefox build could neither pair nor list credentials. The browser
  // answers with its own base URL. Extension pages are not web-accessible,
  // so no page can be framed into presenting one of these URLs.
  const base = extensionBaseUrl();
  return !!sender.url?.startsWith(base);
}

function extensionBaseUrl(): string {
  try {
    const url = chrome.runtime.getURL?.("");
    if (url) return url;
  } catch {
    /* fall through to the id-based form */
  }
  return `chrome-extension://${chrome.runtime.id}/`;
}

/**
 * The fields the Add new form filled, as `[name, value]` lines for the block:
 * sanitised on both sides, blanks dropped, and no name that would open a new
 * line of its own. A template with every field left empty saves nothing.
 */
export function templateFields(fields: Record<string, string>): [string, string][] {
  const out: [string, string][] = [];
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const key = sanitizeSecretField(rawKey)
      .replace(/[:\r\n]/g, " ")
      .trim();
    const value = sanitizeSecretField(rawValue).trim();
    if (!key || !value) continue;
    out.push([key, value]);
  }
  return out;
}

/** A tag the template named: letters, digits and dashes only. */
export function sanitizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
}

/**
 * Sanitize a string for safe inclusion in a :::secret block.
 * Strips newlines and the ::: fence marker to prevent fence breakout.
 */
function sanitizeSecretField(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/:::/g, "");
}

/**
 * A refused or missing passkey is the browser's turn (404, 403 from a
 * declined approval); anything else is reported to the page as an error.
 */
function passkeyFailure(e: unknown): Message {
  const status = (e as { status?: number })?.status;
  if (status === 404 || status === 403 || status === 401 || status === 409) {
    return { type: "PASSKEY_RESULT", outcome: "fallback" };
  }
  const text = e instanceof Error ? e.message : String(e);
  if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(text)) {
    return { type: "PASSKEY_RESULT", outcome: "fallback" };
  }
  return { type: "PASSKEY_RESULT", outcome: "error", error: text };
}

/**
 * Handle messages from popup and content scripts.
 */
export function createMessageHandler(
  getApi: () => ApiClient,
  getCache: () => CredentialCache,
  getHealth: () => HealthCheck,
  getConfig: () => ExtensionConfig,
  onConfigChange: (config: ExtensionConfig) => void,
  /** Called whenever a capture is written, confirmed, discarded or parked. */
  onCapturesChanged?: () => void,
) {
  return (
    message: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: Message) => void,
  ): boolean => {
    // Block privileged messages from content scripts (only popup/options allowed)
    if (PRIVILEGED_MESSAGES.has(message.type) && !isExtensionPage(sender)) {
      console.warn(
        "[Claspt] Blocked privileged message from content script:",
        message.type,
      );
      sendResponse({
        type: "STATUS_RESULT",
        connected: false,
        vaultUnlocked: false,
      } as Message);
      return true;
    }

    handleMessage(
      message,
      sender,
      getApi,
      getCache,
      getHealth,
      getConfig,
      onConfigChange,
      onCapturesChanged,
    )
      .then(sendResponse)
      .catch((err) => {
        console.error("[Claspt] Message handler error:", err);
        sendResponse({
          type: "STATUS_RESULT",
          connected: false,
          vaultUnlocked: false,
        } as Message);
      });
    // Return true synchronously to keep the message port open for async response
    return true;
  };
}

/**
 * Every page in the `identities/` folder, with its secret blocks merged into
 * one set of fields.
 *
 * Shared by the popup's list and the in-field picker, which need the same data
 * ordered differently. A page that fails to load is skipped rather than
 * failing the lot: one unreadable identity should not hide the others.
 */
async function listIdentities(api: ApiClient): Promise<IdentityItem[]> {
  try {
    const summaries = await api.listPages("identities");
    const items: IdentityItem[] = [];

    for (const summary of summaries) {
      try {
        const page = await api.getPage(summary.path);
        const blocks = extractSecretBlocks(page.content);

        const mergedFields: Record<string, string> = {};
        const blockLabels: string[] = [];
        for (const block of blocks) {
          blockLabels.push(block.label);
          Object.assign(mergedFields, block.fields);
        }

        // Classify by page tags (set when creating from extension)
        const tags = page.meta?.tags ?? summary.meta?.tags ?? [];
        const isCard = tags.includes("credit-card");

        items.push({
          pagePath: page.path,
          title: page.meta?.title ?? summary.meta?.title ?? "Untitled",
          itemType: isCard ? "card" : "identity",
          fields: mergedFields,
          blockLabels,
        });
      } catch {
        // Skip pages that fail to load
      }
    }
    return items;
  } catch {
    return [];
  }
}

async function handleMessage(
  message: Message,
  sender: chrome.runtime.MessageSender,
  getApi: () => ApiClient,
  getCache: () => CredentialCache,
  getHealth: () => HealthCheck,
  getConfig: () => ExtensionConfig,
  onConfigChange: (config: ExtensionConfig) => void,
  onCapturesChanged?: () => void,
): Promise<Message> {
  /** The vault page a parked capture became, once the desktop took it. */
  async function writtenCapturePath(site: string, username: string): Promise<string | undefined> {
    try {
      const existing = await getCache().getCredentialsForUrl(`https://${site}`);
      return findWaitingCapture(existing, site, username)?.pagePath;
    } catch {
      return undefined;
    }
  }

  switch (message.type) {
    case "GET_STATUS": {
      // If the user hasn't granted the optional host permission yet, don't
      // even try the health check — fetch() would error out and we'd
      // mislead the UI into a disconnected + "please retry" spinner.
      let granted = true;
      try {
        granted = await chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] });
      } catch {
        granted = false;
      }
      if (!granted) {
        return {
          type: "STATUS_RESULT",
          connected: false,
          vaultUnlocked: false,
          permissionNeeded: true,
        };
      }
      const state = await getHealth().check();
      // A desktop that still answers an old token is not one to work against:
      // the endpoints this extension needs are not there.
      const desktopTooOld = isDesktopTooOld(getHealth().getVersion());
      return {
        type: "STATUS_RESULT",
        connected: state === "connected" && !desktopTooOld,
        vaultUnlocked: state === "connected" && !desktopTooOld,
        desktopTooOld,
        tokenRejected: state === "unauthorized",
        version: getHealth().getVersion(),
        vaultFormatVersion: getHealth().getVaultFormatVersion(),
        vaultSyncVersion: getHealth().getVaultSyncVersion(),
        plan: getHealth().getPlan(),
        features: getHealth().getFeatures(),
      };
    }

    // Passkeys: the desktop is the authenticator; the user approves there.
    // Anything the vault cannot do becomes "fallback", which the page-world
    // provider turns into the browser's own flow.
    case "PASSKEY_CREATE": {
      // Second, independent check of what the content script already checked:
      // the frame's real origin comes from the sender, never the payload, and
      // only a top frame may ask.
      const origin = passkeyOriginForSender(sender);
      if (
        !origin ||
        !rpIdAllowedForHost(new URL(origin).hostname, message.request?.rp?.id ?? "")
      ) {
        return { type: "PASSKEY_RESULT", outcome: "fallback" };
      }
      const request = { ...message.request, origin, cross_origin: false };
      try {
        const result = await getApi().passkeyRegister(request.rp.id, request);
        return { type: "PASSKEY_RESULT", outcome: "done", result };
      } catch (e) {
        return passkeyFailure(e);
      }
    }

    case "PASSKEY_GET": {
      const origin = passkeyOriginForSender(sender);
      if (
        !origin ||
        !rpIdAllowedForHost(new URL(origin).hostname, message.request?.rp_id ?? "")
      ) {
        return { type: "PASSKEY_RESULT", outcome: "fallback" };
      }
      const request = { ...message.request, origin, cross_origin: false };
      try {
        if (request.allow_credentials.length === 0) {
          const candidates = await getApi().passkeyList(request.rp_id);
          if (candidates.length === 0)
            return { type: "PASSKEY_RESULT", outcome: "fallback" };
          if (candidates.length > 1) return { type: "PASSKEY_CHOOSE", candidates };
        }
        const result = await getApi().passkeyAuthenticate(request.rp_id, request);
        return { type: "PASSKEY_RESULT", outcome: "done", result };
      } catch (e) {
        return passkeyFailure(e);
      }
    }

    case "CHECK_HOST_PERMISSION": {
      let granted = false;
      try {
        granted = await chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] });
      } catch {
        /* default false */
      }
      return { type: "HOST_PERMISSION_RESULT", granted };
    }

    case "GET_CREDENTIALS": {
      try {
        // SECURITY: For content scripts, derive domain from sender.tab.url
        // (prevents a malicious page from requesting credentials for another domain).
        // For extension pages (popup), trust the message payload since it's our own code.
        let domain: string | null;
        if (isExtensionPage(sender)) {
          domain = message.domain || null;
        } else {
          domain = contentScriptHost(sender);
        }
        if (!domain || isExcludedDomain(domain, getConfig().excludedDomains)) {
          return { type: "CREDENTIALS_RESULT", credentials: [] };
        }
        const credentials = await getCache().getCredentialsForUrl(`https://${domain}`);
        const state = getHealth().getState();
        return {
          type: "CREDENTIALS_RESULT",
          credentials,
          ...(credentials.length === 0 && state !== "connected" ? { reason: state } : {}),
        };
      } catch {
        return { type: "CREDENTIALS_RESULT", credentials: [] };
      }
    }

    case "SEARCH_CREDENTIALS": {
      // Privileged — already gated by PRIVILEGED_MESSAGES check above
      try {
        const credentials = await getCache().searchCredentials(message.query);
        return { type: "SEARCH_RESULT", credentials };
      } catch {
        return { type: "SEARCH_RESULT", credentials: [] };
      }
    }

    case "COPY_TO_CLIPBOARD": {
      // Legacy path kept for content scripts (inline icon dropdown) which
      // can't use navigator.clipboard. The popup now writes directly and
      // uses COPY_TO_CLIPBOARD_SCHEDULE_CLEAR to just arm the clear alarm.
      try {
        await copyToClipboard(message.text, sender);
        if (message.autoClear) scheduleClipboardClear(getConfig());
        return { type: "COPY_RESULT", success: true };
      } catch {
        return { type: "COPY_RESULT", success: false };
      }
    }

    case "COPY_TO_CLIPBOARD_SCHEDULE_CLEAR": {
      // Popup already wrote to the clipboard via navigator.clipboard. We
      // only need to schedule the auto-clear alarm here.
      scheduleClipboardClear(getConfig());
      return { type: "COPY_RESULT", success: true };
    }

    case "PAIR_WITH_APP": {
      // Privileged — already gated
      //
      // Only succeeds while the desktop app has a pairing window open, which it
      // does solely at the user's request. Failing is the normal case and is not
      // an error worth surfacing loudly: the reason tells the popup whether to
      // say "press Connect in Claspt", "Claspt is not running", or to ask for
      // the localhost permission first.
      const result = await requestPairing(getConfig().port);
      if (!result.ok) {
        return { type: "PAIR_RESULT", ok: false, reason: result.reason };
      }

      const paired = { ...getConfig(), token: result.token };
      await chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: paired });
      onConfigChange(paired);
      return { type: "PAIR_RESULT", ok: true, scope: result.scope };
    }

    case "GET_CONFIG": {
      // Privileged — already gated
      return { type: "CONFIG_RESULT", config: getConfig() };
    }

    case "SAVE_CONFIG": {
      // Privileged — already gated
      await chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: message.config });
      onConfigChange(message.config);
      return { type: "CONFIG_SAVED" };
    }

    case "GENERATE_PASSWORD": {
      // Privileged — already gated
      try {
        const result = await getApi().generatePassword({
          length: message.length,
          uppercase: message.uppercase,
          lowercase: message.lowercase,
          digits: message.digits,
          symbols: message.symbols,
        });
        return { type: "PASSWORD_RESULT", password: result.password };
      } catch {
        return { type: "PASSWORD_RESULT", password: "" };
      }
    }

    case "GET_PASSKEYS": {
      // Names only. The private key never leaves the vault, and the popup has
      // no use for a credential id it cannot sign with.
      try {
        const items = await getApi().passkeyList(message.domain);
        return {
          type: "PASSKEYS_RESULT",
          count: items.length,
          accounts: items
            .map((item: PasskeyCandidate) => item.user_display_name || item.user_name)
            .filter(Boolean),
        };
      } catch {
        return { type: "PASSKEYS_RESULT", count: 0, accounts: [] };
      }
    }

    case "SCAN_QR": {
      // The screenshot is decoded in this worker and dropped; it is never
      // stored and never sent anywhere.
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const windowId = tabs[0]?.windowId;
      if (windowId === undefined) {
        return { type: "QR_SCAN_RESULT", found: false, reason: "capture-failed" };
      }
      const result = await scanTabForTotp(windowId);
      return result.ok
        ? {
            type: "QR_SCAN_RESULT",
            found: true,
            uri: result.uri,
            issuer: result.issuer,
            account: result.account,
          }
        : { type: "QR_SCAN_RESULT", found: false, reason: result.reason };
    }

    case "GENERATE_TOTP": {
      // Privileged — already gated
      try {
        const { code, remaining, period } = await generateTotp(message.secret);
        return { type: "TOTP_RESULT", code, remaining, period };
      } catch {
        // A seed that will not decode returns a blank rather than throwing:
        // the row shows dashes instead of the popup losing its message port.
        return { type: "TOTP_RESULT", code: "", remaining: 0, period: 30 };
      }
    }

    case "CHECK_EXISTING": {
      try {
        // SECURITY: Derive domain from sender tab, not message payload
        const senderDomain = contentScriptHost(sender);
        if (
          !senderDomain ||
          isExcludedDomain(senderDomain, getConfig().excludedDomains)
        ) {
          return { type: "CHECK_EXISTING_RESULT", credentials: [] };
        }
        const credentials = await getCache().getCredentialsForUrl(
          `https://${senderDomain}`,
        );
        return { type: "CHECK_EXISTING_RESULT", credentials };
      } catch {
        return { type: "CHECK_EXISTING_RESULT", credentials: [] };
      }
    }

    case "SAVE_CREDENTIAL": {
      try {
        // For content scripts: derive domain from sender tab (security).
        // For popup/options: trust message.domain (privileged sender).
        const senderDomain = isExtensionPage(sender)
          ? message.domain || "unknown"
          : contentScriptHost(sender);
        if (!senderDomain) {
          return { type: "SAVE_CREDENTIAL_RESULT", success: false };
        }
        if (
          !isExtensionPage(sender) &&
          isExcludedDomain(senderDomain, getConfig().excludedDomains)
        ) {
          return { type: "SAVE_CREDENTIAL_RESULT", success: false };
        }

        // SECURITY: Sanitize all fields to prevent :::secret fence breakout
        const username = sanitizeSecretField(message.username);
        const password = sanitizeSecretField(message.password);
        const url = sanitizeSecretField(message.url);
        const domain = sanitizeSecretField(senderDomain);

        // The Add new form sends every field of the template it used; the
        // save bar sends a login. Writing only username, password and url
        // lost every other field of an API key or an SSH key the form had
        // asked for.
        const typed =
          isExtensionPage(sender) && message.fields
            ? templateFields(message.fields)
            : null;
        const label = typed
          ? sanitizeSecretField(message.label ?? "") || `${domain} Login`
          : "";

        // Determine folder: identities for identity/card items, credentials for logins
        const isIdentityItem =
          domain.startsWith("_identity") || domain.startsWith("_card");
        const folder = isIdentityItem ? "identities" : "credentials";
        const title = isIdentityItem
          ? message.username || domain
          : typed
            ? label
            : `${domain} Login`;

        // `sanitizeSecretField` has already stripped every `:::` from these
        // values, so the block below is always built from scratch. (An earlier
        // version tested `password.includes(":::secret[")` here to pass raw
        // markdown through from the identity tab; that condition could never be
        // true after sanitising, and identities go through SAVE_IDENTITY now.)
        const lines = typed
          ? typed.map(([key, value]) => `${key}: ${value}`)
          : [`username: ${username}`, `password: ${password}`, `url: ${url}`];
        const content = [
          `:::secret[${isIdentityItem ? title : typed ? label : `${domain} Login`}]`,
          ...lines,
          ":::",
        ].join("\n");

        const templateTag = typed ? sanitizeTag(message.template ?? "") : "";
        const tags = isIdentityItem
          ? [domain.startsWith("_card") ? "credit-card" : "identity"]
          : typed
            ? [
                templateTag || "login",
                ...(domain && domain !== "unknown" ? [domain] : []),
              ]
            : ["login", domain];

        await getApi().createPage({ title, content, folder, tags });
        getCache().clear();
        return { type: "SAVE_CREDENTIAL_RESULT", success: true };
      } catch {
        return { type: "SAVE_CREDENTIAL_RESULT", success: false };
      }
    }

    // ── v2.0.0 granular CRUD — uses the new desktop API endpoints ──

    case "RECORD_GENERATED_PASSWORD": {
      // Every generated password is written to the vault, encrypted, whether or
      // not the user goes on to use it. The site is taken from the sender tab,
      // never from the payload, so a page cannot file its generations under
      // someone else's name.
      try {
        if (!message.password) {
          return { type: "RECORD_GENERATED_PASSWORD_RESULT", success: false };
        }
        const fromPage = !isExtensionPage(sender);
        const site = fromPage ? (contentScriptHost(sender) ?? "") : (message.site ?? "");
        if (fromPage && !allowGeneratedFromHost(site)) {
          return { type: "RECORD_GENERATED_PASSWORD_RESULT", success: false };
        }
        const entry = {
          password: message.password,
          site,
          source: "browser extension" as const,
          used: false,
          generated: new Date().toISOString(),
        };
        let where: { pagePath: string; label: string };
        try {
          where = await recordGenerated(getApi(), entry);
        } catch {
          // The vault is out of reach: hold the value here rather than lose
          // it, and say so, so the caller can show it is not saved yet.
          await parkGenerated({
            password: entry.password,
            site: entry.site,
            generated: entry.generated,
          });
          return {
            type: "RECORD_GENERATED_PASSWORD_RESULT",
            success: false,
            parked: true,
          };
        }
        // A successful write means the vault is reachable: retry anything
        // parked earlier.
        void flushGeneratedOutbox(getApi());
        return {
          type: "RECORD_GENERATED_PASSWORD_RESULT",
          success: true,
          pagePath: where.pagePath,
          label: where.label,
        };
      } catch {
        return { type: "RECORD_GENERATED_PASSWORD_RESULT", success: false };
      }
    }

    // ── Session records for content scripts (see session-store.ts) ──

    case "PENDING_SAVE_SET": {
      const ok = await setPendingSave(sender, message.credentials);
      return { type: "SESSION_OK", ok };
    }

    case "PENDING_SAVE_GET": {
      return { type: "PENDING_SAVE_RESULT", pending: await getPendingSave(sender) };
    }

    case "PENDING_SAVE_CLEAR": {
      await clearPendingSave(sender);
      return { type: "SESSION_OK", ok: true };
    }

    case "PENDING_SAVE_PARK": {
      await parkPendingSave(sender);
      return { type: "SESSION_OK", ok: true };
    }

    case "STEP_USERNAME_SET": {
      const ok = await setStepUsername(sender, message.value);
      return { type: "SESSION_OK", ok };
    }

    case "STEP_USERNAME_GET": {
      return { type: "STEP_USERNAME_RESULT", value: await getStepUsername(sender) };
    }

    case "STEP_USERNAME_CLEAR": {
      await clearStepUsername();
      return { type: "SESSION_OK", ok: true };
    }

    // ── Captured logins live in the vault from the moment they are submitted ──

    case "CAPTURE_LOGIN": {
      const host = contentScriptHost(sender);
      const site = senderSite(sender);
      if (!host || !site) return { type: "CAPTURE_RESULT", success: false };
      if (isExcludedDomain(host, getConfig().excludedDomains)) {
        return { type: "CAPTURE_RESULT", success: false };
      }
      const password = sanitizeSecretField(message.password);
      if (!password) return { type: "CAPTURE_RESULT", success: false };
      // The page's own URL is kept only when it really is this site's; the
      // sender, not the message, says where the login happened.
      const claimed = sanitizeSecretField(message.url);
      const url = hostnameFromUrl(claimed) === host ? claimed : `https://${host}/`;
      const entry = {
        username: sanitizeSecretField(message.username),
        password,
        url,
        domain: sanitizeSecretField(site),
        isSignup: message.isSignup,
        capturedAt: new Date().toISOString(),
      };
      const api = getApi();
      if (!api) {
        await parkCapture(entry);
        onCapturesChanged?.();
        return { type: "CAPTURE_RESULT", success: true, parked: true };
      }
      try {
        const existing = await getCache().getCredentialsForUrl(`https://${host}`);
        const waiting = existing.some(
          (c) => c.captured && (c.tags ?? []).includes(site),
        );
        if (!waiting && !captureAllowed(site)) {
          return { type: "CAPTURE_RESULT", success: false };
        }
        const result = await captureToVault(api, existing, entry);
        getCache().clear();
        onCapturesChanged?.();
        return {
          type: "CAPTURE_RESULT",
          success: true,
          pagePath: result.pagePath,
          updatedExisting: result.updatedExisting,
        };
      } catch {
        await parkCapture(entry);
        onCapturesChanged?.();
        return { type: "CAPTURE_RESULT", success: true, parked: true };
      }
    }

    case "CONFIRM_CAPTURE": {
      const site = isExtensionPage(sender) ? null : senderSite(sender);
      if (!isExtensionPage(sender) && !site) {
        return { type: "CONFIRM_CAPTURE_RESULT", success: false };
      }
      const api = getApi();
      let pagePath = message.pagePath;
      if (!pagePath) {
        // The bar knew no page: the capture was parked. It may still be in
        // the outbox, or the desktop came back and it was written since.
        if (!site) return { type: "CONFIRM_CAPTURE_RESULT", success: false };
        const username = message.username ?? "";
        if (await confirmParkedCapture(site, username)) {
          return { type: "CONFIRM_CAPTURE_RESULT", success: true };
        }
        pagePath = await writtenCapturePath(site, username);
        if (!pagePath) return { type: "CONFIRM_CAPTURE_RESULT", success: false };
      }
      if (!api) return { type: "CONFIRM_CAPTURE_RESULT", success: false };
      try {
        if (!(await capturedPageBelongsTo(api, pagePath, site))) {
          return { type: "CONFIRM_CAPTURE_RESULT", success: false };
        }
        await confirmCapture(api, pagePath, message.title);
        getCache().clear();
        onCapturesChanged?.();
        return { type: "CONFIRM_CAPTURE_RESULT", success: true };
      } catch {
        return { type: "CONFIRM_CAPTURE_RESULT", success: false };
      }
    }

    case "DISCARD_CAPTURE": {
      const site = isExtensionPage(sender) ? null : senderSite(sender);
      if (!isExtensionPage(sender) && !site) {
        return { type: "DISCARD_CAPTURE_RESULT", success: false };
      }
      const api = getApi();
      let pagePath = message.pagePath;
      if (!pagePath) {
        if (!site) return { type: "DISCARD_CAPTURE_RESULT", success: false };
        const username = message.username ?? "";
        if (await discardParkedCapture(site, username)) {
          return { type: "DISCARD_CAPTURE_RESULT", success: true };
        }
        pagePath = await writtenCapturePath(site, username);
        if (!pagePath) return { type: "DISCARD_CAPTURE_RESULT", success: false };
      }
      if (!api) return { type: "DISCARD_CAPTURE_RESULT", success: false };
      try {
        if (!(await capturedPageBelongsTo(api, pagePath, site))) {
          return { type: "DISCARD_CAPTURE_RESULT", success: false };
        }
        await discardCapture(api, pagePath);
        getCache().clear();
        onCapturesChanged?.();
        return { type: "DISCARD_CAPTURE_RESULT", success: true };
      } catch {
        return { type: "DISCARD_CAPTURE_RESULT", success: false };
      }
    }

    case "LIST_CAPTURED": {
      if (!isExtensionPage(sender)) {
        return { type: "CAPTURED_RESULT", items: [], parked: 0 };
      }
      const parked = await parkedCaptureCount();
      const api = getApi();
      if (!api) return { type: "CAPTURED_RESULT", items: [], parked };
      try {
        return { type: "CAPTURED_RESULT", items: await listCaptured(api), parked };
      } catch {
        return { type: "CAPTURED_RESULT", items: [], parked };
      }
    }

    case "LAST_CAPTURE_SET": {
      await setLastCapture(sender, message.capture);
      return { type: "SESSION_OK", ok: true };
    }

    case "LAST_CAPTURE_GET": {
      const domain = isExtensionPage(sender)
        ? message.domain
          ? getRegistrableDomain(message.domain)
          : null
        : senderSite(sender);
      if (!domain) return { type: "LAST_CAPTURE_RESULT", capture: null };
      return { type: "LAST_CAPTURE_RESULT", capture: await getLastCapture(domain) };
    }

    case "MARK_GENERATED_USED": {
      try {
        const { pagePath, label } = message;
        if (!pagePath || !label || !isHistoryPagePath(pagePath)) {
          return { type: "MARK_GENERATED_USED_RESULT", success: false };
        }
        await markGeneratedUsed(getApi(), pagePath, label);
        return { type: "MARK_GENERATED_USED_RESULT", success: true };
      } catch {
        return { type: "MARK_GENERATED_USED_RESULT", success: false };
      }
    }

    case "LIST_GENERATED_PASSWORDS": {
      // Privileged — already gated
      try {
        return {
          type: "LIST_GENERATED_PASSWORDS_RESULT",
          entries: await listGenerated(getApi()),
        };
      } catch {
        return { type: "LIST_GENERATED_PASSWORDS_RESULT", entries: [] };
      }
    }

    case "CLEAR_UNUSED_GENERATED": {
      // Privileged — already gated
      try {
        const removed = await clearUnusedGenerated(getApi(), message.days);
        return { type: "CLEAR_UNUSED_GENERATED_RESULT", success: true, removed };
      } catch {
        return { type: "CLEAR_UNUSED_GENERATED_RESULT", success: false, removed: 0 };
      }
    }

    case "PATCH_SECRET_BLOCK": {
      // Non-destructive merge: edits username/password/notes/etc. in one
      // secret block while preserving every other field. This is the ONLY
      // credential write path — the old PATCH_CREDENTIAL_FIELD and
      // UPDATE_CREDENTIAL messages rewrote whole pages with hand-rolled
      // regexes and have been removed.
      try {
        const { pagePath, label, fields, deleteFields, ifMatch } = message;
        if (!pagePath || !label) {
          return {
            type: "PATCH_SECRET_BLOCK_RESULT",
            success: false,
            errorCode: "BAD_REQUEST",
          };
        }

        const touchedKeys = [...Object.keys(fields ?? {}), ...(deleteFields ?? [])];

        // Content scripts get a narrower door than the popup: only credentials
        // their own site can already see, and only the fields the in-page UI
        // edits.
        if (!isExtensionPage(sender)) {
          const writableOnly = touchedKeys.every((k) =>
            CONTENT_SCRIPT_WRITABLE_FIELDS.has(k.toLowerCase()),
          );
          if (!writableOnly) {
            return {
              type: "PATCH_SECRET_BLOCK_RESULT",
              success: false,
              errorCode: "FORBIDDEN",
            };
          }
          const allowed = await contentScriptMayPatch(sender, getCache, pagePath, label);
          if (!allowed) {
            return {
              type: "PATCH_SECRET_BLOCK_RESULT",
              success: false,
              errorCode: "FORBIDDEN",
            };
          }
        }

        // Sanitize all field values before sending — defense-in-depth even
        // though the desktop will run its own validation.
        const safeFields: Record<string, string> = {};
        for (const [k, v] of Object.entries(fields ?? {})) {
          safeFields[k] = sanitizeSecretField(v);
        }
        const senderHost = contentScriptHost(sender);
        if (senderHost) getApi().setSourceHint(senderHost);
        const { etag } = await getApi().patchSecretBlock(
          pagePath,
          { label, fields: safeFields, delete_fields: deleteFields ?? [] },
          ifMatch,
        );
        getApi().setSourceHint(null);
        getCache().clear();
        return { type: "PATCH_SECRET_BLOCK_RESULT", success: true, etag };
      } catch (err) {
        getApi().setSourceHint(null);
        const e = err as { code?: string; message?: string; currentEtag?: string | null };
        return {
          type: "PATCH_SECRET_BLOCK_RESULT",
          success: false,
          errorCode: e.code ?? "INTERNAL_ERROR",
          errorMessage: e.message ?? String(err),
          etag: e.currentEtag ?? null,
        };
      }
    }

    case "DELETE_SECRET_BLOCK": {
      // Removes one secret block. With deletePageIfEmpty:true, deletes the
      // whole page if the block was its only meaningful content.
      try {
        const { pagePath, label, deletePageIfEmpty, ifMatch } = message;
        if (!pagePath || !label) {
          return {
            type: "DELETE_SECRET_BLOCK_RESULT",
            success: false,
            errorCode: "BAD_REQUEST",
          };
        }
        const senderHost = contentScriptHost(sender);
        if (senderHost) getApi().setSourceHint(senderHost);
        const { page } = await getApi().deleteSecretBlock(
          pagePath,
          { label, delete_page_if_empty: deletePageIfEmpty },
          ifMatch,
        );
        getApi().setSourceHint(null);
        getCache().clear();
        return {
          type: "DELETE_SECRET_BLOCK_RESULT",
          success: true,
          pageDeleted: page === null,
        };
      } catch (err) {
        getApi().setSourceHint(null);
        const e = err as { code?: string; message?: string };
        return {
          type: "DELETE_SECRET_BLOCK_RESULT",
          success: false,
          errorCode: e.code ?? "INTERNAL_ERROR",
          errorMessage: e.message ?? String(err),
        };
      }
    }

    case "RENAME_SECRET_BLOCK": {
      try {
        const { pagePath, oldLabel, newLabel, ifMatch } = message;
        if (!pagePath || !oldLabel || !newLabel) {
          return {
            type: "RENAME_SECRET_BLOCK_RESULT",
            success: false,
            errorCode: "BAD_REQUEST",
          };
        }
        const senderHost = contentScriptHost(sender);
        if (senderHost) getApi().setSourceHint(senderHost);
        const { etag } = await getApi().renameSecretBlock(
          pagePath,
          { old_label: oldLabel, new_label: newLabel },
          ifMatch,
        );
        getApi().setSourceHint(null);
        getCache().clear();
        return { type: "RENAME_SECRET_BLOCK_RESULT", success: true, etag };
      } catch (err) {
        getApi().setSourceHint(null);
        const e = err as { code?: string; message?: string };
        return {
          type: "RENAME_SECRET_BLOCK_RESULT",
          success: false,
          errorCode: e.code ?? "INTERNAL_ERROR",
          errorMessage: e.message ?? String(err),
        };
      }
    }

    case "MOVE_PAGE": {
      try {
        const { pagePath, folder } = message;
        if (!pagePath || !folder) {
          return { type: "MOVE_PAGE_RESULT", success: false, errorCode: "BAD_REQUEST" };
        }
        const page = await getApi().movePage(pagePath, folder);
        getCache().clear();
        return { type: "MOVE_PAGE_RESULT", success: true, newPath: page.path };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return {
          type: "MOVE_PAGE_RESULT",
          success: false,
          errorCode: e.code ?? "INTERNAL_ERROR",
          errorMessage: e.message ?? String(err),
        };
      }
    }

    case "LIST_FOLDERS": {
      // Surfaces vault folder names for the popup's "Move to folder" picker.
      // No write side-effects, so no source hint or cache invalidation needed.
      try {
        const folders = await getApi().listFolders();
        return { type: "LIST_FOLDERS_RESULT", success: true, folders };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return {
          type: "LIST_FOLDERS_RESULT",
          success: false,
          folders: [],
          errorCode: e.code ?? "INTERNAL_ERROR",
          errorMessage: e.message ?? String(err),
        };
      }
    }

    case "GET_PAGE_WITH_ETAG": {
      // Used by the popup before an edit to capture the current ETag for
      // optimistic concurrency control on the subsequent PATCH/DELETE.
      try {
        const { pagePath } = message;
        if (!pagePath) {
          return {
            type: "GET_PAGE_WITH_ETAG_RESULT",
            success: false,
            errorCode: "BAD_REQUEST",
          };
        }
        const { page, etag } = await getApi().getPageWithEtag(pagePath);
        return { type: "GET_PAGE_WITH_ETAG_RESULT", success: true, page, etag };
      } catch (err) {
        const e = err as { code?: string };
        return {
          type: "GET_PAGE_WITH_ETAG_RESULT",
          success: false,
          errorCode: e.code ?? "INTERNAL_ERROR",
        };
      }
    }

    case "SET_DOMAIN_PREF": {
      // Use sender tab's actual domain
      const senderDomain = contentScriptHost(sender);
      if (!senderDomain) {
        return { type: "DOMAIN_PREF_SAVED" };
      }
      await setDomainPref(senderDomain, message.pref);
      return { type: "DOMAIN_PREF_SAVED" };
    }

    case "GET_DOMAIN_PREF": {
      const senderDomain = contentScriptHost(sender);
      if (!senderDomain) {
        return { type: "DOMAIN_PREF_RESULT", pref: null };
      }
      const pref = await getDomainPref(senderDomain);
      return { type: "DOMAIN_PREF_RESULT", pref };
    }

    case "REMEMBER_IDENTITY_FOR_SITE": {
      await rememberIdentityForSite(message.host, message.pagePath);
      return { type: "ACK" } as never;
    }

    case "IDENTITY_FOR_SITE": {
      // The site is the sender's own when the request comes from a page;
      // only the popup may ask about another host.
      const host = isExtensionPage(sender) ? message.host : contentScriptHost(sender);
      if (!host) return { type: "IDENTITY_FOR_SITE_RESULT", pagePath: null };
      const pagePath = await identityForSite(host);
      return { type: "IDENTITY_FOR_SITE_RESULT", pagePath };
    }

    case "LIST_IDENTITIES_FOR_SITE": {
      // What the in-field picker needs: identities only (a card cannot fill an
      // address form), each with its fields, ordered with the one last used on
      // this site first. Cards are left to the popup, where the card form is.
      // The site comes from the sender, never the payload, and a site the user
      // excluded gets nothing: identities hold names and addresses, and the
      // exclusion list is the user saying "not here".
      const host = isExtensionPage(sender) ? message.host : contentScriptHost(sender);
      if (!host || isExcludedDomain(host, getConfig().excludedDomains)) {
        return { type: "LIST_IDENTITIES_FOR_SITE_RESULT", items: [] } as never;
      }
      const all = (await listIdentities(getApi())).filter((i) => i.itemType !== "card");
      const preferred = await identityForSite(host);
      const index = preferred ? all.findIndex((i) => i.pagePath === preferred) : -1;
      const ordered =
        index > 0 ? [all[index]!, ...all.slice(0, index), ...all.slice(index + 1)] : all;
      return {
        type: "LIST_IDENTITIES_FOR_SITE_RESULT",
        items: ordered.map((i) => ({
          pagePath: i.pagePath,
          title: i.title,
          fields: i.fields,
        })),
      } as never;
    }

    case "LIST_IDENTITIES": {
      return { type: "LIST_IDENTITIES_RESULT", items: await listIdentities(getApi()) };
    }

    case "SAVE_IDENTITY": {
      try {
        await getApi().createPage({
          title: message.title,
          content: message.content,
          folder: "identities",
          tags: message.tags,
        });
        getCache().clear();
        return { type: "SAVE_IDENTITY_RESULT", success: true };
      } catch {
        return { type: "SAVE_IDENTITY_RESULT", success: false };
      }
    }

    case "UPDATE_IDENTITY": {
      try {
        await getApi().updatePage(message.pagePath, { content: message.content });
        getCache().clear();
        return { type: "UPDATE_IDENTITY_RESULT", success: true };
      } catch {
        return { type: "UPDATE_IDENTITY_RESULT", success: false };
      }
    }

    default:
      return { type: "STATUS_RESULT", connected: false, vaultUnlocked: false };
  }
}

/**
 * Write to the clipboard via a content script.
 *
 * A content-script sender writes into ITS OWN tab. Routing every request to
 * whatever tab happens to be active let a page in a background tab overwrite
 * the clipboard of the page the user was actually looking at. Only the popup,
 * which has no tab of its own, falls back to the active tab.
 */
async function copyToClipboard(
  text: string,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  let tabId = sender.tab?.id;
  if (tabId === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }
  if (tabId === undefined) return;
  await chrome.tabs.sendMessage(tabId, { type: "CLIPBOARD_WRITE", text });
}

function scheduleClipboardClear(config: ExtensionConfig): void {
  if (config.clipboardTimeout > 0) {
    chrome.alarms.create(CLIPBOARD_CLEAR_ALARM, {
      delayInMinutes: config.clipboardTimeout / 60,
    });
  }
}
