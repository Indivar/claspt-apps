// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ServerTab — settings tab that gates all optional server-backed features behind
 * a single "Enable Server Features" toggle. When enabled, it composes the app
 * update, email registration, incoming shares, and server status sections. No
 * vault contents are transmitted; only device/version/email metadata.
 */
import { UpdateSection } from "./UpdateSection";
import { EmailRegistration } from "./EmailRegistration";
import { IncomingShares } from "@/components/settings/IncomingShares";
import { ServerStatus } from "./ServerStatus";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { VaultConfig } from "@claspt/shared/types";

interface ServerTabProps {
  draft: VaultConfig;
  updateDraft: <K extends keyof VaultConfig>(key: K, value: VaultConfig[K]) => void;
}

/** Server-features toggle plus the composed server-backed setting sections. */
export function ServerTab({ draft, updateDraft }: ServerTabProps) {
  const enabled = draft.server_enabled === true;

  return (
    <>
      <SectionHeader title="Server Connection" />
      <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
        When enabled, Claspt periodically checks app.claspt.app for incoming shares and
        app updates. Your device ID, app version, and registered email (if any) are sent.
        All share content is end-to-end encrypted. No vault contents are ever transmitted.
      </p>

      {/* Enable toggle */}
      <div className="flex items-center justify-between py-2.5">
        <span className="text-[13px] text-text-primary">Enable Server Features</span>
        <button
          role="switch"
          aria-checked={enabled}
          onClick={() => updateDraft("server_enabled", !enabled)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            enabled ? "bg-accent" : "bg-border"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-4" : ""
            }`}
          />
        </button>
      </div>

      {enabled ? (
        <>
          <SectionHeader title="App Updates" />
          <UpdateSection />
          <SectionHeader title="Share Notifications" />
          <EmailRegistration />
          <SectionHeader title="Incoming Shares" />
          <IncomingShares />
          <SectionHeader title="Server" />
          <ServerStatus />
        </>
      ) : (
        <p className="mt-2 text-[12px] leading-relaxed text-text-muted/60">
          Enable server features to receive incoming shares, app update notifications, and
          email registration.
        </p>
      )}
    </>
  );
}
