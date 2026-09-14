// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * EditorPane — the main note editing surface (right of the sidebar).
 *
 * Renders the active page: an editable title, save-status indicator,
 * edit/split/preview mode toggle, tag pills, the CodeMirror editor (lazy),
 * markdown preview (lazy), and the secret-block cards. Handles debounced
 * auto-save, Mod+S force-save, crash-recovery drafts in localStorage (with
 * secret values stripped), and scroll sync between editor and preview.
 * Fully-encrypted pages show a lock overlay until revealed. The exported
 * `EditorPane` handles the empty/loading/error states and remounts the inner
 * editor (via `key`) when the page or its external revision changes.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePagesStore } from "@/stores/pages-store";
import { useSearchStore } from "@/stores/search-store";
import { useUIStore } from "@/stores/ui-store";
import { useVaultStore } from "@/stores/vault-store";
import { EditorToolbar } from "@/components/editor/EditorToolbar";
import { SecretBlockRenderer } from "@/components/SecretCard";
import { LockClosedIcon, LockOpenIcon } from "@/components/ui/icons";
import { verifyPassword } from "@/lib/commands";
import { kbd } from "@/lib/platform";
import { stripSecretValues } from "@/lib/strip-secrets";
import { draftKeyFor, canPersistDraft } from "@/lib/drafts";
import type { Page } from "@claspt/shared/types";

/** Lazy-load CodeMirror (~200KB) — only when editing a page. */
const CodeMirrorEditor = lazy(() => import("@/components/editor/CodeMirrorEditor"));
/** Lazy-load marked + dompurify (~35KB) — only in preview/split mode. */
const MarkdownPreview = lazy(() => import("@/components/MarkdownPreview"));

type SaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error";

/** Spinner shown while a lazy chunk (CodeMirror / preview) loads. */
function EditorSkeleton() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
    </div>
  );
}

/** Inline editable title — click to edit, Enter/blur to save, Escape to cancel. */
function EditableTitle({
  title,
  onSave,
}: {
  title: string;
  onSave: (t: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  // Optimistic display value: show committed draft until prop catches up
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Derive display title: show optimistic value until prop catches up
  const displayTitle = optimistic !== null && optimistic !== title ? optimistic : title;

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) {
      setOptimistic(trimmed);
      onSave(trimmed);
    } else {
      setDraft(title);
    }
    setEditing(false);
  };

  if (!editing) {
    return (
      <h2
        className="cursor-pointer text-lg font-semibold tracking-tight text-text-primary transition-colors hover:text-accent"
        onClick={() => {
          setOptimistic(null);
          setDraft(displayTitle);
          setEditing(true);
        }}
        title="Click to rename"
      >
        {displayTitle}
      </h2>
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          setDraft(displayTitle);
          setEditing(false);
        }
      }}
      className="border-b-2 border-accent bg-transparent text-lg font-semibold tracking-tight text-text-primary outline-none"
    />
  );
}

/** Lock overlay shown for fully-encrypted pages (lock_overlay or require_password mode). */
function EncryptedOverlay({
  title,
  mode,
  onReveal,
}: {
  title: string;
  mode: string;
  onReveal: () => void;
}) {
  const [password, setPassword] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReveal = useCallback(async () => {
    if (mode === "require_password") {
      setVerifying(true);
      setError(null);
      try {
        await verifyPassword(password);
        setVerifying(false);
        onReveal();
      } catch (e) {
        setVerifying(false);
        setError(typeof e === "string" ? e : "Incorrect password");
      }
    } else {
      onReveal();
    }
  }, [mode, password, onReveal]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-4 text-center">
        {/* Shield icon */}
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-accent/10">
          <svg width="36" height="36" viewBox="0 0 64 64" fill="none">
            <path
              d="M32 4L10 14v18c0 14 10 22 22 24 12-2 22-10 22-24V14L32 4z"
              className="fill-accent/20 stroke-accent"
              strokeWidth="2"
            />
            <rect
              x="22"
              y="28"
              width="20"
              height="16"
              rx="3"
              className="fill-accent/30 stroke-accent"
              strokeWidth="2"
            />
            <path
              d="M26 28v-4a6 6 0 0112 0v4"
              className="stroke-accent"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div>
          <h3 className="text-lg font-semibold text-text-primary">{title}</h3>
          <p className="mt-1 text-sm text-text-muted">This page is fully encrypted</p>
        </div>
        {mode === "require_password" && (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleReveal();
            }}
            placeholder="Enter vault password"
            className="focus-accent w-64 rounded-lg border border-border/60 bg-surface-raised px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 outline-none"
          />
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        <button
          onClick={handleReveal}
          disabled={verifying}
          className="btn-accent rounded-lg px-6 py-2 text-sm font-medium disabled:opacity-50"
        >
          {verifying ? "Verifying..." : "Reveal Content"}
        </button>
      </div>
    </div>
  );
}

/** Encryption toggle button for the editor title bar. */
function EncryptionButton({ page }: { page: Page }) {
  const { toggleEncryption } = usePagesStore();
  const [toggling, setToggling] = useState(false);

  const handleClick = useCallback(async () => {
    setToggling(true);
    await toggleEncryption(page.path);
    setToggling(false);
  }, [page.path, toggleEncryption]);

  return (
    <button
      onClick={handleClick}
      disabled={toggling}
      title={
        page.meta.encrypted
          ? "Page is fully encrypted — click to decrypt"
          : "Click to encrypt entire page"
      }
      className={`flex items-center gap-1 rounded-md px-2 py-0.5 font-medium transition-all active:scale-95 disabled:opacity-50 ${
        page.meta.encrypted
          ? "bg-accent/15 text-accent hover:bg-accent/25"
          : "text-text-muted hover:bg-surface-overlay hover:text-text-secondary"
      }`}
    >
      {page.meta.encrypted ? <LockClosedIcon /> : <LockOpenIcon />}
      {toggling ? "..." : page.meta.encrypted ? "Encrypted" : "Encrypt"}
    </button>
  );
}

/** Inner editor that resets state via key prop when the page changes. */
function PageEditor({ page }: { page: Page }) {
  const { updatePage, updateTitle, deletePage } = usePagesStore();
  const config = useVaultStore((s) => s.config);
  const { editorMode, setEditorMode, setInspectorOpen } = useUIStore();
  const searchHighlight = useSearchStore((s) => s.searchHighlight);
  const setSearchHighlight = useSearchStore((s) => s.setSearchHighlight);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const savingRef = useRef(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [revealed, setRevealed] = useState(false);
  const [confirmDeletePage, setConfirmDeletePage] = useState(false);
  const [liveContent, setLiveContent] = useState(page.content);
  const liveContentRef = useRef(page.content);

  // Draft persistence for crash recovery
  const draftKey = draftKeyFor(page.meta.id);
  const [recoveredDraft, setRecoveredDraft] = useState<string | null>(null);

  // Check for recovered draft on mount
  useEffect(() => {
    const saved = localStorage.getItem(draftKey);
    if (saved && saved !== page.content) {
      setRecoveredDraft(saved);
    } else if (saved) {
      localStorage.removeItem(draftKey);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Synchronized scroll refs
  const cmScrollRef = useRef<HTMLElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);

  const clearSearchHighlight = useCallback(() => {
    setSearchHighlight(null);
  }, [setSearchHighlight]);

  // Scroll sync between CM6 editor and preview (split mode only).
  // Uses a 50ms lock to prevent feedback loops between the two scroll containers.
  const syncLockRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (editorMode !== "split") return;
    const editorEl = cmScrollRef.current;
    const previewEl = previewScrollRef.current;
    if (!editorEl || !previewEl) return;

    let activeSource: "editor" | "preview" | null = null;

    function syncScroll(source: "editor" | "preview") {
      if (activeSource && activeSource !== source) return;
      activeSource = source;
      if (syncLockRef.current) clearTimeout(syncLockRef.current);

      const srcEl = source === "editor" ? editorEl! : previewEl!;
      const tgtEl = source === "editor" ? previewEl! : editorEl!;
      const maxSrc = srcEl.scrollHeight - srcEl.clientHeight;
      const ratio = maxSrc > 0 ? Math.min(1, Math.max(0, srcEl.scrollTop / maxSrc)) : 0;
      const maxTgt = tgtEl.scrollHeight - tgtEl.clientHeight;
      tgtEl.scrollTop = ratio * maxTgt;

      syncLockRef.current = setTimeout(() => {
        activeSource = null;
      }, 50);
    }

    const onEditor = () => syncScroll("editor");
    const onPreview = () => syncScroll("preview");
    editorEl.addEventListener("scroll", onEditor, { passive: true });
    previewEl.addEventListener("scroll", onPreview, { passive: true });
    return () => {
      editorEl.removeEventListener("scroll", onEditor);
      previewEl.removeEventListener("scroll", onPreview);
      if (syncLockRef.current) clearTimeout(syncLockRef.current);
    };
  }, [editorMode]);

  const doSave = useCallback(
    async (value: string) => {
      savingRef.current = true;
      setSaveStatus("saving");
      try {
        await updatePage(page.path, value);
        // Only drop the crash-recovery draft once the write actually succeeded.
        localStorage.removeItem(draftKey);
        setSaveStatus("saved");
        savedTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
      } catch {
        // Write failed (e.g. readonly DB after auto-lock, disk full,
        // permissions). Keep the draft and surface an error rather than a
        // false "Saved" — the edit still lives in the buffer + localStorage.
        setSaveStatus("error");
      } finally {
        savingRef.current = false;
      }
    },
    [page.path, updatePage, draftKey],
  );

  const handleChange = useCallback(
    (value: string) => {
      setLiveContent(value);
      liveContentRef.current = value;
      // Persist a draft for crash recovery, with secret block values stripped
      // so nothing sensitive reaches unencrypted browser storage. A full-body
      // encrypted page is skipped outright — stripping secret fences leaves the
      // rest of its decrypted body intact, and for those pages the body IS the
      // protected material.
      if (canPersistDraft(page)) {
        localStorage.setItem(draftKey, stripSecretValues(value));
      }
      // Auto-save after configured delay of inactivity. "unsaved" means
      // the debounce timer is armed; the actual "saving" state is set
      // inside doSave once the IPC is in flight. Default pushed from 2s
      // to 5s so every keystroke doesn't churn the save pipeline.
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      const delay = config?.auto_save_delay_ms ?? 5000;
      setSaveStatus("unsaved");
      saveTimerRef.current = setTimeout(() => {
        if (!savingRef.current) doSave(value);
      }, delay);
    },
    [config?.auto_save_delay_ms, doSave, draftKey, page],
  );

  // Listen for Mod+S force-save event from global keyboard handler
  useEffect(() => {
    function onForceSave() {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      if (!savingRef.current && liveContentRef.current !== page.content) {
        doSave(liveContentRef.current);
      }
    }
    window.addEventListener("claspt:force-save", onForceSave);
    return () => window.removeEventListener("claspt:force-save", onForceSave);
  }, [doSave, page.content]);

  /** Cancel pending auto-save, flush dirty content, then update title. */
  const handleTitleSave = useCallback(
    async (newTitle: string) => {
      // Cancel pending auto-save to prevent race condition
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      // Wait for any in-flight save to complete
      while (savingRef.current) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Flush any unsaved content first so the backend file is up-to-date
      if (liveContentRef.current !== page.content) {
        await doSave(liveContentRef.current);
      }
      await updateTitle(page.path, newTitle);
      setSaveStatus("idle");
    },
    [page.path, page.content, doSave, updateTitle],
  );

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const modeButtons = useMemo(
    () =>
      (["edit", "split", "preview"] as const).map((mode) => (
        <button
          key={mode}
          onClick={() => setEditorMode(mode)}
          className={`mode-btn capitalize ${editorMode === mode ? "active" : ""}`}
        >
          {mode}
        </button>
      )),
    [editorMode, setEditorMode],
  );

  // Check if we should show the encrypted overlay
  const displayMode = config?.encrypted_page_display ?? "lock_overlay";
  const showOverlay = page.meta.encrypted && !revealed && displayMode !== "auto_reveal";

  if (showOverlay) {
    return (
      <div className="flex flex-1 flex-col bg-surface">
        {/* Title Bar (minimal for encrypted pages) */}
        <div className="editor-titlebar flex items-center border-b border-border px-6 py-3.5">
          <h2 className="text-lg font-semibold tracking-tight text-text-primary">
            {page.meta.title}
          </h2>
          <div className="ml-auto flex items-center gap-2 text-[11px] text-text-muted">
            <span className="flex items-center gap-1 text-accent">
              <LockClosedIcon />
              Encrypted
            </span>
            <span className="flex items-center gap-1 rounded-md bg-surface-overlay/60 px-2 py-0.5 text-text-muted">
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="shrink-0 opacity-60"
              >
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.172a1.5 1.5 0 011.06.44l.829.828a.5.5 0 00.354.146H13.5A1.5 1.5 0 0115 4.914V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              {page.meta.folder}
            </span>
          </div>
        </div>
        <EncryptedOverlay
          title={page.meta.title}
          mode={displayMode}
          onReveal={() => setRevealed(true)}
        />
      </div>
    );
  }

  return (
    <div data-tour="editor" className="flex flex-1 flex-col overflow-hidden bg-surface">
      {/* Title Bar */}
      <div className="editor-titlebar flex flex-col border-b border-border px-6 py-3.5">
        <div className="flex items-center">
          <EditableTitle title={page.meta.title} onSave={handleTitleSave} />
          <div className="ml-auto flex items-center gap-3 text-[11px] text-text-muted">
            {saveStatus === "unsaved" && (
              <span className="flex items-center gap-1.5 font-medium text-text-muted">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-text-muted" />
                Unsaved
              </span>
            )}
            {saveStatus === "saving" && (
              <span className="flex items-center gap-1.5 font-medium text-accent">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                Saving
              </span>
            )}
            {saveStatus === "error" && (
              <span className="flex items-center gap-1.5 font-medium text-danger">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-danger" />
                Save failed — draft kept
              </span>
            )}
            {saveStatus === "saved" && (
              <span className="flex items-center gap-1.5 font-medium text-success">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3.5 8.5l3 3 6-7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Saved
              </span>
            )}
            <div className="mode-toggle flex items-center gap-0.5">{modeButtons}</div>
            <span className="flex items-center gap-1 rounded-md bg-surface-overlay/60 px-2 py-0.5 text-text-muted">
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="shrink-0 opacity-60"
              >
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.172a1.5 1.5 0 011.06.44l.829.828a.5.5 0 00.354.146H13.5A1.5 1.5 0 0115 4.914V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              {page.meta.folder}
            </span>
            <EncryptionButton page={page} />
            {page.meta.pinned && (
              <span className="flex items-center gap-1 text-accent">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M9.828 1.172a1 1 0 011.414 0l3.586 3.586a1 1 0 010 1.414l-3.586 3.586-1.414-1.414L12.07 6.12 6.12 12.07l-2.242 2.242a1 1 0 01-1.414-1.414L4.706 10.656l-1.414-1.414a1 1 0 010-1.414L6.878 4.242 5.464 2.828z" />
                </svg>
                Pinned
              </span>
            )}
          </div>
        </div>
        {/* Tag pills */}
        <div className="mt-2 flex items-center gap-1.5">
          {(page.meta.tags ?? []).map((tag) => (
            <span
              key={tag}
              className="tag-pill rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-medium text-accent"
            >
              {tag}
            </span>
          ))}
          <button
            onClick={() => setInspectorOpen(true)}
            className="rounded-full border border-dashed border-border/60 px-2 py-0.5 text-[11px] text-text-muted transition-all hover:border-accent hover:bg-accent/5 hover:text-accent"
            title={kbd("Page details (Mod+I)")}
          >
            Page details
          </button>
          {/* Delete this page. Available here so a page opened via search can be
              deleted without locating it in the sidebar. Inline two-step confirm
              (no blocking dialog). */}
          {confirmDeletePage ? (
            <span className="flex items-center gap-1">
              <button
                onClick={() => {
                  setConfirmDeletePage(false);
                  void deletePage(page.path);
                }}
                className="rounded-full border border-red-500/60 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-500 transition-all hover:bg-red-500/20"
                title="Confirm delete this page"
              >
                Delete?
              </button>
              <button
                onClick={() => setConfirmDeletePage(false)}
                className="rounded-full border border-dashed border-border/60 px-2 py-0.5 text-[11px] text-text-muted transition-all hover:bg-surface-overlay"
                title="Cancel"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDeletePage(true)}
              className="rounded-full border border-dashed border-border/60 px-2 py-0.5 text-[11px] text-text-muted transition-all hover:border-red-500 hover:bg-red-500/5 hover:text-red-500"
              title="Delete this page"
            >
              Delete page
            </button>
          )}
        </div>
      </div>

      {/* Draft recovery banner */}
      {recoveredDraft && (
        <div className="flex items-center gap-3 border-b border-accent/30 bg-accent/10 px-6 py-2.5">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            className="shrink-0 text-accent"
          >
            <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M8 5v3M8 10h.01"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span className="text-[13px] text-text-primary">Unsaved changes recovered</span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => {
                // Restore display state only — do NOT call handleChange()
                // because the recovered draft contains [REDACTED] placeholders
                // in place of secret values. Calling handleChange would
                // trigger auto-save and permanently destroy encrypted values
                // on disk. The user must make an explicit edit to trigger save.
                setLiveContent(recoveredDraft);
                liveContentRef.current = recoveredDraft;
                localStorage.removeItem(draftKey);
                setRecoveredDraft(null);
              }}
              className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white transition-all hover:bg-accent-hover active:scale-95"
            >
              Accept
            </button>
            <button
              onClick={() => {
                localStorage.removeItem(draftKey);
                setRecoveredDraft(null);
              }}
              className="rounded-md border border-border/60 px-3 py-1 text-[12px] font-medium text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Editor Toolbar (hidden in preview-only mode) */}
      {editorMode !== "preview" && <EditorToolbar />}

      {/* Editor / Preview area */}
      <div className="flex flex-1 overflow-hidden">
        {(editorMode === "edit" || editorMode === "split") && (
          <div
            className={`relative overflow-hidden ${editorMode === "split" ? "w-1/2 min-w-[300px]" : "w-full"}`}
          >
            <Suspense fallback={<EditorSkeleton />}>
              <CodeMirrorEditor
                value={page.content}
                onChange={handleChange}
                fontSize={config?.editor_font_size}
                fontFamily={config?.editor_font_family}
                searchHighlight={searchHighlight}
                onSearchHighlightApplied={clearSearchHighlight}
                scrollDomRef={cmScrollRef}
              />
            </Suspense>
          </div>
        )}
        {editorMode === "split" && (
          <div className="w-px shrink-0 bg-border shadow-[1px_0_4px_rgba(0,0,0,0.06)]" />
        )}
        {(editorMode === "preview" || editorMode === "split") && (
          <div
            ref={previewScrollRef}
            className={`overflow-auto overscroll-none bg-surface ${editorMode === "split" ? "w-1/2" : "w-full"}`}
          >
            <Suspense fallback={<EditorSkeleton />}>
              <MarkdownPreview content={liveContent} />
            </Suspense>
          </div>
        )}
      </div>

      {/* Secret Block Cards — scrollable, capped at 35vh so they never consume the editor */}
      <div
        data-tour="secret-block"
        className="max-h-[35vh] min-h-0 shrink-0 overflow-y-auto border-t border-border"
      >
        <SecretBlockRenderer
          content={liveContent}
          autoHideDelay={(config?.secret_auto_hide_seconds ?? 30) * 1000}
          clipboardClearDelay={(config?.clipboard_clear_seconds ?? 30) * 1000}
          pagePath={page.path}
          onContentChange={async (newContent) => {
            // Update live content and save immediately
            setLiveContent(newContent);
            liveContentRef.current = newContent;
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            await doSave(newContent);
            // Reload page to sync editor with new content
            const { openPage } = usePagesStore.getState();
            await openPage(page.path);
          }}
        />
      </div>
    </div>
  );
}

/**
 * Top-level editor container. Renders error / loading / empty states, or the
 * {@link PageEditor} for the active page. The `key` remounts PageEditor when
 * the page changes or an external write bumps `activePageExternalRev`.
 */
export function EditorPane() {
  const { activePage, loading, error, clearError, activePageExternalRev } =
    usePagesStore();

  if (!activePage && error) {
    return (
      <div
        data-tour="editor"
        className="flex flex-1 items-center justify-center bg-surface"
      >
        <div className="max-w-md px-6 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-danger/10">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              className="text-danger"
            >
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
              <path
                d="M12 7v6M12 16h.01"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <p className="text-sm font-semibold text-text-primary">
            Couldn't open this page
          </p>
          <p className="mt-2 break-all text-[12px] leading-relaxed text-text-muted">
            {error}
          </p>
          <p className="mt-3 text-[11px] text-text-muted/70">
            This can happen with malformed imported files. Check the developer console for
            details.
          </p>
          <button
            onClick={clearError}
            className="mt-4 rounded-md border border-border/60 px-3 py-1 text-[12px] text-text-secondary transition-all hover:bg-surface-overlay"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (!activePage && loading) {
    return (
      <div
        data-tour="editor"
        className="flex flex-1 items-center justify-center bg-surface"
      >
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
      </div>
    );
  }

  if (!activePage) {
    return (
      <div
        data-tour="editor"
        className="flex flex-1 items-center justify-center bg-surface"
      >
        <div className="text-center">
          <div className="empty-state-icon mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl">
            <svg width="28" height="28" viewBox="0 0 48 48" fill="none">
              <rect
                x="10"
                y="8"
                width="28"
                height="34"
                rx="3"
                className="stroke-text-muted"
                strokeWidth="2"
                fill="none"
                opacity="0.3"
              />
              <path
                d="M30 8v6a2 2 0 002 2h6"
                className="stroke-text-muted"
                strokeWidth="2"
                strokeLinecap="round"
                opacity="0.3"
              />
              <path
                d="M17 20h14M17 25h10M17 30h12"
                className="stroke-text-muted"
                strokeWidth="1.5"
                strokeLinecap="round"
                opacity="0.2"
              />
            </svg>
          </div>
          <p className="text-sm font-medium text-text-muted">No page selected</p>
          <p className="mt-1 text-[12px] text-text-muted/60">
            Select a page from the sidebar or create a new one
          </p>
        </div>
      </div>
    );
  }

  // Key resets PageEditor state when switching pages OR when an external
  // change to the open page is detected (extension/MCP/sync write). The
  // remount drops in-flight typing — that's intentional: keeping it would
  // let the next autosave overwrite the external change. Drafts are still
  // recoverable via the localStorage `draft:<id>` key.
  return (
    <PageEditor key={`${activePage.path}:${activePageExternalRev}`} page={activePage} />
  );
}
