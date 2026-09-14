// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useCallback, useEffect, useRef, useState } from "react";

interface TotpDisplayProps {
  secret: string;
}

export function TotpDisplay({ secret }: TotpDisplayProps) {
  const [code, setCode] = useState<string>("------");
  const [remaining, setRemaining] = useState<number>(30);
  const [copied, setCopied] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchCode = useCallback(() => {
    chrome.runtime.sendMessage(
      { type: "GENERATE_TOTP", secret },
      (res) => {
        if (res?.type === "TOTP_RESULT") {
          setCode(res.code);
          setRemaining(res.remaining);
        }
      },
    );
  }, [secret]);

  useEffect(() => {
    fetchCode();

    intervalRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          fetchCode();
          return 30;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchCode]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const circumference = 2 * Math.PI * 10;

  return (
    <div className="flex items-center gap-3 rounded-md bg-surface-raised px-3 py-2">
      <span className="text-lg font-mono tracking-widest text-accent">
        {code}
      </span>

      <svg width="24" height="24" viewBox="0 0 24 24">
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="var(--color-border)"
          strokeWidth="2"
        />
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - remaining / 30)}
          strokeLinecap="round"
          transform="rotate(-90 12 12)"
          className="transition-all duration-1000"
        />
      </svg>

      <button
        type="button"
        onClick={handleCopy}
        className="ml-auto text-text-muted hover:text-text-primary transition-colors"
        title="Copy code"
      >
        {copied ? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="5" y="5" width="8" height="8" rx="1.5" />
            <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
          </svg>
        )}
      </button>
    </div>
  );
}
