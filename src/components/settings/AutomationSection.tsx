// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * AutomationSection — settings panel with three sub-tabs for local vault
 * automation: Security Alerts (weak/reused/breached password scan results),
 * Automation Rules (auto-tag, auto-folder, archive, password-rotation, auto-pin),
 * and secret-block Templates. All data is stored locally via Tauri commands and
 * never leaves the device.
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as cmd from "@/lib/commands";

interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  rule_type: { type: string; [key: string]: unknown };
  created_at: string;
}

interface SecretTemplate {
  id: string;
  name: string;
  icon: string;
  fields: {
    key: string;
    label: string;
    field_type: string;
    default_value: string | null;
    required: boolean;
  }[];
  use_count: number;
  created_at: string;
}

interface SecurityAlert {
  id: string;
  timestamp: string;
  alert_type: string;
  severity: string;
  title: string;
  description: string;
  page_path: string | null;
  label: string | null;
  dismissed: boolean;
  resolved: boolean;
}

type SubTab = "rules" | "templates" | "alerts";

// ── Rule type definitions for the "Add Rule" form ──

const RULE_TYPES = [
  {
    type: "auto_tag_domain",
    label: "Auto-tag by domain",
    description:
      "Automatically tag new credentials from the browser extension with the website domain.",
  },
  {
    type: "auto_folder",
    label: "Auto-move to folder",
    description:
      "Automatically move new credentials from a specific source to a target folder.",
  },
  {
    type: "auto_archive",
    label: "Auto-archive inactive",
    description:
      "Automatically archive pages not accessed in a specified number of days.",
  },
  {
    type: "password_rotation",
    label: "Password rotation reminder",
    description: "Remind you to change passwords at regular intervals.",
  },
  {
    type: "auto_pin",
    label: "Auto-pin frequent credentials",
    description: "Automatically pin credentials that you use frequently.",
  },
] as const;

/** Sub-tabbed UI for security alerts, automation rules, and secret templates. */
export function AutomationSection() {
  const [subTab, setSubTab] = useState<SubTab>("alerts");
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [templates, setTemplates] = useState<SecretTemplate[]>([]);
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [loading, setLoading] = useState(true);

  // Scan state
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<number | null>(null);

  // Add rule form
  const [showAddRule, setShowAddRule] = useState(false);
  const [newRuleType, setNewRuleType] = useState("auto_tag_domain");
  const [newRuleName, setNewRuleName] = useState("");
  const [newRuleDays, setNewRuleDays] = useState(90);
  const [newRuleFolder, setNewRuleFolder] = useState("credentials");
  const [newRuleSource, setNewRuleSource] = useState("extension");
  const [newRuleMinUses, setNewRuleMinUses] = useState(5);

  // Add template form
  const [showAddTemplate, setShowAddTemplate] = useState(false);
  const [tplName, setTplName] = useState("");
  const [tplIcon, setTplIcon] = useState("🔐");
  const [tplFields, setTplFields] = useState<
    { key: string; label: string; field_type: string; required: boolean }[]
  >([{ key: "", label: "", field_type: "text", required: true }]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, t, a] = await Promise.all([
        invoke<AutomationRule[]>("get_automation_rules"),
        invoke<SecretTemplate[]>("get_templates"),
        invoke<SecurityAlert[]>("get_security_alerts"),
      ]);
      setRules(r);
      setTemplates(t);
      setAlerts(a);
    } catch {
      // May fail if vault not open
    }
    setLoading(false);
  }, []);

  // Load automation data on mount. The async work is wrapped in an IIFE so the
  // effect body itself performs no synchronous state update.
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const toggleRule = useCallback(
    async (ruleId: string) => {
      try {
        await invoke("toggle_automation_rule", { ruleId });
        load();
      } catch {
        /* ignore */
      }
    },
    [load],
  );

  const dismissAlert = useCallback(
    async (alertId: string) => {
      try {
        await invoke("dismiss_security_alert", { alertId });
        load();
      } catch {
        /* ignore */
      }
    },
    [load],
  );

  const handleScan = useCallback(async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const count = await cmd.runSecurityScan();
      setScanResult(count);
      load();
    } catch {
      /* ignore */
    }
    setScanning(false);
  }, [load]);

  const handleDeleteRule = useCallback(
    async (ruleId: string) => {
      try {
        await cmd.deleteAutomationRule(ruleId);
        load();
      } catch {
        /* ignore */
      }
    },
    [load],
  );

  const handleAddRule = useCallback(async () => {
    const name =
      newRuleName.trim() ||
      RULE_TYPES.find((r) => r.type === newRuleType)?.label ||
      "New Rule";
    // Build the type-specific rule_type payload (discriminated by `type`)
    let rule_type: Record<string, unknown> = { type: newRuleType };
    if (newRuleType === "auto_folder") {
      rule_type = {
        type: "auto_folder",
        source: newRuleSource,
        target_folder: newRuleFolder,
      };
    } else if (newRuleType === "auto_archive") {
      rule_type = { type: "auto_archive", days: newRuleDays };
    } else if (newRuleType === "password_rotation") {
      rule_type = {
        type: "password_rotation",
        interval_days: newRuleDays,
        credential_filter: [],
      };
    } else if (newRuleType === "auto_pin") {
      rule_type = { type: "auto_pin", min_uses: newRuleMinUses };
    }

    try {
      await cmd.saveAutomationRule({
        id: `rule-${Date.now()}`,
        name,
        enabled: true,
        rule_type,
        created_at: new Date().toISOString(),
      });
      setShowAddRule(false);
      setNewRuleName("");
      load();
    } catch {
      /* ignore */
    }
  }, [
    newRuleType,
    newRuleName,
    newRuleDays,
    newRuleFolder,
    newRuleSource,
    newRuleMinUses,
    load,
  ]);

  const handleAddTemplate = useCallback(async () => {
    const name = tplName.trim();
    if (!name) return;
    const validFields = tplFields.filter((f) => f.key.trim() && f.label.trim());
    if (validFields.length === 0) return;

    try {
      await cmd.saveTemplate({
        id: `custom-${Date.now()}`,
        name,
        icon: tplIcon,
        fields: validFields.map((f) => ({ ...f, default_value: null })),
        use_count: 0,
        created_at: new Date().toISOString(),
      });
      setShowAddTemplate(false);
      setTplName("");
      setTplIcon("🔐");
      setTplFields([{ key: "", label: "", field_type: "text", required: true }]);
      load();
    } catch {
      /* ignore */
    }
  }, [tplName, tplIcon, tplFields, load]);

  const handleDeleteTemplate = useCallback(
    async (templateId: string) => {
      try {
        await cmd.deleteTemplate(templateId);
        load();
      } catch {
        /* ignore */
      }
    },
    [load],
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-[13px] text-text-secondary leading-relaxed">
          Security alerts, vault automation rules, and secret block templates. Stay on top
          of weak passwords and streamline how you create credentials.
        </p>
        <p className="text-[10px] text-text-dim">
          All data is stored locally on this device and never sent to any server.
        </p>
      </div>
      {/* Sub-tab bar */}
      <div className="flex gap-1 rounded-lg border border-border p-0.5">
        {[
          { key: "alerts" as SubTab, label: "Security Alerts", count: alerts.length },
          { key: "rules" as SubTab, label: "Automation Rules", count: rules.length },
          { key: "templates" as SubTab, label: "Templates", count: templates.length },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            className={`flex-1 rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors ${
              subTab === t.key
                ? "bg-accent/10 text-accent"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            {t.label}
            {t.count > 0 && (
              <span className="ml-1 text-[10px] opacity-60">({t.count})</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : (
        <>
          {/* ── Security Alerts ── */}
          {subTab === "alerts" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-text-muted">
                  Scan your vault for weak, reused, or compromised passwords.
                </p>
                <button
                  onClick={handleScan}
                  disabled={scanning}
                  className="shrink-0 rounded-lg border border-border/60 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-overlay transition-all disabled:opacity-50"
                >
                  {scanning ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                      Scanning...
                    </span>
                  ) : (
                    "Run Security Scan"
                  )}
                </button>
              </div>

              {scanResult !== null && (
                <div
                  className={`rounded-lg border px-3 py-2 text-[12px] ${
                    scanResult === 0
                      ? "border-green-500/30 bg-green-500/5 text-green-600"
                      : "border-orange-500/30 bg-orange-500/5 text-orange-600"
                  }`}
                >
                  {scanResult === 0
                    ? "No issues found — all passwords look good."
                    : `Found ${scanResult} issue${scanResult !== 1 ? "s" : ""}. Review the alerts below.`}
                </div>
              )}

              {alerts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-6 text-center">
                  <p className="text-[12px] text-text-muted">
                    No active alerts. Run a security scan to check for issues.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-[350px] overflow-y-auto">
                  {alerts.map((alert) => (
                    <div
                      key={alert.id}
                      className={`rounded-lg border p-3 ${
                        alert.severity === "critical"
                          ? "border-red-500/30 bg-red-500/5"
                          : alert.severity === "high"
                            ? "border-orange-500/30 bg-orange-500/5"
                            : alert.severity === "medium"
                              ? "border-yellow-500/30 bg-yellow-500/5"
                              : "border-border"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={`mt-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                            alert.severity === "critical"
                              ? "bg-red-500/10 text-red-500"
                              : alert.severity === "high"
                                ? "bg-orange-500/10 text-orange-500"
                                : alert.severity === "medium"
                                  ? "bg-yellow-500/10 text-yellow-600"
                                  : "bg-surface-raised text-text-muted"
                          }`}
                        >
                          {alert.severity}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] font-medium text-text-primary">
                            {alert.title}
                          </div>
                          <div className="text-[11px] text-text-muted mt-0.5">
                            {alert.description}
                          </div>
                          {alert.page_path && (
                            <div className="text-[10px] text-text-dim mt-1">
                              Credential: {alert.label} in {alert.page_path}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => dismissAlert(alert.id)}
                          className="shrink-0 text-[10px] text-text-dim hover:text-text-primary"
                          title="Dismiss"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Automation Rules ── */}
          {subTab === "rules" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-text-muted">
                  Automate vault maintenance — auto-tag, auto-folder, password rotation
                  reminders.
                </p>
                <button
                  onClick={() => setShowAddRule(!showAddRule)}
                  className="shrink-0 rounded-lg border border-border/60 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-overlay transition-all"
                >
                  {showAddRule ? "Cancel" : "+ Add Rule"}
                </button>
              </div>

              {/* Add Rule Form */}
              {showAddRule && (
                <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 space-y-3">
                  <div>
                    <label className="text-[11px] font-medium text-text-muted">
                      Rule Type
                    </label>
                    <select
                      value={newRuleType}
                      onChange={(e) => setNewRuleType(e.target.value)}
                      className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent"
                    >
                      {RULE_TYPES.map((rt) => (
                        <option key={rt.type} value={rt.type}>
                          {rt.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[10px] text-text-dim">
                      {RULE_TYPES.find((r) => r.type === newRuleType)?.description}
                    </p>
                  </div>

                  <div>
                    <label className="text-[11px] font-medium text-text-muted">
                      Name (optional)
                    </label>
                    <input
                      type="text"
                      value={newRuleName}
                      onChange={(e) => setNewRuleName(e.target.value)}
                      placeholder={RULE_TYPES.find((r) => r.type === newRuleType)?.label}
                      className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent"
                    />
                  </div>

                  {/* Type-specific fields */}
                  {newRuleType === "auto_folder" && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[11px] font-medium text-text-muted">
                          Source
                        </label>
                        <select
                          value={newRuleSource}
                          onChange={(e) => setNewRuleSource(e.target.value)}
                          className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent"
                        >
                          <option value="extension">Browser Extension</option>
                          <option value="import">Import</option>
                          <option value="any">Any Source</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-text-muted">
                          Target Folder
                        </label>
                        <input
                          type="text"
                          value={newRuleFolder}
                          onChange={(e) => setNewRuleFolder(e.target.value)}
                          className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent"
                        />
                      </div>
                    </div>
                  )}

                  {(newRuleType === "auto_archive" ||
                    newRuleType === "password_rotation") && (
                    <div>
                      <label className="text-[11px] font-medium text-text-muted">
                        {newRuleType === "auto_archive"
                          ? "Days of inactivity"
                          : "Rotation interval (days)"}
                      </label>
                      <input
                        type="number"
                        value={newRuleDays}
                        onChange={(e) => setNewRuleDays(Number(e.target.value))}
                        min={1}
                        max={365}
                        className="mt-1 w-24 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent"
                      />
                    </div>
                  )}

                  {newRuleType === "auto_pin" && (
                    <div>
                      <label className="text-[11px] font-medium text-text-muted">
                        Minimum uses to auto-pin
                      </label>
                      <input
                        type="number"
                        value={newRuleMinUses}
                        onChange={(e) => setNewRuleMinUses(Number(e.target.value))}
                        min={1}
                        max={100}
                        className="mt-1 w-24 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent"
                      />
                    </div>
                  )}

                  <button
                    onClick={handleAddRule}
                    className="rounded-lg bg-accent px-4 py-1.5 text-[12px] font-medium text-white hover:bg-accent-hover transition-colors"
                  >
                    Add Rule
                  </button>
                </div>
              )}

              {/* Rules list */}
              {rules.length === 0 && !showAddRule ? (
                <div className="rounded-lg border border-dashed border-border py-6 text-center">
                  <p className="text-[12px] text-text-muted">
                    No automation rules yet. Click &ldquo;+ Add Rule&rdquo; to create one.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {rules.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-center gap-3 rounded-lg border border-border p-3"
                    >
                      <button
                        onClick={() => toggleRule(rule.id)}
                        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                          rule.enabled ? "bg-accent" : "bg-border"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                            rule.enabled ? "left-[18px]" : "left-0.5"
                          }`}
                        />
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-medium text-text-primary">
                          {rule.name}
                        </div>
                        <div className="text-[10px] text-text-dim capitalize">
                          {rule.rule_type.type.replace(/_/g, " ")}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteRule(rule.id)}
                        className="shrink-0 rounded p-1 text-[10px] text-text-dim hover:text-danger hover:bg-danger/10 transition-colors"
                        title="Delete rule"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Templates ── */}
          {subTab === "templates" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-text-muted">
                  Your own secret templates. They join the editor&apos;s picker
                  (Cmd+Shift+S) after the built-in ones and sync with the vault.
                </p>
                <button
                  onClick={() => setShowAddTemplate(!showAddTemplate)}
                  className="shrink-0 rounded-lg border border-border/60 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-overlay transition-all"
                >
                  {showAddTemplate ? "Cancel" : "+ New Template"}
                </button>
              </div>

              {/* Add Template Form */}
              {showAddTemplate && (
                <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 space-y-3">
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <div>
                      <label className="text-[11px] font-medium text-text-muted">
                        Template Name
                      </label>
                      <input
                        type="text"
                        value={tplName}
                        onChange={(e) => setTplName(e.target.value)}
                        placeholder="e.g., WiFi Network, SSH Key"
                        className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-text-muted">
                        Icon
                      </label>
                      <input
                        type="text"
                        value={tplIcon}
                        onChange={(e) => setTplIcon(e.target.value)}
                        className="mt-1 w-14 rounded-md border border-border bg-surface px-2.5 py-1.5 text-center text-[14px] outline-none focus:border-accent"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] font-medium text-text-muted">
                      Fields
                    </label>
                    <div className="mt-1 space-y-1.5">
                      {tplFields.map((f, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={f.key}
                            onChange={(e) => {
                              const updated = [...tplFields];
                              updated[i] = { ...f, key: e.target.value };
                              setTplFields(updated);
                            }}
                            placeholder="key"
                            className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent"
                          />
                          <input
                            type="text"
                            value={f.label}
                            onChange={(e) => {
                              const updated = [...tplFields];
                              updated[i] = { ...f, label: e.target.value };
                              setTplFields(updated);
                            }}
                            placeholder="Label"
                            className="flex-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent"
                          />
                          <select
                            value={f.field_type}
                            onChange={(e) => {
                              const updated = [...tplFields];
                              updated[i] = { ...f, field_type: e.target.value };
                              setTplFields(updated);
                            }}
                            className="w-20 rounded-md border border-border bg-surface px-1 py-1 text-[10px] text-text-primary outline-none focus:border-accent"
                          >
                            <option value="text">Text</option>
                            <option value="password">Password</option>
                            <option value="url">URL</option>
                            <option value="email">Email</option>
                            <option value="number">Number</option>
                          </select>
                          <label className="flex items-center gap-0.5 text-[10px] text-text-dim">
                            <input
                              type="checkbox"
                              checked={f.required}
                              onChange={(e) => {
                                const updated = [...tplFields];
                                updated[i] = { ...f, required: e.target.checked };
                                setTplFields(updated);
                              }}
                              className="accent-accent"
                            />
                            Req
                          </label>
                          {tplFields.length > 1 && (
                            <button
                              onClick={() =>
                                setTplFields(tplFields.filter((_, idx) => idx !== i))
                              }
                              className="text-[10px] text-text-dim hover:text-danger"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() =>
                        setTplFields([
                          ...tplFields,
                          { key: "", label: "", field_type: "text", required: false },
                        ])
                      }
                      className="mt-1.5 text-[11px] text-accent hover:text-accent-hover"
                    >
                      + Add field
                    </button>
                  </div>

                  <button
                    onClick={handleAddTemplate}
                    disabled={!tplName.trim() || tplFields.every((f) => !f.key.trim())}
                    className="rounded-lg bg-accent px-4 py-1.5 text-[12px] font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                  >
                    Create Template
                  </button>
                </div>
              )}

              {/* Templates grid */}
              <div className="grid grid-cols-2 gap-2 max-h-[350px] overflow-y-auto">
                {templates.map((t) => (
                  <div key={t.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-base">{t.icon}</span>
                      <span className="text-[12px] font-medium text-text-primary flex-1 truncate">
                        {t.name}
                      </span>
                      {t.id.startsWith("builtin-") ? (
                        <span className="rounded bg-surface-raised px-1 py-0.5 text-[8px] text-text-dim">
                          Built-in
                        </span>
                      ) : (
                        <button
                          onClick={() => handleDeleteTemplate(t.id)}
                          className="rounded p-0.5 text-[10px] text-text-dim hover:text-danger hover:bg-danger/10 transition-colors"
                          title="Delete template"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="space-y-0.5">
                      {t.fields.map((f) => (
                        <div key={f.key} className="flex items-center gap-1 text-[10px]">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${f.required ? "bg-accent" : "bg-border"}`}
                          />
                          <span className="text-text-muted">{f.label}</span>
                          {f.field_type === "password" && (
                            <span className="text-text-dim">&#x1F512;</span>
                          )}
                        </div>
                      ))}
                    </div>
                    {t.use_count > 0 && (
                      <div className="mt-1.5 text-[9px] text-text-dim">
                        Used {t.use_count} times
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
