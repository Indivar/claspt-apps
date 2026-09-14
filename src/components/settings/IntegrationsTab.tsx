// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * IntegrationsTab — settings panel for the localhost-only Local API. Lets the
 * user enable/disable the HTTP server, choose a port, and manage the named
 * clients that may call it: each has its own token (Notes scope with secrets
 * redacted, or Secrets scope with decryption), stored as a hash and shown once
 * at creation, revocable on its own. Provides copy-paste MCP/CLI/curl
 * configuration snippets and a collapsible reference of all HTTP endpoints.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as cmd from "@/lib/commands";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SpinnerIcon } from "@/components/ui/icons";
import type { VaultConfig } from "@claspt/shared/types";
import { copyToClipboard } from "@/lib/clipboard";

interface IntegrationsTabProps {
  draft: VaultConfig;
  updateDraft: <K extends keyof VaultConfig>(key: K, value: VaultConfig[K]) => void;
}

/** Local API enable/port controls, scoped-token management, and config snippets. */
export function IntegrationsTab({ draft, updateDraft }: IntegrationsTabProps) {
  const [apiStatus, setApiStatus] = useState<{ running: boolean; port: number } | null>(
    null,
  );
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [exePath, setExePath] = useState("claspt");
  // Clients live in the registry file, not in the config, so they are fetched
  // rather than read from the draft. Records never include a token.
  const [clients, setClients] = useState<cmd.ApiClient[]>([]);
  // The token of the client created in this session, shown once. It is the
  // only copy: the backend keeps a hash.
  const [created, setCreated] = useState<{ token: string; client: cmd.ApiClient } | null>(
    null,
  );
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<"notes" | "secrets">("notes");
  const [newNamespaces, setNewNamespaces] = useState("");
  const [creating, setCreating] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const refreshClients = useCallback(async () => {
    setClients(await cmd.listApiClients());
  }, []);

  const handleCreate = useCallback(async () => {
    setClientError(null);
    setCreating(true);
    try {
      const namespaces = newNamespaces
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n.length > 0);
      const result = await cmd.createApiClient(newName, newScope, namespaces);
      setCreated(result);
      setNewName("");
      setNewNamespaces("");
      await refreshClients();
    } catch (e) {
      setClientError(String(e));
    }
    setCreating(false);
  }, [newName, newScope, newNamespaces, refreshClients]);

  const handleRevoke = useCallback(
    async (id: string) => {
      setClientError(null);
      try {
        await cmd.revokeApiClient(id);
        if (created?.client.id === id) setCreated(null);
        await refreshClients();
      } catch (e) {
        setClientError(String(e));
      }
      setConfirmRevoke(null);
    },
    [created, refreshClients],
  );

  // Fetch API status, exe path and tokens on mount
  useEffect(() => {
    let cancelled = false;
    cmd.localApiStatus().then((s) => {
      if (!cancelled) setApiStatus(s as { running: boolean; port: number });
    });
    cmd.getExePath().then((p) => {
      if (!cancelled) setExePath(p);
    });
    cmd.listApiClients().then((list) => {
      if (!cancelled) setClients(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = useCallback(async () => {
    setToggleError(null);
    const enabling = !draft.local_api_enabled;
    updateDraft("local_api_enabled", enabling);
    setToggling(true);
    try {
      if (enabling) {
        await cmd.startLocalApi();
        const s = await cmd.localApiStatus();
        setApiStatus(s as { running: boolean; port: number });
      } else {
        await cmd.stopLocalApi();
        setApiStatus({ running: false, port: 0 });
      }
    } catch (e) {
      setToggleError(String(e));
      if (enabling) updateDraft("local_api_enabled", false);
    }
    setToggling(false);
  }, [draft.local_api_enabled, updateDraft]);

  const port = draft.local_api_port ?? 9315;
  // Snippets show the token created in this session while it is on screen;
  // otherwise a placeholder, because no stored token can be read back.
  const configToken = created?.token ?? "<token>";

  return (
    <>
      <SectionHeader title="Local API" />
      <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
        HTTP API for programmatic access. Runs on localhost only.
      </p>

      {/* Enable toggle */}
      <div className="flex items-center justify-between py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-text-primary">Enable Local API</span>
          {toggling && <SpinnerIcon size={12} className="animate-spin text-text-muted" />}
          {!toggling && apiStatus?.running && (
            <span className="inline-flex items-center gap-1 text-[11px] text-success">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
              Port {apiStatus.port}
            </span>
          )}
        </div>
        <button
          role="switch"
          aria-checked={draft.local_api_enabled === true}
          disabled={toggling}
          onClick={handleToggle}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            draft.local_api_enabled ? "bg-accent" : "bg-border"
          } disabled:opacity-50`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              draft.local_api_enabled ? "translate-x-4" : ""
            }`}
          />
        </button>
      </div>
      {toggleError && (
        <p className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {toggleError}
        </p>
      )}

      {/* Port */}
      <div className="flex items-center justify-between py-2.5">
        <span className="text-[13px] text-text-primary">Port</span>
        <input
          type="number"
          value={port}
          min={1024}
          max={65535}
          onChange={(e) => updateDraft("local_api_port", Number(e.target.value))}
          className="focus-accent w-24 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-right text-[13px] text-text-primary outline-none"
        />
      </div>

      {/* API clients */}
      <SectionHeader title="API Clients" />
      <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
        Every tool that talks to Claspt has its own named token, so each can be revoked on
        its own. Tokens are stored as hashes and shown once, when created.{" "}
        <code className="rounded bg-surface-overlay px-1 text-[11px]">
          claspt mcp install claude-code
        </code>{" "}
        and extension pairing create theirs automatically.
      </p>

      {clients.length === 0 ? (
        <p className="mb-3 text-[12px] text-text-muted">No clients yet.</p>
      ) : (
        <ul className="mb-3 divide-y divide-border/60 rounded-lg border border-border/60">
          {clients.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12px] font-medium text-text-primary">
                    {c.name}
                  </span>
                  {c.scope === "Secrets" ? (
                    <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                      secrets
                    </span>
                  ) : (
                    <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] text-text-muted">
                      notes
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-text-muted">
                  {c.hint} · created {new Date(c.created_at).toLocaleDateString()}
                  {c.namespaces.length > 0 && <> · memory: {c.namespaces.join(", ")}</>}
                </div>
              </div>
              {confirmRevoke === c.id ? (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => handleRevoke(c.id)}
                    className="rounded-lg border border-warning/40 px-2.5 py-1 text-[11px] font-medium text-warning transition-all hover:bg-warning/10 active:scale-95"
                  >
                    Confirm revoke
                  </button>
                  <button
                    onClick={() => setConfirmRevoke(null)}
                    className="rounded px-2 py-1 text-[11px] text-text-muted hover:bg-surface-overlay"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmRevoke(c.id)}
                  className="shrink-0 rounded-lg border border-border/60 px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mb-3 rounded-lg border border-border/60 px-3 py-2.5">
        <div className="mb-2 text-[12px] font-medium text-text-primary">
          Create a token
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name, e.g. Deploy script"
            maxLength={80}
            className="focus-accent min-w-[12rem] flex-1 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none"
          />
          <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
            <input
              type="radio"
              name="new_client_scope"
              checked={newScope === "notes"}
              onChange={() => setNewScope("notes")}
              className="accent-accent"
            />
            Notes
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
            <input
              type="radio"
              name="new_client_scope"
              checked={newScope === "secrets"}
              onChange={() => setNewScope("secrets")}
              className="accent-accent"
            />
            Secrets
          </label>
          <button
            onClick={handleCreate}
            disabled={creating || newName.trim().length === 0}
            className="rounded-lg border border-border/60 px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-all hover:bg-surface-overlay active:scale-95 disabled:opacity-50"
          >
            {creating ? (
              <span className="inline-flex items-center gap-1">
                <SpinnerIcon size={10} className="animate-spin" />
                Creating...
              </span>
            ) : (
              "Create"
            )}
          </button>
        </div>
        <input
          type="text"
          value={newNamespaces}
          onChange={(e) => setNewNamespaces(e.target.value)}
          placeholder="Memory namespaces, comma-separated (blank = all), e.g. claspt, global"
          className="focus-accent mt-2 w-full rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none"
        />
        <p className="mt-1 text-[11px] text-text-muted">
          Notes: pages, search, folders, memory; secret values redacted. Secrets: can
          decrypt, subject to the access mode below. A namespace list limits which
          projects' memory the client can touch.
        </p>
        {clientError && <p className="mt-1 text-[11px] text-warning">{clientError}</p>}
        {created && <OneTimeToken token={created.token} name={created.client.name} />}
      </div>

      {/* Secret read limit */}
      <div className="flex items-center justify-between py-2.5">
        <div>
          <span className="text-[13px] text-text-primary">Secret reads per minute</span>
          <p className="text-[11px] text-text-muted">
            Per client. Past this, a client is told to wait and the attempt is logged.
          </p>
        </div>
        <input
          type="number"
          min={1}
          max={600}
          value={draft.secret_read_rate_limit_per_minute ?? 15}
          onChange={(e) =>
            updateDraft("secret_read_rate_limit_per_minute", Number(e.target.value))
          }
          className="focus-accent w-24 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-right text-[13px] text-text-primary outline-none"
        />
      </div>

      {/* Standing approvals */}
      <SshAgentSection draft={draft} updateDraft={updateDraft} />

      <StandingApprovals clients={clients} />

      {/* Secret Access Mode */}
      <div className="py-2.5">
        <span className="text-[13px] text-text-primary">Secret Access Mode</span>
        <div className="mt-2 flex gap-3">
          <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
            <input
              type="radio"
              name="secret_access_mode"
              checked={draft.secret_access_mode !== "approve"}
              onChange={() => updateDraft("secret_access_mode", "auto")}
              className="accent-accent"
            />
            Auto-allow
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
            <input
              type="radio"
              name="secret_access_mode"
              checked={draft.secret_access_mode === "approve"}
              onChange={() => updateDraft("secret_access_mode", "approve")}
              className="accent-accent"
            />
            Require approval
          </label>
        </div>
        <p className="mt-1 text-[11px] text-text-muted">
          {draft.secret_access_mode === "approve"
            ? "A popup will appear when an agent requests secret access."
            : "Secrets token grants immediate access without UI approval."}
        </p>
      </div>

      {/* MCP & CLI Configuration */}
      <SectionHeader title="MCP Configuration" />
      <p className="mb-2 text-[12px] leading-relaxed text-text-muted">
        Copy-paste config for AI tools that support the Model Context Protocol.
      </p>

      <p className="mb-3 text-[11px] text-text-muted">
        The quickest route is{" "}
        <code className="rounded bg-surface-overlay px-1">
          claspt mcp install claude-code
        </code>{" "}
        (or cursor, codex, windsurf, gemini-cli, claude-desktop), which creates a client
        and writes the config for you. The snippets below use the token created above, if
        any.
      </p>
      <ConfigBlock
        label="Claude Code (CLI)"
        code={`claude mcp add claspt -e CLASPT_API_TOKEN=${configToken} -- ${exePath} --mcp`}
      />
      <ConfigBlock
        label="Claude Desktop"
        code={`{
  "mcpServers": {
    "claspt": {
      "command": "${exePath}",
      "args": ["--mcp"],
      "env": {
        "CLASPT_API_TOKEN": "${configToken}"
      }
    }
  }
}`}
      />
      <ConfigBlock
        label="Gemini CLI"
        code={`gemini mcp add claspt -e CLASPT_API_TOKEN=${configToken} -- ${exePath} --mcp`}
      />
      <ConfigBlock
        label="Cursor / Windsurf / Other MCP Clients"
        code={`{
  "mcpServers": {
    "claspt": {
      "command": "${exePath}",
      "args": ["--mcp"],
      "env": {
        "CLASPT_API_TOKEN": "${configToken}"
      }
    }
  }
}`}
      />

      <SectionHeader title="HTTP API" />
      <ConfigBlock
        label="curl"
        code={`curl http://127.0.0.1:${port}/api/status \\
  -H "Authorization: Bearer ${configToken}"`}
      />

      <SectionHeader title="Activity" />
      <p className="mb-2 text-[12px] leading-relaxed text-text-muted">
        Every API request is recorded: which client, what it did, and the result. Values
        are never logged. Also available as{" "}
        <code className="rounded bg-surface-overlay px-1 text-[11px]">claspt log</code>.
      </p>
      <ActivityLog clients={clients} />
      <div className="mb-3 flex items-center justify-between py-1">
        <div>
          <span className="text-[13px] text-text-primary">Keep activity for</span>
          <p className="text-[11px] text-text-muted">
            One file per month; older months are deleted when a new month starts.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={120}
            value={draft.access_log_retention_months ?? 12}
            onChange={(e) =>
              updateDraft("access_log_retention_months", Number(e.target.value))
            }
            className="focus-accent w-20 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-right text-[13px] text-text-primary outline-none"
          />
          <span className="text-[12px] text-text-muted">months</span>
        </div>
      </div>

      <SectionHeader title="Agent Memory" />
      <p className="mb-2 text-[12px] leading-relaxed text-text-muted">
        How long memory pages of each kind are kept when they carry no expiry of their
        own. 0 keeps them forever. Episodic memory (session logs) is the kind worth
        letting go of; decisions and conventions are the point of the vault.
      </p>
      {(
        [
          ["memory_episodic_retention_days", "Episodic (what happened)"],
          ["memory_semantic_retention_days", "Semantic (decisions, facts)"],
          ["memory_procedural_retention_days", "Procedural (how we do things)"],
        ] as const
      ).map(([key, label]) => (
        <div key={key} className="flex items-center justify-between py-1.5">
          <span className="text-[13px] text-text-primary">{label}</span>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={3650}
              value={draft[key] ?? 0}
              onChange={(e) => updateDraft(key, Number(e.target.value))}
              className="focus-accent w-20 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-right text-[13px] text-text-primary outline-none"
            />
            <span className="text-[12px] text-text-muted">days</span>
          </div>
        </div>
      ))}

      <div className="mt-2 flex items-center justify-between py-1.5">
        <div>
          <span className="text-[13px] text-text-primary">
            Re-rank search with Ollama
          </span>
          <p className="text-[11px] text-text-muted">
            Embedding model a local Ollama serves. Blank keeps full-text order. Nothing
            leaves this machine.
          </p>
        </div>
        <input
          type="text"
          value={draft.memory_rerank_model ?? "nomic-embed-text"}
          onChange={(e) => updateDraft("memory_rerank_model", e.target.value)}
          placeholder="nomic-embed-text"
          className="focus-accent w-44 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[13px] text-text-primary outline-none"
        />
      </div>
      <div className="flex items-center justify-between py-1.5">
        <span className="text-[13px] text-text-primary">Ollama address</span>
        <input
          type="text"
          value={draft.ollama_url ?? "http://127.0.0.1:11434"}
          onChange={(e) => updateDraft("ollama_url", e.target.value)}
          className="focus-accent w-56 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[13px] text-text-primary outline-none"
        />
      </div>

      <SectionHeader title="API Reference" />
      <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
        All endpoints require{" "}
        <code className="rounded bg-surface-overlay px-1 text-[11px]">
          Authorization: Bearer &lt;token&gt;
        </code>
        . Notes tokens redact secrets; Secrets tokens decrypt them.
      </p>
      <ApiRefTable baseUrl={`http://127.0.0.1:${port}`} token={configToken} />
    </>
  );
}

// ── One-time token ───────────────────────────────────

/** The freshly created token, shown once with a copy button. */
/**
 * SSH agent controls. Keys live in secret blocks (field `private_key`) on
 * pages tagged `ssh-key`; every signature goes through the same approval,
 * rate limit and access log as a secret read.
 */
function SshAgentSection({ draft, updateDraft }: IntegrationsTabProps) {
  const [status, setStatus] = useState<{ running: boolean; socket: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    cmd
      .sshAgentStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(async () => {
    setError(null);
    const enabling = !draft.ssh_agent_enabled;
    updateDraft("ssh_agent_enabled", enabling);
    setBusy(true);
    try {
      if (enabling) {
        await cmd.startSshAgent();
      } else {
        await cmd.stopSshAgent();
      }
      setStatus(await cmd.sshAgentStatus());
    } catch (e) {
      setError(String(e));
      if (enabling) updateDraft("ssh_agent_enabled", false);
    }
    setBusy(false);
  }, [draft.ssh_agent_enabled, updateDraft]);

  const socket = status?.socket ?? "";
  const envLine = socket.startsWith("\\\\")
    ? `$env:SSH_AUTH_SOCK = '${socket}'`
    : `export SSH_AUTH_SOCK="${socket}"`;

  return (
    <>
      <SectionHeader title="SSH agent" />
      <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
        Lets ssh and git use keys kept in this vault without the key ever being written to
        disk. Store each key in a secret block with a <code>private_key</code> field (and{" "}
        <code>passphrase</code> if it has one) on a page tagged <code>ssh-key</code>. Each
        signature is approved like a secret read.
      </p>
      <div className="flex items-center justify-between py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-text-primary">Enable SSH agent</span>
          {busy && <SpinnerIcon size={12} className="animate-spin text-text-muted" />}
          {!busy && status?.running && (
            <span className="inline-flex items-center gap-1 text-[11px] text-success">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
              Listening
            </span>
          )}
        </div>
        <button
          role="switch"
          aria-checked={draft.ssh_agent_enabled === true}
          disabled={busy}
          onClick={toggle}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            draft.ssh_agent_enabled ? "bg-accent" : "bg-border"
          } disabled:opacity-50`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              draft.ssh_agent_enabled ? "translate-x-4" : ""
            }`}
          />
        </button>
      </div>
      {error && (
        <p className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      {socket && (
        <ConfigBlock
          label={'Point ssh at the agent (or run: eval "$(claspt ssh env)")'}
          code={envLine}
        />
      )}
    </>
  );
}

function OneTimeToken({ token, name }: { token: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    copyToClipboard(token);
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [token]);

  return (
    <div className="mt-2 rounded border border-warning/30 bg-warning/5 px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-warning">
          Token for <strong>{name}</strong>. Copy it now; it is shown once and not stored.
        </span>
        <button
          onClick={handleCopy}
          className="rounded px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface-overlay"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <code className="block break-all text-[11px] text-text-secondary select-all">
        {token}
      </code>
    </div>
  );
}

// ── Standing approvals ───────────────────────────────

/** Per-client, per-page approvals granted from the prompt; each revocable. */
function StandingApprovals({ clients }: { clients: cmd.ApiClient[] }) {
  const [grants, setGrants] = useState<cmd.ApprovalGrant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    cmd
      .listApprovalGrants()
      .then((list) => {
        if (!cancelled) setGrants(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // Re-read when the client list changes too: revoking a client drops its grants.
  }, [reloadToken, clients]);

  const handleRevoke = useCallback(async (clientId: string, target: string) => {
    try {
      await cmd.revokeApprovalGrant(clientId, target);
      setReloadToken((n) => n + 1);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return (
    <div className="py-2.5">
      <span className="text-[13px] text-text-primary">Standing approvals</span>
      <p className="mb-2 text-[11px] text-text-muted">
        Granted from the approval prompt with "Always allow". One client, one page, until
        you revoke it here.
      </p>
      {error && <p className="mb-1 text-[11px] text-warning">{error}</p>}
      {grants.length === 0 ? (
        <p className="text-[12px] text-text-muted">None.</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
          {grants.map((g) => (
            <li
              key={`${g.client_id}:${g.target}`}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0 text-[12px]">
                <span className="font-medium text-text-primary">{g.client_name}</span>
                <span className="text-text-muted"> may read </span>
                <code className="break-all text-text-secondary">{g.target}</code>
                <div className="text-[11px] text-text-muted">
                  since {new Date(g.granted_at).toLocaleDateString()}
                </div>
              </div>
              <button
                onClick={() => handleRevoke(g.client_id, g.target)}
                className="shrink-0 rounded-lg border border-border/60 px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Activity log ─────────────────────────────────────

const ACTIVITY_LIMIT = 50;

/** The last few dozen API requests, with a client filter and a refresh button. */
function ActivityLog({ clients }: { clients: cmd.ApiClient[] }) {
  const [entries, setEntries] = useState<cmd.AccessEntry[]>([]);
  const [clientFilter, setClientFilter] = useState<string>("");
  // Starts true: the first load is in flight as soon as the section mounts.
  // Refresh sets it in the click handler, never inside the effect.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    cmd
      .readAccessLog(ACTIVITY_LIMIT, clientFilter || undefined)
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientFilter, reloadToken]);

  return (
    <div className="mb-3">
      <div className="mb-2 flex items-center gap-2">
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          className="focus-accent rounded-lg border border-border/60 bg-surface px-2 py-1 text-[12px] text-text-primary outline-none"
        >
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            setLoading(true);
            setReloadToken((n) => n + 1);
          }}
          disabled={loading}
          className="rounded-lg border border-border/60 px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-all hover:bg-surface-overlay active:scale-95 disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {error && <p className="mb-1 text-[11px] text-warning">{error}</p>}
      {entries.length === 0 ? (
        <p className="text-[12px] text-text-muted">No activity recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="px-2 py-1 font-medium">Time</th>
                <th className="px-2 py-1 font-medium">Client</th>
                <th className="px-2 py-1 font-medium">Action</th>
                <th className="px-2 py-1 font-medium">Target</th>
                <th className="px-2 py-1 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr
                  key={`${e.ts}-${i}`}
                  className={`border-t border-border/40 ${e.status >= 400 ? "text-warning" : "text-text-secondary"}`}
                >
                  <td className="whitespace-nowrap px-2 py-1">
                    {new Date(e.ts).toLocaleString()}
                  </td>
                  <td className="max-w-[10rem] truncate px-2 py-1">
                    {e.client_name}
                    {e.scope === "Secrets" && (
                      <span className="ml-1 rounded bg-warning/15 px-1 text-[10px] text-warning">
                        secrets
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">{e.action}</td>
                  <td className="max-w-[16rem] truncate px-2 py-1 font-mono">
                    {e.target}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    {e.status} · {e.duration_ms} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Config Block ─────────────────────────────────────

/** Labeled, copy-to-clipboard code block for a config/command snippet. */
function ConfigBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    copyToClipboard(code);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [code]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] font-medium text-text-secondary">{label}</span>
        <button
          onClick={handleCopy}
          className="rounded px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="overflow-x-auto rounded bg-surface-overlay">
        <code className="block whitespace-pre px-3 py-2 text-[11px] text-text-secondary select-all">
          {code}
        </code>
      </div>
    </div>
  );
}

// ── API Reference ────────────────────────────────────

const API_ENDPOINTS: { method: string; path: string; desc: string; body?: string }[] = [
  // Status
  { method: "GET", path: "/api/status", desc: "Server status and vault lock state" },
  // Pages
  {
    method: "GET",
    path: "/api/pages",
    desc: "List pages (optional ?folder=X or ?tag=X)",
  },
  {
    method: "POST",
    path: "/api/pages",
    desc: "Create page",
    body: '{"title": "My Note", "folder": "general", "content": "# Hello", "tags": ["example"]}',
  },
  {
    method: "GET",
    path: "/api/pages/{path}",
    desc: "Read page (secrets redacted with Notes token)",
  },
  {
    method: "PUT",
    path: "/api/pages/{path}",
    desc: "Update page content",
    body: '{"content": "# Updated content"}',
  },
  { method: "DELETE", path: "/api/pages/{path}", desc: "Delete page" },
  // Search
  {
    method: "GET",
    path: "/api/search?q=example",
    desc: "Full-text search (add &scope=secrets for secrets)",
  },
  // Folders
  { method: "GET", path: "/api/folders", desc: "List folders" },
  {
    method: "POST",
    path: "/api/folders",
    desc: "Create folder",
    body: '{"name": "projects"}',
  },
  // Generator
  {
    method: "POST",
    path: "/api/generate/password",
    desc: "Generate password",
    body: '{"length": 20, "uppercase": true, "lowercase": true, "numbers": true, "special": true}',
  },
  {
    method: "POST",
    path: "/api/generate/passphrase",
    desc: "Generate passphrase",
    body: '{"word_count": 5, "separator": "-", "capitalize": true}',
  },
  {
    method: "POST",
    path: "/api/generate/memorable",
    desc: "Generate memorable password",
    body: '{"style": "pronounceable", "syllable_count": 4}',
  },
  {
    method: "POST",
    path: "/api/generate/pin",
    desc: "Generate PIN",
    body: '{"length": 6}',
  },
  { method: "GET", path: "/api/generate/uuid", desc: "Generate UUID v4" },
  {
    method: "POST",
    path: "/api/generate/strength",
    desc: "Check password strength",
    body: '{"password": "test123"}',
  },
  {
    method: "POST",
    path: "/api/generate/bulk",
    desc: "Bulk generate",
    body: '{"type": "password", "options": {"length": 16}, "count": 10}',
  },
  // Agent Memory
  { method: "GET", path: "/api/memory", desc: "List memory namespaces" },
  {
    method: "GET",
    path: "/api/memory/{ns}",
    desc: "List memories in namespace (?tag=X)",
  },
  {
    method: "PUT",
    path: "/api/memory/{ns}",
    desc: "Upsert memory",
    body: '{"title": "context", "content": "Some data to remember", "tags": ["session"], "ttl_hours": 24}',
  },
  { method: "GET", path: "/api/memory/{ns}/{title}", desc: "Read memory" },
  { method: "DELETE", path: "/api/memory/{ns}/{title}", desc: "Delete memory" },
  {
    method: "POST",
    path: "/api/memory/{ns}/bulk",
    desc: "Bulk upsert",
    body: '{"memories": [{"title": "a", "content": "data a"}, {"title": "b", "content": "data b"}]}',
  },
  { method: "POST", path: "/api/memory/cleanup", desc: "Delete expired memories (TTL)" },
];

const METHOD_COLORS: Record<string, string> = {
  GET: "text-success",
  POST: "text-accent",
  PUT: "text-warning",
  DELETE: "text-danger",
};

/** Expandable list of HTTP API endpoints, each with a generated curl example. */
function ApiRefTable({ baseUrl, token }: { baseUrl: string; token: string }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const buildCurl = useCallback(
    (ep: (typeof API_ENDPOINTS)[number]) => {
      const parts = [`curl -X ${ep.method} ${baseUrl}${ep.path}`];
      parts.push(`  -H "Authorization: Bearer ${token}"`);
      if (ep.body) {
        parts.push(`  -H "Content-Type: application/json"`);
        parts.push(`  -d '${ep.body}'`);
      }
      return parts.join(" \\\n");
    },
    [baseUrl, token],
  );

  const handleCopyCurl = useCallback(
    (ep: (typeof API_ENDPOINTS)[number], idx: number) => {
      copyToClipboard(buildCurl(ep));
      setCopiedIdx(idx);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedIdx(null), 1500);
    },
    [buildCurl],
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {API_ENDPOINTS.map((ep, i) => (
        <div
          key={i}
          className={`border-b border-border/40 last:border-0 ${expanded === i ? "bg-surface-raised/50" : ""}`}
        >
          <button
            onClick={() => setExpanded(expanded === i ? null : i)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-raised/30"
          >
            <span
              className={`w-12 shrink-0 font-mono text-[10px] font-bold ${METHOD_COLORS[ep.method] ?? "text-text-muted"}`}
            >
              {ep.method}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-primary">
              {ep.path}
            </span>
            <span className="shrink-0 text-[10px] text-text-muted">{ep.desc}</span>
          </button>
          {expanded === i && (
            <div className="border-t border-border/30 bg-surface-overlay px-3 py-2">
              <div className="flex items-start justify-between">
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[10px] leading-relaxed text-text-secondary">
                  {buildCurl(ep)}
                </code>
                <button
                  onClick={() => handleCopyCurl(ep, i)}
                  className="ml-2 shrink-0 rounded px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
                >
                  {copiedIdx === i ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
