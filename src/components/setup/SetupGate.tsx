// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Decides whether the first-run walkthrough should be on screen.
 *
 * Kept separate from the wizard so the wizard itself stays a plain component
 * with no opinion about when it runs, and so this one small decision — which is
 * the part that gets edge cases — lives in one readable place.
 */
import { useState } from "react";
import { useVaultStore } from "@/stores/vault-store";
import { SetupWizard, SETUP_VERSION } from "@/components/setup/SetupWizard";

export function SetupGate() {
  const config = useVaultStore((s) => s.config);
  const isUnlocked = useVaultStore((s) => s.isUnlocked);
  /** Set the moment the wizard finishes, so it disappears without waiting for
   *  the config write to land. */
  const [dismissed, setDismissed] = useState(false);

  if (!isUnlocked || !config || dismissed) return null;

  // `null` means this vault has never seen the walkthrough. A lower number means
  // it saw an older one; both get the current version.
  const seen = config.setup_version_seen;
  if (seen != null && seen >= SETUP_VERSION) return null;

  return <SetupWizard onFinish={() => setDismissed(true)} />;
}
