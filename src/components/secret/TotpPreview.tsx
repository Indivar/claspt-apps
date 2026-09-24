// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The live code for an authenticator key, shown while it is being entered.
 *
 * Someone pasting a key has no way to know whether they pasted the right
 * thing: the key is meaningless to read, and the consequence of getting it
 * wrong only appears later, at a login they cannot complete. Showing the code
 * next to the site's own code turns that into a check they can make in two
 * seconds, before they save.
 */
import { useEffect, useState } from "react";
import { generateTotp } from "@claspt/shared/totp";

interface Props {
  /**
   * Raw field value: an `otpauth://` URI or a bare base32 key. Never blank —
   * the caller renders nothing at all until there is something to check, and
   * passes the value as `key` so a changed key starts from a clean slate
   * rather than showing the previous key's code while the new one loads.
   */
  secret: string;
}

type State =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "code"; code: string; remaining: number; period: number };

export function TotpPreview({ secret }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const trimmed = secret.trim();
    let cancelled = false;
    const tick = () => {
      generateTotp(trimmed)
        .then(({ code, remaining, period }) => {
          if (!cancelled) setState({ kind: "code", code, remaining, period });
        })
        .catch(() => {
          // Half a pasted key decodes to something; it just never matches.
          // Saying "not a valid key" is more use than a wrong six digits.
          if (!cancelled) setState({ kind: "invalid" });
        });
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [secret]);

  if (state.kind === "loading") return null;

  if (state.kind === "invalid") {
    return (
      <p className="mt-1.5 text-[11px] leading-relaxed text-danger">
        That does not look like an authenticator key. Copy the whole line the site shows
        under &ldquo;can&rsquo;t scan the code?&rdquo;, or the
        <span className="font-mono"> otpauth:// </span> link behind its QR image.
      </p>
    );
  }

  const { code, remaining, period } = state;
  const circumference = 2 * Math.PI * 9;
  const half = Math.ceil(code.length / 2);

  return (
    <div className="mt-1.5 flex items-center gap-2.5 rounded-lg border border-border/60 bg-surface/60 px-2.5 py-1.5">
      <svg width="20" height="20" viewBox="0 0 24 24" className="shrink-0">
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-border"
        />
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - remaining / period)}
          strokeLinecap="round"
          transform="rotate(-90 12 12)"
          className="text-accent"
          style={{ transition: "stroke-dashoffset 1s linear" }}
        />
      </svg>
      <span className="font-mono text-base font-semibold tracking-[0.18em] text-accent">
        {code.slice(0, half)} {code.slice(half)}
      </span>
      <span className="ml-auto text-[10.5px] text-text-muted">
        Should match the code the site is showing you
      </span>
    </div>
  );
}
