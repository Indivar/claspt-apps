// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * What the band on an encrypted page says.
 *
 * A page is fully encrypted either because the owner chose it, or because the
 * desktop found a recognisable credential outside a secret block and sealed
 * the page until that is converted (`auto_encrypted`). The two states read
 * differently and only the second carries an action.
 */

export interface BandState {
  kind: "chosen" | "automatic";
  text: string;
  /** The button's label, when the state has one. */
  action: string | null;
}

export function bandFor(
  meta: { encrypted: boolean; auto_encrypted?: boolean },
  findings: number,
): BandState | null {
  if (!meta.encrypted) return null;
  if (!meta.auto_encrypted) {
    return {
      kind: "chosen",
      text: "Fully encrypted page. Notes and secrets alike are ciphertext on disk. Not in content search.",
      action: null,
    };
  }
  const lines =
    findings === 1
      ? "1 line that looks like a credential"
      : `${findings} lines that look like credentials`;
  return {
    kind: "automatic",
    text: `Stored encrypted while it holds ${lines}.`,
    action: "Convert them to a secret",
  };
}
