// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import type { ExtensionConfig, Message } from "@/shared/types";
import { DEFAULT_CONFIG } from "@/shared/types";

function Options() {
  const [config, setConfig] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_CONFIG" } as Message, (res: Message) => {
      if (res?.type === "CONFIG_RESULT") {
        setConfig(res.config);
      }
    });
  }, []);

  const handleSave = useCallback(() => {
    chrome.runtime.sendMessage(
      { type: "SAVE_CONFIG", config } as Message,
      () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    );
  }, [config]);

  const handleTest = useCallback(() => {
    setTesting(true);
    setTestResult(null);
    chrome.runtime.sendMessage({ type: "GET_STATUS" } as Message, (res: Message) => {
      setTesting(false);
      if (res?.type === "STATUS_RESULT" && res.connected) {
        setTestResult("success");
      } else {
        setTestResult("error");
      }
      setTimeout(() => setTestResult(null), 3000);
    });
  }, []);

  return (
    <div style={styles.card}>
      <h1 style={styles.title}>Claspt Extension Settings</h1>
      <p style={styles.subtitle}>
        Configure the connection to your Claspt desktop app.
      </p>

      <div style={styles.form}>
        <div style={styles.field}>
          <label style={styles.label}>API Port</label>
          <input
            type="number"
            value={config.port}
            onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
            style={styles.input}
            min={1}
            max={65535}
          />
          <span style={styles.hint}>Default: 9315. Must match Claspt Settings &gt; Local API port.</span>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>API Token</label>
          <input
            type="password"
            value={config.token}
            onChange={(e) => setConfig({ ...config, token: e.target.value })}
            style={styles.input}
            placeholder="clss_..."
          />
          <span style={styles.hint}>
            Use a <strong>Secrets</strong> token (clss_*) from Claspt Settings &gt; Local API. This token allows credential decryption.
          </span>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Clipboard auto-clear (seconds)</label>
          <input
            type="number"
            value={config.clipboardTimeout}
            onChange={(e) => setConfig({ ...config, clipboardTimeout: Number(e.target.value) })}
            style={styles.input}
            min={0}
            max={300}
          />
          <span style={styles.hint}>Set to 0 to disable. Default: 30 seconds.</span>
        </div>

        <div style={styles.checkField}>
          <label style={styles.checkLabel}>
            <input
              type="checkbox"
              checked={config.autoFillEnabled}
              onChange={(e) => setConfig({ ...config, autoFillEnabled: e.target.checked })}
            />
            <span>Enable auto-fill on login forms</span>
          </label>
        </div>

        <div style={styles.actions}>
          <button style={styles.saveBtn} onClick={handleSave}>
            {saved ? "Saved!" : "Save Settings"}
          </button>
          <button style={styles.testBtn} onClick={handleTest} disabled={testing}>
            {testing ? "Testing..." : "Test Connection"}
          </button>
        </div>

        {testResult && (
          <div style={testResult === "success" ? styles.successMsg : styles.errorMsg}>
            {testResult === "success"
              ? "Connected to Claspt successfully!"
              : "Cannot connect. Check that Claspt is running, the vault is unlocked, and the port/token are correct."}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    maxWidth: 520,
    width: "100%",
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: "#e6edf3",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: "#8b949e",
    marginBottom: 24,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: "#c9d1d9",
  },
  input: {
    padding: "10px 12px",
    background: "#1c2128",
    border: "1px solid #3d434b",
    borderRadius: 8,
    color: "#e6edf3",
    fontSize: 14,
    outline: "none",
  },
  hint: {
    fontSize: 11,
    color: "#6e7681",
    lineHeight: 1.4,
  },
  checkField: {
    display: "flex",
    alignItems: "center",
  },
  checkLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "#c9d1d9",
    cursor: "pointer",
  },
  actions: {
    display: "flex",
    gap: 12,
    marginTop: 8,
  },
  saveBtn: {
    padding: "10px 20px",
    background: "#d4930a",
    color: "#0c1017",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  testBtn: {
    padding: "10px 20px",
    background: "transparent",
    color: "#d4930a",
    border: "1px solid #d4930a",
    borderRadius: 8,
    fontSize: 14,
    cursor: "pointer",
  },
  successMsg: {
    padding: "10px 12px",
    background: "#052e16",
    border: "1px solid #166534",
    borderRadius: 8,
    color: "#4ade80",
    fontSize: 13,
  },
  errorMsg: {
    padding: "10px 12px",
    background: "#450a0a",
    border: "1px solid #991b1b",
    borderRadius: 8,
    color: "#fca5a5",
    fontSize: 13,
    lineHeight: 1.4,
  },
};

const root = createRoot(document.getElementById("root")!);
root.render(<Options />);
