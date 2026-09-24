// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi } from "vitest";
import {
  executeLoginJob,
  LoginJobRunner,
  type LoginJobDeps,
} from "@/background/login-jobs";
import type { ApiClient } from "@/background/api-client";
import type { LoginJob } from "@/shared/types";

function job(overrides: Partial<LoginJob> = {}): LoginJob {
  return {
    id: "j1",
    submit: true,
    requestedBy: "Claude Code",
    credential: {
      pagePath: "ai/github.md",
      pageTitle: "GitHub",
      label: "Login",
      fields: { username: "u", password: "p" },
      url: "https://github.com/login",
    },
    ...overrides,
  };
}

function deps(overrides: Partial<LoginJobDeps> = {}): LoginJobDeps {
  return {
    openTab: vi.fn(async () => 7),
    activeTab: vi.fn(async () => ({ id: 3, url: "https://active.example/login" })),
    // Tab 7 is the one openTab made for github; tab 3 is the active one.
    tabUrl: vi.fn(async (tabId: number) =>
      tabId === 7 ? "https://github.com/login" : "https://active.example/login",
    ),
    fill: vi.fn(async () => true),
    isExcluded: vi.fn(() => false),
    ...overrides,
  };
}

describe("executeLoginJob", () => {
  it("opens the job's url, fills and submits, and reports success", async () => {
    const d = deps();
    const out = await executeLoginJob(job({ url: "https://github.com/session" }), d);
    expect(d.openTab).toHaveBeenCalledWith("https://github.com/session");
    expect(d.fill).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ label: "Login" }),
      true,
    );
    expect(out).toEqual({ ok: true, message: "filled and submitted" });
  });

  it("falls back to the credential's own url, then to the active tab without submitting", async () => {
    const d = deps();
    await executeLoginJob(job(), d);
    expect(d.openTab).toHaveBeenCalledWith("https://github.com/login");
    const d2 = deps();
    const bare = job();
    delete bare.credential.url;
    const out = await executeLoginJob({ ...bare, submit: false }, d2);
    expect(d2.openTab).not.toHaveBeenCalled();
    expect(d2.fill).toHaveBeenCalledWith(3, expect.anything(), false);
    expect(out.message).toBe("filled, not submitted");
    const d3 = deps({ activeTab: vi.fn(async () => null) });
    const none = await executeLoginJob({ ...bare, submit: false }, d3);
    expect(none.ok).toBe(false);
  });

  it("refuses to submit when no page is known for the credential", async () => {
    const d = deps();
    const bare = job();
    delete bare.credential.url;
    const out = await executeLoginJob(bare, d);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("no url");
    expect(d.activeTab).not.toHaveBeenCalled();
    expect(d.fill).not.toHaveBeenCalled();
  });

  it("refuses when the tab is no longer on the job's site by the time of the fill", async () => {
    const moved = deps({ tabUrl: vi.fn(async () => "https://phish.example/login") });
    const out = await executeLoginJob(job(), moved);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("github.com");
    expect(moved.fill).not.toHaveBeenCalled();

    const gone = deps({ tabUrl: vi.fn(async () => null) });
    expect((await executeLoginJob(job(), gone)).ok).toBe(false);
    expect(gone.fill).not.toHaveBeenCalled();

    // A redirect within the same site is the normal case and is allowed.
    const same = deps({ tabUrl: vi.fn(async () => "https://accounts.github.com/session") });
    expect((await executeLoginJob(job(), same)).ok).toBe(true);
    expect(same.fill).toHaveBeenCalled();
  });

  it("refuses excluded hosts and bad urls without touching the browser", async () => {
    const d = deps({ isExcluded: vi.fn(() => true) });
    const out = await executeLoginJob(job(), d);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("github.com");
    expect(d.openTab).not.toHaveBeenCalled();
    expect(d.fill).not.toHaveBeenCalled();
    const bad = await executeLoginJob(job({ url: "not a url" }), deps());
    expect(bad.ok).toBe(false);
  });

  it("turns a refused fill or a thrown error into a reported failure", async () => {
    const refused = await executeLoginJob(
      job(),
      deps({ fill: vi.fn(async () => false) }),
    );
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("domain");
    const thrown = await executeLoginJob(
      job(),
      deps({
        openTab: vi.fn(async () => {
          throw new Error("tab closed");
        }),
      }),
    );
    expect(thrown).toEqual({ ok: false, message: "tab closed" });
  });
});

describe("LoginJobRunner", () => {
  it("polls while ready, runs each job once, reports it, and stops when not ready", async () => {
    let ready = true;
    const polls: Array<LoginJob | null> = [job(), null];
    const api = {
      // The second (empty) poll is where a real desktop would have held the
      // request open; here it ends the loop by turning ready off.
      pollLoginJob: vi.fn(async () => {
        const next = polls.shift() ?? null;
        if (next === null) ready = false;
        return next;
      }),
      reportLoginJob: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const d = deps();
    const runner = new LoginJobRunner(
      () => api,
      () => ready,
      d,
      async () => undefined,
    );
    runner.ensure();
    runner.ensure();
    expect(runner.isRunning()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.reportLoginJob).toHaveBeenCalledWith("j1", true, "filled and submitted");
    expect(api.reportLoginJob).toHaveBeenCalledTimes(1);
    expect(runner.isRunning()).toBe(false);
  });

  it("backs off instead of spinning when the desktop is unreachable", async () => {
    const api = {
      pollLoginJob: vi.fn(async () => {
        throw new Error("offline");
      }),
      reportLoginJob: vi.fn(),
    } as unknown as ApiClient;
    const sleeps: number[] = [];
    let ready = true;
    const runner = new LoginJobRunner(
      () => api,
      () => ready,
      deps(),
      async (ms) => {
        sleeps.push(ms);
        ready = false;
      },
    );
    runner.ensure();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(sleeps).toEqual([3000]);
    expect(api.reportLoginJob).not.toHaveBeenCalled();
  });
});
