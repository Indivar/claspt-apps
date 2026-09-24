// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * SettingsPanel — the app's full settings modal.
 *
 * A sidebar-navigated modal with sections for General, Editor, Extensions,
 * Integrations, Security, Sync, Account, Import/Export, Utilities, Activity,
 * Automation, and About. Edits are held in a local `draft` copy of the vault
 * config and only persisted on Save; some live-preview changes (theme, UI
 * scale) apply immediately and revert on cancel. Also hosts license
 * activation, cloud-sync setup (OTP device verification, force-push
 * recovery), and Pro purchase links.
 */
import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { errorMessage } from "@/lib/error-message";
import { useVaultStore } from "@/stores/vault-store";
import { useUIStore, THEMES, applyUIScale, type ThemeName } from "@/stores/ui-store";

function openExternal(url: string) {
  openUrl(url).catch(() => window.open(url, "_blank"));
}

import { useSyncStore } from "@/stores/sync-store";
import * as cmd from "@/lib/commands";
import { getVaultConfig, setVaultConfig } from "@/lib/commands";
import { SyncProgressPanel } from "@/components/SyncProgressPanel";
import { FRESH_COPY_STAGES, megabytes } from "@/lib/sync-progress";
import { DEFAULT_ATTACHMENT_MB, formatSize, MAX_ATTACHMENT_MB } from "@/lib/attachments";
import { ActivitySection } from "@/components/settings/ActivitySection";
import { AutomationSection } from "@/components/settings/AutomationSection";

import { SpinnerIcon } from "@/components/ui/icons";
import { useEscapeClose } from "@/hooks/use-escape-close";
import { useExtensionStore } from "@/stores/extension-store";
import type { LicenseStatus, VaultConfig } from "@claspt/shared/types";
import { licenseTierLabel } from "@/lib/license";
import { VERSION_DISPLAY } from "@/lib/version";
import { ChangeMasterPassword } from "@/components/settings/ChangeMasterPassword";
import { BrandLogo } from "@/components/BrandLogo";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmailRegistration } from "@/components/settings/EmailRegistration";
import { IncomingShares } from "@/components/settings/IncomingShares";
import { ServerStatus } from "@/components/settings/ServerStatus";
import { UpdateSection } from "@/components/settings/UpdateSection";
import { ExtensionsTab } from "@/components/settings/ExtensionsTab";
import { IntegrationsTab } from "@/components/settings/IntegrationsTab";
import { MemoryTab } from "@/components/settings/MemoryTab";
import { PasskeysTab } from "@/components/settings/PasskeysTab";
import { LicensesTab } from "@/components/settings/LicensesTab";
import { UtilitiesTab } from "@/components/settings/UtilitiesTab";
import { ExportTab } from "@/components/settings/ExportTab";

type Section =
  | "general"
  | "editor"
  | "extensions"
  | "integrations"
  | "memory"
  | "security"
  | "passkeys"
  | "account"
  | "export"
  | "utilities"
  | "activity"
  | "automation"
  | "about";
type UtilityId =
  "stats" | "health" | "duplicates" | "consolidate" | "tags" | "breach" | "trash";

const UTILITY_ITEMS: { id: UtilityId; label: string }[] = [
  { id: "stats", label: "Vault Statistics" },
  { id: "health", label: "Password Health" },
  { id: "duplicates", label: "Duplicate Finder" },
  { id: "consolidate", label: "Consolidate" },
  { id: "tags", label: "Tag Manager" },
  { id: "breach", label: "Breach Check" },
  { id: "trash", label: "Trash" },
];

const FONT_FAMILIES = [
  "JetBrains Mono",
  "Fira Code",
  "SF Mono",
  "Monaco",
  "Cascadia Code",
  "Source Code Pro",
  "Inconsolata",
];

/** Labeled `<select>` row used throughout the settings form. */
function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-[13px] text-text-primary">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="focus-accent rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[13px] text-text-primary outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Labeled numeric `<input>` row with optional unit suffix. */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-[13px] text-text-primary">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step ?? 1}
          onChange={(e) => onChange(Number(e.target.value))}
          className="focus-accent w-20 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-right text-[13px] text-text-primary outline-none"
        />
        {suffix && <span className="text-[11px] text-text-muted/60">{suffix}</span>}
      </div>
    </div>
  );
}

/** Grid of selectable theme swatches (color dot + label). */
function ThemePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (theme: string) => void;
}) {
  return (
    <div className="py-2.5">
      <div className="grid grid-cols-3 gap-2">
        {THEMES.map((t) => (
          <button
            key={t.name}
            onClick={() => onChange(t.name)}
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-all ${
              value === t.name
                ? "border-accent bg-accent/8 ring-1 ring-accent/30"
                : "border-border/60 hover:border-border hover:bg-surface-overlay/50"
            }`}
          >
            <span
              className="h-4 w-4 shrink-0 rounded-full border border-border/60"
              style={{ backgroundColor: t.preview }}
            />
            <span
              className={`truncate text-[11px] ${value === t.name ? "font-medium text-accent" : "text-text-secondary"}`}
            >
              {t.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Inner component that resets state via key prop when opened. */
function SettingsContent({
  initialConfig,
  onSave,
  onCancel,
}: {
  initialConfig: VaultConfig;
  onSave: (config: VaultConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const [section, setSection] = useState<Section>(() => {
    const requested = useUIStore.getState().settingsSection as Section | null;
    if (requested) useUIStore.getState().setSettingsSection(null);
    return requested || "general";
  });
  const [activeUtility, setActiveUtility] = useState<UtilityId>("stats");
  const [draft, setDraft] = useState<VaultConfig>({ ...initialConfig });
  const [saving, setSaving] = useState(false);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  /** A licence that is present and has not expired. */
  const hasActiveLicense = Boolean(licenseStatus?.is_pro && !licenseStatus.is_expired);
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [reindexState, setReindexState] = useState<"idle" | "loading" | "done">("idle");
  const [reindexCount, setReindexCount] = useState(0);
  const { setAboutOpen } = useUIStore();
  const { biometricAvailable, toggleBiometric, vaultDir } = useVaultStore();

  const updateDraft = useCallback(
    <K extends keyof VaultConfig>(key: K, value: VaultConfig[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
  }, [draft, onSave]);

  // Live preview: apply UI scale while settings open, revert on cancel/unmount
  useEffect(() => {
    applyUIScale(draft.ui_scale ?? 1.0);
  }, [draft.ui_scale]);

  // Revert scale to initial on unmount (cancel path)
  useEffect(() => {
    const initial = initialConfig.ui_scale ?? 1.0;
    return () => {
      applyUIScale(initial);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEscapeClose(onCancel);

  // Attachment usage, read when the Security tab opens; it sits beside the
  // size limit so the owner sees what the vault already holds.
  const [attachmentUsage, setAttachmentUsage] = useState<cmd.MediaUsage | null>(null);
  useEffect(() => {
    if (section !== "security") return;
    let cancelled = false;
    cmd
      .mediaUsage()
      .then((usage) => {
        if (!cancelled) setAttachmentUsage(usage);
      })
      .catch(() => {
        if (!cancelled) setAttachmentUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [section]);

  // Load license status on mount (needed by both Sync and Account tabs)
  useEffect(() => {
    let cancelled = false;
    cmd.getLicenseStatus().then((s) => {
      if (!cancelled) setLicenseStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleActivateLicense = useCallback(async () => {
    if (!licenseKey.trim()) return;
    setLicenseLoading(true);
    setLicenseError(null);
    try {
      const status = await cmd.activateLicense(licenseKey.trim());
      setLicenseStatus(status);
      setDraft((d) => ({ ...d, license_key: licenseKey.trim() }));
      setLicenseKey("");

      // Auto-register the license email with the share server
      if (status.email) {
        try {
          await cmd.registerEmail(status.email);
        } catch {
          // Non-fatal — email registration can be done manually later
        }
      }

      // Auto-enable server features once a licence is active
      if (status.is_pro && !draft.server_enabled) {
        setDraft((d) => ({ ...d, server_enabled: true }));
        await cmd.setVaultConfig({
          ...draft,
          license_key: licenseKey.trim(),
          server_enabled: true,
        });
        toast.success(
          "Pro activated! Server features enabled. Go to Sync to set up cloud sync.",
          { duration: 5000 },
        );
      }
    } catch (e) {
      setLicenseError(errorMessage(e));
    }
    setLicenseLoading(false);
  }, [licenseKey, draft]);

  const handleDeactivateLicense = useCallback(async () => {
    setLicenseLoading(true);
    setLicenseError(null);
    try {
      const status = await cmd.deactivateLicense();
      setLicenseStatus(status);
      setDraft((d) => ({ ...d, license_key: null }));
    } catch (e) {
      setLicenseError(errorMessage(e));
    }
    setLicenseLoading(false);
  }, []);

  const handleReindex = useCallback(async () => {
    setReindexState("loading");
    try {
      const count = await cmd.rebuildSearchIndex();
      setReindexCount(count);
      setReindexState("done");
    } catch {
      setReindexState("idle");
    }
  }, []);

  // Account and Sync were two tabs that were mostly the same subject — a
  // licence, and the thing a licence buys — and both were nearly empty without
  // one. `pro` marks a tab whose contents need a licence, so that is visible
  // before clicking rather than after.
  const sections: { key: Section; label: string; pro?: boolean }[] = [
    { key: "general", label: "General" },
    { key: "editor", label: "Editor" },
    { key: "extensions", label: "Extensions" },
    { key: "integrations", label: "Integrations" },
    { key: "memory", label: "Agent Memory" },
    { key: "security", label: "Security" },
    { key: "passkeys", label: "Passkeys" },
    { key: "account", label: "Account & Sync", pro: true },
    { key: "export", label: "Import / Export" },
    { key: "utilities", label: "Utilities" },
    { key: "activity", label: "Activity" },
    { key: "automation", label: "Automation" },
    { key: "about", label: "About" },
  ];

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60">
      <div className="modal-card flex h-[680px] max-h-[85vh] w-[680px] overflow-hidden rounded-2xl border border-border bg-surface">
        {/* Sidebar */}
        <div className="flex w-44 shrink-0 flex-col border-r border-border bg-surface-raised p-3">
          <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Settings
          </h2>
          <nav className="space-y-0.5">
            {sections.map((s) => (
              <div key={s.key}>
                <button
                  onClick={() => setSection(s.key)}
                  className={`w-full rounded-lg px-3 py-2 text-left text-[13px] transition-all ${
                    section === s.key
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-text-secondary hover:bg-surface-overlay"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate">{s.label}</span>
                    {s.pro && !hasActiveLicense && (
                      <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-[1px] text-[9px] font-semibold uppercase leading-none tracking-wider text-text-muted">
                        Pro
                      </span>
                    )}
                  </span>
                </button>
                {/* Utility sub-items nested under Utilities */}
                {s.key === "utilities" && section === "utilities" && (
                  <div className="ml-3 mt-0.5 space-y-0.5 border-l border-border/40 pl-2">
                    {UTILITY_ITEMS.map((u) => (
                      <button
                        key={u.id}
                        onClick={() => setActiveUtility(u.id)}
                        className={`w-full rounded-md px-2 py-1.5 text-left text-[12px] transition-all ${
                          activeUtility === u.id
                            ? "bg-accent/10 font-medium text-accent"
                            : "text-text-muted hover:bg-surface-overlay hover:text-text-secondary"
                        }`}
                      >
                        {u.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-auto px-6 py-4">
            {section === "general" && (
              <>
                <p className="mb-4 text-[13px] text-text-secondary leading-relaxed">
                  Customise the look and feel of Claspt — theme, fonts, interface scale,
                  and search indexing.
                </p>
                <SectionHeader title="Theme" />
                <ThemePicker
                  value={draft.theme}
                  onChange={(v) => {
                    updateDraft("theme", v);
                    useUIStore.getState().setTheme(v as ThemeName);
                  }}
                />
                <SectionHeader title="Font" />
                <SelectField
                  label="Font Family"
                  value={draft.editor_font_family}
                  options={FONT_FAMILIES.map((f) => ({
                    label: f,
                    value: f,
                  }))}
                  onChange={(v) => updateDraft("editor_font_family", v)}
                />
                <NumberField
                  label="Font Size"
                  value={draft.editor_font_size}
                  min={10}
                  max={24}
                  suffix="px"
                  onChange={(v) => updateDraft("editor_font_size", v)}
                />

                <SectionHeader title="Interface Scale" />
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-[13px] text-text-primary">Scale</span>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0.8}
                      max={1.4}
                      step={0.05}
                      value={draft.ui_scale ?? 1.0}
                      onChange={(e) => updateDraft("ui_scale", Number(e.target.value))}
                      className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-border accent-accent"
                    />
                    <span className="w-10 text-right text-[13px] font-medium text-text-primary">
                      {Math.round((draft.ui_scale ?? 1.0) * 100)}%
                    </span>
                  </div>
                </div>
                <p className="pb-2 text-[11px] leading-relaxed text-text-muted/60">
                  Scales the entire interface. Editor font size is independent.
                </p>

                <SectionHeader title="Search" />
                <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
                  Rebuild the search index if pages aren&apos;t appearing in search
                  results.
                </p>
                <button
                  onClick={handleReindex}
                  disabled={reindexState !== "idle"}
                  className={`rounded-lg px-4 py-2 text-[13px] font-medium transition-all active:scale-95 ${
                    reindexState === "done"
                      ? "bg-success/10 text-success"
                      : "border border-border/60 text-text-secondary hover:bg-surface-overlay"
                  }`}
                >
                  {reindexState === "idle" && "Rebuild Search Index"}
                  {reindexState === "loading" && (
                    <span className="inline-flex items-center gap-2">
                      <SpinnerIcon size={14} className="animate-spin" />
                      Indexing...
                    </span>
                  )}
                  {reindexState === "done" &&
                    `Done — ${reindexCount} page${reindexCount !== 1 ? "s" : ""} indexed`}
                </button>

                <SectionHeader title="Help Pages" />
                <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
                  Reset help pages to the latest version. Existing help pages will be
                  replaced with fresh content.
                </p>
                <button
                  onClick={async () => {
                    try {
                      const msg = await cmd.utilityResetHelpPages();
                      alert(msg);
                    } catch (e) {
                      alert(`Failed: ${e}`);
                    }
                  }}
                  className="rounded-lg border border-border/60 px-4 py-2 text-[13px] font-medium text-text-secondary hover:bg-surface-overlay transition-all active:scale-95"
                >
                  Reset Help Pages
                </button>

                <SectionHeader title="Tour" />
                <button
                  onClick={async () => {
                    try {
                      const config = await getVaultConfig();
                      await setVaultConfig({ ...config, tour_version_seen: null });
                    } catch {
                      /* best-effort reset — ignore if config write fails */
                    }
                    useUIStore.getState().startTour("quick");
                    useUIStore.getState().setSettingsOpen(false);
                  }}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-white hover:border-zinc-500"
                >
                  Restart Tour
                </button>

                <SectionHeader title="Reset" />
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[13px] text-text-primary">Reset to Defaults</p>
                    <p className="text-[11px] text-text-muted">
                      Resets theme, editor, extensions, and help pages. Does not touch
                      your notes or secrets.
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      if (
                        !confirm(
                          "Reset all settings to defaults? This won't affect your notes or secrets.",
                        )
                      )
                        return;
                      try {
                        await cmd.resetToDefaults();
                        const newConfig = await cmd.getVaultConfig();
                        setDraft({ ...newConfig });
                        useUIStore.getState().setTheme(newConfig.theme as ThemeName);
                        applyUIScale(newConfig.ui_scale ?? 1.0);
                      } catch {
                        // handle error
                      }
                    }}
                    className="shrink-0 rounded-lg border border-border/60 px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-overlay transition-colors"
                  >
                    Reset
                  </button>
                </div>
              </>
            )}

            {section === "editor" && (
              <>
                <p className="mb-4 text-[13px] text-text-secondary leading-relaxed">
                  Control how the editor saves your work. Changes are saved automatically
                  after a short delay.
                </p>
                <SectionHeader title="Saving" />
                <NumberField
                  label="Auto-save Delay"
                  value={draft.auto_save_delay_ms}
                  min={500}
                  max={10000}
                  step={500}
                  suffix="ms"
                  onChange={(v) => updateDraft("auto_save_delay_ms", v)}
                />
              </>
            )}

            {section === "security" && (
              <>
                <p className="mb-4 text-[13px] text-text-secondary leading-relaxed">
                  Configure how secrets are displayed, when the clipboard is cleared, and
                  how Claspt locks itself to protect your data when you step away.
                </p>
                <SectionHeader title="Trash" />
                <NumberField
                  label="Keep deleted pages for"
                  value={draft.trash_retention_days ?? 30}
                  min={7}
                  max={90}
                  suffix="days"
                  onChange={(v) =>
                    updateDraft(
                      "trash_retention_days",
                      Math.min(Math.max(Math.round(v) || 7, 7), 90),
                    )
                  }
                />
                <p className="pb-2 text-[11px] leading-relaxed text-text-muted/60">
                  A deleted page waits in the trash (Settings › Utilities › Trash) and can
                  be restored until then; older entries are removed when the vault is
                  unlocked. Only deletion goes to the trash: an edit keeps its history in
                  the version log. The vault&apos;s git history still holds every purged
                  page.
                </p>

                <SectionHeader title="Secrets" />
                <NumberField
                  label="Auto-hide Secrets After"
                  value={draft.secret_auto_hide_seconds}
                  min={5}
                  max={300}
                  suffix="s"
                  onChange={(v) => updateDraft("secret_auto_hide_seconds", v)}
                />
                <NumberField
                  label="Clipboard Clear After"
                  value={draft.clipboard_clear_seconds}
                  min={5}
                  max={300}
                  suffix="s"
                  onChange={(v) => updateDraft("clipboard_clear_seconds", v)}
                />
                <NumberField
                  label="Remind to Rotate Passwords Older Than"
                  value={draft.rotation_reminder_days ?? 180}
                  min={0}
                  max={3650}
                  suffix="days"
                  onChange={(v) => updateDraft("rotation_reminder_days", v)}
                />
                <p className="mb-2 text-[11px] leading-relaxed text-text-muted">
                  0 turns reminders off. Age comes from the generated-password history
                  when Claspt made the password, otherwise from the page&apos;s last save.
                  Reminders appear under Automation &gt; Security alerts and are checked
                  on every unlock.
                </p>
                <SectionHeader title="Encrypted Pages" />
                <SelectField
                  label="Display Mode"
                  value={draft.encrypted_page_display}
                  options={[
                    { label: "Lock overlay", value: "lock_overlay" },
                    { label: "Auto reveal", value: "auto_reveal" },
                    { label: "Require password", value: "require_password" },
                  ]}
                  onChange={(v) => updateDraft("encrypted_page_display", v)}
                />
                <p className="pb-2 text-[11px] leading-relaxed text-text-muted/60">
                  {draft.encrypted_page_display === "auto_reveal"
                    ? "Encrypted pages are automatically decrypted and shown when opened. Convenient but less secure — secrets are visible immediately without any extra action."
                    : draft.encrypted_page_display === "require_password"
                      ? "Shows a lock screen and requires you to re-enter your vault password before revealing the page content. Maximum security — prevents access even if you step away from an unlocked vault."
                      : "Shows a lock screen when you open an encrypted page. Click 'Reveal' to decrypt and view the content. Protects against shoulder-surfing — someone walking by won't see your secrets."}
                </p>

                <SectionHeader title="Attachments" />
                <NumberField
                  label="Size limit per attachment"
                  value={draft.attachment_size_limit_mb ?? DEFAULT_ATTACHMENT_MB}
                  min={1}
                  max={MAX_ATTACHMENT_MB}
                  suffix="MB"
                  onChange={(v) =>
                    updateDraft(
                      "attachment_size_limit_mb",
                      Math.min(Math.max(Math.round(v) || 1, 1), MAX_ATTACHMENT_MB),
                    )
                  }
                />
                <div className="flex items-center justify-between py-2.5">
                  <span className="text-[13px] text-text-primary">In this vault</span>
                  <span className="text-[13px] text-text-secondary">
                    {attachmentUsage
                      ? `${attachmentUsage.files} ${attachmentUsage.files === 1 ? "file" : "files"}, ${formatSize(attachmentUsage.bytes)}`
                      : "…"}
                  </span>
                </div>
                <p className="pb-2 text-[11px] leading-relaxed text-text-muted/60">
                  A file over the limit is refused with both sizes shown; the attach
                  dialog can raise the limit up to {MAX_ATTACHMENT_MB} MB or resize an
                  image to fit. Claspt never shrinks, re-encodes or strips a file on its
                  own.
                </p>
                <SelectField
                  label="Encrypt box starts"
                  value={draft.attachment_encrypt_default ? "ticked" : "unticked"}
                  options={[
                    { label: "Unticked", value: "unticked" },
                    { label: "Ticked", value: "ticked" },
                  ]}
                  onChange={(v) =>
                    updateDraft("attachment_encrypt_default", v === "ticked")
                  }
                />
                <p className="pb-2 text-[11px] leading-relaxed text-text-muted/60">
                  The attach dialog asks for every file. This is only how the box starts,
                  and it follows your last answer. An unencrypted file can be read from
                  the vault folder in Finder; an encrypted one opens only inside Claspt.
                </p>

                <SectionHeader title="Locking" />
                <p className="pb-1 text-[11px] leading-relaxed text-text-muted/60">
                  Claspt uses two lock levels.{" "}
                  <strong className="text-text-muted/80">Screen lock</strong> hides the
                  vault on screen.{" "}
                  <strong className="text-text-muted/80">Key lock</strong> clears the
                  master key from memory, and from then on nothing can read a secret: not
                  the app, the browser extension, MCP or the API, until you enter your
                  password again.
                </p>
                <NumberField
                  label="Screen Lock (hide the vault)"
                  value={draft.auto_lock_minutes}
                  min={1}
                  max={120}
                  suffix="min"
                  onChange={(v) => updateDraft("auto_lock_minutes", v)}
                />
                <p className="pb-2 text-[11px] leading-relaxed text-text-muted/60">
                  After this idle time the vault is hidden on screen. Unlock it with your
                  password or biometrics. Whether tools keep working behind the locked
                  screen is decided by Key lock below.
                </p>
                <NumberField
                  label="Key Lock (clear the master key)"
                  value={draft.key_lock_minutes ?? 0}
                  min={0}
                  max={1440}
                  suffix="min"
                  onChange={(v) => updateDraft("key_lock_minutes", v)}
                />
                <p className="pb-2 text-[11px] leading-relaxed text-text-muted/60">
                  {(draft.key_lock_minutes ?? 0) === 0
                    ? "0 means tied to Screen lock: the master key is cleared the moment the screen locks, so the browser extension, MCP and API stop until you unlock. This is the safest setting."
                    : `The master key is cleared after ${draft.key_lock_minutes} minutes with no activity in the app or from a connected tool. A request from the browser extension, MCP or the API counts as activity, so a tool at work keeps working behind the locked screen. Must be at least the Screen lock time.`}
                </p>

                {biometricAvailable && (
                  <div data-tour="biometric">
                    <SectionHeader title="Biometric" />
                    <SelectField
                      label="Biometric Unlock"
                      value={draft.biometric_mode}
                      options={[
                        { label: "Disabled", value: "disabled" },
                        { label: "Re-auth only", value: "reauth" },
                        { label: "Primary", value: "primary" },
                      ]}
                      onChange={async (v) => {
                        if (vaultDir) {
                          const ok = await toggleBiometric(v);
                          if (ok) updateDraft("biometric_mode", v);
                        }
                      }}
                    />
                    <p className="pb-2 text-[11px] leading-relaxed text-text-muted/60">
                      {draft.biometric_mode === "reauth"
                        ? "First unlock requires password. Biometric available after auto-lock."
                        : draft.biometric_mode === "primary"
                          ? "Biometric can be used for any unlock, including first launch."
                          : "Use Touch ID or Windows Hello to unlock your vault."}
                    </p>
                  </div>
                )}

                <SectionHeader title="Master Password" />
                <ChangeMasterPassword
                  syncConfigured={
                    draft.sync_backend === "hosted" || draft.sync_backend === "gdrive"
                  }
                />

                <SectionHeader title="Recovery Key" />
                {draft.recovery_key_saved_path ? (
                  <p className="pb-2 text-[11px] leading-relaxed text-text-muted/60">
                    Saved to{" "}
                    <span className="break-all text-text-secondary">
                      {draft.recovery_key_saved_path}
                    </span>
                    {draft.recovery_key_saved_at
                      ? ` on ${draft.recovery_key_saved_at}`
                      : ""}
                    . Claspt records where you put it, never the key itself. If you have
                    moved or deleted that file, save a new copy from the key you kept.
                  </p>
                ) : (
                  <p className="pb-2 text-[11px] leading-relaxed text-text-muted/60">
                    No saved location recorded on this device. The recovery key is shown
                    only when a vault is created, so if you no longer have it, change your
                    master password to be issued a new one.
                  </p>
                )}
              </>
            )}

            {section === "extensions" && <ExtensionsTab />}

            {section === "integrations" && (
              <div data-tour="integrations">
                <IntegrationsTab draft={draft} updateDraft={updateDraft} />
              </div>
            )}

            {section === "memory" && <MemoryTab />}
            {section === "passkeys" && <PasskeysTab />}

            {section === "account" && (
              <>
                <p className="mb-4 text-[13px] leading-relaxed text-text-secondary">
                  Your licence, and what it unlocks: syncing to your other devices,
                  sharing, and the mobile apps.
                </p>
                {/* License Status */}
                <SectionHeader title="License" />
                {licenseStatus ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          licenseStatus.is_pro ? "bg-green-500" : "bg-text-muted"
                        }`}
                      />
                      <span className="text-sm font-medium text-text-primary">
                        {licenseTierLabel(licenseStatus)}
                      </span>
                      {licenseStatus.is_expired && (
                        <span className="text-xs text-red-500">Expired</span>
                      )}
                    </div>

                    {licenseStatus.email && (
                      <div className="flex items-center justify-between py-1">
                        <span className="text-sm text-text-muted">Email</span>
                        <span className="text-sm text-text-primary">
                          {licenseStatus.email}
                        </span>
                      </div>
                    )}

                    {licenseStatus.days_remaining != null && (
                      <div className="flex items-center justify-between py-1">
                        <span className="text-sm text-text-muted">Days remaining</span>
                        <span className="text-sm text-text-primary">
                          {licenseStatus.days_remaining}
                        </span>
                      </div>
                    )}

                    {licenseStatus.expires_at && (
                      <div className="flex items-center justify-between py-1">
                        <span className="text-sm text-text-muted">Expires</span>
                        <span className="text-sm text-text-primary">
                          {new Date(licenseStatus.expires_at).toLocaleDateString()}
                        </span>
                      </div>
                    )}

                    {/* Deactivate button for active licenses */}
                    {licenseStatus.is_pro && !licenseStatus.is_expired && (
                      <button
                        onClick={handleDeactivateLicense}
                        disabled={licenseLoading}
                        className="mt-2 rounded-lg border border-red-500/30 px-3 py-1.5 text-sm text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                      >
                        Deactivate License
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-text-muted">Loading license info...</p>
                )}

                {/* Get Pro — shown when no active license */}
                {(!licenseStatus?.is_pro || licenseStatus?.is_expired) && (
                  <>
                    <SectionHeader title="Get Pro" />
                    <p className="pb-3 text-[12px] leading-relaxed text-text-muted">
                      Unlock cloud sync, import from password managers, sharing, and more.
                    </p>
                    {/* One tier. A Pro+ card sat here offering "Vault storage,
                        10 devices", which no longer exists, and the Pro card
                        claimed a device count that is really carried per-licence
                        in the token rather than fixed. */}
                    <div className="rounded-lg border border-border/60 p-3">
                      <div className="text-[13px] font-semibold text-text-primary">
                        Pro
                      </div>
                      <p className="mt-0.5 text-[11px] text-text-dim">
                        Sync, sharing and the mobile apps
                      </p>
                      <div className="mt-2 grid grid-cols-2 gap-1.5">
                        <button
                          onClick={() =>
                            openExternal("https://buy.stripe.com/14AaEWePl6p863GfAEe7m02")
                          }
                          className="rounded-md bg-accent px-3 py-1.5 text-center text-[11px] font-medium text-white transition-colors hover:bg-accent-hover"
                        >
                          Annual
                        </button>
                        <button
                          onClick={() =>
                            openExternal("https://buy.stripe.com/14AaEW0YvaFo1Nq3RWe7m03")
                          }
                          className="rounded-md border border-accent/40 px-3 py-1.5 text-center text-[11px] font-medium text-accent transition-colors hover:bg-accent/10"
                        >
                          Monthly
                        </button>
                      </div>
                    </div>
                    <p className="mt-2 text-[10px] text-text-dim">
                      After purchase, you'll receive a license key by email. Paste it
                      below to activate.
                    </p>
                  </>
                )}

                {/* Activate License — only shown when no active license */}
                {(!licenseStatus?.is_pro || licenseStatus?.is_expired) && (
                  <>
                    <SectionHeader title="Activate License" />
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={licenseKey}
                        onChange={(e) => {
                          setLicenseKey(e.target.value);
                          setLicenseError(null);
                        }}
                        placeholder="Paste your license key here"
                        className="focus-accent w-full rounded-lg border border-border/60 bg-surface px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted/60 outline-none"
                      />
                      {licenseError && (
                        <p className="rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">
                          {licenseError}
                        </p>
                      )}
                      <button
                        onClick={handleActivateLicense}
                        disabled={licenseLoading || !licenseKey.trim()}
                        className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover hover:shadow-md active:scale-95 disabled:opacity-50"
                      >
                        {licenseLoading ? "Activating..." : "Activate"}
                      </button>
                    </div>
                  </>
                )}

                {/* Email Identity */}
                <SectionHeader title="Email Identity" />
                {licenseStatus?.is_pro &&
                !licenseStatus?.is_expired &&
                licenseStatus?.email ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                    <span className="text-[13px] text-text-primary">
                      {licenseStatus.email}
                    </span>
                    <span className="text-[11px] text-text-muted">
                      (from your Pro licence)
                    </span>
                  </div>
                ) : (
                  <EmailRegistration />
                )}

                {/* Incoming Shares */}
                <SectionHeader title="Incoming Shares" />
                <IncomingShares />

                {/* Share delivery.
                    This was one switch called "Enable Server Features" doing
                    two unrelated jobs: collecting shares, which needs a licence,
                    and checking for updates, which does not. A free user was
                    offered a toggle that turned on nothing they could use, and
                    turning it off to avoid that also turned off their update
                    checks. They are separate now. */}
                {hasActiveLicense && (
                  <>
                    <SectionHeader title="Share Delivery" />
                    <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
                      Claspt checks app.claspt.app for credentials shared with you.
                      Nothing is uploaded, and shares are decrypted on this computer.
                    </p>

                    <div className="flex items-center justify-between py-2.5">
                      <span className="text-[13px] text-text-primary">
                        Check for incoming shares
                      </span>
                      <button
                        role="switch"
                        aria-checked={draft.server_enabled === true}
                        onClick={() =>
                          updateDraft("server_enabled", !draft.server_enabled)
                        }
                        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                          draft.server_enabled ? "bg-accent" : "bg-border"
                        }`}
                      >
                        <span
                          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                            draft.server_enabled ? "translate-x-4" : ""
                          }`}
                        />
                      </button>
                    </div>

                    {draft.server_enabled && <ServerStatus />}
                  </>
                )}

                {/* Updates are not a paid feature. A security tool wants
                    everyone on a current build, including people who have not
                    paid for anything. */}
                <SectionHeader title="App Updates" />
                <UpdateSection />

                <SectionHeader title="Sync" />
                <SyncSection
                  draft={draft}
                  updateDraft={updateDraft}
                  licenseStatus={licenseStatus}
                />
              </>
            )}

            {section === "export" && (
              <>
                <SectionHeader title="Import / Export" />
                <ExportTab />
              </>
            )}

            {section === "utilities" && <UtilitiesTab activeUtility={activeUtility} />}

            {section === "activity" && <ActivitySection />}

            {section === "automation" && <AutomationSection />}

            {section === "about" && (
              <>
                <AboutSection
                  onOpenAbout={() => {
                    onCancel();
                    setAboutOpen(true);
                  }}
                />
                <LicensesTab />
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
            <button
              onClick={onCancel}
              className="rounded-lg px-4 py-1.5 text-[13px] font-medium text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-accent rounded-lg px-5 py-1.5 text-[13px]"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Human-readable byte size (B/KB/MB/GB) for storage usage displays. */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/**
 * Collapsed "Advanced recovery" block inside Sync settings. Renders a
 * disclosure widget; expanding it exposes Force Push behind a type-to-
 * confirm input so a single accidental click can't wipe server data.
 *
 * Intentionally has its own component so the confirm state resets every
 * time the user collapses/expands the section — preventing "I typed the
 * phrase yesterday, now one click finishes it off" UX drift.
 */
function AdvancedSyncRecovery() {
  const [expanded, setExpanded] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [forcePushing, setForcePushing] = useState(false);
  const [forcePushResult, setForcePushResult] = useState<string | null>(null);
  const retryFreshCopy = useSyncStore((s) => s.retryFreshCopy);

  const CONFIRM_PHRASE = "force push";
  const armed = confirmText.trim().toLowerCase() === CONFIRM_PHRASE;

  // Runs through the store so the steps and the clock show while the copy
  // is packed and uploaded, the same as the vault-and-account fix.
  async function runForcePush() {
    if (!armed) return;
    setForcePushing(true);
    setForcePushResult(null);
    const pushed = await retryFreshCopy();
    if (pushed) {
      setForcePushResult(
        `Pushed successfully (v${pushed.version}, ${megabytes(pushed.bytes_uploaded)})`,
      );
      setConfirmText("");
    } else {
      setForcePushResult(
        `Error: ${useSyncStore.getState().error ?? "the copy did not go up"}`,
      );
    }
    setForcePushing(false);
  }

  return (
    <div className="mt-4 rounded-lg border border-border/40 bg-surface-overlay/30">
      <button
        type="button"
        onClick={() => {
          setExpanded((x) => !x);
          setConfirmText("");
          setForcePushResult(null);
        }}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] font-medium text-text-muted transition-colors hover:text-text-secondary"
      >
        <span>Advanced recovery</span>
        <span className="text-[10px]">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="border-t border-border/40 px-3 py-3">
          {/* Prominent first — the stop-sign warning. Users should not be
              here unless something is genuinely broken AND support said so. */}
          <div className="mb-3 rounded-md border-2 border-danger/50 bg-danger/10 px-3 py-2">
            <p className="text-[12px] font-semibold text-danger mb-1">
              ⚠ Do not run this without being asked to by Claspt support.
            </p>
            <p className="text-[11px] leading-relaxed text-text-secondary">
              This is a dangerous recovery operation. Running it by mistake can destroy
              data on the server that your other devices still need. If you are
              troubleshooting a sync issue on your own, stop here and contact support
              first — most sync problems do <strong>not</strong> require a force push.
            </p>
          </div>

          <p className="text-[12px] font-medium text-danger mb-1">
            Force Push — overwrite server with this vault
          </p>
          <p className="text-[11px] text-text-muted mb-2 leading-relaxed">
            Deletes <strong>every blob on the server</strong> for your vault and uploads a
            fresh snapshot from this device. Other devices will need to re-sync afterward
            and may lose any unsynced local changes. This action cannot be undone.
          </p>
          <p className="text-[11px] text-text-muted mb-2">
            Type{" "}
            <code className="rounded bg-surface-overlay px-1 font-mono text-text-secondary">
              force push
            </code>{" "}
            to confirm:
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="type to confirm"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="none"
            className="mb-2 w-full rounded-md border border-border/60 bg-surface px-3 py-1.5 text-[12px] font-mono text-text-primary placeholder:text-text-muted/60 focus:border-danger focus:outline-none"
          />
          {forcePushing && (
            <div className="mb-2">
              <SyncProgressPanel stages={FRESH_COPY_STAGES} />
            </div>
          )}
          {forcePushResult && (
            <p
              className={`mb-2 text-[11px] ${forcePushResult.startsWith("Error") ? "text-danger" : "text-green-600"}`}
            >
              {forcePushResult}
            </p>
          )}
          <button
            type="button"
            onClick={runForcePush}
            disabled={!armed || forcePushing}
            className="rounded-md border border-danger/60 bg-danger/10 px-3 py-1.5 text-[12px] font-semibold text-danger transition-all hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {forcePushing ? "Pushing..." : "Force Push (overwrite server)"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Cloud-sync settings section. Renders one of three states depending on
 * license/config: (1) no Pro license, (2) configured-but-not-set-up (backend
 * picker + email OTP device verification), or (3) active sync (status,
 * storage usage, device list, sync/disable actions, and advanced recovery).
 */
function SyncSection({
  updateDraft,
  licenseStatus,
}: {
  draft: VaultConfig;
  updateDraft: <K extends keyof VaultConfig>(key: K, value: VaultConfig[K]) => void;
  licenseStatus: LicenseStatus | null;
}) {
  const {
    v2Status,
    devicesV2,
    syncing,
    error,
    fetchV2Status,
    fetchDevicesV2,
    syncV2,
    disableV2,
    removeDeviceV2,
  } = useSyncStore();

  const [setupBackend, setSetupBackend] = useState<"hosted" | "gdrive">("hosted");
  const [setupLoading, setSetupLoading] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [forcePushing, setForcePushing] = useState(false);
  const [forcePushResult, setForcePushResult] = useState<string | null>(null);
  // OTP flow state
  const [otpPending, setOtpPending] = useState<{
    pendingDeviceId: string;
    emailHint: string;
    deviceId: string;
    backend: string;
    serverUrl: string;
  } | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [storageUsage, setStorageUsage] = useState<{
    used_bytes: number;
    quota_bytes: number;
  } | null>(null);
  const [localSize, setLocalSize] = useState<number | null>(null);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  // Fetch V2 status, devices, storage usage, and local vault size on mount
  useEffect(() => {
    fetchV2Status();
    fetchDevicesV2();
    cmd
      .syncV2Usage()
      .then(setStorageUsage)
      .catch(() => {});
    cmd
      .utilityVaultStats()
      .then((s) => setLocalSize(s.total_size_bytes))
      .catch(() => {});
  }, [fetchV2Status, fetchDevicesV2]);

  const syncIntro = (
    <p className="mb-4 text-[13px] text-text-secondary leading-relaxed">
      Keep your vault in sync across devices. Your notes and encrypted secrets are synced
      end-to-end — the server never sees your plaintext data.
    </p>
  );

  // State 1: No active Pro license
  const hasPro = licenseStatus?.is_pro && !licenseStatus.is_expired;
  if (!hasPro) {
    return (
      <>
        {syncIntro}
        <SectionHeader title="Cloud Sync" />
        <p className="text-[13px] leading-relaxed text-text-muted">
          Cloud sync requires a Pro license. Activate a license in the Account tab to
          enable sync across devices.
        </p>
      </>
    );
  }

  // State 2: Not configured
  if (!v2Status?.configured) {
    return (
      <>
        {syncIntro}
        <SectionHeader title="Cloud Sync" />
        <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
          Enable cloud sync to keep your vault in sync across all your devices. Your data
          is end-to-end encrypted before leaving your device.
        </p>

        <div className="space-y-3">
          <div className="flex items-center justify-between py-2.5">
            <span className="text-[13px] text-text-primary">Backend</span>
            <select
              value={setupBackend}
              onChange={(e) => setSetupBackend(e.target.value as "hosted" | "gdrive")}
              className="focus-accent rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[13px] text-text-primary outline-none"
            >
              <option value="hosted">Claspt Sync</option>
              <option value="gdrive">Google Drive</option>
            </select>
          </div>

          {!otpPending ? (
            <>
              <button
                onClick={async () => {
                  setSetupLoading(true);
                  try {
                    if (setupBackend === "gdrive") {
                      await cmd.syncV2GdriveAuth();
                      updateDraft("sync_backend", "gdrive");
                      await fetchV2Status();
                    } else {
                      const result = await cmd.syncV2Setup(
                        "hosted",
                        "https://app.claspt.app",
                      );
                      if (result.status === "otp_required") {
                        setOtpPending({
                          pendingDeviceId: result.pending_device_id!,
                          emailHint: result.email_hint!,
                          deviceId: result.device_id,
                          backend: result.backend || "hosted",
                          serverUrl: result.server_url || "https://app.claspt.app",
                        });
                      } else {
                        updateDraft("sync_backend", "hosted");
                        await fetchV2Status();
                      }
                    }
                  } catch {
                    // error is set by sync store
                  } finally {
                    setSetupLoading(false);
                  }
                }}
                disabled={setupLoading}
                className="btn-accent rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-50"
              >
                {setupLoading ? "Setting up..." : "Enable Cloud Sync"}
              </button>

              {error && (
                <p className="rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">
                  {error}
                </p>
              )}
            </>
          ) : (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-[13px] text-text-primary font-medium">
                Verify your device
              </p>
              <p className="text-[12px] text-text-muted">
                We sent a 6-digit code to{" "}
                <span className="font-medium text-text-primary">
                  {otpPending.emailHint}
                </span>
              </p>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                className="focus-accent w-32 rounded-lg border border-border/60 bg-surface px-3 py-2 text-center text-lg font-mono tracking-widest text-text-primary outline-none"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    setOtpLoading(true);
                    setOtpError(null);
                    try {
                      await cmd.syncV2Verify(
                        otpPending.pendingDeviceId,
                        otpCode,
                        otpPending.deviceId,
                        otpPending.backend,
                        otpPending.serverUrl,
                      );
                      updateDraft("sync_backend", "hosted");
                      setOtpPending(null);
                      setOtpCode("");
                      await fetchV2Status();
                      // Auto-trigger initial sync after verification
                      syncV2();
                    } catch (e) {
                      setOtpError(errorMessage(e));
                    } finally {
                      setOtpLoading(false);
                    }
                  }}
                  disabled={otpLoading || otpCode.length !== 6}
                  className="btn-accent rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-50"
                >
                  {otpLoading ? "Verifying..." : "Verify"}
                </button>
                <button
                  onClick={() => {
                    setOtpPending(null);
                    setOtpCode("");
                    setOtpError(null);
                  }}
                  className="rounded-lg border border-border px-4 py-2 text-[13px] text-text-muted hover:text-text-primary transition-colors"
                >
                  Cancel
                </button>
              </div>
              {otpError && (
                <p className="rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">
                  {otpError}
                </p>
              )}
            </div>
          )}
        </div>
      </>
    );
  }

  // State 3: Configured
  return (
    <>
      {syncIntro}
      <SectionHeader title="Cloud Sync" />

      {/* Status info */}
      <div className="space-y-1 py-2">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-text-muted">Status</span>
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-text-primary">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                v2Status.engine_active ? "bg-success" : "bg-text-muted"
              }`}
            />
            {v2Status.engine_active ? "Active" : "Configured"}
          </span>
        </div>
        {v2Status.backend && (
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-text-muted">Backend</span>
            <span className="text-[13px] text-text-primary">{v2Status.backend}</span>
          </div>
        )}
        {v2Status.last_synced_version != null && (
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-text-muted">Sync Revision</span>
            <span className="text-[13px] text-text-primary">
              {v2Status.last_synced_version}
            </span>
          </div>
        )}
      </div>

      {/* Storage Usage */}
      {(localSize != null || (storageUsage && storageUsage.quota_bytes > 0)) && (
        <>
          <SectionHeader title="Storage" />
          <div className="space-y-3 py-2">
            {/* Local vault */}
            {localSize != null && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12px] font-medium text-text-secondary">
                    Local Vault
                  </span>
                  <span className="text-[12px] text-text-primary">
                    {formatBytes(localSize)}
                  </span>
                </div>
                <p className="text-[10px] text-text-dim">
                  Space used by your notes, secrets, and search index on this device.
                </p>
              </div>
            )}

            {/* Server storage */}
            {storageUsage && storageUsage.quota_bytes > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12px] font-medium text-text-secondary">
                    Server Sync
                  </span>
                  <span className="text-[12px] text-text-primary">
                    {formatBytes(storageUsage.used_bytes)} /{" "}
                    {formatBytes(storageUsage.quota_bytes)}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-border">
                  <div
                    className={`h-full rounded-full transition-all ${
                      storageUsage.used_bytes / storageUsage.quota_bytes > 0.9
                        ? "bg-danger"
                        : storageUsage.used_bytes / storageUsage.quota_bytes > 0.7
                          ? "bg-yellow-500"
                          : "bg-accent"
                    }`}
                    style={{
                      width: `${Math.min(100, (storageUsage.used_bytes / storageUsage.quota_bytes) * 100)}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-[10px] text-text-dim">
                  Encrypted sync snapshots stored on the server. Includes current and
                  previous versions.
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {/* Device list */}
      <SectionHeader title="Devices" />
      <div className="space-y-1 py-1">
        {devicesV2.length === 0 ? (
          <p className="text-[12px] text-text-muted">No devices registered.</p>
        ) : (
          devicesV2.map((d) => (
            <div
              key={d.device_id}
              className="flex items-center justify-between rounded-lg px-2 py-1.5"
            >
              <div className="flex flex-col">
                <span className="text-[13px] text-text-primary">{d.name}</span>
                <span className="text-[11px] text-text-muted">
                  {d.platform} -- v{d.sync_version}
                </span>
              </div>
              {d.device_id !== v2Status.device_id && (
                <button
                  onClick={() => removeDeviceV2(d.device_id)}
                  className="rounded px-2 py-1 text-[11px] text-danger transition-colors hover:bg-danger/10"
                >
                  Remove
                </button>
              )}
            </div>
          ))
        )}
        <button
          onClick={() => fetchDevicesV2()}
          className="mt-1 rounded-lg border border-border/60 px-3 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-overlay"
        >
          Refresh
        </button>
      </div>

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => syncV2()}
          disabled={syncing}
          className="btn-accent rounded-lg px-4 py-1.5 text-[13px] font-medium disabled:opacity-50"
        >
          {syncing ? "Syncing..." : "Sync Now"}
        </button>
        <button
          onClick={async () => {
            setDisabling(true);
            await disableV2();
            updateDraft("sync_backend", "local_git");
            setDisabling(false);
          }}
          disabled={disabling}
          className="rounded-lg border border-danger/30 px-4 py-1.5 text-[13px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
        >
          {disabling ? "Disabling..." : "Disable Sync"}
        </button>
      </div>

      {/* Advanced recovery — collapsed by default, double-gated behind both
          an expand toggle AND a typed confirmation phrase. Force Push wipes
          every server blob for this vault and uploads a fresh snapshot from
          this device; other devices must re-sync. Destructive enough that
          one misclick would cost data, so we deliberately make it harder
          to reach than a regular button. */}
      <AdvancedSyncRecovery />

      {error && (
        <>
          <p className="mt-3 rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">
            {error}
          </p>
          {error.includes("decryption failed") && (
            <div className="mt-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
              <p className="text-[12px] font-medium text-yellow-600 mb-1">
                Key mismatch detected
              </p>
              <p className="text-[11px] text-text-muted mb-2">
                The server has data encrypted with an older key. Use Force Push to
                overwrite the server with a fresh copy of your current vault.
              </p>
              {forcePushResult && (
                <p
                  className={`mb-2 text-[11px] ${forcePushResult.startsWith("Error") ? "text-danger" : "text-green-600"}`}
                >
                  {forcePushResult}
                </p>
              )}
              <button
                type="button"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setForcePushing(true);
                  setForcePushResult("Starting force push...");
                  cmd
                    .syncV2ForcePush()
                    .then((result) => {
                      useSyncStore.setState({ error: null });
                      setForcePushResult(
                        `Pushed successfully (v${result.version}, ${result.bytes_uploaded} bytes)`,
                      );
                      fetchV2Status();
                    })
                    .catch((e) => {
                      setForcePushResult(
                        `Error: ${e instanceof Error ? e.message : String(e)}`,
                      );
                    })
                    .finally(() => {
                      setForcePushing(false);
                    });
                }}
                disabled={forcePushing}
                className="cursor-pointer rounded-lg border-2 border-yellow-500 bg-yellow-500/20 px-4 py-2 text-[13px] font-semibold text-yellow-300 hover:bg-yellow-500/30 active:scale-95 transition-all disabled:opacity-50"
              >
                {forcePushing ? "Pushing..." : "Force Push (overwrite server)"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * About: which build this is, what it is licensed under, and where to write.
 *
 * It used to show the app name and the company and nothing else — not the
 * version, so a bug report could not say which build it came from, and not the
 * licence, which matters now the source is published. The plan is here too,
 * because About is where people look to answer "what have I actually got".
 */
function AboutSection({ onOpenAbout }: { onOpenAbout: () => void }) {
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    cmd
      .getLicenseStatus()
      .then((s) => {
        if (!cancelled) setLicenseStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <SectionHeader title="Application" />
      <div className="space-y-3 py-2">
        <div className="flex items-center gap-3">
          <BrandLogo size="icon" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-text-primary">Claspt</p>
              {licenseStatus && (
                <span
                  className={`rounded-full border px-2 py-[1px] text-[10px] font-semibold uppercase leading-none tracking-wider ${
                    licenseStatus.is_pro && !licenseStatus.is_expired
                      ? "border-accent/35 bg-accent/10 text-accent"
                      : "border-border/70 bg-surface-overlay/50 text-text-muted"
                  }`}
                >
                  {licenseTierLabel(licenseStatus)}
                </span>
              )}
            </div>
            <p className="text-[12px] text-text-muted">
              By Indivar Software Solutions Limited
            </p>
          </div>
        </div>

        <dl className="space-y-1.5 text-[12.5px]">
          <AboutRow label="Version">
            <span className="font-mono text-[12px]">{VERSION_DISPLAY}</span>
          </AboutRow>
          <AboutRow label="Plan">
            {licenseStatus
              ? licenseStatus.is_pro && !licenseStatus.is_expired
                ? licenseStatus.email
                  ? `Pro — ${licenseStatus.email}`
                  : "Pro"
                : "Free — sync, sharing and the mobile apps need Pro"
              : "…"}
          </AboutRow>
          <AboutRow label="Licence">PolyForm Shield License 1.0.0</AboutRow>
          <AboutRow label="Support">
            <a
              href="mailto:support@claspt.app"
              className="text-accent transition-opacity hover:opacity-80"
            >
              support@claspt.app
            </a>
          </AboutRow>
          <AboutRow label="Security">
            <a
              href="mailto:security@claspt.app"
              className="text-accent transition-opacity hover:opacity-80"
            >
              security@claspt.app
            </a>
          </AboutRow>
        </dl>

        <button
          onClick={onOpenAbout}
          className="rounded-lg border border-border/60 px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
        >
          View Full Details
        </button>
      </div>
    </>
  );
}

/** One label/value row, so the column of labels lines up. */
function AboutRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[74px] shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 text-text-secondary">{children}</dd>
    </div>
  );
}

/**
 * Public entry point for the settings modal. Gates on `settingsOpen` and a
 * loaded config, then mounts {@link SettingsContent} with the current config.
 * Unmounting on close is intentional so state resets fresh on reopen.
 */
export function SettingsPanel() {
  const { config, updateConfig } = useVaultStore();
  const { settingsOpen, setSettingsOpen, setTheme } = useUIStore();

  // When settingsOpen is false, we return null, which unmounts SettingsContent.
  // When it becomes true again, SettingsContent remounts with fresh state.
  if (!settingsOpen || !config) return null;

  const handleSave = async (draft: VaultConfig) => {
    // Apply theme immediately — works for all theme names now
    setTheme(draft.theme as ThemeName);
    // Merge live extension state — ExtensionsTab saves directly to the store,
    // so the draft's markdown_extensions may be stale.
    const liveExtensions = useExtensionStore.getState().enabledMap;
    await updateConfig({ ...draft, markdown_extensions: liveExtensions });
    setSettingsOpen(false);
  };

  return (
    <SettingsContent
      initialConfig={config}
      onSave={handleSave}
      onCancel={() => setSettingsOpen(false)}
    />
  );
}
