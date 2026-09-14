// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * main.tsx — the React entry point.
 *
 * Mounts {@link App} into `#root` under StrictMode and a top-level
 * {@link ErrorBoundary}. Also installs process-wide concerns before render:
 * lazy registration of the markdown preview extensions (off the critical mount
 * path), global handlers for unhandled errors / promise rejections routed to the
 * logger, and suppression of the native context menu everywhere except real text
 * inputs (components with their own menus call `stopPropagation` first).
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { log } from "@/lib/logger";
import "./index.css";

log.debug("[BOOT] main.tsx executing");

// Register all markdown extensions lazily — don't block React mount
import("@/lib/extensions/index")
  .then(() => log.debug("[BOOT] extensions registered"))
  .catch((err) => {
    log.error("Failed to register extensions", err);
  });

// Global unhandled JS error handler
window.addEventListener("error", (event) => {
  log.error("Unhandled error", event.error ?? event.message);
});

// Global unhandled promise rejection handler
window.addEventListener("unhandledrejection", (event) => {
  log.error("Unhandled promise rejection", event.reason);
});

// Disable browser context menu except on text inputs and elements that handle their own
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  // Allow native context menu on text inputs and textareas
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return;
  }
  // Allow custom context menus (components call stopPropagation before this fires)
  e.preventDefault();
});

log.debug("[BOOT] creating React root");
const root = document.getElementById("root");
log.debug("[BOOT] root element:", root ? "found" : "MISSING");

ReactDOM.createRoot(root!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
log.debug("[BOOT] React render called");
