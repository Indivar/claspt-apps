// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * When the unlock screen may start the OS biometric prompt on its own.
 *
 * The OS prompt (Touch ID, Windows Hello) is system-modal: it appears over
 * whatever the person is doing, whether or not the Claspt window is in front.
 * So the screen may only raise it by itself when the person has just asked
 * for the app, which is a cold start with the window in front. After any
 * lock the app performed on its own (the idle lock, the key lock) or that
 * the person asked for, the prompt waits for a click on the biometric
 * button. A lock every fifteen minutes must not become a prompt every
 * fifteen minutes on top of someone's other work.
 */

/** Why the unlock screen is showing; `null` means the app has just started. */
export type LockReason = "auto" | "manual" | "key" | null;

export interface AutoPromptInput {
  lockReason: LockReason;
  biometricAvailable: boolean;
  biometricMode: string;
  biometricFailures: number;
  loading: boolean;
  hasUnlockedWithPassword: boolean;
  /** `document.hasFocus()` at the moment the screen appeared. */
  windowFocused: boolean;
  /** `document.visibilityState === "visible"` at that moment. */
  pageVisible: boolean;
}

/** Whether the biometric button belongs on the screen at all in this mode. */
export function biometricUnlockOffered(
  mode: string,
  hasUnlockedWithPassword: boolean,
): boolean {
  return (
    mode === "enabled" ||
    mode === "primary" ||
    (mode === "reauth" && hasUnlockedWithPassword)
  );
}

export function shouldAutoPromptBiometric(input: AutoPromptInput): boolean {
  if (input.lockReason !== null) return false;
  if (!input.windowFocused || !input.pageVisible) return false;
  if (!input.biometricAvailable || input.loading) return false;
  if (input.biometricFailures >= 3) return false;
  return biometricUnlockOffered(input.biometricMode, input.hasUnlockedWithPassword);
}
