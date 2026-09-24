// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The oldest desktop app this extension can work with.
 *
 * Browser stores update an extension on their own schedule, so it can arrive
 * before its owner has updated the desktop app. A desktop from before 4.0 has
 * no pairing route and none of the endpoints identities and passkeys use; the
 * extension could only fail against it, one confusing error at a time. It says
 * what to do instead.
 */
export const MIN_DESKTOP_VERSION = "4.0.0";

/** The three numbers of a version, or null when it is not one. */
function numbers(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether a desktop reporting `version` is older than this extension supports.
 * An unknown or unreadable version is not called old: the desktop did not say,
 * and a wrong "update your app" is worse than none.
 */
export function isDesktopTooOld(version: string | undefined): boolean {
  if (!version) return false;
  const have = numbers(version);
  const need = numbers(MIN_DESKTOP_VERSION);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] < need[i];
  }
  return false;
}

/** What the popup and onboarding say when the desktop is too old. */
export function desktopTooOldMessage(version: string | undefined): string {
  const found = version ? `You have Claspt ${version}. ` : "";
  return `${found}This extension needs the Claspt desktop app version 4 or later. Download it from claspt.app, install it over the old one, then connect again.`;
}
