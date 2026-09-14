// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ActivitySection — read-only "Activity" settings tab.
 *
 * Surfaces locally-recorded vault telemetry across four sub-tabs: the share
 * audit log, credential usage journal, the device registry, and periodic vault
 * stats snapshots. All data is loaded from Tauri backend commands and stored
 * only on-device — nothing is sent to any server.
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ShareLogEntry {
  timestamp: string;
  item_title: string;
  page_path: string;
  share_type: string;
  recipient: string;
  expires_at: string | null;
  accessed: boolean;
  revoked: boolean;
  share_id: string | null;
}

interface UsageEntry {
  timestamp: string;
  page_path: string;
  label: string;
  action: string;
  source: string;
  domain: string | null;
}

interface StatsSnapshot {
  timestamp: string;
  total_pages: number;
  total_secrets: number;
  total_folders: number;
  folder_counts: { folder: string; count: number }[];
  tag_counts: { tag: string; count: number }[];
}

interface DeviceEntry {
  device_id: string;
  device_name: string;
  os: string;
  device_type: string;
  first_seen: string;
  last_seen: string;
  biometric_enrolled: boolean;
  is_current: boolean;
}

type SubTab = "shares" | "usage" | "devices" | "stats";

export function ActivitySection() {
  const [subTab, setSubTab] = useState<SubTab>("shares");
  const [shareLog, setShareLog] = useState<ShareLogEntry[]>([]);
  const [usageLog, setUsageLog] = useState<UsageEntry[]>([]);
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [stats, setStats] = useState<StatsSnapshot[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [shares, usage, devs, vaultStats] = await Promise.all([
        invoke<ShareLogEntry[]>("get_share_log"),
        invoke<UsageEntry[]>("get_usage_journal"),
        invoke<DeviceEntry[]>("get_devices"),
        invoke<StatsSnapshot[]>("get_vault_stats"),
      ]);
      setShareLog(shares.reverse());
      setUsageLog(usage.reverse().slice(0, 100));
      setDevices(devs);
      setStats(vaultStats);
    } catch {
      // Commands may not exist yet if vault isn't open
    }
    setLoading(false);
  }, []);

  // Load activity data on mount. The async work is wrapped in an IIFE so the
  // effect body itself performs no synchronous state update.
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-[13px] text-text-secondary leading-relaxed">
          Monitor how your vault is being used — track credential access, shared items,
          connected devices, and vault growth over time.
        </p>
        <p className="text-[10px] text-text-dim">
          All data is stored locally on this device and never sent to any server.
        </p>
      </div>
      {/* Sub-tab bar */}
      <div className="flex gap-1 rounded-lg border border-border p-0.5">
        {[
          { key: "shares" as SubTab, label: "Share Log", count: shareLog.length },
          { key: "usage" as SubTab, label: "Usage", count: usageLog.length },
          { key: "devices" as SubTab, label: "Devices", count: devices.length },
          { key: "stats" as SubTab, label: "Vault Stats", count: stats.length },
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
          {/* Share Audit Log */}
          {subTab === "shares" && (
            <div className="space-y-2">
              <p className="text-[11px] text-text-muted">
                Track who you've shared credentials with and whether they've been
                accessed.
              </p>
              {shareLog.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-8 text-center text-[12px] text-text-muted">
                  No shares recorded yet. Share a page or secret to see it here.
                </div>
              ) : (
                <div className="space-y-1 max-h-[400px] overflow-y-auto">
                  {shareLog.map((entry, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-3 rounded-lg border border-border p-2.5"
                    >
                      <div
                        className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                          entry.revoked
                            ? "bg-red-500"
                            : entry.accessed
                              ? "bg-green-500"
                              : "bg-yellow-500"
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-medium text-text-primary truncate">
                          {entry.item_title}
                        </div>
                        <div className="text-[11px] text-text-muted">
                          To: {entry.recipient} · {entry.share_type}
                          {entry.revoked && " · Revoked"}
                          {entry.accessed && !entry.revoked && " · Accessed"}
                        </div>
                        <div className="text-[10px] text-text-dim">
                          {formatDate(entry.timestamp)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Usage Journal */}
          {subTab === "usage" && (
            <div className="space-y-2">
              <p className="text-[11px] text-text-muted">
                Recent credential access — fills, copies, and reveals across all devices.
              </p>
              {usageLog.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-8 text-center text-[12px] text-text-muted">
                  No usage recorded yet. Fill or copy a credential to see it here.
                </div>
              ) : (
                <div className="space-y-1 max-h-[400px] overflow-y-auto">
                  {usageLog.map((entry, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 rounded-lg border border-border px-2.5 py-2"
                    >
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                          entry.action === "fill"
                            ? "bg-accent/10 text-accent"
                            : entry.action === "copy"
                              ? "bg-blue-500/10 text-blue-500"
                              : entry.action === "reveal"
                                ? "bg-yellow-500/10 text-yellow-600"
                                : "bg-surface-raised text-text-muted"
                        }`}
                      >
                        {entry.action}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-text-primary truncate">
                          {entry.label}
                        </div>
                        <div className="text-[10px] text-text-dim truncate">
                          {entry.source}
                          {entry.domain ? ` · ${entry.domain}` : ""}
                        </div>
                      </div>
                      <span className="text-[10px] text-text-dim shrink-0">
                        {formatTimeAgo(entry.timestamp)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Device Registry */}
          {subTab === "devices" && (
            <div className="space-y-2">
              <p className="text-[11px] text-text-muted">
                All devices that have accessed this vault.
              </p>
              {devices.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-8 text-center text-[12px] text-text-muted">
                  No devices registered yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {devices.map((d) => (
                    <div
                      key={d.device_id}
                      className="flex items-center gap-3 rounded-lg border border-border p-3"
                    >
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-raised text-text-muted">
                        {d.device_type === "desktop"
                          ? "🖥️"
                          : d.device_type === "mobile"
                            ? "📱"
                            : "🌐"}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-medium text-text-primary">
                            {d.device_name}
                          </span>
                          {d.is_current && (
                            <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-green-600">
                              Current
                            </span>
                          )}
                          {d.biometric_enrolled && (
                            <span className="text-[10px] text-text-dim">Biometric</span>
                          )}
                        </div>
                        <div className="text-[10px] text-text-dim">
                          {d.os} · First seen {formatDate(d.first_seen)} · Last{" "}
                          {formatTimeAgo(d.last_seen)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Vault Stats */}
          {subTab === "stats" && (
            <div className="space-y-3">
              <p className="text-[11px] text-text-muted">
                Your vault at a glance — tracked over time.
              </p>
              {stats.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-8 text-center text-[12px] text-text-muted">
                  No stats captured yet. Stats are recorded periodically.
                </div>
              ) : (
                <>
                  {/* Latest snapshot */}
                  {(() => {
                    const latest = stats[stats.length - 1]!;
                    return (
                      <div className="grid grid-cols-3 gap-2">
                        <StatCard label="Pages" value={latest.total_pages} />
                        <StatCard label="Secrets" value={latest.total_secrets} />
                        <StatCard label="Folders" value={latest.total_folders} />
                      </div>
                    );
                  })()}

                  {/* Folder breakdown */}
                  {(() => {
                    const latest = stats[stats.length - 1];
                    if (!latest || latest.folder_counts.length === 0) return null;
                    return (
                      <div>
                        <h4 className="text-[11px] font-semibold text-text-muted mb-1">
                          Pages per Folder
                        </h4>
                        <div className="space-y-1">
                          {latest.folder_counts
                            .sort((a, b) => b.count - a.count)
                            .map((fc) => (
                              <div
                                key={fc.folder}
                                className="flex items-center gap-2 text-[11px]"
                              >
                                <span className="text-text-muted w-[120px] truncate">
                                  {fc.folder}
                                </span>
                                <div className="flex-1 h-2 rounded-full bg-border overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-accent/60"
                                    style={{
                                      width: `${Math.min(100, (fc.count / Math.max(1, latest.total_pages)) * 100)}%`,
                                    }}
                                  />
                                </div>
                                <span className="text-text-dim w-8 text-right">
                                  {fc.count}
                                </span>
                              </div>
                            ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* History */}
                  {stats.length > 1 && (
                    <div>
                      <h4 className="text-[11px] font-semibold text-text-muted mb-1">
                        History ({stats.length} snapshots)
                      </h4>
                      <div className="text-[10px] text-text-dim">
                        First: {formatDate(stats[0]?.timestamp ?? "")} · Latest:{" "}
                        {formatDate(stats[stats.length - 1]?.timestamp ?? "")}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-3 text-center">
      <div className="text-xl font-bold text-text-primary">{value}</div>
      <div className="text-[10px] text-text-muted">{label}</div>
    </div>
  );
}

function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return ts;
  }
}

function formatTimeAgo(ts: string): string {
  try {
    const seconds = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  } catch {
    return ts;
  }
}
