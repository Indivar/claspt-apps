// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConnectionState,
  Credential,
  ExtensionConfig,
  Message,
} from "@/shared/types";
import { DEFAULT_CONFIG } from "@/shared/types";
import { connectionFromStatus } from "./connection";
import { STORAGE_KEY_CONFIG, STORAGE_KEY_POPUP_STATE } from "@/shared/constants";
import { detectReusedPasswords, type ReusedReport } from "@/shared/reused";
import { credKey, markUsed } from "@/shared/cred-state";
import { isDeprecated } from "@/shared/cred-flags";
import { Header } from "./components/Header";
import { TabBar } from "./components/TabBar";
import { SearchBar } from "./components/SearchBar";
import { CredentialList } from "./components/CredentialList";
import { PasswordGenerator } from "./components/PasswordGenerator";
import { SettingsPanel } from "./components/SettingsPanel";
import { EmptyState } from "./components/EmptyState";
import { FilterBar } from "./components/FilterBar";
import { QuickAddForm } from "./components/QuickAddForm";
import { IdentityTab } from "./components/IdentityTab";
import { WaitingToSave } from "./components/WaitingToSave";
import { CaptureNote } from "./components/CaptureNote";
import { RecentlyFilled } from "./components/RecentlyFilled";
import { PasskeyNotice } from "./components/PasskeyNotice";
import { Onboarding } from "./components/Onboarding";
import { PermissionPrompt } from "./components/PermissionPrompt";

type Tab = "logins" | "generator" | "identity" | "settings";
type Filter = "matching" | "domain" | "all";

export function App() {
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [version, setVersion] = useState<string>();
  const [vaultSyncVersion, setVaultSyncVersion] = useState<number | undefined>();
  const [plan, setPlan] = useState<string>();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("logins");
  const [activeFilter, setActiveFilter] = useState<Filter>("matching");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [currentDomain, setCurrentDomain] = useState<string>("");
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [allCredentials, setAllCredentials] = useState<Credential[]>([]);
  const [reusedReportState, setReusedReportState] = useState<ReusedReport | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Recompute reused-password report when the vault snapshot changes. The
  // report is only meaningful for the snapshot it was computed from, so an
  // empty snapshot reads as "no report" rather than clearing state in the
  // effect.
  useEffect(() => {
    if (allCredentials.length === 0) return;
    let cancelled = false;
    detectReusedPasswords(allCredentials).then((r) => {
      if (!cancelled) setReusedReportState(r);
    });
    return () => {
      cancelled = true;
    };
  }, [allCredentials]);
  const reusedReport = allCredentials.length === 0 ? null : reusedReportState;
  const listRef = useRef<HTMLDivElement>(null);

  // Restore last active tab from persistent state
  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY_POPUP_STATE, (result) => {
      const state = result[STORAGE_KEY_POPUP_STATE];
      if (state?.activeTab) setActiveTab(state.activeTab);
    });
  }, []);

  // Save active tab to persistent state
  useEffect(() => {
    chrome.storage.local.set({ [STORAGE_KEY_POPUP_STATE]: { activeTab } });
  }, [activeTab]);

  const tryPairing = useCallback((config: ExtensionConfig) => {
    chrome.runtime.sendMessage({ type: "PAIR_WITH_APP" } as Message, (res: Message) => {
      if (res?.type === "PAIR_RESULT" && res.ok) {
        setConnection("connected");
        setShowOnboarding(false);
        return;
      }
      if (res?.type === "PAIR_RESULT" && res.reason === "desktop-too-old") {
        setConnection("desktop_too_old");
        return;
      }
      if (!config.onboardingComplete) setShowOnboarding(true);
    });
  }, []);

  // Check onboarding + status on mount
  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY_CONFIG, (result) => {
      const config: ExtensionConfig = {
        ...DEFAULT_CONFIG,
        ...result[STORAGE_KEY_CONFIG],
      };
      // A stored token used to end the matter for good. If that token was
      // wrong, revoked, or typed by hand into the wrong box, pairing could
      // never run again and the extension stayed broken with no way back
      // except clearing storage. A token that still works short-circuits
      // here; one that does not falls through to pairing like a fresh
      // install would.
      if (config.token) {
        chrome.runtime.sendMessage(
          { type: "GET_STATUS" } as Message,
          (status: Message) => {
            // Retrying costs nothing when the token is fine: PAIR_WITH_APP only
            // succeeds while the app has a pairing window open, and otherwise
            // fails quietly. So the test is simply "did the token work", and a
            // locked vault or a closed app leads to a no-op rather than harm.
            const connected = status?.type === "STATUS_RESULT" && status.connected;
            if (!connected) tryPairing(config);
          },
        );
        return;
      }
      tryPairing(config);

      // No token yet. Try pairing before showing the onboarding screen: if the
      // user has just pressed Connect in the desktop app, its pairing window is
      // open and this succeeds silently — which is the whole point of the
      // handshake. Copying a token by hand is the fallback, not the first move.
    });

    const pollStatus = () => {
      chrome.runtime.sendMessage({ type: "GET_STATUS" } as Message, (res: Message) => {
        if (res?.type === "STATUS_RESULT") {
          setConnection(connectionFromStatus(res));
          setVersion(res.version);
          setVaultSyncVersion(res.vaultSyncVersion);
          setPlan(res.plan);
        }
        setLoading(false);
      });
    };
    // Initial fetch on mount + repeat every 10s while popup stays open so
    // the `vault v{n}` revision ticks up live alongside desktop edits.
    pollStatus();
    const id = setInterval(pollStatus, 10_000);
    return () => clearInterval(id);
    // tryPairing is stable (useCallback with no deps); listed so the mount
    // effect does not silently capture a stale one if that ever changes.
  }, [tryPairing]);

  // Load credentials for current tab
  useEffect(() => {
    if (connection !== "connected") return;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      const tabUrl = tab?.url || "";

      // Extract domain from real web pages only
      let domain = "";
      if (tabUrl.startsWith("http://") || tabUrl.startsWith("https://")) {
        try {
          domain = new URL(tabUrl).hostname;
        } catch {
          /* ignore */
        }
      }
      setCurrentDomain(domain);

      if (domain) {
        chrome.runtime.sendMessage(
          { type: "GET_CREDENTIALS", domain } as Message,
          (res: Message) => {
            if (res?.type === "CREDENTIALS_RESULT") {
              setCredentials(res.credentials);
              // If no domain matches, auto-load all
              if (res.credentials.length === 0) {
                setActiveFilter("all");
                chrome.runtime.sendMessage(
                  { type: "SEARCH_CREDENTIALS", query: "*" } as Message,
                  (r: Message) => {
                    if (r?.type === "SEARCH_RESULT") setCredentials(r.credentials);
                  },
                );
              }
            }
          },
        );
      } else {
        // Not a web page — show all credentials
        setActiveFilter("all");
      }
    });

    // Also preload all credentials for the "All" tab
    chrome.runtime.sendMessage(
      { type: "SEARCH_CREDENTIALS", query: "*" } as Message,
      (res: Message) => {
        if (res?.type === "SEARCH_RESULT") setAllCredentials(res.credentials);
      },
    );
  }, [connection]);

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setSelectedIndex(-1);
    if (!query.trim()) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab?.url) return;
        const url = new URL(tab.url);
        chrome.runtime.sendMessage(
          { type: "GET_CREDENTIALS", domain: url.hostname } as Message,
          (res: Message) => {
            if (res?.type === "CREDENTIALS_RESULT") {
              setCredentials(res.credentials);
            }
          },
        );
      });
      return;
    }

    chrome.runtime.sendMessage(
      { type: "SEARCH_CREDENTIALS", query } as Message,
      (res: Message) => {
        if (res?.type === "SEARCH_RESULT") {
          setCredentials(res.credentials);
        }
      },
    );
  }, []);

  const handleCopy = useCallback(async (text: string, fieldName: string) => {
    // Write directly from the popup: we have clipboardWrite permission + user
    // gesture, and this avoids the tab-roundtrip path that silently fails on
    // chrome:// / chrome-extension:// / accounts.google.com and pages with
    // strict CSP. Background handles the auto-clear alarm separately.
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Fallback: hidden textarea + execCommand (deprecated but still works
      // in extension contexts where the async API is blocked by focus rules).
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        /* give up */
      }
    }
    if (ok) {
      chrome.runtime.sendMessage({ type: "COPY_TO_CLIPBOARD_SCHEDULE_CLEAR" } as Message);
      setCopyFeedback(fieldName);
      setTimeout(() => setCopyFeedback(null), 1500);
    }
  }, []);

  const handleFill = useCallback(
    (credential: Credential, opts?: { submit?: boolean }) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab?.id) return;
        chrome.tabs.sendMessage(tab.id, {
          type: "FILL_CREDENTIAL",
          credential,
          submit: opts?.submit === true,
        });
        void markUsed(credKey(credential.pagePath, credential.label));
        window.close();
      });
    },
    [],
  );

  const handleTestConnection = useCallback(async (): Promise<boolean> => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_STATUS" } as Message, (res: Message) => {
        if (res?.type === "STATUS_RESULT" && res.connected) {
          setConnection("connected");
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }, []);

  const handleQuickSave = useCallback(
    (data: { template: string; label: string; fields: Record<string, string> }) => {
      const username = data.fields["Username"] || data.fields["Email"] || "";
      const password = data.fields["Password"] || data.fields["Secret"] || "";
      const url = data.fields["URL"] || (currentDomain ? `https://${currentDomain}` : "");
      chrome.runtime.sendMessage(
        {
          type: "SAVE_CREDENTIAL",
          username,
          password,
          url,
          domain: currentDomain,
          label: data.label,
          fields: data.fields,
          template: data.template,
        } as Message,
        () => {
          setShowQuickAdd(false);
          if (currentDomain) {
            chrome.runtime.sendMessage(
              { type: "GET_CREDENTIALS", domain: currentDomain } as Message,
              (res: Message) => {
                if (res?.type === "CREDENTIALS_RESULT") setCredentials(res.credentials);
              },
            );
          }
        },
      );
    },
    [currentDomain],
  );

  // Filter credentials by score — "all" uses the preloaded allCredentials.
  // Deprecated credentials are dropped from "matching" and "domain" tiers
  // (still findable via search and visible in "all").
  // The filter the user picked, widened when it would show nothing for this
  // site: "matching" falls back to "domain", and "domain" to "all". Derived
  // rather than written back into state so the tabs and the list agree
  // within one render.
  const effectiveFilter: Filter = (() => {
    if (searchQuery || credentials.length === 0) return activeFilter;
    const hasMatching = credentials.some(
      (c) => (c.score ?? 0) >= 100 && !isDeprecated(c),
    );
    const hasDomain = credentials.some((c) => (c.score ?? 0) >= 25 && !isDeprecated(c));
    if (activeFilter === "matching" && !hasMatching) return hasDomain ? "domain" : "all";
    if (activeFilter === "domain" && !hasDomain) return "all";
    return activeFilter;
  })();

  const filteredCredentials = (() => {
    if (searchQuery) return credentials;
    switch (effectiveFilter) {
      case "matching":
        return credentials.filter((c) => (c.score ?? 0) >= 100 && !isDeprecated(c));
      case "domain":
        return credentials.filter((c) => (c.score ?? 0) >= 25 && !isDeprecated(c));
      case "all": {
        // Merge domain results with all vault credentials
        const seen = new Set(credentials.map((c) => `${c.pagePath}:${c.label}`));
        const merged = [...credentials];
        for (const c of allCredentials) {
          const key = `${c.pagePath}:${c.label}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(c);
          }
        }
        return merged;
      }
    }
  })();

  const filterCounts = {
    matching: credentials.filter((c) => (c.score ?? 0) >= 100 && !isDeprecated(c)).length,
    domain: credentials.filter((c) => (c.score ?? 0) >= 25 && !isDeprecated(c)).length,
    all: Math.max(allCredentials.length, credentials.length),
  };

  // Keyboard navigation
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (activeTab !== "logins") return;

      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        (document.querySelector('input[type="text"]') as HTMLInputElement)?.focus();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredCredentials.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, -1));
      } else if (e.key === "Enter" && selectedIndex >= 0) {
        e.preventDefault();
        const cred = filteredCredentials[selectedIndex];
        if (cred) handleFill(cred);
      } else if (e.key === "Escape") {
        window.close();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeTab, filteredCredentials, selectedIndex, handleFill]);

  // Onboarding wizard (first install)
  if (showOnboarding) {
    return (
      <div className="min-h-[200px] max-h-[580px]">
        <Onboarding
          onComplete={() => {
            setShowOnboarding(false);
            // Re-check connection after onboarding
            chrome.runtime.sendMessage(
              { type: "GET_STATUS" } as Message,
              (res: Message) => {
                if (res?.type === "STATUS_RESULT") {
                  setConnection(connectionFromStatus(res));
                  setVersion(res.version);
                  setVaultSyncVersion(res.vaultSyncVersion);
                  setPlan(res.plan);
                }
              },
            );
          }}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="flex flex-col items-center gap-2">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-xs text-text-muted">Connecting...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-[200px] max-h-[580px]">
      <Header
        connection={connection}
        matchCount={filterCounts.matching}
        desktopVersion={version}
        vaultSyncVersion={vaultSyncVersion}
        plan={plan}
      />

      {/* TabBar: always visible — generator and settings work without connection */}
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Settings tab — always accessible */}
      {activeTab === "settings" ? (
        <SettingsPanel onTestConnection={handleTestConnection} />
      ) : /* Generator tab — works without connection (pure local crypto) */
      activeTab === "generator" ? (
        <PasswordGenerator />
      ) : /* Permission needed takes precedence over other disconnected states */
      connection === "permission_needed" ? (
        <PermissionPrompt
          onGranted={() => {
            // Re-fetch status so the UI refreshes into "connected" / "vault_locked".
            chrome.runtime.sendMessage(
              { type: "GET_STATUS" } as Message,
              (res: Message) => {
                if (res?.type === "STATUS_RESULT") {
                  setConnection(connectionFromStatus(res));
                  setVersion(res.version);
                  setVaultSyncVersion(res.vaultSyncVersion);
                  setPlan(res.plan);
                }
              },
            );
          }}
        />
      ) : /* Logins & Identity require connection */
      connection === "disconnected" || connection === "unauthorized" ? (
        <div className="flex flex-col">
          <EmptyState
            variant={connection === "unauthorized" ? "unauthorized" : "disconnected"}
            onAction={() => setActiveTab("settings")}
          />
          <WaitingToSave connected={false} />
        </div>
      ) : connection === "vault_locked" ? (
        <EmptyState variant="vault-locked" />
      ) : (
        <>
          {activeTab === "logins" && (
            <div className="flex flex-col flex-1 min-h-0">
              <WaitingToSave
                connected={connection === "connected"}
                onChanged={() => {
                  if (currentDomain) {
                    chrome.runtime.sendMessage(
                      { type: "GET_CREDENTIALS", domain: currentDomain } as Message,
                      (res: Message) => {
                        if (res?.type === "CREDENTIALS_RESULT") setCredentials(res.credentials);
                      },
                    );
                  }
                }}
              />
              <CaptureNote domain={currentDomain} />
              <PasskeyNotice domain={currentDomain} />
              <RecentlyFilled onFill={handleFill} />
              <SearchBar value={searchQuery} onChange={handleSearch} />

              {!searchQuery &&
                (credentials.length > 0 || allCredentials.length > 0) &&
                (() => {
                  // Hide the FilterBar entirely when only one tier actually has
                  // results — it just adds visual weight when there's nothing
                  // to switch between.
                  const populated =
                    (filterCounts.matching > 0 ? 1 : 0) +
                    (filterCounts.domain > 0 ? 1 : 0) +
                    (filterCounts.all > 0 ? 1 : 0);
                  if (populated < 2) return null;
                  return (
                    <FilterBar
                      active={effectiveFilter}
                      onFilterChange={setActiveFilter}
                      counts={filterCounts}
                    />
                  );
                })()}

              {filteredCredentials.length === 0 ? (
                <EmptyState
                  variant={searchQuery ? "no-results" : "no-credentials"}
                  domain={currentDomain}
                  query={searchQuery}
                  onAction={() => setShowQuickAdd(true)}
                />
              ) : (
                <div ref={listRef} className="flex-1 overflow-y-auto relative">
                  {reusedReport && reusedReport.reusedCount >= 2 && (
                    <div
                      className="flex items-center gap-2 px-3 py-1.5 text-[11px] border-b border-border"
                      style={{
                        background:
                          "color-mix(in oklab, var(--color-warning) 15%, transparent)",
                        color: "var(--color-warning)",
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <circle cx="8" cy="8" r="7" opacity="0.85" />
                        <path
                          d="M5.5 5.5l5 5M10.5 5.5l-5 5"
                          stroke="#fff"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                      <span>
                        <strong>{reusedReport.reusedCount}</strong> credentials share
                        passwords with another login
                      </span>
                    </div>
                  )}
                  <CredentialList
                    credentials={filteredCredentials}
                    onCopy={handleCopy}
                    onFill={handleFill}
                    copyFeedback={copyFeedback}
                    selectedIndex={selectedIndex}
                    reusedHashes={reusedReport?.reusedHashes}
                    credentialHashes={
                      reusedReport
                        ? new Map(
                            Array.from(reusedReport.byCredential, ([k, v]) => [
                              k,
                              v.hash,
                            ]),
                          )
                        : undefined
                    }
                  />
                </div>
              )}


              {/* Quick Add — subtle bottom bar, not FAB */}
              {!showQuickAdd && (
                <div className="border-t border-border px-3 py-1.5 flex justify-end">
                  <button
                    onClick={() => setShowQuickAdd(true)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/10 transition-colors"
                    title="Add new credential"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M8 3v10M3 8h10"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                    Add new
                  </button>
                </div>
              )}

              {/* Quick Add Form */}
              {showQuickAdd && (
                <QuickAddForm
                  domain={currentDomain}
                  onSave={handleQuickSave}
                  onCancel={() => setShowQuickAdd(false)}
                />
              )}
            </div>
          )}

          {activeTab === "identity" && (
            <IdentityTab connected={connection === "connected"} />
          )}
        </>
      )}
    </div>
  );
}
