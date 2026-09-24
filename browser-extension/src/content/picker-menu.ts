// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The row menu's shape: which actions exist, in which groups, with which
 * icon. Kept apart from the DOM code so the shape can be tested and so an
 * action that has no working path cannot quietly stay on the menu.
 *
 * Rename, move and delete used to be here. They send messages only the popup
 * may send, so every click failed silently: a dead button on the one menu
 * a person reaches most. Management stays in the popup, where it works, and
 * a page that manages to steer a click cannot delete a credential.
 */

/** One row-menu entry. `icon` is an SVG path set in the picker's format. */
export interface RowMenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: () => void;
}

/** A visual break between groups. */
export interface RowMenuSeparator {
  separator: true;
}

export type RowMenuEntry = RowMenuItem | RowMenuSeparator;

export const MENU_ICONS = {
  pin: "M12 2 15 8l6.5 1-4.75 4.6L18 20l-6-3.2L6 20l1.25-6.4L2.5 9 9 8z",
  fill: "M15 3h6v6|M10 14 21 3|M21 3v18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6",
  submit: "M5 12h14|M12 5l7 7-7 7",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2|M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  key: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4",
  code: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20|M12 6v6l4 2",
  primary: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20|M9 12l2 2 4-4",
  deprecated: "M4 4l16 16|M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20",
  edit: "M12 20h9|M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z",
} as const;

/** The parts a row can offer; each is present only when it applies. */
export interface RowMenuActions {
  pinned: boolean;
  primary: boolean;
  deprecated: boolean;
  hasUsername: boolean;
  hasPassword: boolean;
  hasTotp: boolean;
  onTogglePin: () => void;
  onFill: () => void;
  onFillSubmit: () => void;
  onCopyUsername: () => void;
  onCopyPassword: () => void;
  onCopyTotp: () => void;
  onTogglePrimary: () => void;
  onToggleDeprecated: () => void;
  onEdit: () => void;
}

/** The menu for one row, grouped: pin | fill | copy | status | edit. */
export function buildRowMenu(a: RowMenuActions): RowMenuEntry[] {
  const groups: RowMenuItem[][] = [
    [
      {
        label: a.pinned ? "Unpin" : "Pin to top",
        icon: MENU_ICONS.pin,
        onClick: a.onTogglePin,
      },
    ],
    [
      { label: "Fill form", icon: MENU_ICONS.fill, onClick: a.onFill },
      { label: "Fill & submit", icon: MENU_ICONS.submit, onClick: a.onFillSubmit },
    ],
    [
      ...(a.hasUsername
        ? [{ label: "Copy username", icon: MENU_ICONS.user, onClick: a.onCopyUsername }]
        : []),
      ...(a.hasPassword
        ? [{ label: "Copy password", icon: MENU_ICONS.key, onClick: a.onCopyPassword }]
        : []),
      ...(a.hasTotp
        ? [{ label: "Copy 2FA code", icon: MENU_ICONS.code, onClick: a.onCopyTotp }]
        : []),
    ],
    [
      {
        label: a.primary ? "Unmark primary" : "Mark as primary",
        icon: MENU_ICONS.primary,
        onClick: a.onTogglePrimary,
      },
      {
        label: a.deprecated ? "Restore (un-deprecate)" : "Mark as deprecated",
        icon: MENU_ICONS.deprecated,
        onClick: a.onToggleDeprecated,
      },
    ],
    [{ label: "Edit credential…", icon: MENU_ICONS.edit, onClick: a.onEdit }],
  ];
  const out: RowMenuEntry[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (out.length) out.push({ separator: true });
    out.push(...group);
  }
  return out;
}

/** "used 2 h ago", or null when the credential has not been used here. */
export function lastUsedText(
  lastUsed: number | undefined,
  now = Date.now(),
): string | null {
  if (!lastUsed) return null;
  const s = Math.max(0, Math.floor((now - lastUsed) / 1000));
  if (s < 60) return "used just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `used ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `used ${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `used ${d} d ago`;
  return `used ${Math.floor(d / 30)} mo ago`;
}
