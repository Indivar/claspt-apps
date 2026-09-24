// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The plan name to show, from whatever the desktop reports.
 *
 * There is one paid tier and no trial. Older desktops, and licences issued
 * while a second tier existed, still report `pro_plus` or `Trial`; both are
 * normalised here rather than in each of the two places that render a pill,
 * which had drifted into showing "Pro+" long after it stopped existing.
 */
export function planLabel(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const lower = plan.toLowerCase();
  if (lower === "pro" || lower === "pro_plus" || lower === "pro+") return "Pro";
  if (lower === "free" || lower === "trial") return "Free";
  return plan;
}

/** Whether the plan is a paid one, for styling the pill. */
export function isPaidPlan(plan: string | null | undefined): boolean {
  return planLabel(plan) === "Pro";
}
