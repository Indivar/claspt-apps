// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Stand-in for the account-restore wizard in a build without the sync
 * server. Says so, and offers the way back.
 */
interface Props {
  vaultDir: string;
  onBack: () => void;
}

export function RestoreFromAccount({ onBack }: Props) {
  return (
    <div className="space-y-3 text-center">
      <p className="text-[13px] text-text-secondary">
        Restoring a vault from an account needs the sync service, which is not part of
        this build. Open an existing vault folder instead, or create a new one.
      </p>
      <button onClick={onBack} className="text-[12px] text-accent hover:underline">
        Back
      </button>
    </div>
  );
}
