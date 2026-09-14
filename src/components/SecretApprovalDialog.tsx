// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Consent dialog for external secret-access requests (browser extension, MCP,
 * or local API). The Rust backend emits a `secret-access-request` event when an
 * outside tool wants to decrypt a secret; this modal asks the user to approve
 * or deny, optionally remembering the decision for the rest of the session.
 * It auto-denies after a 30-second countdown so an unattended prompt fails safe.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { approveSecretAccess, type Remember } from "@/lib/commands";

/** Payload emitted by the backend describing who is asking for secret access. */
interface ApprovalRequest {
  request_id: string;
  tool_name: string;
  page_path: string | null;
  client_id: string;
  client_name: string;
  target: string;
  recent_secret_reads: number;
}

/** Approve/deny modal for external secret-access requests, with auto-deny timeout. */
export function SecretApprovalDialog() {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [remember, setRemember] = useState<Remember>("once");
  const [countdown, setCountdown] = useState(30);

  useEffect(() => {
    const unlisten = listen<ApprovalRequest>("secret-access-request", (event) => {
      setRequest(event.payload);
      setCountdown(30);
      setRemember("once");
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const handleResponse = useCallback(
    (approved: boolean) => {
      if (!request) return;
      approveSecretAccess(request.request_id, approved, remember).catch(console.error);
      setRequest(null);
    },
    [request, remember],
  );

  // Keep the latest handleResponse reachable from the countdown effect without
  // making the timer restart when `remember` changes.
  const handleResponseRef = useRef(handleResponse);
  useEffect(() => {
    handleResponseRef.current = handleResponse;
  }, [handleResponse]);

  // Auto-deny after 30s
  useEffect(() => {
    if (!request) return;
    if (countdown <= 0) {
      handleResponseRef.current(false);
      return;
    }
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [request, countdown]);

  if (!request) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[400px] rounded-xl border border-border bg-surface p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/20">
            <svg className="h-5 w-5 text-warning" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-text-primary">
              Secret Access Request
            </h3>
            <p className="text-[12px] text-text-muted">
              <strong className="text-text-primary">{request.client_name}</strong> is
              requesting access to encrypted secrets.
            </p>
          </div>
        </div>

        <div className="mb-4 rounded-lg bg-surface-overlay px-3 py-2">
          <div className="text-[12px] text-text-muted">Page</div>
          <code className="text-[13px] text-text-primary break-all">
            {request.target}
          </code>
          <div className="mt-1 text-[11px] text-text-muted">
            {request.recent_secret_reads === 0
              ? "No secrets read by this client in the last minute."
              : `${request.recent_secret_reads} secret read${request.recent_secret_reads === 1 ? "" : "s"} by this client in the last minute.`}
          </div>
        </div>

        <fieldset className="mb-4 space-y-1.5 text-[13px] text-text-secondary">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="approval_remember"
              checked={remember === "once"}
              onChange={() => setRemember("once")}
              className="accent-accent"
            />
            Just this once
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="approval_remember"
              checked={remember === "always"}
              onChange={() => setRemember("always")}
              className="accent-accent"
            />
            Always allow{" "}
            <strong className="text-text-primary">{request.client_name}</strong> to read
            this page (until revoked in Settings)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="approval_remember"
              checked={remember === "session"}
              onChange={() => setRemember("session")}
              className="accent-accent"
            />
            Allow every client, every secret, until the vault locks
          </label>
        </fieldset>

        <div className="flex items-center justify-between">
          <span className="text-[12px] text-text-muted">Auto-deny in {countdown}s</span>
          <div className="flex gap-2">
            <button
              onClick={() => handleResponse(false)}
              className="rounded-lg border border-border/60 px-4 py-1.5 text-[13px] font-medium text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
            >
              Deny
            </button>
            <button
              onClick={() => handleResponse(true)}
              className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent/90 active:scale-95"
            >
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
