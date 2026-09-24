// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Whether this vault has an active licence.
 *
 * Pro-only controls were shown to everyone and only refused once clicked — the
 * share button sat in the sidebar and the editor toolbar for a free user, who
 * discovered it did nothing for them by pressing it. Offering a control and
 * then declining is worse than not offering it: the Account & Sync tab is
 * where Pro is advertised, deliberately and once.
 *
 * Refetched when the settings panel closes, which is when a licence can have
 * been activated or deactivated — the same trigger the sidebar's plan pill
 * already uses.
 */
import { useEffect, useState } from "react";
import { getLicenseStatus } from "@/lib/commands";
import { useUIStore } from "@/stores/ui-store";

export function useHasPro(): boolean {
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const [hasPro, setHasPro] = useState(false);

  useEffect(() => {
    if (settingsOpen) return;
    let cancelled = false;
    getLicenseStatus()
      .then((status) => {
        if (!cancelled) setHasPro(status.is_pro && !status.is_expired);
      })
      .catch(() => {
        // Unknown means not offered. Failing closed here shows one fewer
        // button; failing open shows a control that cannot work.
        if (!cancelled) setHasPro(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);

  return hasPro;
}
