// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * constants.ts — shared tuning values and on-disk/wire format markers.
 *
 * Cross-platform magic numbers and string prefixes that BOTH the desktop and
 * mobile apps must agree on. Changing a format prefix here is a breaking change
 * to how vaults are read/written or how sync bundles are parsed, so treat these
 * as part of the persisted contract, not free-to-tweak UI knobs.
 */

/** How long a revealed secret stays visible before auto-hiding (ms). */
export const SECRET_AUTO_HIDE_MS = 30_000;
/** Minimum accepted master-password length. */
export const MIN_PASSWORD_LENGTH = 12;
/** Debounce before firing a search as the user types (ms). */
export const SEARCH_DEBOUNCE_MS = 300;
/** Idle delay after the last edit before autosaving a page (ms). */
export const AUTO_SAVE_DELAY_MS = 2_000;
/** Window over which rapid saves are batched into one git commit (ms). */
export const GIT_COMMIT_BATCH_MS = 5_000;
/** Default folder new pages land in. */
export const DEFAULT_FOLDER = "general";
/** Vault subdirectories that are not user content (skipped when listing pages). */
export const EXCLUDED_DIRS = [".securenotes", ".git", ".nosync"];
/** On-disk marker prefixing an encrypted secret value: `enc:v1:<base64>`. */
export const ENCRYPTED_PREFIX = "enc:v1:";

// ── Sync V2 ───────────────────────────────────────
/** Prefix identifying a V2 encrypted sync bundle payload. */
export const SYNC_BUNDLE_PREFIX = "syncbundle:v1:";
/** Magic header bytes at the start of a decoded sync bundle. */
export const SYNC_BUNDLE_MAGIC = "CSYNC1";
/** Salt-derivation prefix binding a sync group's key material to its id. */
export const SYNC_GROUP_SALT_PREFIX = "claspt-sync-group:";
