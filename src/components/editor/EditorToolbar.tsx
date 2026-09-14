// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * EditorToolbar — the formatting toolbar above the CodeMirror editor.
 *
 * Buttons apply markdown formatting to the active editor via the editor-api
 * helpers (headings, bold/italic/strike/code, lists, quote, link, image,
 * code block with language picker, rule, table), plus insert-secret-block,
 * share, and markdown-help actions. Image insertion supports either a direct
 * insert or an options dialog (resize/convert). A second row renders any
 * enabled markdown-extension inserts via {@link ExtensionToolbar}.
 */
import { useState, useRef } from "react";
import { useUIStore } from "@/stores/ui-store";
import { usePagesStore } from "@/stores/pages-store";
import { useClickOutside } from "@/hooks/use-click-outside";
import { kbd } from "@/lib/platform";
import { open } from "@tauri-apps/plugin-dialog";
import {
  insertAtCursor,
  insertImageMarkdown,
  prefixLine,
  wrapSelection,
} from "./editor-api";
import { saveMediaFromPath } from "@/lib/commands";
import { ImageOptionsModal } from "./ImageOptionsModal";
import { ExtensionToolbar } from "./ExtensionToolbar";

/** Shared icon button used for individual toolbar actions. */
function ToolbarButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title} className="icon-btn p-1.5 text-text-muted">
      {children}
    </button>
  );
}

function Divider() {
  return <div className="mx-1 h-5 w-px bg-border" />;
}

const IMAGE_FILTERS = [
  { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"] },
];
const RASTER_FILTERS = [
  { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
];

/** Split button: insert an image/file as-is, or open the options dialog
 *  (resize/convert) via a dropdown. Saves the picked file into the vault. */
function InsertImageButton() {
  const folder = usePagesStore((s) => s.activePage?.meta.folder ?? "general");
  const [menuOpen, setMenuOpen] = useState(false);
  const [optionsFilePath, setOptionsFilePath] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

  async function handleInsertAsIs() {
    setMenuOpen(false);
    const selected = await open({ multiple: false, filters: IMAGE_FILTERS });
    if (!selected) return;
    try {
      const mf = await saveMediaFromPath(folder, selected);
      const name =
        selected
          .split(/[/\\]/)
          .pop()
          ?.replace(/\.[^.]+$/, "") ?? "image";
      insertImageMarkdown(name, mf.md_path);
    } catch (err) {
      console.error("Failed to insert image:", err);
    }
  }

  async function handleInsertWithOptions() {
    setMenuOpen(false);
    const selected = await open({ multiple: false, filters: RASTER_FILTERS });
    if (!selected) return;
    setOptionsFilePath(selected);
  }

  return (
    <>
      <div className="relative flex items-center" ref={menuRef}>
        {/* Main button: insert as-is */}
        <button
          onClick={handleInsertAsIs}
          title="Insert image or file (PNG, JPG, PDF, SVG...)"
          className="icon-btn rounded-l-md p-1.5 text-text-muted"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect
              x="1"
              y="2"
              width="14"
              height="12"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle cx="5" cy="6" r="1.5" fill="currentColor" />
            <path d="M1 12l4-4 2 2 3-3 5 5H1z" fill="currentColor" opacity="0.3" />
          </svg>
        </button>
        {/* Dropdown arrow */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          title="Insert options"
          className="icon-btn -ml-px rounded-r-md px-0.5 py-1.5 text-text-muted"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path
              d="M2 3l2 2 2-2"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {/* Dropdown menu */}
        {menuOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-lg border border-border bg-surface shadow-lg">
            <button
              onClick={handleInsertAsIs}
              className="w-full px-3 py-2 text-left text-[12px] text-text-secondary transition-colors hover:bg-surface-overlay"
            >
              Insert image or file
            </button>
            <button
              onClick={handleInsertWithOptions}
              className="w-full px-3 py-2 text-left text-[12px] text-text-secondary transition-colors hover:bg-surface-overlay"
            >
              Insert with options (resize, convert)...
            </button>
          </div>
        )}
      </div>

      {/* Image options modal */}
      {optionsFilePath && (
        <ImageOptionsModal
          filePath={optionsFilePath}
          onClose={() => setOptionsFilePath(null)}
        />
      )}
    </>
  );
}

const CODE_LANGUAGES = [
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "rust", label: "Rust" },
  { value: "go", label: "Go" },
  { value: "java", label: "Java" },
  { value: "kotlin", label: "Kotlin" },
  { value: "swift", label: "Swift" },
  { value: "ruby", label: "Ruby" },
  { value: "bash", label: "Bash / Shell" },
  { value: "sql", label: "SQL" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "scss", label: "SCSS" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "xml", label: "XML" },
  { value: "markdown", label: "Markdown" },
  { value: "graphql", label: "GraphQL" },
  { value: "dockerfile", label: "Dockerfile" },
  { value: "nginx", label: "Nginx" },
  { value: "ini", label: "INI / Config" },
];

/** Split button: insert a plain fenced code block, or pick a language from
 *  the dropdown to insert a language-tagged fence. */
function CodeBlockButton() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

  return (
    <div className="relative flex items-center" ref={menuRef}>
      {/* Main button: plain code block */}
      <button
        onClick={() => wrapSelection("```\n", "\n```", "code here")}
        title="Code block"
        className="icon-btn rounded-l-md p-1.5 text-text-muted"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect
            x="1"
            y="1"
            width="14"
            height="14"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M5 5L2.5 8 5 11M11 5l2.5 3L11 11"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {/* Dropdown arrow: choose language */}
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        title="Code block with language"
        className="icon-btn -ml-px rounded-r-md px-0.5 py-1.5 text-text-muted"
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path
            d="M2 3l2 2 2-2"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {/* Language picker dropdown */}
      {menuOpen && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-72 w-44 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
          {CODE_LANGUAGES.map((lang) => (
            <button
              key={lang.value}
              onClick={() => {
                wrapSelection(`\`\`\`${lang.value}\n`, "\n```", "code here");
                setMenuOpen(false);
              }}
              className="w-full px-3 py-1.5 text-left text-[12px] text-text-secondary transition-colors hover:bg-surface-overlay"
            >
              {lang.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Toolbar button that opens the secret-block template picker. */
function SecretBlockButton() {
  const { setTemplatePickerOpen } = useUIStore();
  return (
    <ToolbarButton
      title={kbd("Insert secret block (Mod+Shift+S)")}
      onClick={() => setTemplatePickerOpen(true)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect
          x="3"
          y="7"
          width="10"
          height="7"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M5 7V5a3 3 0 016 0v2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx="8" cy="10.5" r="1" fill="currentColor" />
      </svg>
    </ToolbarButton>
  );
}

/** The editor's markdown formatting toolbar (plus extension row). */
export function EditorToolbar() {
  return (
    <div className="editor-toolbar flex flex-col">
      <div className="flex items-center gap-0.5 px-4 py-1.5">
        {/* Headings */}
        <ToolbarButton title="Heading 1" onClick={() => prefixLine("# ")}>
          <span className="text-xs font-bold">H1</span>
        </ToolbarButton>
        <ToolbarButton title="Heading 2" onClick={() => prefixLine("## ")}>
          <span className="text-xs font-bold">H2</span>
        </ToolbarButton>
        <ToolbarButton title="Heading 3" onClick={() => prefixLine("### ")}>
          <span className="text-xs font-bold">H3</span>
        </ToolbarButton>

        <Divider />

        {/* Inline formatting */}
        <ToolbarButton
          title={kbd("Bold (Mod+B)")}
          onClick={() => wrapSelection("**", "**", "bold")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 2h5a3 3 0 010 6H4V2zM4 8h6a3 3 0 010 6H4V8z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          title={kbd("Italic (Mod+I)")}
          onClick={() => wrapSelection("*", "*", "italic")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 2H6M10 14H6M9.5 2L6.5 14"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          title="Strikethrough"
          onClick={() => wrapSelection("~~", "~~", "strikethrough")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 8h12M5 3h5a2 2 0 010 4M6 9h4a2 2 0 010 4H5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          title="Inline code"
          onClick={() => wrapSelection("`", "`", "code")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M5 4L1 8l4 4M11 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </ToolbarButton>

        <Divider />

        {/* Block formatting */}
        <ToolbarButton title="Bullet list" onClick={() => prefixLine("- ")}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="3" cy="4" r="1.5" fill="currentColor" />
            <circle cx="3" cy="8" r="1.5" fill="currentColor" />
            <circle cx="3" cy="12" r="1.5" fill="currentColor" />
            <path
              d="M7 4h7M7 8h7M7 12h7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </ToolbarButton>
        <ToolbarButton title="Numbered list" onClick={() => prefixLine("1. ")}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <text x="1" y="5.5" fontSize="5" fontWeight="bold" fill="currentColor">
              1
            </text>
            <text x="1" y="9.5" fontSize="5" fontWeight="bold" fill="currentColor">
              2
            </text>
            <text x="1" y="13.5" fontSize="5" fontWeight="bold" fill="currentColor">
              3
            </text>
            <path
              d="M7 4h7M7 8h7M7 12h7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </ToolbarButton>
        <ToolbarButton title="Task list" onClick={() => prefixLine("- [ ] ")}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect
              x="1"
              y="2"
              width="6"
              height="5"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M9 4h5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <rect
              x="1"
              y="9"
              width="6"
              height="5"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M3 11.5l1.5 1.5L6 10.5"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M9 11h5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </ToolbarButton>
        <ToolbarButton title="Blockquote" onClick={() => prefixLine("> ")}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 3v10M6 5h8M6 8h6M6 11h8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </ToolbarButton>

        <Divider />

        {/* Insert elements */}
        <ToolbarButton
          title="Link"
          onClick={() => wrapSelection("[", "](url)", "link text")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M6.5 9.5l3-3M7 11l-1.5 1.5a2.12 2.12 0 01-3-3L4 8M9 5l1.5-1.5a2.12 2.12 0 013 3L12 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </ToolbarButton>
        <InsertImageButton />
        <CodeBlockButton />
        <ToolbarButton title="Horizontal rule" onClick={() => prefixLine("---\n")}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 8h12"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          title="Table"
          onClick={() =>
            insertAtCursor(
              "| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n| Cell     | Cell     | Cell     |\n",
            )
          }
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect
              x="1"
              y="2"
              width="14"
              height="12"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M1 6h14M1 10h14M6 2v12M11 2v12"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </ToolbarButton>

        <Divider />

        {/* Secret block */}
        <SecretBlockButton />

        {/* Share */}
        <ToolbarButton
          title={kbd("Share page (Mod+Shift+E)")}
          onClick={() => useUIStore.getState().setShareModalOpen(true)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 9v4a1 1 0 001 1h6a1 1 0 001-1V9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M8 10V2M5 5l3-3 3 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </ToolbarButton>

        <Divider />

        {/* Help */}
        <ToolbarButton
          title={kbd("Markdown help (Mod+Shift+/)")}
          onClick={() => useUIStore.getState().setHelpOpen(true)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M6 6.5a2 2 0 013.5 1.3c0 1.2-1.5 1.2-1.5 2.2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <circle cx="8" cy="12" r="0.75" fill="currentColor" />
          </svg>
        </ToolbarButton>
      </div>
      <ExtensionToolbar />
    </div>
  );
}
