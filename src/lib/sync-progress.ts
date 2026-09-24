// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Wording for the steps of a fresh-copy push, shared by the vault-and-account
 * fix and by Force Push in Settings. Plain functions so they can be tested.
 */

/** The steps of the fix, in the order the backend reports them. */
export const FIX_STAGES = [
  "checking-password",
  "asking-account",
  "recording-id",
  "moving-keys",
  "reconnecting",
  "clearing",
  "packing",
  "uploading",
  "recording",
] as const;

/** The steps of sending the fresh copy alone, as Force Push runs them. */
export const FRESH_COPY_STAGES = [
  "clearing",
  "packing",
  "uploading",
  "recording",
] as const;

export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** The line shown for a step; the size joins it once the backend knows it. */
export function stageLabel(stage: string, bytes: number | null): string {
  const size = bytes != null ? ` (${megabytes(bytes)})` : "";
  switch (stage) {
    case "checking-password":
      return "Checking your password";
    case "asking-account":
      return "Asking the account which vault it holds";
    case "recording-id":
      return "Recording the account's vault id";
    case "moving-keys":
      return "Moving the biometric keys";
    case "reconnecting":
      return "Reconnecting sync";
    case "clearing":
      return "Clearing the account's old copy";
    case "packing":
      return "Packing this vault";
    case "uploading":
      return `Uploading the fresh copy${size}`;
    case "recording":
      return `Recording the new version${size}`;
    default:
      return stage;
  }
}

/** Whole seconds since `startedAt`, never negative. */
export function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}
