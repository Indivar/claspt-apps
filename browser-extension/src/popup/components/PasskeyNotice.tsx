// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Says that this site has a passkey in the vault.
 *
 * Passkeys were invisible until a site happened to ask for one, so someone who
 * had created one could not tell whether it worked, whether it was still
 * there, or whether to reach for their password instead. One line, only on
 * sites where there is something to say.
 */
import { useEffect, useState } from "react";
import type { Message } from "@/shared/types";

interface Props {
  /** Hostname of the tab the popup was opened over. */
  domain: string;
}

export function PasskeyNotice({ domain }: Props) {
  const [state, setState] = useState<{ count: number; accounts: string[] }>({
    count: 0,
    accounts: [],
  });

  useEffect(() => {
    if (!domain) return;
    let cancelled = false;
    chrome.runtime.sendMessage(
      { type: "GET_PASSKEYS", domain } as Message,
      (res: Message) => {
        if (cancelled || res?.type !== "PASSKEYS_RESULT") return;
        setState({ count: res.count, accounts: res.accounts });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [domain]);

  if (state.count === 0) return null;

  const who = state.accounts.slice(0, 2).join(", ");
  return (
    <div className="mx-2 mb-1.5 flex items-start gap-2 rounded-md border border-accent/25 bg-accent/5 px-2.5 py-1.5">
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        className="mt-[1px] shrink-0 text-accent"
      >
        <circle cx="6" cy="6" r="3.2" />
        <path
          d="M8.3 7.6 L13.5 12.8 M11.6 11 L10.4 12.2 M13.5 12.8 L12.4 13.9"
          strokeLinecap="round"
        />
      </svg>
      <p className="text-[10.5px] leading-relaxed text-text-secondary">
        {state.count === 1 ? "A passkey" : `${state.count} passkeys`} for this site
        {who ? <span className="text-text-muted"> ({who})</span> : null}. Choose Claspt
        when the site asks you to sign in, and you will not need the password.
      </p>
    </div>
  );
}
