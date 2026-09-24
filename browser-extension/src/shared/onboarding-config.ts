// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { DEFAULT_CONFIG, type ExtensionConfig } from "./types";

/**
 * The config the onboarding writes, built on what is already stored.
 *
 * Pairing puts the token into the stored config from the worker; the popup
 * never sees it. The finish step used to write a fresh config from its own
 * fields, whose token box was empty after a pairing, and so erased the token
 * it had just collected: "connected" on the last step, "not connected" the
 * moment the wizard closed. A typed token still wins, because typing one is
 * the deliberate way to replace whatever is stored.
 */
export function onboardingConfig(
  stored: Partial<ExtensionConfig> | undefined,
  port: number,
  typedToken: string,
  complete: boolean,
): ExtensionConfig {
  const base: ExtensionConfig = { ...DEFAULT_CONFIG, ...stored };
  const token = typedToken.trim() || base.token;
  return {
    ...base,
    port,
    token,
    onboardingComplete: complete || base.onboardingComplete,
  };
}
