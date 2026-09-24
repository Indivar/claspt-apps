// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { LicenseStatus } from "@claspt/shared/types";

/**
 * The plan name to show the user.
 *
 * Free is the resting state, not a failure: a vault with no licence keeps
 * every local feature and is missing only sharing and hosted sync. It used to
 * read "Trial" here because a first launch silently started a 14-day Pro
 * trial; there is no trial now, so anything without an activated licence is
 * Free.
 *
 * Lives in one place because the same label appears in the sidebar footer, the
 * vault switcher and the settings panel, and three copies of the same ternary
 * drifted apart once already.
 */
export function licenseTierLabel(status: LicenseStatus): string {
  if (!status.is_pro || status.is_expired) return "Free";

  // There is one paid tier. A licence issued while a second tier existed still
  // reports `pro_plus`, and it buys the same thing now, so it reads as Pro
  // rather than as a tier the app can no longer explain.
  return "Pro";
}
