// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { Message, Credential, IdentityItem, ExtensionConfig } from "@/shared/types";
import { STORAGE_KEY_CONFIG, CLIPBOARD_CLEAR_ALARM } from "@/shared/constants";
import { generateTotp } from "@/shared/totp";
import { getDomainPref, setDomainPref, isExcludedDomain } from "@/shared/domain-prefs";
import { extractSecretBlocks } from "@claspt/shared/secret-parser";
import { requestPairing } from "./pairing";
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
  const host = hostnameFromUrl(sender.tab?.url);
  if (!host) return false;
  try {
    const visible = await getCache().getCredentialsForUrl(`https://${host}`);
    return visible.some((c) => c.pagePath === pagePath && c.label === label);
  } catch {
    return false;
  }
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
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  // Extension pages have sender.url starting with chrome-extension://
  return !!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

/**
 * Sanitize a string for safe inclusion in a :::secret block.
 * Strips newlines and the ::: fence marker to prevent fence breakout.
 */
function sanitizeSecretField(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/:::/g, "");
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
  onConfigChange: (config: ExtensionConfig) => void
) {
  return (
    message: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: Message) => void
  ): boolean => {
    // Block privileged messages from content scripts (only popup/options allowed)
    if (PRIVILEGED_MESSAGES.has(message.type) && !isExtensionPage(sender)) {
      console.warn("[Claspt] Blocked privileged message from content script:", message.type);
      sendResponse({ type: "STATUS_RESULT", connected: false, vaultUnlocked: false } as Message);
      return true;
    }

    handleMessage(message, sender, getApi, getCache, getHealth, getConfig, onConfigChange)
      .then(sendResponse)
      .catch((err) => {
        console.error("[Claspt] Message handler error:", err);
        sendResponse({ type: "STATUS_RESULT", connected: false, vaultUnlocked: false } as Message);
      });
    // Return true synchronously to keep the message port open for async response
    return true;
  };
}

async function handleMessage(
  message: Message,
  sender: chrome.runtime.MessageSender,
  getApi: () => ApiClient,
  getCache: () => CredentialCache,
  getHealth: () => HealthCheck,
  getConfig: () => ExtensionConfig,
  onConfigChange: (config: ExtensionConfig) => void
): Promise<Message> {
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
      return {
        type: "STATUS_RESULT",
        connected: state === "connected",
        vaultUnlocked: state === "connected",
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
      try {
        const result = await getApi().passkeyRegister(message.request.rp.id, message.request);
        return { type: "PASSKEY_RESULT", outcome: "done", result };
      } catch (e) {
        return passkeyFailure(e);
      }
    }

    case "PASSKEY_GET": {
      const request = message.request;
      try {
        if (request.allow_credentials.length === 0) {
          const candidates = await getApi().passkeyList(request.rp_id);
          if (candidates.length === 0) return { type: "PASSKEY_RESULT", outcome: "fallback" };
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
      } catch { /* default false */ }
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
          domain = hostnameFromUrl(sender.tab?.url);
        }
        if (!domain || isExcludedDomain(domain, getConfig().excludedDomains)) {
          return { type: "CREDENTIALS_RESULT", credentials: [] };
        }
        const credentials = await getCache().getCredentialsForUrl(
          `https://${domain}`
        );
        return { type: "CREDENTIALS_RESULT", credentials };
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

    case "GENERATE_TOTP": {
      // Privileged — already gated
      try {
        const { code, remaining } = await generateTotp(message.secret);
        return { type: "TOTP_RESULT", code, remaining };
      } catch {
        return { type: "TOTP_RESULT", code: "", remaining: 0 };
      }
    }

    case "CHECK_EXISTING": {
      try {
        // SECURITY: Derive domain from sender tab, not message payload
        const senderDomain = hostnameFromUrl(sender.tab?.url);
        if (!senderDomain || isExcludedDomain(senderDomain, getConfig().excludedDomains)) {
          return { type: "CHECK_EXISTING_RESULT", credentials: [] };
        }
        const credentials = await getCache().getCredentialsForUrl(
          `https://${senderDomain}`
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
          ? (message.domain || "unknown")
          : hostnameFromUrl(sender.tab?.url);
        if (!senderDomain) {
          return { type: "SAVE_CREDENTIAL_RESULT", success: false };
        }
        if (!isExtensionPage(sender) && isExcludedDomain(senderDomain, getConfig().excludedDomains)) {
          return { type: "SAVE_CREDENTIAL_RESULT", success: false };
        }

        // SECURITY: Sanitize all fields to prevent :::secret fence breakout
        const username = sanitizeSecretField(message.username);
        const password = sanitizeSecretField(message.password);
        const url = sanitizeSecretField(message.url);
        const domain = sanitizeSecretField(senderDomain);

        // Determine folder: identities for identity/card items, credentials for logins
        const isIdentityItem = domain.startsWith("_identity") || domain.startsWith("_card");
        const folder = isIdentityItem ? "identities" : "credentials";
        const title = isIdentityItem ? message.username || domain : `${domain} Login`;

        // `sanitizeSecretField` has already stripped every `:::` from these
        // values, so the block below is always built from scratch. (An earlier
        // version tested `password.includes(":::secret[")` here to pass raw
        // markdown through from the identity tab; that condition could never be
        // true after sanitising, and identities go through SAVE_IDENTITY now.)
        const content = [
          `:::secret[${isIdentityItem ? title : `${domain} Login`}]`,
          `username: ${username}`,
          `password: ${password}`,
          `url: ${url}`,
          ":::",
        ].join("\n");

        const tags = isIdentityItem
          ? [domain.startsWith("_card") ? "credit-card" : "identity"]
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
        const site = isExtensionPage(sender)
          ? (message.site ?? "")
          : (hostnameFromUrl(sender.tab?.url) ?? "");
        const where = await recordGenerated(getApi(), {
          password: message.password,
          site,
          source: "browser extension",
          used: false,
          generated: new Date().toISOString(),
        });
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
        return { type: "LIST_GENERATED_PASSWORDS_RESULT", entries: await listGenerated(getApi()) };
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
          return { type: "PATCH_SECRET_BLOCK_RESULT", success: false, errorCode: "BAD_REQUEST" };
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
            return { type: "PATCH_SECRET_BLOCK_RESULT", success: false, errorCode: "FORBIDDEN" };
          }
          const allowed = await contentScriptMayPatch(sender, getCache, pagePath, label);
          if (!allowed) {
            return { type: "PATCH_SECRET_BLOCK_RESULT", success: false, errorCode: "FORBIDDEN" };
          }
        }

        // Sanitize all field values before sending — defense-in-depth even
        // though the desktop will run its own validation.
        const safeFields: Record<string, string> = {};
        for (const [k, v] of Object.entries(fields ?? {})) {
          safeFields[k] = sanitizeSecretField(v);
        }
        const senderHost = hostnameFromUrl(sender.tab?.url);
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
          return { type: "DELETE_SECRET_BLOCK_RESULT", success: false, errorCode: "BAD_REQUEST" };
        }
        const senderHost = hostnameFromUrl(sender.tab?.url);
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
          return { type: "RENAME_SECRET_BLOCK_RESULT", success: false, errorCode: "BAD_REQUEST" };
        }
        const senderHost = hostnameFromUrl(sender.tab?.url);
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
          return { type: "GET_PAGE_WITH_ETAG_RESULT", success: false, errorCode: "BAD_REQUEST" };
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
      const senderDomain = hostnameFromUrl(sender.tab?.url);
      if (!senderDomain) {
        return { type: "DOMAIN_PREF_SAVED" };
      }
      await setDomainPref(senderDomain, message.pref);
      return { type: "DOMAIN_PREF_SAVED" };
    }

    case "GET_DOMAIN_PREF": {
      const senderDomain = hostnameFromUrl(sender.tab?.url);
      if (!senderDomain) {
        return { type: "DOMAIN_PREF_RESULT", pref: null };
      }
      const pref = await getDomainPref(senderDomain);
      return { type: "DOMAIN_PREF_RESULT", pref };
    }

    case "LIST_IDENTITIES": {
      try {
        const summaries = await getApi().listPages("identities");
        const items: IdentityItem[] = [];

        for (const summary of summaries) {
          try {
            const page = await getApi().getPage(summary.path);
            const blocks = extractSecretBlocks(page.content);

            // Merge all fields from all secret blocks in this page into one item
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
        return { type: "LIST_IDENTITIES_RESULT", items };
      } catch {
        return { type: "LIST_IDENTITIES_RESULT", items: [] };
      }
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
