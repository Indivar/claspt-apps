// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Setting up two-factor on a credential, from the page that is offering it.
 *
 * The alternative is what people did before: find the site's "can't scan the
 * code?" link, copy a long string, switch to Claspt, work out which field it
 * goes in, paste. Most of them stopped at step one and used their phone
 * instead, which is the outcome this is meant to prevent.
 */
import { useCallback, useState } from "react";
import type { Credential, Message } from "@/shared/types";
import { buildFieldPatch } from "@/shared/patch-field";
import { CANONICAL_TOTP_FIELD } from "@claspt/shared/credential-fields";

interface Props {
  credential: Credential;
  /** Called with the saved key, so the row can show its code immediately. */
  onSaved: (seed: string) => void;
}

type Stage =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "failed"; message: string }
  | { kind: "found"; uri: string; issuer: string; account: string }
  | { kind: "saving" };

/** What went wrong, said in terms of what the person should do next. */
function explain(reason: string | undefined): string {
  switch (reason) {
    case "no-qr":
      return "No QR code on screen. Scroll so the whole code is visible, then try again.";
    case "not-totp":
      return "That QR code is not a two-factor key. Make sure you are looking at the site's two-factor setup page.";
    default:
      return "Could not read the page. Open the site in a normal tab and try again.";
  }
}

export function AddTwoFactor({ credential, onSaved }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [manual, setManual] = useState<string | null>(null);

  const scan = useCallback(() => {
    setStage({ kind: "scanning" });
    chrome.runtime.sendMessage({ type: "SCAN_QR" } as Message, (res: Message) => {
      if (res?.type !== "QR_SCAN_RESULT") {
        setStage({ kind: "failed", message: explain(undefined) });
        return;
      }
      if (!res.found) {
        setStage({ kind: "failed", message: explain(res.reason) });
        return;
      }
      setStage({
        kind: "found",
        uri: res.uri ?? "",
        issuer: res.issuer ?? "",
        account: res.account ?? "",
      });
    });
  }, []);

  const save = useCallback(
    (value: string) => {
      setStage({ kind: "saving" });
      chrome.runtime.sendMessage(
        buildFieldPatch(
          credential.pagePath,
          credential.label,
          CANONICAL_TOTP_FIELD,
          value.trim(),
        ) as Message,
        (res: Message) => {
          if (res?.type === "PATCH_SECRET_BLOCK_RESULT" && res.success) {
            setStage({ kind: "idle" });
            setManual(null);
            onSaved(value.trim());
          } else {
            setStage({
              kind: "failed",
              message: "Claspt would not save the key. Is the vault still unlocked?",
            });
          }
        },
      );
    },
    [credential.pagePath, credential.label, onSaved],
  );

  if (manual !== null) {
    return (
      <div className="mt-1 space-y-1.5 rounded-md border border-border bg-surface-raised/50 px-2.5 py-2">
        <p className="text-[10.5px] leading-relaxed text-text-muted">
          On the site, choose &ldquo;can&rsquo;t scan the code?&rdquo; beside the QR image
          and paste what it shows.
        </p>
        <input
          autoFocus
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="otpauth://… or the key from the site"
          className="w-full rounded border border-border bg-surface px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent"
        />
        <div className="flex gap-1.5">
          <button
            onClick={() => setManual(null)}
            className="flex-1 rounded border border-border py-1 text-[10.5px] text-text-muted hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={() => save(manual)}
            disabled={!manual.trim() || stage.kind === "saving"}
            className="flex-1 rounded bg-accent py-1 text-[10.5px] font-medium text-white disabled:opacity-50"
          >
            {stage.kind === "saving" ? "Saving…" : "Save key"}
          </button>
        </div>
      </div>
    );
  }

  if (stage.kind === "found") {
    return (
      <div className="mt-1 space-y-1.5 rounded-md border border-accent/30 bg-accent/5 px-2.5 py-2">
        <p className="text-[11px] text-text-primary">
          Found a two-factor key
          {stage.issuer ? (
            <>
              {" "}
              for <span className="font-medium">{stage.issuer}</span>
            </>
          ) : null}
          {stage.account ? (
            <span className="text-text-muted"> ({stage.account})</span>
          ) : null}
        </p>
        <p className="text-[10.5px] leading-relaxed text-text-muted">
          Save it to <span className="text-text-secondary">{credential.label}</span>? The
          site will ask you to confirm a code afterwards.
        </p>
        <div className="flex gap-1.5">
          <button
            onClick={() => setStage({ kind: "idle" })}
            className="flex-1 rounded border border-border py-1 text-[10.5px] text-text-muted hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={() => save(stage.uri)}
            className="flex-1 rounded bg-accent py-1 text-[10.5px] font-medium text-white"
          >
            Save it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5">
        <button
          onClick={scan}
          disabled={stage.kind === "scanning" || stage.kind === "saving"}
          className="rounded border border-border px-2 py-0.5 text-[10.5px] text-accent hover:bg-accent/10 disabled:opacity-50"
        >
          {stage.kind === "scanning" ? "Reading the page…" : "Set up two-factor"}
        </button>
        <button
          onClick={() => setManual("")}
          className="text-[10.5px] text-text-muted hover:text-text-primary"
        >
          paste a key instead
        </button>
      </div>
      {stage.kind === "failed" && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-amber-500">
          {stage.message}
        </p>
      )}
    </div>
  );
}
