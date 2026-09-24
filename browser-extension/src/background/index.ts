// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { dbg, loadDebugState } from "@/shared/debug";
import { ApiClient } from "./api-client";
import { CredentialCache } from "./credential-cache";
import { HealthCheck } from "./health-check";
import { createMessageHandler } from "./message-handler";
import { LoginJobRunner } from "./login-jobs";
import { flushGeneratedOutbox } from "./generated-outbox";
import { countCaptured, flushCaptureOutbox, parkedCaptureCount } from "./capture-store";
import { applyActionState, type ActionState } from "./action-state";
import type { ExtensionConfig, RecentCredential } from "@/shared/types";
import { DEFAULT_CONFIG } from "@/shared/types";
import {
  STORAGE_KEY_CONFIG,
  STORAGE_KEY_RECENT,
  HEALTH_CHECK_ALARM,
  CLIPBOARD_CLEAR_ALARM,
  AUTO_LOCK_ALARM,
  MAX_RECENT,
} from "@/shared/constants";
import { generatePassword } from "@/shared/generator";
import { isExcludedDomain } from "@/shared/domain-prefs";
import { clearLastUsed } from "@/shared/cred-state";
import type { Credential } from "@/shared/types";

/**
 * Claspt browser extension — background service worker.
 *
 * Responsibilities:
 * - Maintain API client and health check with Claspt desktop
 * - Resolve credentials for tab URLs
 * - Handle messages from popup and content scripts
 * - Manage clipboard auto-clear timers
 * - Auto-lock on idle / browser close
 * - Context menu for right-click fill and copy
 * - Badge match count per tab
 * - Track recently used credentials
 */

// Service worker — no console.log in production

let config: ExtensionConfig = { ...DEFAULT_CONFIG };
const api = new ApiClient(config);
const cache = new CredentialCache(api);
const health = new HealthCheck(api);
/** Whether the extension is "locked" (user must reconnect/re-authenticate). */
let extensionLocked = false;

/** Whether a pairing token carries Secrets scope (`clss_`) rather than Notes (`clsn_`). */
function isSecretsToken(token: string): boolean {
  return token.startsWith("clss_");
}

// Fills requested by an agent through the desktop, after the owner approved
// them there. Runs only while connected and unlocked.
const loginJobs = new LoginJobRunner(
  () => api,
  () => !extensionLocked && hasLocalhostPermission && health.getState() === "connected",
  {
    openTab: (url) =>
      new Promise<number>((resolve, reject) => {
        chrome.tabs.create({ url, active: true }, (tab) => {
          if (!tab?.id) {
            reject(new Error("could not open a tab"));
            return;
          }
          const id = tab.id;
          const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            reject(new Error("the login page did not finish loading"));
          }, 20_000);
          const onUpdated = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
            if (tabId !== id || info.status !== "complete") return;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            // The content script attaches on load; give it a moment to run.
            setTimeout(() => resolve(id), 300);
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
        });
      }),
    activeTab: async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id && tab.url ? { id: tab.id, url: tab.url } : null;
    },
    tabUrl: async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        return tab?.url ?? null;
      } catch {
        return null;
      }
    },
    fill: async (tabId, credential, submit) => {
      const result = (await chrome.tabs.sendMessage(tabId, {
        type: "FILL_CREDENTIAL",
        credential,
        submit,
      })) as { type?: string; success?: boolean } | undefined;
      if (result?.success) {
        recordRecentUse(
          credential.pagePath,
          credential.label,
          credential.fields["url"] ?? "",
          credential.fields["username"] ?? "",
        );
      }
      return result?.success === true;
    },
    isExcluded: (hostname) => isExcludedDomain(hostname, config.excludedDomains),
  },
);
/** Whether the user has granted optional http://127.0.0.1/* host permission. */
let hasLocalhostPermission = false;

const LOCALHOST_ORIGIN = "http://127.0.0.1/*";

/**
 * Credentials for a tab URL, honouring the user's excluded-domain list.
 *
 * Every background path that acts on a tab — badge count, context menu,
 * keyboard shortcut — goes through here, so an excluded site is invisible to
 * all of them and not just to the content script.
 */
async function credentialsForTabUrl(url: string): Promise<Credential[]> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return [];
  }
  if (isExcludedDomain(hostname, config.excludedDomains)) return [];
  return cache.getCredentialsForUrl(url);
}

// Session storage stays at its default, trusted-contexts-only access level.
// It holds cleartext captured passwords (the pending save, the unsaved queue,
// the generated-password outbox); the worker writes and reads them on behalf
// of content scripts through messages that bind each record to the sender's
// own site (see session-store.ts). Opening the area to untrusted contexts,
// which is what this used to do, let the content script on any origin read
// every other site's captured passwords.

/**
 * Check whether the user has granted the optional host permission for our
 * local API origin. All API calls must be gated on this — without it,
 * fetch() will reject with a CORS/permission error and we'd flap
 * disconnected forever.
 */
async function checkLocalhostPermission(): Promise<boolean> {
  try {
    hasLocalhostPermission = await chrome.permissions.contains({
      origins: [LOCALHOST_ORIGIN],
    });
  } catch {
    hasLocalhostPermission = false;
  }
  return hasLocalhostPermission;
}

/** Load config from storage and reinitialize clients */
async function loadConfig(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  if (stored[STORAGE_KEY_CONFIG]) {
    config = { ...DEFAULT_CONFIG, ...stored[STORAGE_KEY_CONFIG] };
  }
  api.updateConfig(config);
  cache.updateApi(api);
  health.updateApi(api);
  setupAutoLock();
}

function onConfigChange(newConfig: ExtensionConfig): void {
  config = newConfig;
  api.updateConfig(config);
  cache.updateApi(api);
  health.updateApi(api);
  cache.clear();
  health.check();
  setupAutoLock();
}

// ── Auto-Lock ──────────────────────────────────────

function setupAutoLock() {
  if (config.autoLockMinutes > 0) {
    chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: config.autoLockMinutes });
  } else {
    chrome.alarms.clear(AUTO_LOCK_ALARM);
  }
  extensionLocked = false;
}

/** Reset auto-lock timer on user activity */
function resetAutoLockTimer() {
  if (config.autoLockMinutes > 0) {
    chrome.alarms.clear(AUTO_LOCK_ALARM, () => {
      chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: config.autoLockMinutes });
    });
  }
}

function lockExtension() {
  extensionLocked = true;
  loginJobs.stop();
  cache.clear();
  // Drop the in-memory bearer token so the locked worker no longer holds the
  // local-API credential. It is restored from `config` on the next health tick
  // (see the HEALTH_CHECK_ALARM handler) so auto-unlock still works.
  api.clearToken();
  // Drop the save bar's handoff: it holds the submitted password in session
  // memory, and a locked extension keeps no plaintext password it can avoid.
  //
  // The generated-password outbox and the capture outbox are deliberately
  // NOT cleared. They hold passwords that could not reach the vault yet, and
  // dropping them on lock is how a password used to be lost. The vault is
  // where they belong, and they are written there on the next reconnection.
  chrome.storage.session.remove("claspt_pending_save").catch(() => {});
  // Also drop the recently-used metadata (usernames + domains) from disk on
  // lock — it's account-linkage data that a locked vault shouldn't retain.
  chrome.storage.local.remove(STORAGE_KEY_RECENT).catch(() => {});
  // Same reasoning for the per-credential last-used timestamps. Pins are kept:
  // see the exposure note in shared/cred-state.ts.
  void clearLastUsed().catch(() => {});
  updateGlobalBadge("vault_locked");
}

function unlockExtension() {
  extensionLocked = false;
  resetAutoLockTimer();
}

// (idle listener removed in 1.8.0 — see note further down)

// ── Recently Used Tracking ─────────────────────────

async function recordRecentUse(
  pagePath: string,
  label: string,
  domain: string,
  username: string,
) {
  const result = await chrome.storage.local.get(STORAGE_KEY_RECENT);
  const recent: RecentCredential[] = result[STORAGE_KEY_RECENT] ?? [];

  // Remove existing entry for same credential
  const filtered = recent.filter((r) => !(r.pagePath === pagePath && r.label === label));

  // Add to front
  filtered.unshift({ pagePath, label, domain, username, timestamp: Date.now() });

  // Trim
  const trimmed = filtered.slice(0, MAX_RECENT);
  await chrome.storage.local.set({ [STORAGE_KEY_RECENT]: trimmed });
}

// ── Context Menu ───────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "claspt-fill",
      title: "Fill with Claspt",
      contexts: ["editable"],
    });
    chrome.contextMenus.create({
      id: "claspt-generate",
      title: "Generate password",
      contexts: ["editable"],
    });
    chrome.contextMenus.create({
      id: "claspt-copy-password",
      title: "Copy password for this site",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "claspt-copy-username",
      title: "Copy username for this site",
      contexts: ["page"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return;
  resetAutoLockTimer();

  if (info.menuItemId === "claspt-fill") {
    try {
      const credentials = await credentialsForTabUrl(tab.url);
      if (credentials.length > 0) {
        chrome.tabs.sendMessage(tab.id, {
          type: "FILL_CREDENTIAL",
          credential: credentials[0],
        });
        const c = credentials[0];
        recordRecentUse(
          c.pagePath,
          c.label,
          c.fields["url"] ?? "",
          c.fields["username"] ?? "",
        );
      }
    } catch {
      // No credentials found
    }
  }

  if (info.menuItemId === "claspt-generate") {
    // Use the inline-icon generator's persisted prefs so right-clicking is
    // consistent with the dropdown the user already configured.
    const stored = await new Promise<
      Partial<{
        length: number;
        uppercase: boolean;
        lowercase: boolean;
        digits: boolean;
        symbols: boolean;
        excludeAmbiguous: boolean;
        excludeProblematic: boolean;
        maxSymbols: number;
      }>
    >((resolve) => {
      try {
        chrome.storage.local.get("claspt_inline_gen_prefs", (data) => {
          resolve(data?.["claspt_inline_gen_prefs"] ?? {});
        });
      } catch {
        resolve({});
      }
    });
    const pw = generatePassword({
      length: stored.length ?? 20,
      uppercase: stored.uppercase ?? true,
      lowercase: stored.lowercase ?? true,
      digits: stored.digits ?? true,
      symbols: stored.symbols ?? true,
      excludeAmbiguous: stored.excludeAmbiguous ?? false,
      excludeProblematic: stored.excludeProblematic ?? false,
      maxSymbols: (stored.symbols ?? true) ? (stored.maxSymbols ?? 2) : undefined,
    });
    chrome.tabs.sendMessage(tab.id, { type: "GENERATE_INTO_FIELD", text: pw });
  }

  if (info.menuItemId === "claspt-copy-password") {
    try {
      const credentials = await credentialsForTabUrl(tab.url);
      const pw = credentials[0]?.fields["password"] ?? "";
      if (pw) {
        chrome.tabs.sendMessage(tab.id, { type: "CLIPBOARD_WRITE", text: pw });
        scheduleClipboardClear();
      }
    } catch {
      /* ignore */
    }
  }

  if (info.menuItemId === "claspt-copy-username") {
    try {
      const credentials = await credentialsForTabUrl(tab.url);
      const user =
        credentials[0]?.fields["username"] ?? credentials[0]?.fields["email"] ?? "";
      if (user) {
        chrome.tabs.sendMessage(tab.id, { type: "CLIPBOARD_WRITE", text: user });
      }
    } catch {
      /* ignore */
    }
  }
});

/** How many times a clear has been attempted without a tab able to do it. */
let clipboardClearAttempts = 0;
const CLIPBOARD_CLEAR_MAX_ATTEMPTS = 6;

/**
 * Clear the clipboard through the active tab, and try again shortly if no tab
 * could do it.
 *
 * The clear used to be sent once and forgotten. On a chrome:// page, the Web
 * Store, or an unfocused window there is no content script to receive it, or
 * the write is refused for lack of focus, and a copied password stayed on
 * the clipboard while the UI implied it had been cleared. Without the
 * clipboardRead permission the extension cannot check what is there first,
 * so a clear replaces whatever the clipboard holds at that moment; the
 * setting says so.
 */
async function clearClipboardOrRetry() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let delivered = false;
  if (tab?.id) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, {
        type: "CLIPBOARD_WRITE",
        text: "",
      });
      delivered = reply?.type === "CLIPBOARD_WRITTEN" ? reply.ok === true : true;
    } catch {
      delivered = false;
    }
  }
  if (delivered || clipboardClearAttempts >= CLIPBOARD_CLEAR_MAX_ATTEMPTS) {
    clipboardClearAttempts = 0;
    return;
  }
  clipboardClearAttempts += 1;
  chrome.alarms.create(CLIPBOARD_CLEAR_ALARM, { delayInMinutes: 0.25 });
}

function scheduleClipboardClear() {
  clipboardClearAttempts = 0;
  if (config.clipboardTimeout > 0) {
    chrome.alarms.create(CLIPBOARD_CLEAR_ALARM, {
      delayInMinutes: config.clipboardTimeout / 60,
    });
  }
}

// ── Badge Match Count ──────────────────────────────

/**
 * Captured logins waiting for a decision. Counted after every change and on
 * every health check, so the badge and the hover text need no vault call of
 * their own when a tab changes.
 */
let waitingCount = 0;

async function refreshWaitingCount(): Promise<void> {
  try {
    const parked = await parkedCaptureCount();
    const inVault =
      health.getState() === "connected" && !extensionLocked ? await countCaptured(api) : 0;
    waitingCount = parked + inVault;
  } catch {
    // Keep the last count; the next check corrects it.
  }
}

function actionStateNow(): ActionState {
  if (extensionLocked) return "extension_locked";
  return health.getState();
}

async function updateBadgeForTab(tabId: number, url: string) {
  const state = actionStateNow();
  let matches = 0;
  if (state === "connected") {
    try {
      matches = (await credentialsForTabUrl(url)).length;
    } catch {
      matches = 0;
    }
  }
  await applyActionState({ state, matches, waiting: waitingCount }, tabId);
}

/** Re-apply the toolbar state after the waiting count changed. */
async function onCapturesChanged(): Promise<void> {
  await refreshWaitingCount();
  updateGlobalBadge(health.getState());
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined && tab.url) await updateBadgeForTab(tab.id, tab.url);
  } catch {
    // No active tab to refresh.
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    resetAutoLockTimer();
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
      updateBadgeForTab(activeInfo.tabId, tab.url);
    }
  } catch (err) {
    // chrome.tabs.get rejects when the tab was closed in the same tick.
    dbg("onActivated error:", err);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    updateBadgeForTab(tabId, tab.url);
  }
});

// ── Lifecycle ──────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await loadConfig();
    setupContextMenu();
    chrome.alarms.create(HEALTH_CHECK_ALARM, { periodInMinutes: 0.25 });
    const state = await health.check();
    updateGlobalBadge(state);
  } catch (err) {
    // health.check() can throw when desktop is offline or fetch is blocked.
    // Don't let it bubble as an unhandled rejection (which Chrome reports as
    // a generic service-worker error in chrome://extensions).
    dbg("onInstalled error:", err);
    updateGlobalBadge("disconnected");
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await loadConfig();
    setupContextMenu();
    chrome.alarms.create(HEALTH_CHECK_ALARM, { periodInMinutes: 0.25 });
    const state = await health.check();
    updateGlobalBadge(state);
    // Lock on browser restart if configured
    if (config.lockOnBrowserClose) {
      lockExtension();
    }
  } catch (err) {
    dbg("onStartup error:", err);
    updateGlobalBadge("disconnected");
  }
});

// ── Alarms ─────────────────────────────────────────

function updateGlobalBadge(state: string) {
  const known: ActionState[] = [
    "connected",
    "vault_locked",
    "disconnected",
    "permission_needed",
    "desktop_too_old",
    "unauthorized",
  ];
  const resolved: ActionState = extensionLocked
    ? "extension_locked"
    : known.includes(state as ActionState)
      ? (state as ActionState)
      : "disconnected";
  void applyActionState({ state: resolved, matches: 0, waiting: waitingCount });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEALTH_CHECK_ALARM) {
    // Skip the health check until the user has granted the optional host
    // permission — fetch() would error out every tick otherwise.
    if (!hasLocalhostPermission) {
      updateGlobalBadge("disconnected");
      return;
    }
    // If we're locked, the bearer token was cleared from the ApiClient on lock.
    // Restore it from the in-memory config so this health probe can detect the
    // desktop coming back and auto-unlock. (config is not wiped on lock — the
    // companion model needs the token to persist for reconnection.)
    if (extensionLocked && !api.hasToken() && config.token) {
      api.updateConfig(config);
    }
    const prevState = health.getState();
    const newState = await health.check();
    updateGlobalBadge(newState);
    if (prevState === "connected" && newState !== "connected") {
      cache.clear();
    }
    // Unlock extension if desktop is connected and we were auto-locked
    if (extensionLocked && newState === "connected") {
      unlockExtension();
      updateGlobalBadge(newState);
    }
    // The vault is back: write whatever was generated or captured while it
    // was away, then count what is waiting so the toolbar says so.
    if (prevState !== "connected" && newState === "connected") {
      void flushGeneratedOutbox(api);
      void flushCaptureOutbox(api, (url) => cache.getCredentialsForUrl(url)).then(() =>
        onCapturesChanged(),
      );
    } else {
      void refreshWaitingCount().then(() => updateGlobalBadge(newState));
    }
    // Login jobs deliver decrypted credentials, and the desktop refuses the
    // poll from a notes-scope pairing, so a notes-scope extension does not
    // start the poll at all rather than retrying a 403 forever.
    if (newState === "connected" && !extensionLocked && isSecretsToken(config.token)) {
      loginJobs.ensure();
    } else {
      loginJobs.stop();
    }
  }

  if (alarm.name === CLIPBOARD_CLEAR_ALARM) {
    await clearClipboardOrRetry();
  }

  if (alarm.name === AUTO_LOCK_ALARM) {
    lockExtension();
  }
});

// ── Messages ───────────────────────────────────────

const handler = createMessageHandler(
  () => api,
  () => cache,
  () => health,
  () => config,
  onConfigChange,
  () => void onCapturesChanged(),
);

// Wrap handler to reset auto-lock timer on any user interaction
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  resetAutoLockTimer();

  // Track recently used on fill
  if (message.type === "FILL_CREDENTIAL" && message.credential) {
    const c = message.credential;
    recordRecentUse(
      c.pagePath,
      c.label,
      c.fields?.["url"] ?? "",
      c.fields?.["username"] ?? "",
    );
  }

  return handler(message, sender, sendResponse);
});

// ── Keyboard Shortcut ──────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  resetAutoLockTimer();

  if (command === "fill-credentials") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return;

    try {
      const credentials = await credentialsForTabUrl(tab.url);
      if (credentials.length > 0) {
        chrome.tabs.sendMessage(tab.id, {
          type: "FILL_CREDENTIAL",
          credential: credentials[0],
        });
        const c = credentials[0];
        recordRecentUse(
          c.pagePath,
          c.label,
          c.fields["url"] ?? "",
          c.fields["username"] ?? "",
        );
      }
    } catch {
      // Ignore
    }
  }
});

// NOTE: Earlier versions used chrome.idle to lock on OS lock (Cmd+Ctrl+Q /
// Win+L). The `idle` permission was removed in 1.8.0 to keep the manifest
// minimal for Chrome Web Store review. Time-based auto-lock still runs via
// chrome.alarms (AUTO_LOCK_ALARM) and the message-based resetAutoLockTimer
// — both unaffected.

// ── Initial Load ───────────────────────────────────

loadConfig()
  .then(async () => {
    await loadDebugState();
    dbg("Config loaded, port:", config.port, "token:", config.token ? "set" : "empty");

    await checkLocalhostPermission();
    if (!hasLocalhostPermission) {
      dbg("Localhost host permission not granted — skipping health check");
      updateGlobalBadge("disconnected");
      return;
    }

    const state = await health.check();
    dbg("Health check:", state);
    updateGlobalBadge(state);
  })
  .catch((err) => {
    // Catch-all — never let an unhandled rejection surface as a generic
    // "src/background/index.js:0 (anonymous function)" error in
    // chrome://extensions when the desktop isn't reachable yet.
    dbg("Initial load error:", err);
    updateGlobalBadge("disconnected");
  });

// React to user granting / revoking the localhost host permission at runtime.
// chrome.permissions.onAdded fires when the user accepts the permission
// prompt triggered by chrome.permissions.request() in the popup; onRemoved
// fires from chrome://extensions → "Site access" → revoke.
chrome.permissions.onAdded.addListener(async (added) => {
  if (added.origins?.includes(LOCALHOST_ORIGIN)) {
    hasLocalhostPermission = true;
    const state = await health.check();
    updateGlobalBadge(state);
  }
});

chrome.permissions.onRemoved.addListener((removed) => {
  if (removed.origins?.includes(LOCALHOST_ORIGIN)) {
    hasLocalhostPermission = false;
    cache.clear();
    updateGlobalBadge("disconnected");
  }
});
