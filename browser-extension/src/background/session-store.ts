// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Session records the worker keeps on behalf of content scripts.
 *
 * Three things a page's content script needs to survive a navigation live
 * here: the login it just captured (a redirect or a second factor happens
 * before the save bar can be answered), the username typed on step one of a
 * two-step login, and the queue of captures the user dismissed. All of them
 * are cleartext passwords. They used to be written and read by the content
 * scripts directly, which meant session storage had to be opened to every
 * untrusted context, so the content script on any origin could read every
 * other site's captured passwords, and a login captured on one site was
 * offered as "save password?" on the next site the user opened.
 *
 * The worker now owns the storage, at its default trusted-only access level,
 * and binds each record to the site it came from: a record is written with
 * the sender's registrable domain, never one from the payload, and read back
 * only by a sender on that same domain. The browser is the only thing that
 * can say which site a message came from, so that is the only thing asked.
 */
import type { LastCapture, PendingSave } from "@/shared/types";
import { getRegistrableDomain } from "@/shared/url-matching";

const PENDING_KEY = "claspt_pending_save";
const STEP_USERNAME_KEY = "claspt_step_username";
/**
 * How long the bar keeps coming back for a capture. The capture itself is in
 * the vault from the first second; this only bounds how long the pages of the
 * site keep asking. An hour covers a second factor and a welcome tour.
 */
const PENDING_TTL_MS = 3_600_000;
/**
 * A step-one username older than this is forgotten. Three minutes: long
 * enough to reach the password page, short enough that an old address is not
 * joined to the next account's password on a site with several.
 */
const STEP_USERNAME_TTL_MS = 180_000;
/** The last capture outcome per site, for the popup to explain. */
const LAST_CAPTURE_KEY = "claspt_last_capture";
const MAX_LAST_CAPTURES = 50;

interface StepUsername {
  value: string;
  /** Exact host: step two of a login is on the same host as step one. */
  host: string;
  timestamp: number;
}

/** The site a sender is on, as its registrable domain; null for non-page senders. */
export function senderSite(sender: chrome.runtime.MessageSender): string | null {
  if (!sender.tab || sender.frameId !== 0) return null;
  const url = sender.url ?? sender.tab.url;
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host ? getRegistrableDomain(host) : null;
  } catch {
    return null;
  }
}

function senderHost(sender: chrome.runtime.MessageSender): string | null {
  if (!sender.tab || sender.frameId !== 0) return null;
  try {
    return new URL(sender.url ?? sender.tab.url ?? "").hostname || null;
  } catch {
    return null;
  }
}

async function readKey<T>(key: string): Promise<T | undefined> {
  try {
    const result = await chrome.storage.session.get(key);
    return result[key] as T | undefined;
  } catch {
    return undefined;
  }
}

async function writeKey(key: string, value: unknown): Promise<boolean> {
  try {
    await chrome.storage.session.set({ [key]: value });
    return true;
  } catch {
    return false;
  }
}

async function removeKey(key: string): Promise<void> {
  try {
    await chrome.storage.session.remove(key);
  } catch {
    // Nothing to remove, or storage unavailable: either way it is gone.
  }
}

/** Remember a capture from the sender's site. Refused for non-page senders. */
export async function setPendingSave(
  sender: chrome.runtime.MessageSender,
  credentials: Omit<PendingSave, "timestamp" | "domain">,
): Promise<boolean> {
  const site = senderSite(sender);
  if (!site) return false;
  const pending: PendingSave = {
    username: credentials.username,
    password: credentials.password,
    url: credentials.url,
    isSignup: credentials.isSignup,
    domain: site,
    timestamp: Date.now(),
    ...(credentials.pagePath ? { pagePath: credentials.pagePath } : {}),
  };
  return writeKey(PENDING_KEY, pending);
}

/**
 * The pending capture for the sender's site, if any. A capture from another
 * site is invisible to this sender; one past its time-to-live is moved to the
 * unsaved queue instead.
 */
export async function getPendingSave(
  sender: chrome.runtime.MessageSender,
): Promise<PendingSave | null> {
  const site = senderSite(sender);
  if (!site) return null;
  const pending = await readKey<PendingSave>(PENDING_KEY);
  if (!pending) return null;
  if (Date.now() - pending.timestamp > PENDING_TTL_MS) {
    // The vault already holds the capture; only the bar's handoff expires.
    await removeKey(PENDING_KEY);
    return null;
  }
  if (pending.domain !== site) return null;
  return pending;
}

/** Drop the pending capture, if it belongs to the sender's site. */
export async function clearPendingSave(sender: chrome.runtime.MessageSender): Promise<void> {
  const site = senderSite(sender);
  if (!site) return;
  const pending = await readKey<PendingSave>(PENDING_KEY);
  if (pending && pending.domain === site) await removeKey(PENDING_KEY);
}

/** Move the sender's pending capture to the unsaved queue (dismissed, not lost). */
export async function parkPendingSave(sender: chrome.runtime.MessageSender): Promise<void> {
  const site = senderSite(sender);
  if (!site) return;
  const pending = await readKey<PendingSave>(PENDING_KEY);
  if (!pending || pending.domain !== site) return;
  // The capture is in the vault; the popup lists it there. Only the bar's
  // handoff ends, so the next page of the site does not ask again.
  await removeKey(PENDING_KEY);
}

interface LastCaptureRecord extends LastCapture {
  domain: string;
}

/**
 * Remember what became of the last submission on the sender's site, so the
 * popup can say why a login was or was not taken. Set by the page's own
 * content script; read for any site by the popup. Holds no secret.
 */
export async function setLastCapture(
  sender: chrome.runtime.MessageSender,
  capture: Omit<LastCapture, "at">,
): Promise<void> {
  const site = senderSite(sender);
  if (!site) return;
  const records = (await readKey<LastCaptureRecord[]>(LAST_CAPTURE_KEY)) ?? [];
  const rest = records.filter((r) => r.domain !== site);
  const entry: LastCaptureRecord = { ...capture, domain: site, at: Date.now() };
  await writeKey(LAST_CAPTURE_KEY, [entry, ...rest].slice(0, MAX_LAST_CAPTURES));
}

export async function getLastCapture(domain: string): Promise<LastCapture | null> {
  const records = (await readKey<LastCaptureRecord[]>(LAST_CAPTURE_KEY)) ?? [];
  const record = records.find((r) => r.domain === domain);
  if (!record) return null;
  const { outcome, username, at, pagePath } = record;
  return { outcome, username, at, ...(pagePath ? { pagePath } : {}) };
}

/** Remember the username typed on step one of a login on the sender's host. */
export async function setStepUsername(
  sender: chrome.runtime.MessageSender,
  value: string,
): Promise<boolean> {
  const host = senderHost(sender);
  if (!host || !value) return false;
  const record: StepUsername = { value, host, timestamp: Date.now() };
  return writeKey(STEP_USERNAME_KEY, record);
}

/** The step-one username for the sender's host, if recent. */
export async function getStepUsername(
  sender: chrome.runtime.MessageSender,
): Promise<string | null> {
  const host = senderHost(sender);
  if (!host) return null;
  const record = await readKey<StepUsername>(STEP_USERNAME_KEY);
  if (!record) return null;
  if (record.host !== host) return null;
  if (Date.now() - record.timestamp > STEP_USERNAME_TTL_MS) {
    await removeKey(STEP_USERNAME_KEY);
    return null;
  }
  return record.value;
}

/** Forget the step-one username. Any page sender may clear it: it holds no secret. */
export async function clearStepUsername(): Promise<void> {
  await removeKey(STEP_USERNAME_KEY);
}
