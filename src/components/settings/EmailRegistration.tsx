// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * EmailRegistration — settings widget for registering and verifying an email
 * address so the device can receive shares from other Claspt users. Renders one
 * of three states driven by the share store: verified (shows the address), code
 * entry (after a verification code is sent), or the initial email-entry form.
 */
import { useState } from "react";
import { useShareStore } from "@/stores/share-store";

/** Email registration / 6-digit code verification flow for share notifications. */
export function EmailRegistration() {
  const {
    email,
    emailVerified,
    registrationStep,
    registering,
    registrationError,
    registerEmail,
    verifyCode,
    resetRegistration,
  } = useShareStore();

  const [emailInput, setEmailInput] = useState("");
  const [codeInput, setCodeInput] = useState("");

  if (emailVerified && email) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
        <span className="text-[13px] text-text-primary">{email}</span>
        <span className="text-[11px] text-green-600 dark:text-green-400">Verified</span>
      </div>
    );
  }

  if (registrationStep === "code_sent") {
    return (
      <div className="space-y-2">
        <p className="text-[12px] text-text-muted">
          Verification code sent to{" "}
          <span className="font-medium text-text-primary">{email}</span>. Check your
          inbox.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={codeInput}
            // Keep only digits, capped at the 6-char code length
            onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="6-digit code"
            maxLength={6}
            className="focus-accent w-28 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-center font-mono text-[13px] tracking-widest text-text-primary placeholder:text-text-muted/60 outline-none"
          />
          <button
            onClick={() => verifyCode(codeInput)}
            disabled={registering || codeInput.length !== 6}
            className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-all hover:bg-accent-hover active:scale-95 disabled:opacity-50"
          >
            {registering ? "Verifying..." : "Verify"}
          </button>
        </div>
        {registrationError && (
          <p className="rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">
            {registrationError}
          </p>
        )}
        <button
          onClick={() => {
            resetRegistration();
            setCodeInput("");
          }}
          className="text-[11px] text-text-muted hover:text-text-secondary"
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-text-muted">
        Register your email to receive shares from other Claspt users.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="email"
          value={emailInput}
          onChange={(e) => setEmailInput(e.target.value)}
          placeholder="you@example.com"
          className="focus-accent flex-1 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted/60 outline-none"
        />
        <button
          onClick={() => registerEmail(emailInput)}
          disabled={registering || !emailInput.includes("@")}
          className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-all hover:bg-accent-hover active:scale-95 disabled:opacity-50"
        >
          {registering ? "Sending..." : "Register"}
        </button>
      </div>
      {registrationError && (
        <p className="rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">
          {registrationError}
        </p>
      )}
    </div>
  );
}
