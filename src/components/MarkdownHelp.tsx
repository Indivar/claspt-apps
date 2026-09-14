// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Modal reference sheet for the app's supported markdown syntax (including the
 * custom `:::secret` block) plus usage tips. Visibility is driven by the UI store's
 * `helpOpen` flag; closes on Escape or the close button.
 */
import { useEffect } from "react";
import { useUIStore } from "@/stores/ui-store";
import { kbd } from "@/lib/platform";

const SYNTAX_ITEMS = [
  { syntax: "# Heading 1", result: "Top-level heading" },
  { syntax: "## Heading 2", result: "Sub-heading" },
  { syntax: "### Heading 3", result: "Section heading" },
  { syntax: "**bold text**", result: "Bold" },
  { syntax: "*italic text*", result: "Italic" },
  { syntax: "~~strikethrough~~", result: "Strikethrough" },
  { syntax: "`inline code`", result: "Inline code" },
  { syntax: "```\\ncode\\n```", result: "Code block (fenced)" },
  { syntax: "- item", result: "Bullet list" },
  { syntax: "1. item", result: "Numbered list" },
  { syntax: "- [ ] task", result: "Task / checkbox list" },
  { syntax: "> quote", result: "Blockquote" },
  { syntax: "[text](url)", result: "Hyperlink" },
  { syntax: "![alt](image-url)", result: "Image" },
  { syntax: "---", result: "Horizontal rule / divider" },
  { syntax: "| A | B |\\n|---|---|", result: "Table" },
  { syntax: ":::secret[Label]\\nKey: Value\\n:::", result: "Secret block (encrypted)" },
];

const TIPS = [
  "Use the toolbar buttons above the editor to insert formatting without memorizing syntax.",
  kbd("Press Mod+Shift+S (or the lock icon) to insert an encrypted secret block."),
  "Switch between Edit, Split, and Preview modes using the buttons in the title bar.",
  "Changes are saved automatically after 2 seconds of inactivity.",
  kbd("Press Mod+I to open the Inspector panel for tags, metadata, and history."),
  kbd("Press Mod+K to search across all your pages."),
];

/** Modal listing markdown syntax and editor tips; rendered when `helpOpen` is set. */
export function MarkdownHelp() {
  const { helpOpen, setHelpOpen } = useUIStore();

  useEffect(() => {
    if (!helpOpen) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setHelpOpen(false);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [helpOpen, setHelpOpen]);

  if (!helpOpen) return null;

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50">
      <div className="modal-card flex max-h-[80vh] w-[520px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-6 py-3">
          <h2 className="text-[13px] font-semibold text-text-primary">
            Markdown Reference
          </h2>
          <button
            onClick={() => setHelpOpen(false)}
            className="icon-btn p-1 text-text-muted"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <p className="mb-4 text-xs text-text-muted">
            Markdown is a simple way to format text. Use the syntax below or click the
            toolbar buttons to format your notes.
          </p>

          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="pb-2 text-left text-xs font-semibold text-text-muted">
                  What you type
                </th>
                <th className="pb-2 text-left text-xs font-semibold text-text-muted">
                  What it means
                </th>
              </tr>
            </thead>
            <tbody>
              {SYNTAX_ITEMS.map((item) => (
                <tr key={item.syntax} className="border-b border-border/50">
                  <td className="py-2 pr-4 font-mono text-xs text-accent">
                    {item.syntax}
                  </td>
                  <td className="py-2 text-xs text-text-primary">{item.result}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="mt-6 mb-2 text-xs font-semibold text-text-secondary">Tips</h3>
          <ul className="space-y-1.5">
            {TIPS.map((tip) => (
              <li key={tip} className="text-xs text-text-muted">
                {tip}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
