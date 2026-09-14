// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Platform detection + connection troubleshooting copy.
 *
 * The extension talks to the desktop app over http://127.0.0.1, which
 * triggers different prompts on each OS the first time the desktop binds
 * to its local port. This module surfaces the right hint next to each
 * "Allow local connection" / "Not connected" UI so users aren't left
 * guessing which dialog to click.
 */

export type Platform = "mac" | "windows" | "linux" | "unknown";

export type Browser = "firefox" | "chromium";

/** Firefox or a Chromium-family browser; the two differ in where the
 *  extension's site access lives and what the permission dialog looks like. */
export function detectBrowser(ua: string = navigator.userAgent): Browser {
  return /firefox|fxios/i.test(ua) ? "firefox" : "chromium";
}

/** Where the user re-enables access to 127.0.0.1 after declining it. */
export function siteAccessPath(browser: Browser = detectBrowser()): string {
  return browser === "firefox"
    ? "about:addons → Claspt → Permissions → Access your data for 127.0.0.1"
    : "chrome://extensions → Claspt → Site access → On 127.0.0.1";
}

/** Detect the user's OS using userAgentData (modern) → userAgent fallback. */
export function detectPlatform(): Platform {
  // userAgentData is the modern Chromium API — accurate, intent-stable.
  type NavigatorWithUAD = Navigator & { userAgentData?: { platform?: string } };
  const uad = (navigator as NavigatorWithUAD).userAgentData?.platform?.toLowerCase();
  if (uad) {
    if (uad.includes("mac")) return "mac";
    if (uad.includes("win")) return "windows";
    if (uad.includes("linux")) return "linux";
  }
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac os") || ua.includes("macos")) return "mac";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "unknown";
}

export interface PlatformHint {
  title: string;
  steps: string[];
}

/**
 * What dialogs the user may see on first connect, per platform. Returned
 * as small `{ title, steps[] }` records so the UI can render them in a
 * disclosure / accordion without bespoke per-platform components.
 */
export function connectionHintsFor(platform: Platform): PlatformHint[] {
  const browserHint: PlatformHint = {
    title: "Browser permission",
    steps: [
      "Chrome / Edge / Brave / Firefox will ask once for permission to talk to http://127.0.0.1 — click Allow.",
      `If you skipped it: ${siteAccessPath()}.`,
    ],
  };

  if (platform === "mac") {
    return [
      browserHint,
      {
        title: "macOS firewall (first launch only)",
        steps: [
          'If the firewall is on, macOS asks: "Do you want the application Claspt to accept incoming network connections?" — click Allow.',
          'If you clicked Deny: System Settings → Network → Firewall → Options → set Claspt to "Allow incoming connections".',
        ],
      },
      {
        title: "If still blocked",
        steps: [
          "Make sure the desktop app is open and the vault is unlocked.",
          "Settings → Integrations → Local API in the desktop app must be enabled.",
        ],
      },
    ];
  }

  if (platform === "windows") {
    return [
      browserHint,
      {
        title: "Windows Defender Firewall (first launch only)",
        steps: [
          'Windows asks: "Allow Claspt to communicate on these networks" — tick at least Private networks, click Allow access.',
          "If you clicked Cancel: Windows Security → Firewall & network protection → Allow an app through firewall → find Claspt → tick Private.",
        ],
      },
      {
        title: "If still blocked",
        steps: [
          "Corporate antivirus (CrowdStrike, SentinelOne, etc.) sometimes flags new local listeners. Ask IT to whitelist the signed Claspt binary.",
          "Check the desktop app log for an EADDRINUSE error — port 9315 may be in use. Change it in Settings → Integrations → Local API.",
        ],
      },
    ];
  }

  if (platform === "linux") {
    return [
      browserHint,
      {
        title: "Linux firewall",
        steps: [
          "Most distros allow loopback by default — no prompt.",
          "If you run ufw or firewalld with strict rules, allow loopback: sudo ufw allow from 127.0.0.1",
        ],
      },
      {
        title: "If still blocked",
        steps: [
          "Make sure the desktop app is running and the vault is unlocked.",
          "Settings → Integrations → Local API in the desktop app must be enabled.",
        ],
      },
    ];
  }

  // Unknown platform — generic guidance only.
  return [
    browserHint,
    {
      title: "If still blocked",
      steps: [
        "Make sure the Claspt desktop app is running and the vault is unlocked.",
        "Your OS firewall may need to allow the app to accept loopback connections.",
        "Settings → Integrations → Local API in the desktop app must be enabled.",
      ],
    },
  ];
}
