// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Restore saved theme before first render to avoid flash
chrome.storage.local.get("claspt_theme", (result) => {
  const theme = result["claspt_theme"] as "auto" | "light" | "dark" | undefined;
  if (theme) {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme === "dark" ? "dark" : theme === "light" ? "light" : "";
  }
});

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
