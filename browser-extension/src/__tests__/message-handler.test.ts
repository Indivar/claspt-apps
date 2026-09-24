// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  allowGeneratedFromHost,
  createMessageHandler,
  sanitizeTag,
  templateFields,
} from "@/background/message-handler";
import {
  DEFAULT_CONFIG,
  type Credential,
  type ExtensionConfig,
  type Message,
} from "@/shared/types";
import { chromeStub, stores } from "./setup";
import { rememberIdentityForSite } from "@/shared/identity-prefs";
import type { ApiClient } from "@/background/api-client";
import type { CredentialCache } from "@/background/credential-cache";
import type { HealthCheck } from "@/background/health-check";
import { HISTORY_FOLDER } from "@claspt/shared/generated-history";
import { resetHistoryPathCache } from "@/background/generated-history-store";

const POPUP_SENDER: chrome.runtime.MessageSender = {
  url: "chrome-extension://test-extension-id/src/popup/index.html",
};

/** A content script running on an ordinary web page. */
function pageSender(url: string): chrome.runtime.MessageSender {
  // A real content-script sender always carries its frame id; 0 is the top frame.
  return { url, frameId: 0, tab: { id: 7, url } as chrome.tabs.Tab };
}

/** The credential the attacker's page is allowed to see (it is theirs). */
const OWN_CREDENTIAL: Credential = {
  pagePath: "credentials/evil.md",
  pageTitle: "Evil",
  label: "evil.test Login",
  fields: { username: "me", password: "pw", url: "https://evil.test" },
};

/** A credential from a completely different site. */
const BANK_CREDENTIAL: Credential = {
  pagePath: "credentials/bank.md",
  pageTitle: "Bank",
  label: "bank.test Login",
  fields: { username: "me", password: "real", url: "https://bank.test" },
};

function harness(overrides?: { config?: Partial<ExtensionConfig> }) {
  const api = {
    patchSecretBlock: vi.fn(() => Promise.resolve({ page: {}, etag: "v1" })),
    createPage: vi.fn(() => Promise.resolve({ path: `${HISTORY_FOLDER}/2026-09.md` })),
    getPage: vi.fn(() => Promise.resolve({ content: "" })),
    listPages: vi.fn(() => Promise.resolve([])),
    deleteSecretBlock: vi.fn(() => Promise.resolve({ page: null, etag: null })),
    setSourceHint: vi.fn(),
    listFolders: vi.fn(() => Promise.resolve(["credentials"])),
  } as unknown as ApiClient;

  const cache = {
    // Only ever returns the credential belonging to evil.test.
    getCredentialsForUrl: vi.fn(() => Promise.resolve([OWN_CREDENTIAL])),
    clear: vi.fn(),
  } as unknown as CredentialCache;

  const health = {
    check: vi.fn(() => Promise.resolve("connected")),
    getVersion: vi.fn(),
    getVaultFormatVersion: vi.fn(),
    getVaultSyncVersion: vi.fn(),
    getPlan: vi.fn(),
    getFeatures: vi.fn(),
  } as unknown as HealthCheck;

  const config: ExtensionConfig = { ...DEFAULT_CONFIG, ...overrides?.config };
  const handler = createMessageHandler(
    () => api,
    () => cache,
    () => health,
    () => config,
    vi.fn(),
  );

  const send = (
    message: Message,
    sender: chrome.runtime.MessageSender,
  ): Promise<Message> =>
    new Promise((resolve) => {
      handler(message, sender, resolve);
    });

  return { api, cache, health, send };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetHistoryPathCache();
});

describe("privileged messages", () => {
  const PRIVILEGED: Message[] = [
    { type: "GET_CONFIG" },
    { type: "SAVE_CONFIG", config: DEFAULT_CONFIG },
    { type: "SEARCH_CREDENTIALS", query: "x" },
    { type: "LIST_FOLDERS" },
    { type: "PAIR_WITH_APP" },
    { type: "DELETE_SECRET_BLOCK", pagePath: "a.md", label: "L" },
    { type: "RENAME_SECRET_BLOCK", pagePath: "a.md", oldLabel: "L", newLabel: "M" },
    { type: "MOVE_PAGE", pagePath: "a.md", folder: "x" },
  ] as Message[];

  for (const message of PRIVILEGED) {
    it(`refuses ${message.type} from a content script`, async () => {
      const { send } = harness();
      const res = await send(message, pageSender("https://evil.test/"));
      expect(res.type).toBe("STATUS_RESULT");
    });
  }

  it("allows a privileged message from the popup", async () => {
    const { send } = harness();
    const res = await send({ type: "GET_CONFIG" }, POPUP_SENDER);
    expect(res.type).toBe("CONFIG_RESULT");
  });
});

describe("GET_CREDENTIALS", () => {
  it("uses the sender tab's host and ignores the message payload", async () => {
    const { send, cache } = harness();
    await send(
      { type: "GET_CREDENTIALS", domain: "bank.test" } as Message,
      pageSender("https://evil.test/login"),
    );
    expect(cache.getCredentialsForUrl).toHaveBeenCalledWith("https://evil.test");
  });

  it("returns nothing for a site the user excluded", async () => {
    const { send, cache } = harness({ config: { excludedDomains: ["evil.test"] } });
    const res = await send(
      { type: "GET_CREDENTIALS", domain: "" } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res).toEqual({ type: "CREDENTIALS_RESULT", credentials: [] });
    expect(cache.getCredentialsForUrl).not.toHaveBeenCalled();
  });
});

/**
 * PATCH_SECRET_BLOCK is the only write a content script may make. These cover
 * the attack the previous design allowed: a page naming any page path in the
 * vault and overwriting the secret block on it.
 */
describe("PATCH_SECRET_BLOCK from a content script", () => {
  it("allows patching a credential its own site can already see", async () => {
    const { send, api } = harness();
    const res = await send(
      {
        type: "PATCH_SECRET_BLOCK",
        pagePath: OWN_CREDENTIAL.pagePath,
        label: OWN_CREDENTIAL.label,
        fields: { password: "rotated" },
      } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res).toMatchObject({ type: "PATCH_SECRET_BLOCK_RESULT", success: true });
    expect(api.patchSecretBlock).toHaveBeenCalled();
  });

  it("refuses a page path its own site cannot see", async () => {
    const { send, api } = harness();
    const res = await send(
      {
        type: "PATCH_SECRET_BLOCK",
        pagePath: BANK_CREDENTIAL.pagePath,
        label: BANK_CREDENTIAL.label,
        fields: { password: "attacker-chosen" },
      } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res).toMatchObject({ success: false, errorCode: "FORBIDDEN" });
    expect(api.patchSecretBlock).not.toHaveBeenCalled();
  });

  it("refuses to rewrite the fields that decide where a credential is offered", async () => {
    const { send, api } = harness();
    for (const key of ["url", "url_match"]) {
      const res = await send(
        {
          type: "PATCH_SECRET_BLOCK",
          pagePath: OWN_CREDENTIAL.pagePath,
          label: OWN_CREDENTIAL.label,
          fields: { [key]: "https://bank.test" },
        } as Message,
        pageSender("https://evil.test/"),
      );
      expect(res).toMatchObject({ success: false, errorCode: "FORBIDDEN" });
    }
    expect(api.patchSecretBlock).not.toHaveBeenCalled();
  });

  it("refuses to delete a field outside the writable set", async () => {
    const { send, api } = harness();
    const res = await send(
      {
        type: "PATCH_SECRET_BLOCK",
        pagePath: OWN_CREDENTIAL.pagePath,
        label: OWN_CREDENTIAL.label,
        fields: {},
        deleteFields: ["url_match"],
      } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res).toMatchObject({ success: false, errorCode: "FORBIDDEN" });
    expect(api.patchSecretBlock).not.toHaveBeenCalled();
  });

  it("refuses when the sender has no tab URL", async () => {
    const { send } = harness();
    const res = await send(
      {
        type: "PATCH_SECRET_BLOCK",
        pagePath: OWN_CREDENTIAL.pagePath,
        label: OWN_CREDENTIAL.label,
        fields: { password: "x" },
      } as Message,
      { url: "https://evil.test/" },
    );
    expect(res).toMatchObject({ success: false, errorCode: "FORBIDDEN" });
  });
});

describe("PATCH_SECRET_BLOCK from the popup", () => {
  it("is not restricted to the visible-credential set or the writable fields", async () => {
    const { send, api } = harness();
    const res = await send(
      {
        type: "PATCH_SECRET_BLOCK",
        pagePath: BANK_CREDENTIAL.pagePath,
        label: BANK_CREDENTIAL.label,
        fields: { url_match: "host" },
      } as Message,
      POPUP_SENDER,
    );
    expect(res).toMatchObject({ success: true });
    expect(api.patchSecretBlock).toHaveBeenCalled();
  });
});

describe("SAVE_CREDENTIAL from the Add new form", () => {
  it("writes every field of the template, under the label the form gave", async () => {
    const { send, api } = harness();
    await send(
      {
        type: "SAVE_CREDENTIAL",
        username: "",
        password: "",
        url: "",
        domain: "github.com",
        label: "GitHub deploy key",
        template: "ssh-key",
        fields: {
          Host: "github.com",
          Username: "git",
          private_key:
            "-----BEGIN OPENSSH PRIVATE KEY----- AAAA -----END OPENSSH PRIVATE KEY-----",
          passphrase: "",
          public_key: "ssh-ed25519 AAAA",
        },
      } as Message,
      POPUP_SENDER,
    );
    const body = (api.createPage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.title).toBe("GitHub deploy key");
    expect(body.folder).toBe("credentials");
    expect(body.tags).toEqual(["ssh-key", "github.com"]);
    expect(body.content).toBe(
      [
        ":::secret[GitHub deploy key]",
        "Host: github.com",
        "Username: git",
        "private_key: -----BEGIN OPENSSH PRIVATE KEY----- AAAA -----END OPENSSH PRIVATE KEY-----",
        "public_key: ssh-ed25519 AAAA",
        ":::",
      ].join("\n"),
    );
  });

  it("ignores the field map from a content script, which only knows a login", async () => {
    const { send, api } = harness();
    await send(
      {
        type: "SAVE_CREDENTIAL",
        username: "me",
        password: "pw",
        url: "https://evil.test/login",
        domain: "evil.test",
        fields: { Injected: "value" },
        label: "Not from the form",
      } as Message,
      pageSender("https://evil.test/login"),
    );
    const body = (api.createPage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.title).toBe("evil.test Login");
    expect(body.content).not.toContain("Injected");
  });

  it("keeps field names and values on one line each and drops blanks", () => {
    expect(
      templateFields({
        "Card Number": " 4111 ",
        "bad:key\nname": "x",
        Empty: "   ",
        note: "a:::secret[b]",
      }),
    ).toEqual([
      ["Card Number", "4111"],
      ["bad key name", "x"],
      ["note", "asecret[b]"],
    ]);
    expect(sanitizeTag("SSH-Key!")).toBe("ssh-key");
    expect(sanitizeTag("")).toBe("");
  });
});

describe("SAVE_CREDENTIAL", () => {
  it("labels the entry with the sender's own host, not the payload", async () => {
    const { send, api } = harness();
    await send(
      {
        type: "SAVE_CREDENTIAL",
        username: "me",
        password: "pw",
        url: "https://evil.test/login",
        domain: "bank.test",
      } as Message,
      pageSender("https://evil.test/login"),
    );
    const body = (api.createPage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.title).toBe("evil.test Login");
    expect(body.content).toContain(":::secret[evil.test Login]");
    expect(body.content).not.toContain("bank.test");
  });

  it("refuses to save on an excluded site", async () => {
    const { send, api } = harness({ config: { excludedDomains: ["evil.test"] } });
    const res = await send(
      {
        type: "SAVE_CREDENTIAL",
        username: "me",
        password: "pw",
        url: "",
        domain: "",
      } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res).toMatchObject({ success: false });
    expect(api.createPage).not.toHaveBeenCalled();
  });

  it("strips fence markers and newlines out of the values", async () => {
    const { send, api } = harness();
    await send(
      {
        type: "SAVE_CREDENTIAL",
        username: "me\n:::secret[Injected]",
        password: "pw",
        url: "",
        domain: "",
      } as Message,
      pageSender("https://evil.test/"),
    );
    const body = (api.createPage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.content).not.toContain(":::secret[Injected]");
    expect(body.content.match(/:::secret\[/g)).toHaveLength(1);
  });
});

describe("COPY_TO_CLIPBOARD", () => {
  it("writes into the sender's own tab, not whatever tab is active", async () => {
    const { send } = harness();
    await send(
      { type: "COPY_TO_CLIPBOARD", text: "secret" } as Message,
      pageSender("https://evil.test/"),
    );
    expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: "CLIPBOARD_WRITE",
      text: "secret",
    });
    expect(chromeStub.tabs.query).not.toHaveBeenCalled();
  });

  it("falls back to the active tab for the popup, which has none of its own", async () => {
    const { send } = harness();
    await send({ type: "COPY_TO_CLIPBOARD", text: "secret" } as Message, POPUP_SENDER);
    expect(chromeStub.tabs.query).toHaveBeenCalled();
    expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: "CLIPBOARD_WRITE",
      text: "secret",
    });
  });
});

/**
 * Every generated password is kept in the vault whether or not it gets used.
 * These cover the boundary: a page may file its own generations and mark them
 * used, and may not enumerate or sweep anyone's.
 */
describe("generated-password history", () => {
  it("files a generation under the sender's own host, not the payload's", async () => {
    const { send, api } = harness();
    const res = await send(
      {
        type: "RECORD_GENERATED_PASSWORD",
        password: "generated-value",
        site: "bank.test",
      } as Message,
      pageSender("https://evil.test/signup"),
    );
    expect(res).toMatchObject({
      type: "RECORD_GENERATED_PASSWORD_RESULT",
      success: true,
    });

    const [, body] = (api.patchSecretBlock as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body.fields.site).toBe("evil.test");
    expect(body.fields.password).toBe("generated-value");
    expect(body.upsert).toBe(true);
  });

  it("parks a generation the vault cannot take and says so", async () => {
    const { send, api } = harness();
    (api.patchSecretBlock as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("locked"),
    );
    const res = await send(
      { type: "RECORD_GENERATED_PASSWORD", password: "parked-value" } as Message,
      pageSender("https://evil.test/signup"),
    );
    expect(res).toMatchObject({
      type: "RECORD_GENERATED_PASSWORD_RESULT",
      success: false,
      parked: true,
    });
    const outbox = stores.session.get("claspt_generated_outbox") as Array<{
      password: string;
    }>;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.password).toBe("parked-value");
  });

  it("caps how many generations one site may file", () => {
    let t = 1_000;
    for (let i = 0; i < 30; i++)
      expect(allowGeneratedFromHost("busy.test", t++)).toBe(true);
    expect(allowGeneratedFromHost("busy.test", t)).toBe(false);
    // Another site is unaffected, and the window slides.
    expect(allowGeneratedFromHost("calm.test", t)).toBe(true);
    expect(allowGeneratedFromHost("busy.test", t + 60 * 60 * 1000 + 1)).toBe(true);
  });

  it("marks the entry so the picker will never offer it on its own site", async () => {
    const { send, api } = harness();
    await send(
      { type: "RECORD_GENERATED_PASSWORD", password: "v" } as Message,
      pageSender("https://evil.test/"),
    );
    const [, body] = (api.patchSecretBlock as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body.fields.url_match).toBe("never");
  });

  it("refuses to enumerate the history for a content script", async () => {
    const { send } = harness();
    const res = await send(
      { type: "LIST_GENERATED_PASSWORDS" } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res.type).toBe("STATUS_RESULT");
  });

  it("refuses to sweep the history for a content script", async () => {
    const { send, api } = harness();
    const res = await send(
      { type: "CLEAR_UNUSED_GENERATED", days: 0 } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res.type).toBe("STATUS_RESULT");
    expect(api.deleteSecretBlock).not.toHaveBeenCalled();
  });

  it("refuses to mark a page outside the history folder", async () => {
    const { send, api } = harness();
    const res = await send(
      {
        type: "MARK_GENERATED_USED",
        pagePath: "credentials/bank.md",
        label: "bank.test Login",
      } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res).toMatchObject({ success: false });
    expect(api.patchSecretBlock).not.toHaveBeenCalled();
  });

  it("marks a history entry as used", async () => {
    const { send, api } = harness();
    const res = await send(
      {
        type: "MARK_GENERATED_USED",
        pagePath: `${HISTORY_FOLDER}/2026-09.md`,
        label: "evil.test — 4 Sep 16:43:07",
      } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res).toMatchObject({ success: true });
    const [, body] = (api.patchSecretBlock as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body.fields.used).toBe("yes");
  });
});

describe("passkeys: the worker re-derives origin and RP from the sender", () => {
  /** A content script in the top frame of a real https page. */
  function topFrame(url: string): chrome.runtime.MessageSender {
    return { url, frameId: 0, tab: { id: 7, url } as chrome.tabs.Tab };
  }
  const GET = (rp_id: string, origin: string) => ({
    type: "PASSKEY_GET" as const,
    request: {
      origin,
      cross_origin: false,
      rp_id,
      challenge: "AAAA",
      allow_credentials: ["cred-1"],
    },
  });

  it("refuses a foreign RP ID even when the payload claims that origin", async () => {
    const { api, send } = harness();
    (api as unknown as { passkeyAuthenticate: unknown }).passkeyAuthenticate = vi.fn();
    const res = await send(
      GET("github.com", "https://github.com") as Message,
      topFrame("https://evil.example/"),
    );
    expect(res).toEqual({ type: "PASSKEY_RESULT", outcome: "fallback" });
    expect(
      (api as unknown as { passkeyAuthenticate: ReturnType<typeof vi.fn> })
        .passkeyAuthenticate,
    ).not.toHaveBeenCalled();
  });

  it("overwrites the payload origin with the sender's before calling the vault", async () => {
    const { api, send } = harness();
    const auth = vi.fn(() => Promise.resolve({ signed: true }));
    (api as unknown as { passkeyAuthenticate: unknown }).passkeyAuthenticate = auth;
    const res = await send(
      GET("example.com", "https://attacker.example") as Message,
      topFrame("https://login.example.com/"),
    );
    expect(res).toMatchObject({ type: "PASSKEY_RESULT", outcome: "done" });
    expect(auth).toHaveBeenCalledOnce();
    const [rp, request] = auth.mock.calls[0] as unknown as [
      string,
      { origin: string; cross_origin: boolean },
    ];
    expect(rp).toBe("example.com");
    expect(request.origin).toBe("https://login.example.com");
    expect(request.cross_origin).toBe(false);
  });

  it("refuses a request from an iframe, an insecure page, or no tab", async () => {
    const { api, send } = harness();
    const auth = vi.fn();
    (api as unknown as { passkeyAuthenticate: unknown }).passkeyAuthenticate = auth;
    const iframe = { ...topFrame("https://example.com/"), frameId: 3 };
    const http = topFrame("http://example.com/");
    const noTab: chrome.runtime.MessageSender = {
      url: "https://example.com/",
      frameId: 0,
    };
    for (const sender of [iframe, http, noTab]) {
      const res = await send(
        GET("example.com", "https://example.com") as Message,
        sender,
      );
      expect(res).toEqual({ type: "PASSKEY_RESULT", outcome: "fallback" });
    }
    expect(auth).not.toHaveBeenCalled();
  });

  it("applies the same gate to registration", async () => {
    const { api, send } = harness();
    const reg = vi.fn(() => Promise.resolve({ made: true }));
    (api as unknown as { passkeyRegister: unknown }).passkeyRegister = reg;
    const create = (rpId: string) => ({
      type: "PASSKEY_CREATE" as const,
      request: {
        origin: "https://attacker.example",
        cross_origin: true,
        rp: { id: rpId, name: "X" },
        user: { id: "AA", name: "me", display_name: "Me" },
        challenge: "AAAA",
        pub_key_cred_params: [-7],
      },
    });
    const bad = await send(
      create("github.com") as Message,
      topFrame("https://evil.example/"),
    );
    expect(bad).toEqual({ type: "PASSKEY_RESULT", outcome: "fallback" });
    const good = await send(
      create("example.com") as Message,
      topFrame("https://app.example.com/"),
    );
    expect(good).toMatchObject({ outcome: "done" });
    const [, request] = reg.mock.calls[0] as unknown as [string, { origin: string }];
    expect(request.origin).toBe("https://app.example.com");
  });
});

describe("identities for a site", () => {
  it("answers for the sender's own site, whatever host the payload names", async () => {
    await rememberIdentityForSite("evil.test", "identities/me.md");
    const { send } = harness();
    const res = await send(
      { type: "IDENTITY_FOR_SITE", host: "bank.test" } as Message,
      pageSender("https://evil.test/checkout"),
    );
    expect(res).toEqual({
      type: "IDENTITY_FOR_SITE_RESULT",
      pagePath: "identities/me.md",
    });
    // The popup may ask about any host.
    const popup = await send(
      { type: "IDENTITY_FOR_SITE", host: "evil.test" } as Message,
      POPUP_SENDER,
    );
    expect(popup).toEqual({
      type: "IDENTITY_FOR_SITE_RESULT",
      pagePath: "identities/me.md",
    });
  });

  it("lists nothing for a site the user excluded, without reading the vault", async () => {
    const { send, api } = harness({ config: { excludedDomains: ["evil.test"] } });
    const res = await send(
      { type: "LIST_IDENTITIES_FOR_SITE", host: "bank.test" } as Message,
      pageSender("https://evil.test/checkout"),
    );
    expect(res).toEqual({ type: "LIST_IDENTITIES_FOR_SITE_RESULT", items: [] });
    expect(api.listPages).not.toHaveBeenCalled();
  });
});

describe("session records for content scripts", () => {
  it("binds a pending save to the sender's site and hides it from other sites", async () => {
    const { send } = harness();
    await send(
      {
        type: "PENDING_SAVE_SET",
        credentials: {
          username: "me",
          password: "pw",
          url: "https://bank.test/login",
          isSignup: false,
        },
      } as Message,
      pageSender("https://evil.test/login"),
    );
    const own = await send(
      { type: "PENDING_SAVE_GET" } as Message,
      pageSender("https://evil.test/next"),
    );
    expect(own).toMatchObject({
      type: "PENDING_SAVE_RESULT",
      pending: { domain: "evil.test" },
    });
    const other = await send(
      { type: "PENDING_SAVE_GET" } as Message,
      pageSender("https://bank.test/"),
    );
    expect(other).toEqual({ type: "PENDING_SAVE_RESULT", pending: null });
  });
});

describe("frames and browsers", () => {
  it("answers a cross-origin iframe with nothing, whatever the tab is", async () => {
    // bank.com embeds a widget from evil.net; the widget's content script
    // must not receive bank.com's credentials by pointing at the tab.
    const { cache, send } = harness();
    const iframe: chrome.runtime.MessageSender = {
      url: "https://evil.net/widget",
      frameId: 3,
      tab: { id: 7, url: "https://bank.test/login" } as chrome.tabs.Tab,
    };
    const res = await send(
      { type: "GET_CREDENTIALS", domain: "bank.test" } as Message,
      iframe,
    );
    expect(res).toEqual({ type: "CREDENTIALS_RESULT", credentials: [] });
    expect(cache.getCredentialsForUrl).not.toHaveBeenCalled();
  });

  it("recognises the Firefox popup as an extension page", async () => {
    const original = (globalThis as { chrome: { runtime: { getURL?: unknown } } }).chrome
      .runtime.getURL;
    (globalThis as { chrome: { runtime: { getURL?: unknown } } }).chrome.runtime.getURL =
      () => "moz-extension://5d1b8a3e-0000-4000-8000-000000000000/";
    try {
      const { send } = harness();
      const popup: chrome.runtime.MessageSender = {
        url: "moz-extension://5d1b8a3e-0000-4000-8000-000000000000/src/popup/index.html",
      };
      const res = await send({ type: "GET_CONFIG" } as Message, popup);
      expect(res.type).not.toBe("ERROR");
      expect(res.type).toBe("CONFIG_RESULT");
    } finally {
      (
        globalThis as { chrome: { runtime: { getURL?: unknown } } }
      ).chrome.runtime.getURL = original;
    }
  });
});

describe("captured logins", () => {
  /** A vault whose pages the fake API remembers, so tags and deletes can be checked. */
  function vault() {
    const pages: Record<string, { title: string; tags: string[]; content: string }> = {};
    const h = harness();
    const api = h.api as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.createPage = vi.fn(async (body: { title: string; content: string; tags?: string[] }) => {
      const path = `credentials/${body.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`;
      pages[path] = { title: body.title, tags: body.tags ?? [], content: body.content };
      return { path, meta: { title: body.title, tags: body.tags ?? [] }, content: body.content };
    });
    api.getPage = vi.fn(async (path: string) => {
      const page = pages[path];
      if (!page) throw new Error("not found");
      return { path, content: page.content, meta: { title: page.title, tags: page.tags, created_at: "" } };
    });
    api.updateTags = vi.fn(async (path: string, tags: string[]) => {
      pages[path].tags = tags;
      return {};
    });
    api.updateTitle = vi.fn(async () => ({}));
    api.deletePage = vi.fn(async (path: string) => {
      delete pages[path];
    });
    api.listPages = vi.fn(async () =>
      Object.entries(pages).map(([path, p]) => ({
        path,
        snippet: "",
        meta: { title: p.title, tags: p.tags, created_at: "2026-09-23T10:00:00Z", folder: "credentials" },
      })),
    );
    return { ...h, pages };
  }

  it("writes a submitted login to the vault at once, filed under the sender's site", async () => {
    const { send, pages, cache } = vault();
    (cache.getCredentialsForUrl as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await send(
      {
        type: "CAPTURE_LOGIN",
        username: "me@shop.test",
        password: "pw\n:::",
        url: "https://evil.test/steal",
        isSignup: true,
      },
      pageSender("https://www.shop.test/signup"),
    );

    expect(res).toMatchObject({ type: "CAPTURE_RESULT", success: true });
    expect((res as { parked?: boolean }).parked).toBeUndefined();
    const [path, page] = Object.entries(pages)[0]!;
    expect((res as { pagePath?: string }).pagePath).toBe(path);
    expect(page.tags).toEqual(["login", "shop.test", "captured"]);
    // The fence cannot be broken out of, and a URL for another site is not believed.
    expect(page.content).not.toContain("\n:::\nusername");
    expect(page.content).toContain("url: https://www.shop.test/");
    expect(page.content).not.toContain("evil.test");
  });

  it("refuses a capture from a frame, from the popup, or on an excluded site", async () => {
    const { send } = vault();
    const framed = { ...pageSender("https://shop.test/"), frameId: 3 };
    const capture = {
      type: "CAPTURE_LOGIN" as const,
      username: "me",
      password: "pw",
      url: "https://shop.test/",
      isSignup: false,
    };
    expect(await send(capture, framed)).toMatchObject({ success: false });
    expect(await send(capture, POPUP_SENDER)).toMatchObject({ success: false });

    const excluded = harness({ config: { excludedDomains: ["shop.test"] } });
    expect(await excluded.send(capture, pageSender("https://shop.test/"))).toMatchObject({ success: false });
    expect(excluded.api.createPage).not.toHaveBeenCalled();
  });

  it("parks the capture when the vault cannot be reached, and reports so", async () => {
    const { send, api, cache } = vault();
    (cache.getCredentialsForUrl as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));

    const res = await send(
      { type: "CAPTURE_LOGIN", username: "me", password: "pw", url: "https://shop.test/", isSignup: false },
      pageSender("https://shop.test/"),
    );

    expect(res).toMatchObject({ type: "CAPTURE_RESULT", success: true, parked: true });
    expect(api.createPage).not.toHaveBeenCalled();
    const listed = await send({ type: "LIST_CAPTURED" }, POPUP_SENDER);
    expect(listed).toMatchObject({ type: "CAPTURED_RESULT", parked: 1 });
  });

  it("lets a page confirm or discard only a capture from its own site", async () => {
    const { send, pages, cache } = vault();
    (cache.getCredentialsForUrl as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = (await send(
      { type: "CAPTURE_LOGIN", username: "me", password: "pw", url: "https://shop.test/", isSignup: false },
      pageSender("https://shop.test/"),
    )) as { pagePath: string };

    const stranger = pageSender("https://evil.test/");
    expect(await send({ type: "DISCARD_CAPTURE", pagePath: res.pagePath }, stranger)).toMatchObject({
      success: false,
    });
    expect(await send({ type: "CONFIRM_CAPTURE", pagePath: res.pagePath }, stranger)).toMatchObject({
      success: false,
    });
    expect(pages[res.pagePath]).toBeDefined();

    expect(
      await send({ type: "CONFIRM_CAPTURE", pagePath: res.pagePath }, pageSender("https://shop.test/done")),
    ).toMatchObject({ success: true });
    expect(pages[res.pagePath].tags).toEqual(["login", "shop.test"]);

    // Once confirmed it is an ordinary login: no page may discard it through this door.
    expect(
      await send({ type: "DISCARD_CAPTURE", pagePath: res.pagePath }, pageSender("https://shop.test/")),
    ).toMatchObject({ success: false });
    expect(await send({ type: "DISCARD_CAPTURE", pagePath: res.pagePath }, POPUP_SENDER)).toMatchObject({
      success: false,
    });
    expect(pages[res.pagePath]).toBeDefined();
  });

  it("lists captures for the popup only, without passwords", async () => {
    const { send, cache } = vault();
    (cache.getCredentialsForUrl as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await send(
      { type: "CAPTURE_LOGIN", username: "me", password: "s3cret", url: "https://shop.test/", isSignup: false },
      pageSender("https://shop.test/"),
    );

    const fromPage = await send({ type: "LIST_CAPTURED" }, pageSender("https://shop.test/"));
    expect(fromPage).toMatchObject({ type: "CAPTURED_RESULT", items: [] });

    const listed = await send({ type: "LIST_CAPTURED" }, POPUP_SENDER);
    expect(listed).toMatchObject({ type: "CAPTURED_RESULT", parked: 0 });
    const items = (listed as { items: Array<{ username: string; domain: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ username: "me", domain: "shop.test" });
    expect(JSON.stringify(listed)).not.toContain("s3cret");
  });

  it("records the outcome per site for the popup, from the page only", async () => {
    const { send } = vault();
    await send(
      { type: "LAST_CAPTURE_SET", capture: { outcome: "captured", username: "me" } },
      pageSender("https://accounts.shop.test/"),
    );
    await send(
      { type: "LAST_CAPTURE_SET", capture: { outcome: "failed", username: "x" } },
      POPUP_SENDER,
    );

    const popupView = await send({ type: "LAST_CAPTURE_GET", domain: "www.shop.test" }, POPUP_SENDER);
    expect(popupView).toMatchObject({ capture: { outcome: "captured", username: "me" } });
    const pageView = await send({ type: "LAST_CAPTURE_GET" }, pageSender("https://shop.test/"));
    expect(pageView).toMatchObject({ capture: { outcome: "captured" } });
    const other = await send({ type: "LAST_CAPTURE_GET" }, pageSender("https://evil.test/"));
    expect(other).toMatchObject({ capture: null });
  });

  it("tells the picker why a list is empty when the app is away", async () => {
    const { send, cache, health } = vault();
    (cache.getCredentialsForUrl as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (health as unknown as { getState: () => string }).getState = () => "disconnected";

    const res = await send({ type: "GET_CREDENTIALS", domain: "" }, pageSender("https://shop.test/"));

    expect(res).toMatchObject({ type: "CREDENTIALS_RESULT", credentials: [], reason: "disconnected" });
  });
});
