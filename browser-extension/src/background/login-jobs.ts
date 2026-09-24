// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * "Log me in" jobs. The desktop queues a job after the owner approved an
 * agent's request; this module long-polls for it, opens the login page (or
 * uses the active tab), asks the content script to fill and submit, and
 * reports the outcome. The same content-script checks apply as for a manual
 * fill: HTTPS only, and the credential's domain must match the page's.
 *
 * The browser work is behind `LoginJobDeps` so the decision logic can be
 * tested without a browser.
 */
import type { ApiClient } from "./api-client";
import type { Credential, LoginJob } from "@/shared/types";
import { getRegistrableDomain } from "@/shared/url-matching";

export interface LoginJobDeps {
  /** Open `url` in a new active tab and resolve with its id once loaded. */
  openTab(url: string): Promise<number>;
  /** The active tab, if any. */
  activeTab(): Promise<{ id: number; url: string } | null>;
  /** The URL the tab shows right now, or null when it is gone. */
  tabUrl(tabId: number): Promise<string | null>;
  /** Ask the content script in `tabId` to fill; true when it did. */
  fill(tabId: number, credential: Credential, submit: boolean): Promise<boolean>;
  /** Whether the user excluded this host from filling in the options. */
  isExcluded(hostname: string): boolean;
}

export interface LoginJobOutcome {
  ok: boolean;
  message: string;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Same registrable domain: `accounts.example.com` is `example.com`'s. */
function sameSite(a: string, b: string): boolean {
  return getRegistrableDomain(a) === getRegistrableDomain(b);
}

/**
 * Carry one job out. Never throws; every failure becomes a reported message.
 *
 * A job names a page (its own `url`, or the credential's) or it does not. With
 * a page, the fill goes only where that page's site is still showing when the
 * tab has finished loading; a redirect to another site between the load and
 * the fill is refused. Without one, the fill goes to the active tab, and only
 * without submitting: typing a password into whatever page happens to be in
 * front and pressing enter is not a decision the desktop can have approved,
 * because it did not know the page either.
 */
export async function executeLoginJob(
  job: LoginJob,
  deps: LoginJobDeps,
): Promise<LoginJobOutcome> {
  const target = job.url ?? job.credential.url;
  let tabId: number;
  let hostname: string | null;
  try {
    if (target) {
      hostname = hostnameOf(target);
      if (!hostname) return { ok: false, message: `not a valid URL: ${target}` };
      if (deps.isExcluded(hostname)) {
        return {
          ok: false,
          message: `${hostname} is excluded from filling in the extension settings`,
        };
      }
      tabId = await deps.openTab(target);
    } else {
      if (job.submit) {
        return {
          ok: false,
          message:
            "the credential has no url, so there is no page to submit on; add a url to it or ask for a fill without submit",
        };
      }
      const active = await deps.activeTab();
      if (!active) return { ok: false, message: "no login page given and no active tab" };
      hostname = hostnameOf(active.url);
      if (hostname && deps.isExcluded(hostname)) {
        return {
          ok: false,
          message: `${hostname} is excluded from filling in the extension settings`,
        };
      }
      tabId = active.id;
    }
    // The page may have moved between loading and now: a login page that
    // bounces to another site, or a tab the user navigated. The fill goes
    // only to the site the job was for.
    const current = await deps.tabUrl(tabId);
    const currentHost = current ? hostnameOf(current) : null;
    if (!currentHost || !hostname || !sameSite(currentHost, hostname)) {
      return {
        ok: false,
        message: `the page is no longer on ${hostname ?? "the expected site"}; nothing was filled`,
      };
    }
    const filled = await deps.fill(tabId, job.credential, job.submit);
    if (!filled) {
      return {
        ok: false,
        message:
          "the page had no login form the extension could fill, or its domain did not match the credential",
      };
    }
    return {
      ok: true,
      message: job.submit ? "filled and submitted" : "filled, not submitted",
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Keeps one long poll open while the extension is connected. `ensure()` is
 * safe to call on every health tick: it starts the loop only when none is
 * running, which is also how the loop comes back after the service worker
 * was suspended.
 */
export class LoginJobRunner {
  private running = false;

  constructor(
    private readonly api: () => ApiClient,
    private readonly ready: () => boolean,
    private readonly deps: LoginJobDeps,
    private readonly sleepMs: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  ensure(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running && this.ready()) {
      try {
        const job = await this.api().pollLoginJob(25);
        if (job && this.running) {
          const outcome = await executeLoginJob(job, this.deps);
          await this.api().reportLoginJob(job.id, outcome.ok, outcome.message);
        }
      } catch {
        // The desktop is away or the vault locked; the health tick decides
        // when to try again, so back off rather than spin.
        await this.sleepMs(3000);
      }
    }
    this.running = false;
  }
}
