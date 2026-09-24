// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * commands.ts — the single typed boundary between the React frontend and the
 * Rust (Tauri) backend.
 *
 * Every function here is a thin wrapper over Tauri's `invoke(...)`: it names a
 * backend command, forwards its arguments (converted to the camelCase keys Tauri
 * expects), and returns a `Promise` typed with the shape the Rust command
 * produces. There is intentionally **no runtime schema validation** on the
 * responses — the Rust side is the trust and validation boundary. Values coming
 * back across IPC are treated as already-validated and are cast to their declared
 * TypeScript types. If a command's Rust signature changes, update the matching
 * type here; the compiler is the only thing keeping the two sides in sync.
 *
 * Conventions:
 *  - Functions are grouped by domain (Vault, Crypto, Pages, Search, Git, Sync,
 *    Share, License, Generator, Export, Utilities, …) with section banners.
 *  - Optional backend params are passed as explicit `null` (Tauri distinguishes
 *    "missing" from "null" for some commands), e.g. `maxCount ?? null`.
 *  - Response-only helper interfaces (MediaFile, GenerateResult, VaultStats, …)
 *    live next to the commands that return them rather than in shared/types.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  CheckResponse,
  CommitDiff,
  CommitEntry,
  CsvColumnMapping,
  DecryptedShare,
  DuplicateStrategy,
  ImageTransformParams,
  ImageTransformPreview,
  ImportEntry,
  ImportFormat,
  ImportResult,
  LicenseStatus,
  MarkdownImportPreview,
  Page,
  PageSummary,
  SearchResult,
  SearchScope,
  SecretSummary,
  ShareCreateResult,
  SharePreview,
  ShareSecretField,
  SyncResolution,
  SyncResult,
  SyncStatus,
  VaultConfig,
  VaultCreationResult,
} from "@claspt/shared/types";

// ── Vault ──────────────────────────────────────────────

export function createVault(
  password: string,
  vaultDir: string,
): Promise<VaultCreationResult> {
  return invoke("create_vault", { password, vaultDir });
}

export function unlockVault(password: string, vaultDir: string): Promise<void> {
  return invoke("unlock_vault", { password, vaultDir });
}

export function lockVault(): Promise<void> {
  return invoke("lock_vault");
}

export function keyLockVault(): Promise<void> {
  return invoke("key_lock_vault");
}

export function touchActivity(): Promise<void> {
  return invoke("touch_activity");
}

export function verifyPassword(password: string): Promise<void> {
  return invoke("verify_password", { password });
}

export function getVaultConfig(): Promise<VaultConfig> {
  return invoke("get_vault_config");
}

export function setVaultConfig(config: VaultConfig): Promise<void> {
  return invoke("set_vault_config", { config });
}

/**
 * Whether a Claspt vault already exists at this path.
 *
 * Used by the unlock screen to decide whether to offer "unlock" or "create" on
 * first launch, instead of always assuming a vault is there.
 */
export function vaultExistsAt(path: string): Promise<boolean> {
  return invoke("vault_exists_at", { path });
}

export function suggestDefaultVaultDir(): Promise<string> {
  return invoke("suggest_default_vault_dir");
}

export function resetToDefaults(): Promise<{ ok: boolean; message: string }> {
  return invoke("reset_to_defaults");
}

export function recoverWithKey(
  recoveryKey: string,
  newPassword: string,
  vaultDir: string,
): Promise<VaultCreationResult> {
  return invoke("recover_with_key", { recoveryKey, newPassword, vaultDir });
}

// ── Crypto ─────────────────────────────────────────────

export function encryptBlock(plaintext: string): Promise<string> {
  return invoke("encrypt_block", { plaintext });
}

export function decryptBlock(encoded: string): Promise<string> {
  return invoke("decrypt_block", { encoded });
}

// ── Pages ──────────────────────────────────────────────

export function createPage(
  title: string,
  folder: string,
  content: string,
): Promise<Page> {
  return invoke("create_page", { title, folder, content });
}

export function readPage(path: string): Promise<Page> {
  return invoke("read_page", { path });
}

export function updatePage(path: string, content: string): Promise<Page> {
  return invoke("update_page", { path, content });
}

/** A page in the vault's trash. */
export interface TrashEntry {
  id: string;
  original_path: string;
  title: string;
  folder: string;
  encrypted: boolean;
  deleted_at: string;
  /** When the unlock-time purge will remove it under the current retention. */
  purge_at: string;
}

/** Move a page to the vault's trash; the entry can restore it. */
export function deletePage(path: string): Promise<TrashEntry> {
  return invoke("delete_page", { path });
}

export function trashList(): Promise<TrashEntry[]> {
  return invoke("trash_list");
}

export function trashRestore(entryId: string): Promise<Page> {
  return invoke("trash_restore", { entryId });
}

export function trashPurge(entryId: string): Promise<void> {
  return invoke("trash_purge", { entryId });
}

export function trashEmpty(): Promise<number> {
  return invoke("trash_empty");
}

export function deletePagesBulk(paths: string[]): Promise<number> {
  return invoke("delete_pages_bulk", { paths });
}

export function duplicatePage(path: string): Promise<Page> {
  return invoke("duplicate_page", { path });
}

export function togglePin(path: string): Promise<Page> {
  return invoke("toggle_pin", { path });
}

/** Record the owner's review of an agent-memory page (app only, never the API). */
export function setMemoryReviewed(path: string, reviewed: boolean): Promise<Page> {
  return invoke("set_memory_reviewed", { path, reviewed });
}

export function listPages(): Promise<PageSummary[]> {
  return invoke("list_pages");
}

export function movePage(path: string, newFolder: string): Promise<Page> {
  return invoke("move_page", { path, newFolder });
}

export function updateTitle(path: string, title: string): Promise<Page> {
  return invoke("update_title", { path, title });
}

export function updateTags(path: string, tags: string[]): Promise<Page> {
  return invoke("update_tags", { path, tags });
}

export function listTags(): Promise<string[]> {
  return invoke("list_tags");
}

export function listSecrets(): Promise<SecretSummary[]> {
  return invoke("list_secrets");
}

export function toggleArchive(path: string): Promise<Page> {
  return invoke("toggle_archive", { path });
}

export function toggleEncryption(path: string): Promise<Page> {
  return invoke("toggle_encryption", { path });
}

// ── Media ───────────────────────────────────────────────

export interface MediaFile {
  rel_path: string;
  md_path: string;
  abs_path: string;
  /** Size of the original bytes, before any sealing. */
  size: number;
  /** Whether the file on disk is sealed under the master key. */
  sealed: boolean;
}

/** An attachment read back for display. */
export interface MediaRead {
  data_url: string;
  sealed: boolean;
  size: number;
  name: string;
  ext: string;
  rel_path: string;
  md_path: string;
}

/** Every attachment in the vault, counted and summed by size on disk. */
export interface MediaUsage {
  files: number;
  bytes: number;
}

/** Name, extension and size of a file the owner picked, before it is read. */
export interface SourceFileInfo {
  name: string;
  ext: string;
  size: number;
}

export function saveMedia(
  folder: string,
  data: number[],
  extension: string,
  encrypt: boolean,
): Promise<MediaFile> {
  return invoke("save_media", { folder, data, extension, encrypt });
}

export function saveMediaFromPath(
  folder: string,
  sourcePath: string,
  encrypt: boolean,
): Promise<MediaFile> {
  return invoke("save_media_from_path", { folder, sourcePath, encrypt });
}

export function statSourceFile(sourcePath: string): Promise<SourceFileInfo> {
  return invoke("stat_source_file", { sourcePath });
}

export function deleteMedia(relPath: string): Promise<void> {
  return invoke("delete_media", { relPath });
}

export function setMediaSealed(relPath: string, encrypt: boolean): Promise<MediaFile> {
  return invoke("set_media_sealed", { relPath, encrypt });
}

export function mediaUsage(): Promise<MediaUsage> {
  return invoke("media_usage");
}

/** The pages of a folder that still reference an attachment. */
export interface MediaReferences {
  pages: string[];
  /** Encrypted pages in the folder, whose bodies could not be checked. */
  unchecked_encrypted: number;
}

export function mediaReferences(
  folder: string,
  mdPath: string,
): Promise<MediaReferences> {
  return invoke("media_references", { folder, mdPath });
}

export function exportMedia(relPath: string, destPath: string): Promise<void> {
  return invoke("export_media", { relPath, destPath });
}

export function resolveMediaPath(folder: string, mdPath: string): Promise<string> {
  return invoke("resolve_media_path", { folder, mdPath });
}

/** Read an attachment for display. With `includeData` false only its
 *  description comes back and `data_url` is empty. */
export function readMedia(
  folder: string,
  mdPath: string,
  includeData: boolean,
): Promise<MediaRead> {
  return invoke("read_media_data_url", { folder, mdPath, includeData });
}

export function previewImageTransform(
  sourcePath: string,
  params: ImageTransformParams,
): Promise<ImageTransformPreview> {
  return invoke("preview_image_transform", { sourcePath, params });
}

export function previewImageTransformBytes(
  data: number[],
  extension: string,
  params: ImageTransformParams,
): Promise<ImageTransformPreview> {
  return invoke("preview_image_transform_bytes", { data, extension, params });
}

export function processAndSaveMedia(
  folder: string,
  sourcePath: string,
  params: ImageTransformParams,
  encrypt: boolean,
): Promise<MediaFile> {
  return invoke("process_and_save_media", { folder, sourcePath, params, encrypt });
}

export function processAndSaveMediaBytes(
  folder: string,
  data: number[],
  extension: string,
  params: ImageTransformParams,
  encrypt: boolean,
): Promise<MediaFile> {
  return invoke("process_and_save_media_bytes", {
    folder,
    data,
    extension,
    params,
    encrypt,
  });
}

// ── Folders ─────────────────────────────────────────────

export function listFolders(): Promise<string[]> {
  return invoke("list_folders");
}

export function createFolder(name: string): Promise<string> {
  return invoke("create_folder", { name });
}

export function renameFolder(oldName: string, newName: string): Promise<void> {
  return invoke("rename_folder", { oldName, newName });
}

export function deleteFolder(name: string, action: string): Promise<void> {
  return invoke("delete_folder", { name, action });
}

// ── Search ─────────────────────────────────────────────

export function searchPages(
  query: string,
  scope: SearchScope,
  includeAiMemory: boolean,
  limit: number,
): Promise<SearchResult[]> {
  return invoke("search_pages", { query, scope, includeAiMemory, limit });
}

export function rebuildSearchIndex(): Promise<number> {
  return invoke("rebuild_search_index");
}

// ── Git ────────────────────────────────────────────────

export function gitCommit(): Promise<string | null> {
  return invoke("git_commit");
}

export function gitLog(maxCount?: number): Promise<CommitEntry[]> {
  return invoke("git_log", { maxCount: maxCount ?? null });
}

export function gitFileLog(path: string, maxCount?: number): Promise<CommitEntry[]> {
  return invoke("git_file_log", { path, maxCount: maxCount ?? null });
}

export function gitFileAtCommit(oid: string, path: string): Promise<string | null> {
  return invoke("git_file_at_commit", { oid, path });
}

export function gitCommitDiff(oid: string, path: string): Promise<CommitDiff> {
  return invoke("git_commit_diff", { oid, path });
}

export function gitRestoreToCommit(oid: string, path: string): Promise<string> {
  return invoke("git_restore_to_commit", { oid, path });
}

// ── Import ──────────────────────────────────────────────

export function detectCsvColumns(filePath: string): Promise<CsvColumnMapping[]> {
  return invoke("detect_csv_columns", { filePath });
}

export function previewImport(
  filePath: string,
  format: ImportFormat,
  columnMappings?: CsvColumnMapping[] | null,
): Promise<ImportEntry[]> {
  return invoke("preview_import", {
    filePath,
    format,
    columnMappings: columnMappings ?? null,
  });
}

export function executeImport(
  filePath: string,
  format: ImportFormat,
  duplicateStrategy: DuplicateStrategy = "skip",
  columnMappings?: CsvColumnMapping[] | null,
): Promise<ImportResult> {
  return invoke("execute_import", {
    filePath,
    format,
    duplicateStrategy,
    columnMappings: columnMappings ?? null,
  });
}

export function previewMarkdownImport(filePath: string): Promise<MarkdownImportPreview> {
  return invoke("preview_markdown_import", { filePath });
}

export function importMarkdownPage(
  filePath: string,
  title: string,
  folder: string,
  tags: string[],
): Promise<Page> {
  return invoke("import_markdown_page", { filePath, title, folder, tags });
}

/** What is already at a chosen vault location, so the form can warn first. */
export type VaultDirState = "empty" | "vault" | "damaged" | "not_empty";

export function inspectVaultDir(path: string): Promise<VaultDirState> {
  return invoke("inspect_vault_dir", { path });
}

/** What `connect_ai_tool` hands back: a config to paste, and where it points. */
export interface AiToolConnection {
  snippet: string;
  port: number;
  scope: "notes" | "secrets";
}

/**
 * Mint an AI tool its own key, start the local API, and return the config
 * fragment to paste into the tool's settings.
 */
export function connectAiTool(scope: "notes" | "secrets"): Promise<AiToolConnection> {
  return invoke("connect_ai_tool", { scope });
}

/**
 * Change the master password on an unlocked vault.
 *
 * The recovery key is unaffected — it is the master key itself, which this
 * re-wraps rather than replaces.
 */
export function changeMasterPassword(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  return invoke("change_master_password", { oldPassword, newPassword });
}

// ── Recovery key ───────────────────────────────────────

/** The filename to offer in the save dialog for this vault's recovery key. */
export function recoveryKeyFilename(vaultDir: string): Promise<string> {
  return invoke("recovery_key_filename", { vaultDir });
}

/**
 * Write the recovery key to `filePath` as a self-describing sheet, returning
 * where it landed. Rejects a location inside the vault.
 */
export function saveRecoveryKey(
  recoveryKey: string,
  filePath: string,
  vaultDir: string,
): Promise<string> {
  return invoke("save_recovery_key", { recoveryKey, filePath, vaultDir });
}

/** Open the OS print dialog for the current window. */
export function printWindow(): Promise<void> {
  return invoke("print_window");
}

// ── Biometric ──────────────────────────────────────────

export function biometricAvailable(): Promise<boolean> {
  return invoke("biometric_available");
}

export function biometricEnrolled(vaultDir: string): Promise<boolean> {
  return invoke("biometric_enrolled", { vaultDir });
}

export function biometricEnroll(mode?: string): Promise<void> {
  // The backend scopes the enrolment to the vault it has open; a caller-chosen
  // directory is not accepted any more.
  return invoke("biometric_enroll", { mode: mode ?? "primary" });
}

export function biometricUnlock(vaultDir: string): Promise<void> {
  return invoke("biometric_unlock", { vaultDir });
}

export function biometricVerify(): Promise<void> {
  return invoke("biometric_verify");
}

export function biometricDisable(): Promise<void> {
  return invoke("biometric_disable");
}

export function biometricStatus(): Promise<string> {
  return invoke("biometric_status");
}

// ── License ─────────────────────────────────────────────

export function getLicenseStatus(): Promise<LicenseStatus> {
  return invoke("get_license_status");
}

export function activateLicense(token: string): Promise<LicenseStatus> {
  return invoke("activate_license", { token });
}

export function deactivateLicense(): Promise<LicenseStatus> {
  return invoke("deactivate_license");
}

// ── Share ──────────────────────────────────────────────

export function createPageShare(
  path: string,
  password: string,
  expiresHours: number,
  recipientEmail?: string,
  burnAfterReading?: boolean,
): Promise<ShareCreateResult> {
  return invoke("create_page_share", {
    path,
    password,
    expiresHours,
    recipientEmail: recipientEmail ?? null,
    burnAfterReading: burnAfterReading ?? false,
  });
}

export function createSecretShare(
  path: string,
  secretLabel: string,
  password: string,
  expiresHours: number,
  recipientEmail?: string,
  burnAfterReading?: boolean,
): Promise<ShareCreateResult> {
  return invoke("create_secret_share", {
    path,
    secretLabel,
    password,
    expiresHours,
    recipientEmail: recipientEmail ?? null,
    burnAfterReading: burnAfterReading ?? false,
  });
}

/** A share whose key rides in the link's fragment; the server never sees it. */
export function createPasswordlessPageShare(
  path: string,
  expiresHours: number,
  burnAfterReading?: boolean,
): Promise<ShareCreateResult> {
  return invoke("create_passwordless_page_share", {
    path,
    expiresHours,
    burnAfterReading: burnAfterReading ?? false,
  });
}

export function createPasswordlessSecretShare(
  path: string,
  secretLabel: string,
  expiresHours: number,
  burnAfterReading?: boolean,
): Promise<ShareCreateResult> {
  return invoke("create_passwordless_secret_share", {
    path,
    secretLabel,
    expiresHours,
    burnAfterReading: burnAfterReading ?? false,
  });
}

export function previewShare(shareId: string): Promise<SharePreview> {
  return invoke("preview_share", { shareId });
}

export function openShare(shareId: string, password: string): Promise<DecryptedShare> {
  return invoke("open_share", { shareId, password });
}

export function importSharedPage(
  title: string,
  tags: string[],
  folder: string,
  content: string,
): Promise<Page> {
  return invoke("import_shared_page", { title, tags, folder, content });
}

export function importSharedSecret(
  label: string,
  fields: ShareSecretField[],
  folder: string,
): Promise<Page> {
  return invoke("import_shared_secret", { label, fields, folder });
}

// ── Unified Check ──────────────────────────────────────

export function checkServer(): Promise<CheckResponse> {
  return invoke("check_server");
}

export function getEmailState(): Promise<[string | null, boolean]> {
  return invoke("get_email_state");
}

// ── Email Registration ────────────────────────────────────

export function registerEmail(email: string): Promise<void> {
  return invoke("register_email", { email });
}

export function verifyEmail(email: string, code: string): Promise<void> {
  return invoke("verify_email", { email, code });
}

// ── Sync ───────────────────────────────────────────────

export function syncStatus(): Promise<SyncStatus> {
  return invoke("sync_status");
}

export function syncNow(): Promise<SyncResult> {
  return invoke("sync_now");
}

export function syncConfigure(
  backend: string,
  remoteUrl?: string,
  intervalSecs?: number,
): Promise<void> {
  return invoke("sync_configure", {
    backend,
    remoteUrl: remoteUrl ?? null,
    intervalSecs: intervalSecs ?? null,
  });
}

export function syncStop(): Promise<void> {
  return invoke("sync_stop");
}

export function syncResolveConflict(
  path: string,
  resolution: SyncResolution,
): Promise<void> {
  return invoke("sync_resolve_conflict", { path, resolution });
}

// ── Sync V2 ────────────────────────────────────────────

export function syncV2Setup(
  backend: string,
  serverUrl: string,
): Promise<{
  status: "registered" | "otp_required";
  group_id?: string;
  device_id: string;
  current_version?: number;
  pending_device_id?: string;
  email_hint?: string;
  backend?: string;
  server_url?: string;
}> {
  return invoke("sync_v2_setup", { backend, serverUrl });
}

export function syncV2Verify(
  pendingDeviceId: string,
  code: string,
  deviceId: string,
  backend: string,
  serverUrl: string,
): Promise<{ group_id: string; device_id: string; current_version: number }> {
  return invoke("sync_v2_verify", {
    pendingDeviceId,
    code,
    deviceId,
    backend,
    serverUrl,
  });
}

export function syncV2Push(): Promise<{
  version: number;
  bundle_type: string;
  bytes_uploaded: number;
}> {
  return invoke("sync_v2_push");
}

export function syncV2Usage(): Promise<{
  used_bytes: number;
  quota_bytes: number;
}> {
  return invoke("sync_v2_usage");
}

export function syncV2ForcePush(): Promise<{
  version: number;
  bundle_type: string;
  bytes_uploaded: number;
}> {
  return invoke("sync_v2_force_push");
}

/** The two ids a refused sync found: this vault's and the account's. */
export interface VaultMismatch {
  local: string;
  remote: string;
}

/** What adopting the account's vault id did. */
export interface AdoptAccountVaultResult {
  previous_vault_id: string | null;
  vault_id: string;
  /** "moved": biometric keys follow the new id; "off": they could not and
   *  biometric unlock was switched off; "none": nothing was enrolled. */
  biometric: "moved" | "off" | "none";
  pushed_version: number | null;
  /** Set when the id changed but the fresh snapshot did not go up. */
  push_error: string | null;
}

/** One step of a fresh-copy push, as the backend reports it starting. */
export interface SyncProgress {
  stage: string;
  /** The size of the copy, once it is known. */
  bytes: number | null;
}

/** The event that carries `SyncProgress` while a fresh copy is made. */
export const VAULT_IDENTITY_PROGRESS_EVENT = "vault-identity-progress";

/**
 * Make this vault the one the account's sync group was set up for and put
 * a fresh copy on the server. Needs the master password: the group key is
 * derived from it and the vault id.
 */
export function syncV2AdoptAccountVault(
  password: string,
): Promise<AdoptAccountVaultResult> {
  return invoke("sync_v2_adopt_account_vault", { password });
}

/** One page a sync merge chose between: the newer `updated_at` was kept. */
export interface ResolvedPage {
  path: string;
  title: string;
  /** True when the version this device had is the one replaced. */
  mine_lost: boolean;
  kept_updated_at: string;
  lost_updated_at: string;
}

/** A resolved page as recorded in the sync state until dismissed, and after. */
export interface MergeNotice extends ResolvedPage {
  id: number;
  at: string;
  version: number;
  dismissed: boolean;
}

export function syncV2Pull(): Promise<{
  versions_applied: number[];
  commits_applied: number;
  conflicts: string[];
  resolved: ResolvedPage[];
}> {
  return invoke("sync_v2_pull");
}

export function syncV2MergeNotices(): Promise<MergeNotice[]> {
  return invoke("sync_v2_merge_notices");
}

export function syncV2DismissMergeNotices(): Promise<void> {
  return invoke("sync_v2_dismiss_merge_notices");
}

export function syncV2Status(): Promise<{
  configured: boolean;
  engine_active: boolean;
  merge_notices_pending?: number;
  /** Set while sync refuses to run because the account's group was set
   *  up for another vault. */
  vault_mismatch?: VaultMismatch | null;
  backend?: string;
  group_id?: string;
  device_id?: string;
  last_synced_version?: number;
  server_url?: string;
}> {
  return invoke("sync_v2_status");
}

export function syncV2Devices(): Promise<
  Array<{
    device_id: string;
    name: string;
    platform: string;
    sync_version: number;
    last_seen: string;
  }>
> {
  return invoke("sync_v2_devices");
}

export function syncV2RemoveDevice(deviceId: string): Promise<void> {
  return invoke("sync_v2_remove_device", { deviceId });
}

export function syncV2Disable(): Promise<void> {
  return invoke("sync_v2_disable");
}

export function syncV2GdriveAuth(): Promise<{ ok: boolean }> {
  return invoke("sync_v2_gdrive_auth");
}

// ── Account Linking ──────────────────────────────────────

export function accountLink(
  email: string,
  serverUrl: string,
): Promise<{
  pending_id: string;
  email_hint: string;
  tier: string;
  device_id: string;
}> {
  return invoke("account_link", { email, serverUrl });
}

export function accountLinkVerify(
  pendingId: string,
  code: string,
  serverUrl: string,
  deviceId: string,
): Promise<{
  license_token: string;
  tier: string;
  group_id: string;
  current_version: number;
  max_devices: number;
  device_count: number;
  /** The group key wrapped under the master key, for a recovery-key restore; null until a desktop publishes it. */
  restore_key: string | null;
}> {
  return invoke("account_link_verify", { pendingId, code, serverUrl, deviceId });
}

export function restoreSetupSync(
  licenseToken: string,
  deviceId: string,
  groupId: string,
  serverUrl: string,
): Promise<{ ok: boolean; pull_ok: boolean; group_id: string; device_id: string }> {
  return invoke("restore_setup_sync", { licenseToken, deviceId, groupId, serverUrl });
}

/**
 * Atomic restore — fetches the server manifest, creates the local vault using
 * the server's authoritative vault_id, pulls + decrypts + applies all bundles,
 * then persists the license + email + tier. Fails cleanly (no half-written
 * state) if decryption or pull fails.
 */
export function restoreFromServer(args: {
  email: string;
  password: string;
  licenseToken: string;
  deviceId: string;
  tier: string;
  serverUrl: string;
  vaultDir: string;
}): Promise<{ ok: boolean; vault_id: string; pulled_version: number }> {
  return invoke("restore_from_server", args);
}

/** Restore with the recovery key instead of the password; the vault is put under `newPassword`. */
export function restoreWithRecoveryKey(args: {
  email: string;
  recoveryKey: string;
  newPassword: string;
  restoreKey: string;
  licenseToken: string;
  deviceId: string;
  tier: string;
  serverUrl: string;
  vaultDir: string;
}): Promise<{ ok: boolean; vault_id: string; pulled_version: number }> {
  return invoke("restore_with_recovery_key", args);
}

// ── Local API ─────────────────────────────────────────

export function startLocalApi(): Promise<string> {
  return invoke("start_local_api");
}

export function stopLocalApi(): Promise<void> {
  return invoke("stop_local_api");
}

/** How far an approval decision reaches. */
export type Remember = "once" | "session" | "always";

export function approveSecretAccess(
  requestId: string,
  approved: boolean,
  remember: Remember,
): Promise<void> {
  return invoke("approve_secret_access", { requestId, approved, remember });
}

/** A standing approval: one client may read one page without a prompt. */
export interface ApprovalGrant {
  client_id: string;
  client_name: string;
  target: string;
  granted_at: string;
}

/** One memory page as the Agent Memory dashboard shows it (no content). */
export interface MemoryPageOverview {
  path: string;
  title: string;
  kind: string | null;
  stale: boolean;
  reviewed: boolean;
  written_by_name: string | null;
  updated_at: string;
  verified_on: string | null;
  valid_until: string | null;
  superseded_by: string | null;
  read_count: number;
  last_read: string | null;
}

export interface NamespaceOverview {
  namespace: string;
  pages: MemoryPageOverview[];
}

/** A stored password older than the rotation limit (no values). */
export interface RotationEntry {
  page_path: string;
  page_title: string;
  label: string;
  field: string;
  since: string;
  age_days: number;
  basis: "generated" | "page_updated";
}

export interface RotationReport {
  max_age_days: number;
  due: RotationEntry[];
}

export function utilityRotationDue(): Promise<RotationReport> {
  return invoke("utility_rotation_due");
}

export function memoryOverview(): Promise<NamespaceOverview[]> {
  return invoke("memory_overview");
}

export function listApprovalGrants(): Promise<ApprovalGrant[]> {
  return invoke("list_approval_grants");
}

export function revokeApprovalGrant(clientId: string, target: string): Promise<boolean> {
  return invoke("revoke_approval_grant", { clientId, target });
}

export function localApiStatus(): Promise<{ running: boolean; port: number }> {
  return invoke("local_api_status");
}

/** Start the SSH agent; resolves with the socket (or pipe) path for SSH_AUTH_SOCK. */
export function startSshAgent(): Promise<string> {
  return invoke("start_ssh_agent");
}

export function stopSshAgent(): Promise<void> {
  return invoke("stop_ssh_agent");
}

export function sshAgentStatus(): Promise<{ running: boolean; socket: string }> {
  return invoke("ssh_agent_status");
}

export function getExePath(): Promise<string> {
  return invoke("get_exe_path");
}

/** One named client that may call the local API. Never carries a token. */
export interface ApiClient {
  id: string;
  name: string;
  scope: "Notes" | "Secrets";
  /** Prefix and last four characters of the token, for matching by eye. */
  hint: string;
  created_at: string;
  /** Memory namespaces this client may touch; empty means all. */
  namespaces: string[];
}

/** The registered API clients, for the Settings list. */
export function listApiClients(): Promise<ApiClient[]> {
  return invoke("list_api_clients");
}

/**
 * Mint a token for a new named client.
 *
 * The returned token is the only copy that will ever exist: the backend keeps
 * a hash. Show it once, then let it go.
 */
export function createApiClient(
  name: string,
  scope: "notes" | "secrets",
  namespaces: string[],
): Promise<{ token: string; client: ApiClient }> {
  return invoke("create_api_client", { name, scope, namespaces });
}

/** Revoke a client; its token stops working on the next request. */
export function revokeApiClient(id: string): Promise<boolean> {
  return invoke("revoke_api_client", { id });
}

/** One recorded API request. Never carries a value or a query string. */
export interface AccessEntry {
  ts: string;
  /** Empty for a request that failed authentication. */
  client_id: string;
  client_name: string;
  scope: "Notes" | "Secrets" | null;
  action: string;
  method: string;
  target: string;
  status: number;
  duration_ms: number;
}

/** The most recent API requests, newest first, optionally for one client. */
export function readAccessLog(limit: number, clientId?: string): Promise<AccessEntry[]> {
  return invoke("read_access_log", { limit, clientId: clientId ?? null });
}

/** Whether a pairing window is open, and for how much longer. */
export interface PairingStatus {
  armed: boolean;
  secondsLeft: number;
}

/**
 * Open a short window during which the browser extension can collect a token,
 * so the user does not have to copy one by hand.
 *
 * `scope` is "secrets" for the browser extension, which must decrypt in order to
 * fill a password, or "notes" for a client that only reads pages.
 */
export function beginExtensionPairing(scope: "notes" | "secrets"): Promise<void> {
  return invoke("begin_extension_pairing", { scope });
}

/** Close the pairing window without pairing. */
export function cancelExtensionPairing(): Promise<void> {
  return invoke("cancel_extension_pairing");
}

export function extensionPairingStatus(): Promise<PairingStatus> {
  return invoke("extension_pairing_status");
}

// ── Generator ────────────────────────────────────────────

export interface PasswordOptions {
  length: number;
  uppercase?: boolean;
  lowercase?: boolean;
  numbers?: boolean;
  special?: boolean;
  exclude_ambiguous?: boolean;
  exclude_problematic?: boolean;
  custom_special?: string | null;
  /**
   * Cap on how many symbol characters may appear. Surplus symbol positions are
   * replaced with random non-symbol characters. Omit for no cap.
   */
  max_symbols?: number | null;
}

export interface PassphraseOptions {
  word_count: number;
  separator?: string;
  capitalize?: boolean;
  include_number?: boolean;
  word_list?: "eff" | "bip39";
}

export interface MemorableOptions {
  style?: "pronounceable" | "pattern";
  syllable_count?: number | null;
  word_count?: number | null;
}

export interface PinOptions {
  length: number;
}

export interface GenerateResult {
  value: string;
  entropy_bits: number;
  strength: StrengthResult;
}

export interface StrengthResult {
  entropy_bits: number;
  crack_time_display: string;
  score: number;
  label: string;
  suggestions: string[];
}

export function generatePassword(options: PasswordOptions): Promise<GenerateResult> {
  return invoke("generate_password", { options });
}

export function generatePassphrase(options: PassphraseOptions): Promise<GenerateResult> {
  return invoke("generate_passphrase", { options });
}

export function generateMemorable(options: MemorableOptions): Promise<GenerateResult> {
  return invoke("generate_memorable", { options });
}

export function generatePin(options: PinOptions): Promise<GenerateResult> {
  return invoke("generate_pin", { options });
}

export function generateUuid(): Promise<string> {
  return invoke("generate_uuid");
}

export function checkPasswordStrength(password: string): Promise<StrengthResult> {
  return invoke("check_password_strength", { password });
}

export function generateBulk(
  genType: string,
  optionsJson: string,
  count: number,
): Promise<string[]> {
  return invoke("generate_bulk", { genType, optionsJson, count });
}

export function exportGenerated(
  values: string[],
  filePath: string,
  format: string,
): Promise<void> {
  return invoke("export_generated", { values, filePath, format });
}

// ── Export ────────────────────────────────────────────

export interface ExportResult {
  pages_exported: number;
  secrets_exported: number;
  file_path: string;
}

export function exportVaultComplete(
  filePath: string,
  password?: string,
): Promise<ExportResult> {
  return invoke("export_vault_complete", { filePath, password: password || null });
}

export function exportSecretsOnly(
  filePath: string,
  format: string,
): Promise<ExportResult> {
  return invoke("export_secrets_only", { filePath, format });
}

export interface ImportZipResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export function importFromZip(
  zipPath: string,
  password?: string,
): Promise<ImportZipResult> {
  return invoke("import_from_zip", { zipPath, password: password || null });
}

// ── Utilities ─────────────────────────────────────────

export interface VaultStats {
  total_pages: number;
  total_folders: number;
  total_secrets: number;
  total_tags: number;
  total_size_bytes: number;
  pages_by_folder: Record<string, number>;
  avg_secrets_per_page: number;
  top_tags: [string, number][];
}

export interface PasswordHealthEntry {
  page_title: string;
  page_path: string;
  label: string;
  score: number;
  label_text: string;
  crack_time: string;
  entropy_bits: number;
  reused: boolean;
}

export interface PasswordHealthReport {
  entries: PasswordHealthEntry[];
  summary: {
    total: number;
    by_score: Record<number, number>;
    reused_count: number;
  };
}

export interface DuplicateEntry {
  page_title: string;
  page_path: string;
  label: string;
  username: string | null;
  url: string | null;
}

export interface DuplicateReport {
  groups: { key: string; entries: DuplicateEntry[] }[];
}

export interface ConsolidateEntry {
  page_title: string;
  page_path: string;
  label: string;
  domain: string;
  updated_at: string;
}

export interface ConsolidatePlan {
  groups: { domain: string; entries: ConsolidateEntry[] }[];
  total_secrets: number;
  total_pages_scanned: number;
}

export interface ConsolidateProgress {
  current: number;
  total: number;
  current_domain: string;
  pages_created: number;
  secrets_moved: number;
}

export interface ConsolidateResult {
  pages_created: number;
  pages_merged: number;
  secrets_moved: number;
  source_pages_deleted: number;
  source_folders_deleted: string[];
  folders_created: string[];
}

export interface TagUsage {
  tag: string;
  count: number;
  pages: string[];
}

export interface BulkTagResult {
  affected_pages: number;
}

export interface BreachEntry {
  page_title: string;
  page_path: string;
  label: string;
  breach_count: number;
}

export interface BreachCheckReport {
  entries: BreachEntry[];
  total_checked: number;
  total_breached: number;
}

export function utilityVaultStats(): Promise<VaultStats> {
  return invoke("utility_vault_stats");
}

export function utilityPasswordHealth(): Promise<PasswordHealthReport> {
  return invoke("utility_password_health");
}

export function utilityFindDuplicates(): Promise<DuplicateReport> {
  return invoke("utility_find_duplicates");
}

export function utilityConsolidatePreview(
  sourceFolders: string[],
): Promise<ConsolidatePlan> {
  return invoke("utility_consolidate_preview", { sourceFolders });
}

export function utilityConsolidateExecute(
  plan: ConsolidatePlan,
  targetFolder: string,
  sourceFolders: string[],
  testMode?: boolean,
  testLimit?: number,
): Promise<ConsolidateResult> {
  return invoke("utility_consolidate_execute", {
    plan,
    targetFolder,
    sourceFolders,
    testMode: testMode ?? null,
    testLimit: testLimit ?? null,
  });
}

export function utilityListTagsUsage(): Promise<TagUsage[]> {
  return invoke("utility_list_tags_usage");
}

export function utilityBulkTagOperation(op: {
  type: string;
  from?: string;
  to?: string;
  into?: string;
  tag?: string;
}): Promise<BulkTagResult> {
  return invoke("utility_bulk_tag_operation", { op });
}

export function utilityBreachCheck(): Promise<BreachCheckReport> {
  return invoke("utility_breach_check");
}

export function utilityResetHelpPages(): Promise<string> {
  return invoke("utility_reset_help_pages");
}

export interface ImportFolderResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export function utilityImportFolder(
  folderPath: string,
  targetFolder: string,
): Promise<ImportFolderResult> {
  return invoke("utility_import_folder", { folderPath, targetFolder });
}

// ── Activity Logging ─────────────────────────────────

export function logCredentialUsage(entry: {
  timestamp: string;
  page_path: string;
  label: string;
  action: string;
  source: string;
  domain: string | null;
  device_id: string | null;
}): Promise<void> {
  return invoke("log_credential_usage", { entry });
}

export function registerDevice(
  deviceId: string,
  deviceName: string,
  os: string,
  deviceType: string,
): Promise<void> {
  return invoke("register_device", { deviceId, deviceName, os, deviceType });
}

export function runSecurityScan(): Promise<number> {
  return invoke("run_security_scan");
}

export function saveAutomationRule(rule: {
  id: string;
  name: string;
  enabled: boolean;
  rule_type: Record<string, unknown>;
  created_at: string;
}): Promise<void> {
  return invoke("save_automation_rule", { rule });
}

export function deleteAutomationRule(ruleId: string): Promise<void> {
  return invoke("delete_automation_rule", { ruleId });
}

/** A template the owner saved in Settings › Automation › Templates. */
export interface SavedSecretTemplate {
  id: string;
  name: string;
  icon: string;
  fields: { key: string; label: string; field_type: string; required: boolean }[];
  use_count: number;
  created_at: string;
}

/** The owner's saved templates; the built-in ones live in the shared list. */
export function getTemplates(): Promise<SavedSecretTemplate[]> {
  return invoke("get_templates");
}

export function saveTemplate(template: {
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
}): Promise<void> {
  return invoke("save_template", { template });
}

export function deleteTemplate(templateId: string): Promise<void> {
  return invoke("delete_template", { templateId });
}

export function postUnlockInit(): Promise<void> {
  return invoke("post_unlock_init");
}

export function saveVaultStatsSnapshot(snapshot: {
  timestamp: string;
  total_pages: number;
  total_secrets: number;
  total_folders: number;
  folder_counts: { folder: string; count: number }[];
  tag_counts: { tag: string; count: number }[];
}): Promise<void> {
  return invoke("save_vault_stats_snapshot", { snapshot });
}

/** One passkey in the vault, as the settings screen lists it. Never the key. */
export interface PasskeySummary {
  page_path: string;
  label: string;
  rp_id: string;
  rp_name: string;
  credential_id: string;
  user_name: string;
  user_display_name: string;
  created: string;
  last_used: string | null;
}

export function listPasskeys(): Promise<PasskeySummary[]> {
  return invoke("list_passkeys");
}

export function deletePasskey(pagePath: string, credentialId: string): Promise<void> {
  return invoke("delete_passkey", { pagePath, credentialId });
}
