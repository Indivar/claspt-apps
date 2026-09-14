// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Collect a token from the desktop app without the user copying one.
 *
 * Connecting used to mean opening Claspt's Settings, generating a token, and
 * pasting it into this extension's options page. On a fresh install there was no
 * token to generate yet, so the extension could not be connected at all — which
 * was reported as the desktop app "not linking with the browser plugin".
 *
 * The desktop app opens a short pairing window when the user asks it to. While
 * that window is open, `POST /api/pair` returns a token once. Outside it the
 * endpoint refuses, so this is not a way to obtain a token unprompted.
 */

import { buildLocalBaseUrl } from "./api-client";

/** Outcome of one pairing attempt. */
export type PairResult =
  | { ok: true; token: string; scope: "notes" | "secrets" }
  /** The desktop app answered, but no pairing window is open. */
  | { ok: false; reason: "not-open" }
  /** Nothing answered on the port — Claspt is not running, or the API is off. */
  | { ok: false; reason: "unreachable" }
  /** The extension has not been granted access to 127.0.0.1 yet. */
  | { ok: false; reason: "no-permission" };

/**
 * Ask the desktop app for a token.
 *
 * Never throws: every failure is a `PairResult` the caller can act on, because
 * the difference between "Claspt is not running" and "you have not pressed
 * Connect yet" is the difference between two quite different things to tell the
 * user.
 */
export async function requestPairing(port: number): Promise<PairResult> {
  try {
    const granted = await chrome.permissions.contains({
      origins: ["http://127.0.0.1/*"],
    });
    if (!granted) return { ok: false, reason: "no-permission" };
  } catch {
    return { ok: false, reason: "no-permission" };
  }

  let response: Response;
  try {
    response = await fetch(`${buildLocalBaseUrl(port)}/api/pair`, {
      method: "POST",
      // No credentials and no body: the pairing window is the only thing
      // authorising this, so there is nothing to send.
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  if (!response.ok) {
    // 403 is the normal answer when no window is open. Anything else still
    // means we did not get a token, and the user's next move is the same:
    // press Connect in Claspt.
    return { ok: false, reason: "not-open" };
  }

  try {
    const body = (await response.json()) as { token?: string; scope?: string };
    if (!body.token) return { ok: false, reason: "not-open" };
    return {
      ok: true,
      token: body.token,
      scope: body.scope === "notes" ? "notes" : "secrets",
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
