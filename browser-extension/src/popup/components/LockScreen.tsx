// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React from "react";
import { LockIcon } from "./icons";

export function LockScreen() {
  return (
    <div className="flex min-h-[300px] flex-col items-center justify-center px-6">
      <div className="animate-pulse">
        <LockIcon size={48} className="text-accent" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-text-primary">
        Vault Locked
      </h2>
      <p className="mt-2 text-sm text-text-muted">
        Open Claspt to unlock your vault
      </p>
    </div>
  );
}
