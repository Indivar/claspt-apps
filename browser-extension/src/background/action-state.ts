// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The toolbar icon is the extension's only always-visible surface. Its badge,
 * its hover text and its tint together say what the extension can do right
 * now, so nobody has to open the popup to learn that the desktop app is not
 * running or that the vault is locked.
 */

export type ActionState =
  | "connected"
  | "vault_locked"
  | "disconnected"
  | "extension_locked"
  | "permission_needed"
  | "desktop_too_old"
  | "unauthorized";

export interface ActionSummary {
  state: ActionState;
  /** Logins the vault holds for the active tab's site. */
  matches: number;
  /** Captured logins waiting for a decision, in the vault and in the outbox. */
  waiting: number;
}

const BADGE_MATCHES = "#d4930a";
const BADGE_WAITING = "#2563eb";
const BADGE_WARN = "#eab308";
const BADGE_ERROR = "#ef4444";
const BADGE_INFO = "#3b82f6";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The hover text: one line on the connection, one on what is waiting. */
export function actionTitle(summary: ActionSummary): string {
  const lines: string[] = [];
  switch (summary.state) {
    case "connected":
      lines.push(
        summary.matches > 0
          ? `Claspt: ${plural(summary.matches, "login", "logins")} for this site`
          : "Claspt: connected",
      );
      break;
    case "vault_locked":
      lines.push("Claspt: the vault is locked. Unlock it in the Claspt app.");
      break;
    case "extension_locked":
      lines.push("Claspt: locked after inactivity. Click to unlock.");
      break;
    case "permission_needed":
      lines.push("Claspt: needs permission to reach the app. Click to allow.");
      break;
    case "desktop_too_old":
      lines.push("Claspt: the app is older than this extension. Update the app.");
      break;
    case "unauthorized":
      lines.push(
        "Claspt: the app does not know this extension's key. Pair again from Settings \u203a Integrations.",
      );
      break;
    default:
      lines.push("Claspt: the app is not running. Open Claspt to reconnect.");
  }
  if (summary.waiting > 0) {
    lines.push(`${plural(summary.waiting, "login", "logins")} waiting to be saved`);
  }
  return lines.join("\n");
}

/** What the badge shows: a count when there is one, a mark when there is a problem. */
export function actionBadge(summary: ActionSummary): { text: string; color: string } {
  switch (summary.state) {
    case "connected":
      if (summary.matches > 0)
        return { text: String(summary.matches), color: BADGE_MATCHES };
      if (summary.waiting > 0)
        return { text: String(summary.waiting), color: BADGE_WAITING };
      return { text: "", color: BADGE_MATCHES };
    case "vault_locked":
    case "extension_locked":
    case "unauthorized":
      return { text: "!", color: BADGE_WARN };
    case "permission_needed":
      return { text: "?", color: BADGE_INFO };
    case "desktop_too_old":
      return { text: "↑", color: BADGE_WARN };
    default:
      return { text: "X", color: BADGE_ERROR };
  }
}

/** How the icon itself is drawn: full colour only when it can fill. */
export function iconTreatment(state: ActionState): "normal" | "dimmed" {
  return state === "connected" ? "normal" : "dimmed";
}

const ICON_SIZES = [16, 32] as const;
const iconCache = new Map<string, chrome.action.TabIconDetails["imageData"]>();

/**
 * A dimmed copy of the packaged icon, drawn once per size and kept. The
 * dimming is a grey wash at reduced alpha: the shape stays recognisable and
 * the loss of colour reads as "off" without any extra glyph.
 */
async function iconImageData(
  treatment: "normal" | "dimmed",
): Promise<Record<number, ImageData> | null> {
  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) {
    return null;
  }
  const cached = iconCache.get(treatment);
  if (cached) return cached as Record<number, ImageData>;
  const out: Record<number, ImageData> = {};
  for (const size of ICON_SIZES) {
    const response = await fetch(chrome.runtime.getURL(`assets/icon-${size}.png`));
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    if (treatment === "dimmed") {
      ctx.filter = "grayscale(1)";
      ctx.globalAlpha = 0.55;
    }
    ctx.drawImage(bitmap, 0, 0, size, size);
    out[size] = ctx.getImageData(0, 0, size, size);
  }
  iconCache.set(treatment, out);
  return out;
}

/**
 * Apply badge, title and icon for the whole extension, or for one tab when
 * `tabId` is given (the badge count is per tab; the tint and the connection
 * line are the same everywhere).
 */
export async function applyActionState(
  summary: ActionSummary,
  tabId?: number,
): Promise<void> {
  const badge = actionBadge(summary);
  const title = actionTitle(summary);
  const scope = tabId === undefined ? {} : { tabId };
  try {
    await Promise.all([
      chrome.action.setBadgeText({ ...scope, text: badge.text }),
      chrome.action.setBadgeBackgroundColor({ ...scope, color: badge.color }),
      chrome.action.setTitle({ ...scope, title }),
    ]);
  } catch {
    // The action API is unavailable while the browser is shutting down.
  }
  if (tabId !== undefined) return;
  try {
    const imageData = await iconImageData(iconTreatment(summary.state));
    if (imageData) await chrome.action.setIcon({ imageData });
  } catch {
    // No canvas here; the badge and the title carry the state on their own.
  }
}
