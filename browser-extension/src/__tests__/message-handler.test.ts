// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMessageHandler } from "@/background/message-handler";
import { DEFAULT_CONFIG, type Credential, type ExtensionConfig, type Message } from "@/shared/types";
import { chromeStub } from "./setup";
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
  return { url, tab: { id: 7, url } as chrome.tabs.Tab };
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
  const handler = createMessageHandler(() => api, () => cache, () => health, () => config, vi.fn());

  const send = (message: Message, sender: chrome.runtime.MessageSender): Promise<Message> =>
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
    const res = await send({ type: "GET_CREDENTIALS", domain: "" } as Message, pageSender("https://evil.test/"));
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
      { type: "SAVE_CREDENTIAL", username: "me", password: "pw", url: "", domain: "" } as Message,
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
    await send({ type: "COPY_TO_CLIPBOARD", text: "secret" } as Message, pageSender("https://evil.test/"));
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
      { type: "RECORD_GENERATED_PASSWORD", password: "generated-value", site: "bank.test" } as Message,
      pageSender("https://evil.test/signup"),
    );
    expect(res).toMatchObject({ type: "RECORD_GENERATED_PASSWORD_RESULT", success: true });

    const [, body] = (api.patchSecretBlock as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body.fields.site).toBe("evil.test");
    expect(body.fields.password).toBe("generated-value");
    expect(body.upsert).toBe(true);
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
    const res = await send({ type: "LIST_GENERATED_PASSWORDS" } as Message, pageSender("https://evil.test/"));
    expect(res.type).toBe("STATUS_RESULT");
  });

  it("refuses to sweep the history for a content script", async () => {
    const { send, api } = harness();
    const res = await send({ type: "CLEAR_UNUSED_GENERATED", days: 0 } as Message, pageSender("https://evil.test/"));
    expect(res.type).toBe("STATUS_RESULT");
    expect(api.deleteSecretBlock).not.toHaveBeenCalled();
  });

  it("refuses to mark a page outside the history folder", async () => {
    const { send, api } = harness();
    const res = await send(
      { type: "MARK_GENERATED_USED", pagePath: "credentials/bank.md", label: "bank.test Login" } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res).toMatchObject({ success: false });
    expect(api.patchSecretBlock).not.toHaveBeenCalled();
  });

  it("marks a history entry as used", async () => {
    const { send, api } = harness();
    const res = await send(
      { type: "MARK_GENERATED_USED", pagePath: `${HISTORY_FOLDER}/2026-09.md`, label: "evil.test — 4 Sep 16:43:07" } as Message,
      pageSender("https://evil.test/"),
    );
    expect(res).toMatchObject({ success: true });
    const [, body] = (api.patchSecretBlock as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body.fields.used).toBe("yes");
  });
});
