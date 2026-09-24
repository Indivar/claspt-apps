// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Reading a two-factor QR code off the page the person is looking at.
 *
 * Every site that offers two-factor shows a QR image and, behind a link, the
 * same key as text. Asking someone to find that link, copy the text and paste
 * it into another window is three chances to give up, and it is the step that
 * made setting up two-factor here feel unfinished. Capturing the tab and
 * decoding the image is the one-click version of the same thing.
 *
 * The capture never leaves the browser: the screenshot is decoded in this
 * worker and dropped. Nothing is uploaded, and the image is not kept after the
 * function returns.
 */
import jsQR from "jsqr";

/** What a scan found, or why it found nothing. */
export type QrScanResult =
  | { ok: true; uri: string; issuer: string; account: string }
  | { ok: false; reason: "no-qr" | "not-totp" | "capture-failed" };

/**
 * Pull the `otpauth://` payload out of decoded QR text.
 *
 * A page can carry QR codes that have nothing to do with two-factor: an app
 * store link, a payment code, a wifi join. Accepting only `otpauth://totp/`
 * means scanning the wrong code says so instead of saving a key that will
 * never produce a working number.
 */
export function readOtpauth(text: string): QrScanResult {
  const trimmed = text.trim();
  if (!/^otpauth:\/\/totp\//i.test(trimmed)) {
    return { ok: false, reason: "not-totp" };
  }

  let issuer = "";
  let account = "";
  try {
    const url = new URL(trimmed);
    // The label is `Issuer:account` or just `account`, and is percent-encoded.
    const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const colon = label.indexOf(":");
    if (colon >= 0) {
      issuer = label.slice(0, colon).trim();
      account = label.slice(colon + 1).trim();
    } else {
      account = label.trim();
    }
    // The issuer parameter wins over the label prefix when both are present,
    // which is what RFC-adjacent practice and every authenticator app does.
    issuer = url.searchParams.get("issuer")?.trim() || issuer;
  } catch {
    // A malformed URI still has a usable secret for the TOTP code itself, so
    // it is not rejected here; only the display names are lost.
  }

  return { ok: true, uri: trimmed, issuer, account };
}

/**
 * Decode a captured screenshot.
 *
 * Split from the capture so it can be tested without a browser tab, and so a
 * decode failure is distinguishable from a capture failure: the first means
 * "no QR on screen", the second means the extension was not allowed to look.
 */
export async function decodeImage(dataUrl: string): Promise<QrScanResult> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) return { ok: false, reason: "capture-failed" };

  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();

  const found = jsQR(image.data, image.width, image.height, {
    // Sites draw the QR dark-on-light; trying both costs a second pass only
    // when the first finds nothing, which is the case where we want it.
    inversionAttempts: "attemptBoth",
  });
  if (!found) return { ok: false, reason: "no-qr" };
  return readOtpauth(found.data);
}

/**
 * Capture the visible part of a tab and look for a two-factor QR code.
 *
 * Only the visible area is captured, which is the same thing the person can
 * see. A QR scrolled off screen is not found, and the caller says so rather
 * than scrolling the page on their behalf.
 */
export async function scanTabForTotp(windowId: number): Promise<QrScanResult> {
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch {
    return { ok: false, reason: "capture-failed" };
  }
  if (!dataUrl) return { ok: false, reason: "capture-failed" };

  try {
    return await decodeImage(dataUrl);
  } catch {
    return { ok: false, reason: "capture-failed" };
  }
}
