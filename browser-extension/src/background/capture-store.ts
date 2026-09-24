// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * A submitted login goes into the vault the moment it is captured.
 *
 * The save bar used to be the only place a captured password lived, in the
 * extension's session memory, for five minutes and until the next lock. A
 * signup that went on through a second factor and a welcome tour lost its
 * password before anyone could press Save. Now the capture is written to the
 * vault at once as an ordinary credential page tagged "captured", encrypted
 * like every secret, and the bar merely asks what to make of it. Confirm
 * drops the tag; discard sends the page to the trash. When the desktop is
 * out of reach the capture waits here, in memory, the way generated
 * passwords do, and is written on the next reconnection.
 */
import type { ApiClient } from "./api-client";
import type { CapturedItem, Credential } from "@/shared/types";
import { extractSecretBlocks } from "@claspt/shared/secret-parser";
import { getRegistrableDomain } from "@/shared/url-matching";

export const CAPTURED_TAG = "captured";
export const CAPTURE_FOLDER = "credentials";
const OUTBOX_KEY = "claspt_capture_outbox";
const MAX_OUTBOX = 50;

export interface CaptureEntry {
  username: string;
  password: string;
  url: string;
  /** The registrable domain the browser reported for the sender. */
  domain: string;
  isSignup: boolean;
  capturedAt: string;
  /** Answered Save while parked: written as an ordinary login, not a capture. */
  confirmed?: boolean;
}

/** The page title: the account and where it is used. */
export function captureTitle(username: string, domain: string): string {
  return username ? `${username} at ${domain}` : `${domain} Login`;
}

export function captureTags(domain: string): string[] {
  return ["login", domain, CAPTURED_TAG];
}

export function withoutCapturedTag(tags: string[]): string[] {
  return tags.filter((t) => t !== CAPTURED_TAG);
}

export function isCapturedPage(tags: string[] | undefined): boolean {
  return (tags ?? []).includes(CAPTURED_TAG);
}

/** The block the capture becomes; every value has already been sanitised. */
export function captureContent(entry: CaptureEntry): string {
  return [
    `:::secret[${entry.domain} Login]`,
    `username: ${entry.username}`,
    `password: ${entry.password}`,
    `url: ${entry.url}`,
    ":::",
  ].join("\n");
}

function sameAccount(credential: Credential, username: string): boolean {
  const stored =
    credential.fields["username"] ||
    credential.fields["user"] ||
    credential.fields["login"] ||
    credential.fields["email"] ||
    "";
  return stored.trim().toLowerCase() === username.trim().toLowerCase();
}

/**
 * Write the capture to the vault: a fresh captured page, or the new password
 * onto a capture for the same account that is already waiting, so retyping
 * a password does not leave two unconfirmed pages behind.
 */
export async function captureToVault(
  api: ApiClient,
  existing: Credential[],
  entry: CaptureEntry,
): Promise<{ pagePath: string; updatedExisting: boolean }> {
  // Only a capture tagged with this very site is a candidate: the list may
  // hold pages for other sites the caller's lookup matched.
  const waiting = existing.find(
    (c) =>
      c.captured &&
      (c.tags ?? []).includes(entry.domain) &&
      sameAccount(c, entry.username),
  );
  if (waiting) {
    await api.patchSecretBlock(waiting.pagePath, {
      label: waiting.label,
      fields: { password: entry.password, ...(entry.url ? { url: entry.url } : {}) },
    });
    if (entry.confirmed) await confirmCapture(api, waiting.pagePath);
    return { pagePath: waiting.pagePath, updatedExisting: true };
  }
  const page = await api.createPage({
    title: captureTitle(entry.username, entry.domain),
    content: captureContent(entry),
    folder: CAPTURE_FOLDER,
    tags: entry.confirmed
      ? withoutCapturedTag(captureTags(entry.domain))
      : captureTags(entry.domain),
  });
  return { pagePath: page.path, updatedExisting: false };
}

/** Keep the capture; drop the tag and, when the owner named it, retitle it. */
export async function confirmCapture(
  api: ApiClient,
  pagePath: string,
  title?: string,
): Promise<void> {
  const page = await api.getPage(pagePath);
  await api.updateTags(pagePath, withoutCapturedTag(page.meta?.tags ?? []));
  const wanted = (title ?? "").trim();
  if (wanted && wanted !== page.meta?.title) await api.updateTitle(pagePath, wanted);
}

/** The capture is not wanted: to the trash, where it waits like any page. */
export async function discardCapture(api: ApiClient, pagePath: string): Promise<void> {
  await api.deletePage(pagePath);
}

/**
 * Whether a page is a capture, and, for a page sender, a capture from that
 * sender's own site. A web page may confirm or discard only what was captured
 * on it; it cannot reach any other page in the vault by naming a path.
 */
export async function capturedPageBelongsTo(
  api: ApiClient,
  pagePath: string,
  site: string | null,
): Promise<boolean> {
  try {
    const page = await api.getPage(pagePath);
    const tags = page.meta?.tags ?? [];
    if (!isCapturedPage(tags)) return false;
    if (site === null) return true;
    return tags.includes(site);
  } catch {
    return false;
  }
}

/** How many captures wait in the vault. One listing, no page reads. */
export async function countCaptured(api: ApiClient): Promise<number> {
  const pages = await api.listPages(CAPTURE_FOLDER);
  return pages.filter((p) => isCapturedPage(p.meta?.tags)).length;
}

/**
 * The capture waiting for an account on a site, when the bar only knows the
 * account: a capture parked while the desktop was away and written since.
 */
export function findWaitingCapture(
  existing: Credential[],
  site: string,
  username: string,
): Credential | undefined {
  return existing.find(
    (c) => c.captured && (c.tags ?? []).includes(site) && sameAccount(c, username),
  );
}

/** Every capture waiting in the vault, newest first. Passwords stay in the vault. */
export async function listCaptured(api: ApiClient): Promise<CapturedItem[]> {
  const pages = await api.listPages(CAPTURE_FOLDER);
  const items: CapturedItem[] = [];
  for (const summary of pages) {
    if (!isCapturedPage(summary.meta?.tags)) continue;
    try {
      const page = await api.getPage(summary.path);
      const block = extractSecretBlocks(page.content)[0];
      const fields = block?.fields ?? {};
      const url = fields["url"] ?? "";
      const domain =
        summary.meta.tags.find((t) => t !== "login" && t !== CAPTURED_TAG) ??
        domainOf(url);
      items.push({
        pagePath: summary.path,
        title: summary.meta.title,
        username: fields["username"] ?? fields["email"] ?? "",
        domain,
        url,
        capturedAt: summary.meta.created_at,
      });
    } catch {
      // A page that vanished or cannot be read is not a capture to show.
    }
  }
  return items.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
}

function domainOf(url: string): string {
  try {
    return getRegistrableDomain(new URL(url).hostname);
  } catch {
    return "";
  }
}

// ── The outbox: captures the desktop could not take yet ──────────────────

async function readOutbox(): Promise<CaptureEntry[]> {
  try {
    const data = await chrome.storage.session.get(OUTBOX_KEY);
    return (data?.[OUTBOX_KEY] as CaptureEntry[] | undefined) ?? [];
  } catch {
    return [];
  }
}

async function writeOutbox(entries: CaptureEntry[]): Promise<void> {
  try {
    await chrome.storage.session.set({ [OUTBOX_KEY]: entries.slice(0, MAX_OUTBOX) });
  } catch {
    // Storage unavailable; the caller has already been told the capture is not saved.
  }
}

/** Hold a capture the vault could not take. One per account and site. */
export async function parkCapture(entry: CaptureEntry): Promise<void> {
  const existing = await readOutbox();
  const rest = existing.filter(
    (e) =>
      !(
        e.domain === entry.domain &&
        e.username.toLowerCase() === entry.username.toLowerCase()
      ),
  );
  await writeOutbox([entry, ...rest]);
}

export async function parkedCaptureCount(): Promise<number> {
  return (await readOutbox()).length;
}

function sameParked(e: CaptureEntry, site: string, username: string): boolean {
  return e.domain === site && e.username.toLowerCase() === username.toLowerCase();
}

/** The owner pressed Save while the desktop was away: write it confirmed. */
export async function confirmParkedCapture(
  site: string,
  username: string,
): Promise<boolean> {
  const entries = await readOutbox();
  const target = entries.find((e) => sameParked(e, site, username));
  if (!target) return false;
  target.confirmed = true;
  await writeOutbox(entries);
  return true;
}

export async function discardParkedCapture(
  site: string,
  username: string,
): Promise<boolean> {
  const entries = await readOutbox();
  const rest = entries.filter((e) => !sameParked(e, site, username));
  if (rest.length === entries.length) return false;
  await writeOutbox(rest);
  return true;
}

/** Write everything parked; whatever still fails stays parked. */
export async function flushCaptureOutbox(
  api: ApiClient,
  existingFor: (url: string) => Promise<Credential[]>,
): Promise<number> {
  const parked = await readOutbox();
  if (parked.length === 0) return 0;
  const stillParked: CaptureEntry[] = [];
  let written = 0;
  for (const entry of parked) {
    try {
      const existing = await existingFor(entry.url || `https://${entry.domain}/`);
      await captureToVault(api, existing, entry);
      written += 1;
    } catch {
      stillParked.push(entry);
    }
  }
  await writeOutbox(stillParked);
  return written;
}
