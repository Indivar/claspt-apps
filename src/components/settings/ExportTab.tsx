// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ExportTab — settings panel for getting data in and out of the vault. Supports
 * exporting the whole vault as a (optionally AES-256 password-protected) ZIP,
 * exporting secrets only as CSV/JSON, and importing from a Claspt export ZIP or
 * a folder of markdown files. Exports decrypt secrets inline, so it warns that
 * exported files contain plaintext.
 */
import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as cmd from "@/lib/commands";
import { SpinnerIcon } from "@/components/ui/icons";
import { errorMessage } from "@/lib/error-message";
import { usePagesStore } from "@/stores/pages-store";

type ExportState =
  | { status: "idle" }
  | { status: "loading"; type: string }
  | { status: "done"; result: cmd.ExportResult }
  | { status: "error"; error: string };

type ImportState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: cmd.ImportFolderResult }
  | { status: "error"; error: string };

/** Export (ZIP / secrets) and import (ZIP / markdown folder) controls and results. */
export function ExportTab() {
  const [state, setState] = useState<ExportState>({ status: "idle" });
  const [secretsFormat, setSecretsFormat] = useState<"csv" | "json">("csv");
  const [usePassword, setUsePassword] = useState(true);
  const [password, setPassword] = useState("");

  const [importState, setImportState] = useState<ImportState>({ status: "idle" });
  const [importFolder, setImportFolder] = useState("");
  const [targetFolder, setTargetFolder] = useState("general");
  const [folders, setFolders] = useState<string[]>([]);

  // Import from ZIP state
  const [zipPath, setZipPath] = useState("");
  const [zipPassword, setZipPassword] = useState("");
  const [zipImportState, setZipImportState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "done"; result: cmd.ImportZipResult }
    | { status: "error"; error: string }
  >({ status: "idle" });

  useEffect(() => {
    cmd
      .listFolders()
      .then(setFolders)
      .catch(() => {});
  }, []);

  async function handleCompleteExport() {
    const filePath = await save({
      defaultPath: `claspt-vault-export.zip`,
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (!filePath) return;

    setState({ status: "loading", type: "complete" });
    try {
      const result = await cmd.exportVaultComplete(
        filePath,
        usePassword ? password : undefined,
      );
      setState({ status: "done", result });
    } catch (e) {
      setState({ status: "error", error: errorMessage(e) });
    }
  }

  async function handleSecretsExport() {
    const ext = secretsFormat === "csv" ? "csv" : "json";
    const filePath = await save({
      defaultPath: `claspt-secrets.${ext}`,
      filters: [
        {
          name: secretsFormat === "csv" ? "CSV File" : "JSON File",
          extensions: [ext],
        },
      ],
    });
    if (!filePath) return;

    setState({ status: "loading", type: "secrets" });
    try {
      const result = await cmd.exportSecretsOnly(filePath, secretsFormat);
      setState({ status: "done", result });
    } catch (e) {
      setState({ status: "error", error: errorMessage(e) });
    }
  }

  async function handleBrowseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setImportFolder(selected);
    }
  }

  async function handleBrowseZip() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (selected && typeof selected === "string") {
      setZipPath(selected);
    }
  }

  const { loadPages, loadFolders } = usePagesStore();

  async function refreshSidebar() {
    await loadPages();
    await loadFolders();
  }

  async function handleImportZip() {
    if (!zipPath) return;
    setZipImportState({ status: "loading" });
    try {
      const result = await cmd.importFromZip(zipPath, zipPassword || undefined);
      setZipImportState({ status: "done", result });
      await refreshSidebar();
    } catch (e) {
      setZipImportState({ status: "error", error: errorMessage(e) });
    }
  }

  async function handleImportFolder() {
    if (!importFolder) return;
    setImportState({ status: "loading" });
    try {
      const result = await cmd.utilityImportFolder(importFolder, targetFolder);
      setImportState({ status: "done", result });
      await refreshSidebar();
    } catch (e) {
      setImportState({ status: "error", error: errorMessage(e) });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Intro */}
      <div>
        <p className="text-[13px] text-text-secondary leading-relaxed">
          Your data belongs to you. Export everything anytime — no lock-in, ever. Take
          your pages and secrets anywhere.
        </p>
      </div>

      {/* Complete Export */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 text-xl">📦</div>
          <div className="flex-1">
            <h3 className="text-[14px] font-semibold text-text-primary">
              Complete Export
            </h3>
            <p className="mt-1 text-[12px] text-text-muted leading-relaxed">
              All pages and secrets as a{" "}
              <span className="font-medium text-text-secondary">.zip</span> archive.
              Secrets are decrypted inline — the exported files are plain markdown,
              readable by any text editor. Folder structure is preserved.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <label className="flex items-center gap-2 text-[13px] text-text-primary cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={usePassword}
                  onChange={(e) => setUsePassword(e.target.checked)}
                  className="rounded border-border h-4 w-4"
                />
                Protect with password (AES-256)
              </label>
              {usePassword && (
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter export password"
                  className="rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text-primary w-full max-w-xs"
                />
              )}
              <div>
                <button
                  onClick={handleCompleteExport}
                  disabled={state.status === "loading" || (usePassword && !password)}
                  className="btn-accent rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-50"
                >
                  {state.status === "loading" && state.type === "complete" ? (
                    <span className="inline-flex items-center gap-2">
                      <SpinnerIcon size={14} className="animate-spin" />
                      Exporting...
                    </span>
                  ) : usePassword ? (
                    "Export as Encrypted ZIP"
                  ) : (
                    "Export as ZIP"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Secrets Only */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 text-xl">🔑</div>
          <div className="flex-1">
            <h3 className="text-[14px] font-semibold text-text-primary">Secrets Only</h3>
            <p className="mt-1 text-[12px] text-text-muted leading-relaxed">
              Export just your secret values as{" "}
              <span className="font-medium text-text-secondary">CSV</span> or{" "}
              <span className="font-medium text-text-secondary">JSON</span>. Each entry
              includes the page name, folder, label, and decrypted value. CSV can be
              imported into password managers like 1Password or Bitwarden.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <select
                value={secretsFormat}
                onChange={(e) => setSecretsFormat(e.target.value as "csv" | "json")}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text-primary"
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
              <button
                onClick={handleSecretsExport}
                disabled={state.status === "loading"}
                className="btn-accent rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-50"
              >
                {state.status === "loading" && state.type === "secrets" ? (
                  <span className="inline-flex items-center gap-2">
                    <SpinnerIcon size={14} className="animate-spin" />
                    Exporting...
                  </span>
                ) : (
                  "Export Secrets"
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Export Result */}
      {state.status === "done" && (
        <div className="rounded-lg bg-success/10 border border-success/20 px-4 py-3">
          <p className="text-[13px] font-medium text-success-text">Export complete</p>
          <p className="mt-1 text-[12px] text-text-muted">
            {state.result.pages_exported} page
            {state.result.pages_exported !== 1 ? "s" : ""},{" "}
            {state.result.secrets_exported} secret
            {state.result.secrets_exported !== 1 ? "s" : ""} exported.
          </p>
        </div>
      )}

      {state.status === "error" && (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {state.error}
        </p>
      )}

      {/* Security note */}
      <div className="rounded-lg bg-warning/10 border border-warning/20 px-4 py-3">
        <p className="text-[12px] text-warning-text leading-relaxed">
          <span className="font-medium">Security notice:</span> Exported files contain
          your decrypted secrets in plaintext. Store them securely and delete after use.
        </p>
      </div>

      {/* ── Import Section ── */}
      <div className="mt-2 border-t border-border pt-5">
        <h2 className="text-[15px] font-semibold text-text-primary mb-1">Import</h2>
        <p className="text-[13px] text-text-secondary leading-relaxed mb-4">
          Bring your existing notes into Claspt.
        </p>
      </div>

      {/* Import from ZIP */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 text-xl">📦</div>
          <div className="flex-1">
            <h3 className="text-[14px] font-semibold text-text-primary">
              Import from Claspt Export
            </h3>
            <p className="mt-1 text-[12px] text-text-muted leading-relaxed">
              Re-import a previously exported{" "}
              <span className="font-medium text-text-secondary">.zip</span> archive. Pages
              are imported into a new folder (e.g.{" "}
              <code className="rounded bg-surface-raised px-1 py-0.5 text-[11px] text-text-secondary">
                imported-20260330
              </code>
              ). Secret blocks are re-encrypted with your current vault key.
            </p>
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBrowseZip}
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-overlay transition-colors"
                >
                  Choose ZIP file...
                </button>
                <span className="text-[12px] text-text-muted truncate min-w-0">
                  {zipPath ? zipPath.split("/").pop() : "No file selected"}
                </span>
              </div>
              <div>
                <label className="text-[12px] text-text-secondary mb-1 block">
                  ZIP password (if encrypted)
                </label>
                <input
                  type="password"
                  value={zipPassword}
                  onChange={(e) => setZipPassword(e.target.value)}
                  placeholder="Leave empty if not encrypted"
                  className="rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text-primary w-full max-w-xs"
                />
              </div>
              <div>
                <button
                  onClick={handleImportZip}
                  disabled={!zipPath || zipImportState.status === "loading"}
                  className="btn-accent rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-50"
                >
                  {zipImportState.status === "loading" ? (
                    <span className="inline-flex items-center gap-2">
                      <SpinnerIcon size={14} className="animate-spin" />
                      Importing...
                    </span>
                  ) : (
                    "Import ZIP"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ZIP Import Result */}
      {zipImportState.status === "done" && (
        <div className="rounded-lg bg-success/10 border border-success/20 px-4 py-3">
          <p className="text-[13px] font-medium text-success-text">Import complete</p>
          <p className="mt-1 text-[12px] text-text-muted">
            {zipImportState.result.imported} page
            {zipImportState.result.imported !== 1 ? "s" : ""} imported
            {zipImportState.result.skipped > 0 &&
              `, ${zipImportState.result.skipped} skipped`}
            .
          </p>
          {zipImportState.result.errors.length > 0 && (
            <div className="mt-2">
              <p className="text-[11px] font-medium text-warning-text">
                {zipImportState.result.errors.length} error
                {zipImportState.result.errors.length !== 1 ? "s" : ""}:
              </p>
              <ul className="mt-1 text-[11px] text-text-muted list-disc pl-4">
                {zipImportState.result.errors.slice(0, 5).map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {zipImportState.status === "error" && (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {zipImportState.error}
        </p>
      )}

      {/* Import Folder */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 text-xl">📂</div>
          <div className="flex-1">
            <h3 className="text-[14px] font-semibold text-text-primary">
              Import Markdown Folder
            </h3>
            <p className="mt-1 text-[12px] text-text-muted leading-relaxed">
              Import all <span className="font-medium text-text-secondary">.md</span>{" "}
              files from a folder (including subfolders). Titles are extracted from YAML
              frontmatter or the first heading. Any{" "}
              <span className="font-medium text-text-secondary">:::secret</span> blocks
              are encrypted with your vault key.
            </p>
            <div className="mt-3 flex flex-col gap-3">
              {/* Source folder */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBrowseFolder}
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-overlay transition-colors"
                >
                  Browse...
                </button>
                <span className="text-[12px] text-text-muted truncate min-w-0">
                  {importFolder || "No folder selected"}
                </span>
              </div>

              {/* Target folder */}
              <div className="flex items-center gap-2">
                <label className="text-[12px] text-text-secondary shrink-0">
                  Import into:
                </label>
                <select
                  value={targetFolder}
                  onChange={(e) => setTargetFolder(e.target.value)}
                  className="rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text-primary"
                >
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <button
                  onClick={handleImportFolder}
                  disabled={!importFolder || importState.status === "loading"}
                  className="btn-accent rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-50"
                >
                  {importState.status === "loading" ? (
                    <span className="inline-flex items-center gap-2">
                      <SpinnerIcon size={14} className="animate-spin" />
                      Importing...
                    </span>
                  ) : (
                    "Import Folder"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Import Result */}
      {importState.status === "done" && (
        <div className="rounded-lg bg-success/10 border border-success/20 px-4 py-3">
          <p className="text-[13px] font-medium text-success-text">Import complete</p>
          <p className="mt-1 text-[12px] text-text-muted">
            {importState.result.imported} page
            {importState.result.imported !== 1 ? "s" : ""} imported
            {importState.result.skipped > 0 && `, ${importState.result.skipped} skipped`}.
          </p>
          {importState.result.errors.length > 0 && (
            <div className="mt-2">
              <p className="text-[11px] font-medium text-warning-text">
                {importState.result.errors.length} error
                {importState.result.errors.length !== 1 ? "s" : ""}:
              </p>
              <ul className="mt-1 text-[11px] text-text-muted list-disc pl-4">
                {importState.result.errors.slice(0, 5).map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
                {importState.result.errors.length > 5 && (
                  <li>...and {importState.result.errors.length - 5} more</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}

      {importState.status === "error" && (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {importState.error}
        </p>
      )}

      {/* Sync promo */}
      <div className="rounded-lg border border-border/50 bg-surface px-4 py-3">
        <p className="text-[12px] text-text-dim leading-relaxed">
          <span className="font-medium text-text-muted">
            Want automatic sync instead?
          </span>{" "}
          Claspt Pro keeps your vault in sync across all your devices — no manual export
          needed. Your data stays encrypted end-to-end.
        </p>
      </div>
    </div>
  );
}
