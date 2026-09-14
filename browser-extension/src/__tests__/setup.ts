// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { vi, beforeEach } from "vitest";

/**
 * Minimal `chrome.*` stub.
 *
 * Only the surface the modules under test actually touch is implemented, and
 * every store is reset between tests. Anything not stubbed here will throw,
 * which is deliberate: a test that reaches for an unmodelled browser API should
 * fail loudly rather than silently pass against a permissive mock.
 */

export const stores = {
  local: new Map<string, unknown>(),
  session: new Map<string, unknown>(),
};

function area(store: Map<string, unknown>) {
  return {
    get: vi.fn((keys: string | string[] | null, cb?: (items: Record<string, unknown>) => void) => {
      const names = keys === null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of names) if (store.has(k)) out[k] = store.get(k);
      if (cb) { cb(out); return undefined; }
      return Promise.resolve(out);
    }),
    set: vi.fn((items: Record<string, unknown>, cb?: () => void) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[], cb?: () => void) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    }),
    setAccessLevel: vi.fn(() => Promise.resolve()),
  };
}

export const chromeStub = {
  runtime: {
    id: "test-extension-id",
    lastError: undefined as { message: string } | undefined,
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
  },
  storage: {
    local: area(stores.local),
    session: area(stores.session),
    onChanged: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(() => Promise.resolve([{ id: 1, url: "https://active-tab.example" }])),
    sendMessage: vi.fn(() => Promise.resolve()),
    get: vi.fn(),
  },
  permissions: {
    contains: vi.fn(() => Promise.resolve(true)),
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn(),
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = chromeStub;

beforeEach(() => {
  stores.local.clear();
  stores.session.clear();
  vi.clearAllMocks();
  chromeStub.runtime.lastError = undefined;
  chromeStub.tabs.query.mockResolvedValue([{ id: 1, url: "https://active-tab.example" }]);
  chromeStub.permissions.contains.mockResolvedValue(true);
});
