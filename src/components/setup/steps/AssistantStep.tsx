// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useEffect, useState } from "react";
import * as cmd from "@/lib/commands";
import { StepHeading, StepFooter } from "@/components/setup/WizardFrame";
import { copyToClipboard } from "@/lib/clipboard";

export function AssistantStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const [exePath, setExePath] = useState("claspt");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    cmd
      .getExePath()
      .then((p) => {
        if (!cancelled) setExePath(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The full path, never a bare command name: nothing puts `claspt` on PATH, so
  // a snippet naming it would simply fail to start for everyone who copied it.
  const snippet = `"claspt": {\n  "command": ${JSON.stringify(exePath)},\n  "args": ["--mcp"]\n}`;

  return (
    <>
      <StepHeading eyebrow="AI tools" title="Connect an AI tool to your vault">
        An AI tool such as Claude can use Claspt as its memory. It reads your notes and
        writes new ones, so what you tell it is still there next time.
      </StepHeading>

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

      <p className="max-w-[48ch] text-[12.5px] leading-relaxed text-text-muted">
        The tool is given read access to your notes. Anything it reads is sent to that AI
        service as part of your conversation. Passwords stay hidden unless you allow them
        in Settings.
      </p>

      <StepFooter>
        <button
          type="button"
          onClick={onBack}
          className="px-1 py-2 text-[13px] text-text-muted transition-colors hover:text-text-secondary"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          className="btn-accent rounded-xl px-7 py-3 text-[13px]"
        >
          Continue
        </button>
      </StepFooter>
    </>
  );
}
