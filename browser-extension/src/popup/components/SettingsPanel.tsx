// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useEffect, useState } from "react";
import { CheckIcon, XIcon } from "./icons";
import { STORAGE_KEY_CONFIG } from "@/shared/constants";
import { DEFAULT_CONFIG, type ExtensionConfig } from "@/shared/types";

interface SettingsPanelProps {
  onTestConnection: () => Promise<boolean>;
}

export function SettingsPanel({ onTestConnection }: SettingsPanelProps) {
  const [config, setConfig] = useState<ExtensionConfig>({ ...DEFAULT_CONFIG });
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [newExclude, setNewExclude] = useState("");

  // Load config on mount
  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY_CONFIG, (result) => {
      if (result[STORAGE_KEY_CONFIG]) {
        setConfig({ ...DEFAULT_CONFIG, ...result[STORAGE_KEY_CONFIG] });
      }
    });
  }, []);

  function save(updates: Partial<ExtensionConfig>) {
    const newConfig = { ...config, ...updates };
    setConfig(newConfig);
    chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: newConfig });
    chrome.runtime.sendMessage({
      type: "SAVE_CONFIG",
      config: newConfig,
    });
  }

  async function handleTestConnection() {
    setTestStatus("testing");
    try {
      const ok = await onTestConnection();
      setTestStatus(ok ? "success" : "error");
    } catch {
      setTestStatus("error");
    }
    setTimeout(() => setTestStatus("idle"), 3000);
  }

  function addExcludedDomain() {
    const domain = newExclude.trim().toLowerCase();
    if (!domain) return;
    if (config.excludedDomains.includes(domain)) return;
    save({ excludedDomains: [...config.excludedDomains, domain] });
    setNewExclude("");
  }

  function removeExcludedDomain(domain: string) {
    save({ excludedDomains: config.excludedDomains.filter((d) => d !== domain) });
  }

  return (
    <div className="space-y-5 p-4 overflow-y-auto max-h-[480px]">
      {/* Connection Section */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Connection
        </h3>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              Port
            </label>
            <input
              type="number"
              value={config.port}
              onChange={(e) => save({ port: Number(e.target.value) })}
              className="w-full rounded-md border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              API Token
            </label>
            <input
              type="password"
              value={config.token}
              onChange={(e) => save({ token: e.target.value })}
              placeholder="Paste token from Claspt → Settings → Integrations"
              className="w-full rounded-md border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary placeholder:text-text-dim outline-none focus:border-accent"
            />
            <p className="mt-1 text-[10px] text-text-dim">
              Get this from Claspt desktop → Settings → Integrations → Local API
            </p>
          </div>
          <div>
            <button
              onClick={handleTestConnection}
              disabled={testStatus === "testing"}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-overlay disabled:opacity-50"
            >
              {testStatus === "testing" && "Testing..."}
              {testStatus === "idle" && "Test Connection"}
              {testStatus === "success" && (
                <>
                  <CheckIcon size={12} className="text-green-500" />
                  Connected
                </>
              )}
              {testStatus === "error" && (
                <>
                  <XIcon size={12} className="text-red-500" />
                  Failed — check port & token
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Auto-Fill Section */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Auto-Fill
        </h3>
        <div className="space-y-2.5">
          <Toggle label="Auto-fill credentials" sublabel="Show inline icons on login fields" checked={config.autoFillEnabled} onChange={(v) => save({ autoFillEnabled: v })} />
          <Toggle label="Auto-fill on page load" sublabel="Fill credentials automatically without clicking (only for exact domain matches)" checked={config.autoFillOnPageLoad} onChange={(v) => save({ autoFillOnPageLoad: v })} />
          <Toggle label="Auto-paste TOTP" sublabel="Automatically fill the 2FA code after filling password" checked={config.autoFillTotp} onChange={(v) => save({ autoFillTotp: v })} />
          <Toggle label="Show fill flash" sublabel="Gold highlight on filled fields for visual confirmation" checked={config.showFillFlash} onChange={(v) => save({ showFillFlash: v })} />
        </div>
      </section>

      {/* Security Section */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Security
        </h3>
        <div className="space-y-2.5">
          {/*
            Phishing warnings and iframe protection used to be toggles here.
            Nothing ever read either setting, so turning one off changed
            nothing — and neither is a setting worth offering: a password
            manager that can be told to stop checking the domain is not doing
            its job. Both are unconditional now, and stated as such.
          */}
          <p className="rounded-md bg-surface-raised px-2.5 py-2 text-[11px] leading-relaxed text-text-muted">
            Domain checks and iframe protection are always on. Claspt will not
            fill a credential on a site that does not match its saved address,
            will not fill inside a frame, and will not fill over plain HTTP.
          </p>
          <Toggle label="Lock on browser close" sublabel="Clear cached credentials when the browser closes or system locks" checked={config.lockOnBrowserClose} onChange={(v) => save({ lockOnBrowserClose: v })} />
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              Auto-lock after idle
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={config.autoLockMinutes}
                onChange={(e) => save({ autoLockMinutes: Number(e.target.value) })}
                min={0}
                className="w-20 rounded-md border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
              />
              <span className="text-xs text-text-muted">minutes (0 = never)</span>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              Clipboard clear timeout
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={config.clipboardTimeout}
                onChange={(e) => save({ clipboardTimeout: Number(e.target.value) })}
                min={0}
                className="w-20 rounded-md border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
              />
              <span className="text-xs text-text-muted">seconds (0 = never)</span>
            </div>
          </div>
        </div>
      </section>

      {/* Excluded Domains Section */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Excluded Domains
        </h3>
        <p className="mb-2 text-[10px] text-text-dim">
          Never prompt to save passwords on these sites.
        </p>
        <div className="flex gap-1.5 mb-2">
          <input
            type="text"
            value={newExclude}
            onChange={(e) => setNewExclude(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addExcludedDomain()}
            placeholder="example.com"
            className="flex-1 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary outline-none focus:border-accent placeholder:text-text-dim"
          />
          <button
            onClick={addExcludedDomain}
            className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors"
          >
            Add
          </button>
        </div>
        {config.excludedDomains.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {config.excludedDomains.map((d) => (
              <span
                key={d}
                className="inline-flex items-center gap-1 rounded-full bg-surface-raised px-2 py-0.5 text-[10px] text-text-muted"
              >
                {d}
                <button
                  onClick={() => removeExcludedDomain(d)}
                  className="text-red-500/60 hover:text-red-500 transition-colors"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Appearance Section */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Appearance
        </h3>
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-primary">Theme</span>
            <div className="flex rounded-md border border-border overflow-hidden">
              {(["auto", "light", "dark"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    chrome.storage.local.set({ claspt_theme: t });
                    applyTheme(t);
                  }}
                  className={`px-3 py-1 text-[11px] capitalize transition-colors ${
                    (document.documentElement.dataset.theme || "auto") === t
                      ? "bg-accent/15 text-accent font-medium"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Toggle switch with label and optional sublabel. */
function Toggle({
  label, sublabel, checked, onChange,
}: {
  label: string; sublabel?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded border-border accent-accent"
      />
      <div>
        <span className="text-xs text-text-primary">{label}</span>
        {sublabel && <p className="text-[10px] text-text-dim leading-tight">{sublabel}</p>}
      </div>
    </label>
  );
}

function applyTheme(theme: "auto" | "light" | "dark") {
  const root = document.documentElement;
  root.dataset.theme = theme;
  if (theme === "dark") {
    root.style.colorScheme = "dark";
  } else if (theme === "light") {
    root.style.colorScheme = "light";
  } else {
    root.style.colorScheme = "";
  }
}
