// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useEffect, useState } from "react";
import { STORAGE_KEY_CONFIG } from "@/shared/constants";
import { DEFAULT_CONFIG, type ExtensionConfig } from "@/shared/types";
import { TroubleshootingPanel } from "./TroubleshootingPanel";

const LOCALHOST_ORIGIN = "http://127.0.0.1/*";

interface Props {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [port, setPort] = useState(9315);
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"idle" | "success" | "error">("idle");
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [requestingPermission, setRequestingPermission] = useState(false);

  useEffect(() => {
    // Pre-check so returning users don't re-click grant.
    chrome.permissions
      .contains({ origins: [LOCALHOST_ORIGIN] })
      .then(setPermissionGranted)
      .catch(() => setPermissionGranted(false));
  }, []);

  const requestPermission = () => {
    setRequestingPermission(true);
    chrome.permissions.request({ origins: [LOCALHOST_ORIGIN] }, (granted) => {
      setRequestingPermission(false);
      setPermissionGranted(granted);
      if (granted) setStep(2);
    });
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult("idle");
    return new Promise<void>((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
        if (res?.type === "STATUS_RESULT" && res.connected) {
          setTestResult("success");
        } else {
          setTestResult("error");
        }
        setTesting(false);
        resolve();
      });
    });
  };

  const handleFinish = () => {
    const config: ExtensionConfig = {
      ...DEFAULT_CONFIG,
      port,
      token,
      onboardingComplete: true,
    };
    chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: config });
    chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config });
    onComplete();
  };

  const steps = [
    // Step 0: Welcome
    <div key="welcome" className="flex flex-col items-center text-center">
      <img
        src={new URL("../../assets/logo-claspt.png", import.meta.url).href}
        alt="Claspt"
        className="h-12 w-12 rounded-lg mb-3"
      />
      <h2 className="text-base font-bold text-text-primary">Welcome to Claspt</h2>
      <p className="text-[12px] text-text-muted mt-2 max-w-[260px] leading-relaxed">
        Auto-fill passwords, generate secure credentials, and manage your vault — all from your browser.
      </p>
      <button
        onClick={() => setStep(1)}
        className="mt-4 w-full rounded-lg bg-accent py-2 text-sm font-semibold text-white hover:bg-accent-hover transition-colors"
      >
        Get Started
      </button>
    </div>,

    // Step 1: Grant localhost permission (optional host permission pattern)
    <div key="permission" className="flex flex-col items-center text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 mb-2">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
      </div>
      <h2 className="text-sm font-bold text-text-primary">Allow local connection</h2>
      <p className="text-[11px] text-text-muted mt-2 max-w-[280px] leading-relaxed">
        Claspt talks to the desktop app over{" "}
        <code className="rounded bg-surface-raised px-1 py-px text-[10px]">http://127.0.0.1</code>
        {" "}— your own computer. Chrome will ask your permission. No data leaves your machine.
      </p>
      <button
        onClick={requestPermission}
        disabled={requestingPermission || permissionGranted}
        className="mt-4 w-full rounded-lg bg-accent py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-60 transition-colors"
      >
        {permissionGranted ? "✓ Granted" : requestingPermission ? "Waiting for Chrome…" : "Allow 127.0.0.1 access"}
      </button>
      <div className="flex gap-2 mt-2 w-full">
        <button onClick={() => setStep(0)} className="flex-1 rounded-lg border border-border py-1.5 text-xs text-text-muted hover:text-text-primary">Back</button>
        <button
          onClick={() => setStep(2)}
          disabled={!permissionGranted}
          className="flex-1 rounded-lg bg-accent py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-60"
        >
          Next
        </button>
      </div>
      <TroubleshootingPanel />
    </div>,

    // Step 2: Connect
    <div key="connect" className="flex flex-col">
      <h2 className="text-sm font-bold text-text-primary mb-1">Connect to Claspt Desktop</h2>
      <p className="text-[11px] text-text-muted mb-3 leading-relaxed">
        Open Claspt desktop → Settings → Integrations → Local API. Enable it and copy the token.
      </p>
      <label className="block text-[10px] font-medium text-text-muted mb-1">Port</label>
      <input
        type="number" value={port}
        onChange={(e) => setPort(Number(e.target.value))}
        className="w-full rounded-md border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent mb-2"
      />
      <label className="block text-[10px] font-medium text-text-muted mb-1">API Token</label>
      <input
        type="password" value={token}
        onChange={(e) => {
          setToken(e.target.value);
          // Save immediately so the test connection can use it
          const config: ExtensionConfig = { ...DEFAULT_CONFIG, port, token: e.target.value };
          chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: config });
          chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config });
        }}
        placeholder="Paste token here"
        className="w-full rounded-md border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary placeholder:text-text-dim outline-none focus:border-accent mb-3"
      />
      <button
        onClick={handleTest}
        disabled={testing}
        className={`w-full rounded-lg py-2 text-sm font-semibold transition-colors mb-2 ${
          testResult === "success"
            ? "bg-green-500 text-white"
            : testResult === "error"
              ? "bg-red-500/10 text-red-500 border border-red-500/30"
              : "bg-accent text-white hover:bg-accent-hover"
        } disabled:opacity-50`}
      >
        {testing ? "Testing..." : testResult === "success" ? "Connected!" : testResult === "error" ? "Failed — check settings" : "Test Connection"}
      </button>
      <div className="flex gap-2">
        <button onClick={() => setStep(1)} className="flex-1 rounded-lg border border-border py-1.5 text-xs text-text-muted hover:text-text-primary">Back</button>
        <button
          onClick={() => setStep(3)}
          className="flex-1 rounded-lg bg-accent py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
        >
          {testResult === "success" ? "Next" : "Skip for now"}
        </button>
      </div>
    </div>,

    // Step 3: Features
    <div key="features" className="flex flex-col">
      <h2 className="text-sm font-bold text-text-primary mb-3">What you can do</h2>
      <div className="space-y-2.5">
        {[
          { icon: "🔑", title: "Auto-fill logins", desc: "Click the icon in any password field to pick a saved login" },
          { icon: "⚡", title: "Smart generator", desc: "Strong passwords with limits on symbols — your last settings stick" },
          { icon: "🕒", title: "Password history", desc: "Recovers passwords you copied or used but forgot to save" },
          { icon: "⚠️", title: "Reused-password warning", desc: "Flags accounts sharing the same password across your vault" },
          { icon: "💳", title: "Cards & identities", desc: "Stored in your vault folder — never in the browser" },
          { icon: "📋", title: "Right-click anywhere", desc: "Fill from Claspt or generate a password into any field" },
        ].map((f) => (
          <div key={f.title} className="flex items-start gap-2.5">
            <span className="text-base">{f.icon}</span>
            <div>
              <div className="text-[12px] font-medium text-text-primary">{f.title}</div>
              <div className="text-[10px] text-text-muted">{f.desc}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-4">
        <button onClick={() => setStep(2)} className="flex-1 rounded-lg border border-border py-1.5 text-xs text-text-muted hover:text-text-primary">Back</button>
        <button
          onClick={handleFinish}
          className="flex-1 rounded-lg bg-accent py-2 text-sm font-semibold text-white hover:bg-accent-hover transition-colors"
        >
          Start Using Claspt
        </button>
      </div>
    </div>,
  ];

  return (
    <div className="p-5 min-h-[300px] flex flex-col justify-center">
      {/* Progress dots */}
      <div className="flex justify-center gap-1.5 mb-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`h-1.5 rounded-full transition-all ${i === step ? "w-5 bg-accent" : "w-1.5 bg-border"}`} />
        ))}
      </div>
      {steps[step]}
    </div>
  );
}
