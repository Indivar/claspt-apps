// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React from "react";

type Tab = "logins" | "generator" | "identity" | "settings";

interface TabBarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

const tabs: { id: Tab; label: string }[] = [
  { id: "logins", label: "Logins" },
  { id: "generator", label: "Generator" },
  { id: "identity", label: "Identity" },
  { id: "settings", label: "Settings" },
];

export function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    <div className="flex border-b border-border bg-surface">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex-1 cursor-pointer py-2 text-center text-[11px] transition-colors ${
              isActive
                ? "border-b-2 border-accent font-medium text-accent"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
