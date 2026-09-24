// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Content-script half of the passkey provider. Runs at document_start in
 * the top frame: injects the page-world provider, relays its requests to
 * the background (which talks to the desktop), and, when a site has more
 * than one passkey in the vault, shows a picker so the user can choose.
 *
 * Only messages from this window with the provider's marker are relayed;
 * the reply carries the request id, so a page cannot answer its own
 * request.
 */
import {
  BRIDGE_MESSAGE_SOURCE,
  type BridgeReply,
  PAGE_MESSAGE_SOURCE,
  type PageRequest,
  type PasskeyCandidate,
  type PasskeyCreateRequest,
  type PasskeyGetRequest,
  rpIdAllowedForHost,
} from "@/shared/passkey-codec";
import type { Message } from "@/shared/types";

function reply(message: BridgeReply) {
  window.postMessage(message, window.location.origin);
}

function sendToBackground(message: Message): Promise<Message | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(undefined);
          return;
        }
        resolve(response as Message | undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** A small closed-shadow-root list of accounts; resolves with the choice. */
export function pickPasskey(
  candidates: PasskeyCandidate[],
  rpId: string,
): Promise<PasskeyCandidate | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.style.cssText =
      "all:initial; position:fixed; top:16px; right:16px; z-index:2147483647; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .box { background:#1f2937; color:#f9fafb; border-radius:10px; padding:12px 14px; width:280px; box-shadow:0 8px 24px rgba(0,0,0,.35); font-size:13px; }
      .title { font-weight:600; margin-bottom:8px; }
      button { display:block; width:100%; text-align:left; background:#374151; color:#f9fafb; border:0; border-radius:6px; padding:8px 10px; margin-top:6px; font-size:13px; cursor:pointer; }
      button:hover { background:#4b5563; }
      .cancel { background:transparent; color:#9ca3af; text-align:center; }
    `;
    shadow.appendChild(style);
    const box = document.createElement("div");
    box.className = "box";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = `Sign in to ${rpId} with a Claspt passkey`;
    box.appendChild(title);
    const finish = (choice: PasskeyCandidate | null) => {
      host.remove();
      resolve(choice);
    };
    for (const candidate of candidates) {
      const button = document.createElement("button");
      button.textContent = candidate.user_display_name
        ? `${candidate.user_display_name} (${candidate.user_name})`
        : candidate.user_name || candidate.label;
      button.addEventListener("click", () => finish(candidate));
      box.appendChild(button);
    }
    const cancel = document.createElement("button");
    cancel.className = "cancel";
    cancel.textContent = "Use another way";
    cancel.addEventListener("click", () => finish(null));
    box.appendChild(cancel);
    shadow.appendChild(box);
    (document.body || document.documentElement).appendChild(host);
  });
}

async function handle(page: PageRequest): Promise<BridgeReply> {
  const base = { source: BRIDGE_MESSAGE_SOURCE, id: page.id } as const;

  // The request came from the page, and any script on the page can post one
  // with whatever origin and RP ID it likes. The origin is therefore replaced
  // with the frame's own, and the RP ID is checked against the frame's host
  // before the vault ever hears about it. A request that fails the check falls
  // back to the browser, which will refuse it for the same reason.
  const origin = window.location.origin;
  const host = window.location.hostname;

  if (page.kind === "create") {
    const incoming = page.request as Partial<PasskeyCreateRequest> | undefined;
    const rpId = incoming?.rp?.id;
    if (typeof rpId !== "string" || !rpIdAllowedForHost(host, rpId)) {
      return { ...base, outcome: "fallback" };
    }
    const request: PasskeyCreateRequest = {
      ...(incoming as PasskeyCreateRequest),
      origin,
      cross_origin: false,
    };
    const response = await sendToBackground({ type: "PASSKEY_CREATE", request });
    if (!response || response.type !== "PASSKEY_RESULT")
      return { ...base, outcome: "fallback" };
    return {
      ...base,
      outcome: response.outcome,
      result: response.result,
      error: response.error,
    };
  }
  const incoming = page.request as Partial<PasskeyGetRequest> | undefined;
  if (typeof incoming?.rp_id !== "string" || !rpIdAllowedForHost(host, incoming.rp_id)) {
    return { ...base, outcome: "fallback" };
  }
  let request: PasskeyGetRequest = {
    ...(incoming as PasskeyGetRequest),
    origin,
    cross_origin: false,
  };
  let response = await sendToBackground({ type: "PASSKEY_GET", request });
  if (response?.type === "PASSKEY_CHOOSE") {
    const choice = await pickPasskey(response.candidates, request.rp_id);
    if (!choice) return { ...base, outcome: "fallback" };
    request = { ...request, allow_credentials: [choice.credential_id] };
    response = await sendToBackground({ type: "PASSKEY_GET", request });
  }
  if (!response || response.type !== "PASSKEY_RESULT")
    return { ...base, outcome: "fallback" };
  return {
    ...base,
    outcome: response.outcome,
    result: response.result,
    error: response.error,
  };
}

// The page-world provider (`src/page/passkey-provider.ts`) is declared in the
// manifest as a `world: "MAIN"` content script, so the browser runs it in the
// page before page scripts and nothing of the extension has to be
// web-accessible for it. It used to be injected from here through a script
// tag pointing at a web-accessible resource, which any page could fetch to
// learn the extension was installed.
function start() {
  if (window !== window.top) return;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as PageRequest | undefined;
    if (!data || data.source !== PAGE_MESSAGE_SOURCE || !data.id || !data.kind) return;
    void handle(data).then(reply);
  });
}

start();
