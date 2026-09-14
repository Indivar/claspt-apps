// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * StrengthMeter — visual readout of a password/secret strength score.
 *
 * Renders a five-segment bar plus a text label, entropy (in bits), and an
 * estimated crack time. The strength analysis itself is computed by the Rust
 * backend (zxcvbn-style); this component only displays the {@link StrengthResult}.
 */
import type { StrengthResult } from "@/lib/commands";

// Bar/label colors indexed by score 0–4 (Very Weak → Very Strong).
const COLORS = [
  "bg-red-500", // 0 = Very Weak
  "bg-orange-500", // 1 = Weak
  "bg-yellow-500", // 2 = Fair
  "bg-green-500", // 3 = Strong
  "bg-emerald-500", // 4 = Very Strong
];

const TEXT_COLORS = [
  "text-red-500",
  "text-orange-500",
  "text-yellow-500",
  "text-green-500",
  "text-emerald-500",
];

/** Five-segment strength bar with label, entropy bits, and crack-time estimate. */
export function StrengthMeter({ result }: { result: StrengthResult | null }) {
  if (!result) return null;

  const { score, label, entropy_bits, crack_time_display } = result;
  const segments = 5;

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1">
        {Array.from({ length: segments }, (_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i <= score ? (COLORS[score] ?? "bg-gray-400") : "bg-border/40"
            }`}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className={`font-medium ${TEXT_COLORS[score] ?? "text-text-muted"}`}>
          {label}
        </span>
        <span className="text-text-muted">
          {Math.round(entropy_bits)} bits &middot; {crack_time_display}
        </span>
      </div>
    </div>
  );
}
