// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useState } from "react";
import * as cmd from "@/lib/commands";
import { StepHeading, StepFooter } from "@/components/setup/WizardFrame";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * Connect an AI tool, with something that actually works at the end of it.
 *
 * This screen used to print a config fragment built here by hand, with no
 * `env` block. The MCP server reads `CLASPT_API_TOKEN` from the environment
 * and nothing else, so the tool started and every request came back "Vault not
 * connected" — and the local API it talks to was not running either, because a
 * new vault leaves it off. Three things were missing and the screen said none
 * of them.
 *
 * The snippet is now rendered by the backend from the same code that writes
 * these files for `claspt mcp install`, after minting a client of its own and
 * starting the server, so the two cannot drift apart again.
 *
 * The one question asked first is a security choice and belongs to the person,
 * not to a default: an AI tool given the secrets scope can decrypt passwords.
 */
type Scope = "notes" | "secrets";

export function AssistantStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const [scope, setScope] = useState<Scope>("notes");
  const [snippet, setSnippet] = useState<string | null>(null);
  const [port, setPort] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await cmd.connectAiTool(scope);
      setSnippet(result.snippet);
      setPort(result.port);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <StepHeading eyebrow="AI tools" title="Connect an AI tool to your vault">
        An AI tool such as Claude can use Claspt as its memory. It reads your notes and
        writes new ones, so what you tell it is still there next time.
      </StepHeading>

      {!snippet ? (
        <>
          <p className="mb-3 text-[13px] font-medium text-text-secondary">
            What may the tool read?
          </p>
          <div className="mb-5 flex flex-col gap-2.5">
            <ScopeOption
              checked={scope === "notes"}
              onSelect={() => setScope("notes")}
              title="Notes only"
              recommended
              body="It can read and write your notes. Secret values come back hidden, and it cannot change them."
            />
            <ScopeOption
              checked={scope === "secrets"}
              onSelect={() => setScope("secrets")}
              title="Notes and secrets"
              body="It can also decrypt passwords and keys. Only choose this if you want the tool using your credentials for you."
            />
          </div>

          <p className="mb-5 max-w-[52ch] text-[12.5px] leading-relaxed text-text-muted">
            Connecting mints a key for this tool alone, which you can withdraw at any time
            in Settings, and starts Claspt listening on this computer only so the tool can
            reach it. Nothing is opened to the network.
          </p>

          {error && (
            <p className="mb-4 max-w-[52ch] rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] leading-relaxed text-danger">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy}
            className="btn-accent self-start rounded-xl px-5 py-2.5 text-[13px] disabled:opacity-60"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </>
      ) : (
        <>
          <div className="mb-3.5 rounded-xl border border-border/60 bg-surface-raised px-4 py-3.5">
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <p className="text-[12.5px] text-text-muted">
                Add this to your tool&rsquo;s configuration file
              </p>
              <button
                type="button"
                onClick={() => {
                  void copyToClipboard(snippet);
                  setCopied(true);
                }}
                className="rounded-lg border border-border/60 bg-surface px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="overflow-x-auto whitespace-pre font-mono text-[11.5px] leading-relaxed text-text-secondary">
              {snippet}
            </pre>
          </div>

          <p className="max-w-[52ch] text-[12.5px] leading-relaxed text-text-muted">
            The key in there is this tool&rsquo;s own, so treat the file as you would any
            other credential. Claspt is now listening on 127.0.0.1
            {port ? `:${port}` : ""} — this computer only — and both that and the key can
            be turned off in Settings.
            {scope === "notes"
              ? " Secret values will come back hidden."
              : " This tool can decrypt your secrets."}
          </p>
        </>
      )}

      <StepFooter>
        <button
          type="button"
          onClick={onBack}
          className="px-1 py-2 text-[13px] text-text-muted transition-colors hover:text-text-secondary"
        >
          Back
        </button>
        {/* Before connecting, the accent belongs to Connect. Two filled
            buttons on one screen make skipping look like the intended path. */}
        <button
          type="button"
          onClick={onNext}
          className={
            snippet
              ? "btn-accent rounded-xl px-7 py-3 text-[13px]"
              : "rounded-xl border border-border/60 bg-surface px-5 py-3 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
          }
        >
          {snippet ? "Continue" : "Skip for now"}
        </button>
      </StepFooter>
    </>
  );
}

function ScopeOption({
  checked,
  onSelect,
  title,
  body,
  recommended,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  recommended?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3.5 rounded-xl px-4 py-3 transition-colors ${
        checked
          ? "border-[1.5px] border-accent bg-accent/[0.04]"
          : "border border-border/60 bg-surface hover:bg-surface-raised/50"
      }`}
    >
      <input
        type="radio"
        name="ai-scope"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-[17px] w-[17px] shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="mb-0.5 flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-text-primary">{title}</span>
          {recommended && (
            <span className="text-[11px] font-medium text-text-muted">Recommended</span>
          )}
        </span>
        <span className="block text-[12.5px] leading-normal text-text-secondary">
          {body}
        </span>
      </span>
    </label>
  );
}
