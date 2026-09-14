// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * AppShell — the top-level authenticated layout (shown after the vault is
 * unlocked). Composes the sidebar, editor, and side panels, mounts all the
 * global modals/overlays, wires up global keyboard shortcuts and auto-lock,
 * and boots the background sync engine.
 */
import { AboutDialog } from "@/components/AboutDialog";
import { UpdateBanner } from "@/components/UpdateBanner";
import { ConflictModal } from "@/components/ConflictModal";
import { EditorPane } from "@/components/EditorPane";
import { GeneratorPanel } from "@/components/generator/GeneratorPanel";
import { ImportModal } from "@/components/ImportModal";
import { InspectorPanel } from "@/components/InspectorPanel";
import { MarkdownHelp } from "@/components/MarkdownHelp";
import { RecoveryKeyModal } from "@/components/RecoveryKeyModal";
import { SetupGate } from "@/components/setup/SetupGate";
import { ShareModal } from "@/components/ShareModal";
import { SearchPanel } from "@/components/SearchPanel";
import { SecretTemplateInserter } from "@/components/SecretTemplateInserter";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Sidebar } from "@/components/Sidebar";
import { TourOverlay } from "@/components/tour/TourOverlay";
import { useAutoLock } from "@/hooks/use-auto-lock";
import { useKeyboard } from "@/hooks/use-keyboard";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { useUIStore } from "@/stores/ui-store";
import { useSyncStore } from "@/stores/sync-store";
import { useCallback, useEffect, useRef } from "react";

/**
 * Draggable divider between the sidebar and editor. Dragging updates the
 * sidebar width in the UI store; double-click resets it to the default.
 */
function ResizeHandle() {
  const { sidebarOpen, sidebarWidth, setSidebarWidth } = useUIStore();
  // Anchor the pointer x and the sidebar width captured at drag start, so
  // width is computed from the cumulative delta rather than per-move jitter.
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = sidebarWidth;

      // Track the drag on the document so it continues even if the pointer
      // leaves the thin handle; listeners are torn down on mouse-up.
      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startXRef.current;
        setSidebarWidth(startWidthRef.current + delta);
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth, setSidebarWidth],
  );

  const handleDoubleClick = useCallback(() => {
    setSidebarWidth(280);
  }, [setSidebarWidth]);

  if (!sidebarOpen) return null;

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      className="group relative z-10 w-1 shrink-0 cursor-col-resize"
    >
      <div className="absolute inset-y-0 -left-0.5 w-1.5 transition-colors group-hover:bg-accent/30" />
    </div>
  );
}

/** Root layout for the unlocked app. */
export default function AppShell() {
  useKeyboard();
  useAutoLock();

  // Kick off the sync engine as soon as the vault unlocks. fetchV2Status
  // calls ensure_engine on the Rust side, which spawns the 30s background
  // auto-sync loop. Without this, auto-push only started when the user
  // opened the Settings panel, so edits stayed local until manual sync.
  useEffect(() => {
    void useSyncStore.getState().fetchV2Status();
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <UpdateBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <ResizeHandle />
        <PanelErrorBoundary name="Editor">
          <EditorPane />
        </PanelErrorBoundary>
        <PanelErrorBoundary name="Inspector">
          <InspectorPanel />
        </PanelErrorBoundary>
        <PanelErrorBoundary name="Search">
          <SearchPanel />
        </PanelErrorBoundary>
        <PanelErrorBoundary name="Settings">
          <SettingsPanel />
        </PanelErrorBoundary>
        <GeneratorPanel />
        <SecretTemplateInserter />
        <SetupGate />
        <RecoveryKeyModal />
        <ImportModal />
        <ShareModal />
        <ConflictModal />
        <MarkdownHelp />
        <TourOverlay />
        <AboutDialog />
      </div>
    </div>
  );
}
