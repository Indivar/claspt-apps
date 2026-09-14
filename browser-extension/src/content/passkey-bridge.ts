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
  PAGE_MESSAGE_SOURCE,
  type BridgeReply,
  type PageRequest,
  type PasskeyCandidate,
  type PasskeyGetRequest,
} from "@/shared/passkey-codec";
import type { Message } from "@/shared/types";

function injectProvider() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/page/passkey-provider.js");
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

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
  if (page.kind === "create") {
    const response = await sendToBackground({
      type: "PASSKEY_CREATE",
      request: page.request as never,
    });
    if (!response || response.type !== "PASSKEY_RESULT")
      return { ...base, outcome: "fallback" };
    return {
      ...base,
      outcome: response.outcome,
      result: response.result,
      error: response.error,
    };
  }
  let request = page.request as PasskeyGetRequest;
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

function start() {
  if (window !== window.top) return;
  injectProvider();
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as PageRequest | undefined;
    if (!data || data.source !== PAGE_MESSAGE_SOURCE || !data.id || !data.kind) return;
    void handle(data).then(reply);
  });
}

start();
