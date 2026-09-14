// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * AboutDialog — modal showing app version, build metadata, company/legal
 * info, and external links. Visibility is driven by `aboutOpen` in the UI
 * store; renders nothing when closed.
 */
import { APP_VERSION, GIT_HASH, GIT_DIRTY, BUILD_TIME, IS_PRO } from "@/lib/version";
import { useUIStore } from "@/stores/ui-store";
import { BrandLogo } from "@/components/BrandLogo";

// External links rendered in the dialog's "Links" grid.
const LINKS = [
  { label: "Website", url: "https://claspt.app" },
  { label: "Privacy Policy", url: "https://claspt.app/privacy" },
  { label: "Pricing", url: "https://claspt.app/pricing" },
  { label: "Documentation", url: "https://claspt.app/docs" },
  { label: "Send Feedback", url: "https://claspt.app/feedback" },
];

export function AboutDialog() {
  const { aboutOpen, setAboutOpen, setSettingsOpen, setSettingsSection } = useUIStore();

  if (!aboutOpen) return null;

  return (
    <div
      className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={(e) => {
        // Close only when the backdrop itself is clicked, not the card.
        if (e.target === e.currentTarget) setAboutOpen(false);
      }}
    >
      <div className="modal-card w-full max-w-[440px] overflow-hidden rounded-2xl border border-border bg-surface">
        {/* Header */}
        <div className="border-b border-border bg-surface-raised px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BrandLogo size="icon" />
              <div>
                <h2 className="brand-gradient text-lg font-extrabold tracking-tight">
                  Claspt
                </h2>
                <p className="text-[11px] text-text-muted">v{APP_VERSION}</p>
              </div>
            </div>
            <button
              onClick={() => setAboutOpen(false)}
              className="rounded-lg p-1 text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-5">
          <div className="space-y-5">
            {/* Tagline */}
            <p className="text-[13px] leading-relaxed text-text-secondary">
              Secure notes vault with encrypted secret storage. Combine markdown
              note-taking with AES-256-GCM encrypted secrets in portable{" "}
              <code className="rounded bg-surface-overlay px-1 py-0.5 text-[12px]">
                .md
              </code>{" "}
              files.
            </p>

            {/* Info card */}
            <div className="space-y-2 rounded-xl border border-border/60 bg-surface-raised px-4 py-3">
              <InfoRow
                label="Version"
                value={`${APP_VERSION} (${GIT_HASH}${GIT_DIRTY ? "*" : ""})`}
              />
              <InfoRow
                label="Build Date"
                value={new Date(BUILD_TIME).toLocaleDateString()}
              />
              <InfoRow label="Author" value="Indivar Software Solutions Limited" />
              <InfoRow label="Location" value="Auckland, New Zealand" />
              <InfoRow label="Contact" value="hello@claspt.app" />
              <InfoRow label="Edition" value={IS_PRO ? "Pro" : "Source-available"} />
              <InfoRow
                label="License"
                value={IS_PRO ? "Commercial (Pro)" : "PolyForm Shield 1.0.0"}
              />
              <InfoRow label="Built with" value="Tauri, React, Rust" />
            </div>

            {/* Edition / licensing note */}
            <p className="text-[12px] leading-relaxed text-text-muted">
              {IS_PRO ? (
                <>
                  This is the <span className="text-text-secondary">Pro</span> edition:
                  the commercial build (sync, sharing and licensed features) on top of the
                  source-available Claspt core, whose source is published under the{" "}
                  <span className="text-text-secondary">
                    PolyForm Shield License 1.0.0
                  </span>{" "}
                  so anyone can read it, verify its security claims and report problems.
                </>
              ) : (
                <>
                  Source-available edition. The source is published under the{" "}
                  <span className="text-text-secondary">
                    PolyForm Shield License 1.0.0
                  </span>{" "}
                  so anyone can read it, verify its security claims and report problems.
                  It is not open source: you may study, build and audit it, but not ship a
                  competing product from it.
                </>
              )}
            </p>

            {/* Links */}
            <div>
              <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted/60">
                Links
              </h4>
              <div className="grid grid-cols-2 gap-1.5">
                {LINKS.map((link) => (
                  <a
                    key={link.label}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-accent transition-colors hover:bg-accent/8"
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 16 16"
                      fill="none"
                      className="shrink-0"
                    >
                      <path
                        d="M6 3H3.5A1.5 1.5 0 002 4.5v8A1.5 1.5 0 003.5 14h8a1.5 1.5 0 001.5-1.5V10M10 2h4v4M7 9l7-7"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {link.label}
                  </a>
                ))}
                {/* Jumps to the Settings > About section (third-party
                    open-source license attributions), closing this dialog. */}
                <button
                  onClick={() => {
                    setAboutOpen(false);
                    setSettingsOpen(true);
                    setSettingsSection("about");
                  }}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-accent transition-colors hover:bg-accent/8"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0"
                  >
                    <path
                      d="M2 4.5A2.5 2.5 0 014.5 2h7A2.5 2.5 0 0114 4.5v7a2.5 2.5 0 01-2.5 2.5h-7A2.5 2.5 0 012 11.5v-7z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M5 6h6M5 8h6M5 10h3"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                  Open Source Licenses
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border px-6 py-3 text-center">
          <p className="text-[11px] text-text-muted/70">
            &copy; 2025–2026 Indivar Software Solutions Limited
          </p>
        </div>
      </div>
    </div>
  );
}

/** A single label/value row in the About dialog's info card. */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-text-muted">{label}</span>
      <span className="text-[12px] font-medium text-text-primary">{value}</span>
    </div>
  );
}
