// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useCallback, useEffect, useState } from "react";
import type { IdentityItem, Message } from "@/shared/types";
import { detectCardBrand } from "@/shared/url-matching";

/**
 * Heuristic: is this vault item actually a credit card, even if it wasn't
 * tagged "credit-card" when saved (e.g. created in the desktop app, or
 * imported)? We treat anything with a card-number-like field, a CVV, a
 * brand-like title, or a Luhn-valid number value as a card.
 */
const CARD_NUMBER_KEYS = ["card_number", "card number", "cardnumber", "cc_number", "cc number", "number", "card no"];
const CVV_KEYS = ["cvv", "cv2", "cvc", "security_code", "security code"];
const EXPIRY_KEYS = ["expiry", "expiry (mm/yy)", "expiration", "exp", "valid_thru", "valid thru"];
const BRAND_PATTERNS = [
  /\bvisa\b/i,
  /\bmaster\s*card\b|\bmc\b/i,
  /\b(amex|american\s*express|ax\s*ex)\b/i,
  /\bdiscover\b/i,
  /\bjcb\b/i,
  /\bdiners\b/i,
  /\bunion\s*pay\b/i,
  /\brupay\b/i,
];

function looksLikeCardNumber(v: string): boolean {
  const digits = v.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  return detectCardBrand(digits) !== null;
}

function classifyAsCard(item: IdentityItem): boolean {
  if (item.itemType === "card") return true;
  const lowerKeys = Object.keys(item.fields).map((k) => k.toLowerCase());
  const hasCardNumberField = lowerKeys.some((k) => CARD_NUMBER_KEYS.includes(k));
  const hasCvv = lowerKeys.some((k) => CVV_KEYS.includes(k));
  const hasExpiry = lowerKeys.some((k) => EXPIRY_KEYS.includes(k));
  if (hasCardNumberField && (hasCvv || hasExpiry)) return true;
  // A field literally containing a card-shaped number value
  for (const v of Object.values(item.fields)) {
    if (typeof v === "string" && looksLikeCardNumber(v)) return true;
  }
  // Title/labels that look like brand names with no identity-y fields
  const text = `${item.title} ${item.blockLabels.join(" ")}`;
  const matchesBrand = BRAND_PATTERNS.some((re) => re.test(text));
  const hasIdentityFields = lowerKeys.some((k) =>
    ["first_name", "last_name", "email", "phone", "street", "city", "zip"].includes(k)
  );
  if (matchesBrand && !hasIdentityFields) return true;
  return false;
}

/**
 * Identity & Credit Card tab.
 *
 * SECURITY: All data lives exclusively in the Claspt vault (identities/ folder).
 * Nothing is stored in chrome.storage.local. The tab only works when connected
 * to the desktop app. If disconnected, it shows a message to connect first.
 */

const PERSONAL_FIELDS = [
  { key: "first_name", label: "First Name", placeholder: "John" },
  { key: "last_name", label: "Last Name", placeholder: "Doe" },
  { key: "email", label: "Email", placeholder: "john@example.com" },
  { key: "phone", label: "Phone", placeholder: "+1 234 567 8900" },
  { key: "company", label: "Company", placeholder: "Acme Inc" },
  { key: "job_title", label: "Job Title", placeholder: "Developer" },
];

const ADDRESS_FIELDS = [
  { key: "street", label: "Street", placeholder: "123 Main St" },
  { key: "city", label: "City", placeholder: "San Francisco" },
  { key: "state", label: "State / Region", placeholder: "California" },
  { key: "zip", label: "ZIP / Postal Code", placeholder: "94102" },
  { key: "country", label: "Country", placeholder: "United States" },
];

const CARD_FIELDS = [
  { key: "card_name", label: "Cardholder Name", placeholder: "John Doe" },
  { key: "card_number", label: "Card Number", placeholder: "4242 4242 4242 4242" },
  { key: "expiry", label: "Expiry (MM/YY)", placeholder: "12/28" },
  { key: "cvv", label: "CVV", placeholder: "123", sensitive: true },
  { key: "billing_zip", label: "Billing ZIP", placeholder: "94102" },
];

type Section = "list" | "new-identity" | "edit-identity" | "new-card";

interface IdentityTabProps {
  connected?: boolean;
}

export function IdentityTab({ connected = true }: IdentityTabProps) {
  const [items, setItems] = useState<IdentityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<Section>("list");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Identity form state (used for both new and edit)
  const [editingPagePath, setEditingPagePath] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPersonal, setEditPersonal] = useState<Record<string, string>>({});
  const [editAddress, setEditAddress] = useState<Record<string, string>>({});

  // New card form state
  const [editCardName, setEditCardName] = useState("");
  const [editCard, setEditCard] = useState<Record<string, string>>({});

  // Load identities from vault via search API
  const loadFromVault = useCallback(() => {
    if (!connected) {
      setLoading(false);
      return;
    }
    chrome.runtime.sendMessage(
      { type: "LIST_IDENTITIES" } as Message,
      (res: Message) => {
        if (res?.type === "LIST_IDENTITIES_RESULT") {
          setItems(res.items);
        }
        setLoading(false);
      }
    );
  }, [connected]);

  useEffect(() => { loadFromVault(); }, [loadFromVault]);

  // ── Save identity to vault ──

  const saveIdentityToVault = useCallback(() => {
    setSaving(true);
    const name = editName.trim() || "Personal";

    let content = `# ${name} Identity\n\n`;
    content += `:::secret[${name} — Personal Info]\n`;
    for (const f of PERSONAL_FIELDS) {
      const val = editPersonal[f.key];
      if (val) content += `${f.label}: ${val}\n`;
    }
    content += ":::\n\n";
    content += `:::secret[${name} — Address]\n`;
    for (const f of ADDRESS_FIELDS) {
      const val = editAddress[f.key];
      if (val) content += `${f.label}: ${val}\n`;
    }
    content += ":::\n";

    chrome.runtime.sendMessage(
      {
        type: "SAVE_IDENTITY",
        title: `${name} Identity`,
        content,
        tags: ["identity"],
      } as Message,
      () => {
        setSaving(false);
        setSection("list");
        setEditName("");
        setEditPersonal({});
        setEditAddress({});
        setTimeout(loadFromVault, 1500);
      }
    );
  }, [editName, editPersonal, editAddress, loadFromVault]);

  // ── Update existing identity in vault ──

  const updateIdentityInVault = useCallback(() => {
    if (!editingPagePath) return;
    setSaving(true);
    const name = editName.trim() || "Personal";

    let content = `# ${name} Identity\n\n`;
    content += `:::secret[${name} — Personal Info]\n`;
    for (const f of PERSONAL_FIELDS) {
      const val = editPersonal[f.key];
      if (val) content += `${f.label}: ${val}\n`;
    }
    content += ":::\n\n";
    content += `:::secret[${name} — Address]\n`;
    for (const f of ADDRESS_FIELDS) {
      const val = editAddress[f.key];
      if (val) content += `${f.label}: ${val}\n`;
    }
    content += ":::\n";

    chrome.runtime.sendMessage(
      {
        type: "UPDATE_IDENTITY",
        pagePath: editingPagePath,
        content,
      } as Message,
      () => {
        setSaving(false);
        setSection("list");
        setEditingPagePath(null);
        setEditName("");
        setEditPersonal({});
        setEditAddress({});
        setTimeout(loadFromVault, 1500);
      }
    );
  }, [editingPagePath, editName, editPersonal, editAddress, loadFromVault]);

  // ── Save card to vault ──

  const saveCardToVault = useCallback(() => {
    setSaving(true);
    const num = editCard.card_number?.replace(/\s/g, "") ?? "";
    const last4 = num.slice(-4);
    const name = editCardName.trim() || (last4 ? `Card ending ${last4}` : "Credit Card");

    let content = `# ${name}\n\n`;
    content += `:::secret[${name}]\n`;
    for (const f of CARD_FIELDS) {
      const val = editCard[f.key];
      if (val) content += `${f.label}: ${val}\n`;
    }
    content += ":::\n";

    chrome.runtime.sendMessage(
      {
        type: "SAVE_IDENTITY",
        title: name,
        content,
        tags: ["credit-card"],
      } as Message,
      () => {
        setSaving(false);
        setSection("list");
        setEditCardName("");
        setEditCard({});
        setTimeout(loadFromVault, 1500);
      }
    );
  }, [editCardName, editCard, loadFromVault]);

  // ── Fill form ──

  const fillForm = useCallback((fields: Record<string, string>) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, {
        type: "FILL_IDENTITY",
        identity: fields,
      });
    });
  }, []);

  // ── Not connected ──

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-text-dim mb-3">
          <circle cx="12" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 19c0-2.8 3.1-5 7-5s7 2.2 7 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <p className="text-sm font-medium text-text-primary">Identities & Cards</p>
        <p className="text-[11px] text-text-muted mt-1 max-w-[240px]">
          Connect to Claspt desktop to manage identities and credit cards. All data is stored securely in your vault — never in the browser.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  // ── New Identity Form ──
  if (section === "new-identity") {
    return (
      <div className="p-3 overflow-y-auto space-y-2 max-h-[480px]">
        <div>
          <label className="block text-[10px] font-medium text-text-muted mb-0.5">Label</label>
          <input
            type="text" value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="e.g. Personal, Work, Home"
            className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim outline-none focus:border-accent"
            autoFocus
          />
        </div>
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted pt-1">Personal</h3>
        {PERSONAL_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block text-[10px] font-medium text-text-muted mb-0.5">{f.label}</label>
            <input
              type="text" value={editPersonal[f.key] || ""}
              onChange={(e) => setEditPersonal({ ...editPersonal, [f.key]: e.target.value })}
              placeholder={f.placeholder}
              className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim outline-none focus:border-accent"
            />
          </div>
        ))}
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted pt-1">Address</h3>
        {ADDRESS_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block text-[10px] font-medium text-text-muted mb-0.5">{f.label}</label>
            <input
              type="text" value={editAddress[f.key] || ""}
              onChange={(e) => setEditAddress({ ...editAddress, [f.key]: e.target.value })}
              placeholder={f.placeholder}
              className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim outline-none focus:border-accent"
            />
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={() => setSection("list")} className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text-primary">Cancel</button>
          <button onClick={saveIdentityToVault} disabled={saving} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            {saving ? "Saving..." : "Save to Vault"}
          </button>
        </div>
      </div>
    );
  }

  // ── Edit Identity Form (same as new, but updates existing page) ──
  if (section === "edit-identity") {
    return (
      <div className="p-3 overflow-y-auto space-y-2 max-h-[480px]">
        <div>
          <label className="block text-[10px] font-medium text-text-muted mb-0.5">Label</label>
          <input
            type="text" value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="e.g. Personal, Work, Home"
            className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim outline-none focus:border-accent"
            autoFocus
          />
        </div>
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted pt-1">Personal</h3>
        {PERSONAL_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block text-[10px] font-medium text-text-muted mb-0.5">{f.label}</label>
            <input
              type="text" value={editPersonal[f.key] || ""}
              onChange={(e) => setEditPersonal({ ...editPersonal, [f.key]: e.target.value })}
              placeholder={f.placeholder}
              className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim outline-none focus:border-accent"
            />
          </div>
        ))}
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted pt-1">Address</h3>
        {ADDRESS_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block text-[10px] font-medium text-text-muted mb-0.5">{f.label}</label>
            <input
              type="text" value={editAddress[f.key] || ""}
              onChange={(e) => setEditAddress({ ...editAddress, [f.key]: e.target.value })}
              placeholder={f.placeholder}
              className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim outline-none focus:border-accent"
            />
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={() => { setSection("list"); setEditingPagePath(null); }} className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text-primary">Cancel</button>
          <button onClick={updateIdentityInVault} disabled={saving} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            {saving ? "Updating..." : "Update"}
          </button>
        </div>
      </div>
    );
  }

  // ── New Card Form ──
  if (section === "new-card") {
    return (
      <div className="p-3 overflow-y-auto space-y-2 max-h-[480px]">
        <div>
          <label className="block text-[10px] font-medium text-text-muted mb-0.5">Label</label>
          <input
            type="text" value={editCardName}
            onChange={(e) => setEditCardName(e.target.value)}
            placeholder="e.g. Visa Personal, Amex Business"
            className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim outline-none focus:border-accent"
            autoFocus
          />
        </div>
        {CARD_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block text-[10px] font-medium text-text-muted mb-0.5">{f.label}</label>
            <input
              type={f.sensitive ? "password" : "text"} value={editCard[f.key] || ""}
              onChange={(e) => setEditCard({ ...editCard, [f.key]: e.target.value })}
              placeholder={f.placeholder}
              className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim outline-none focus:border-accent"
            />
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={() => setSection("list")} className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text-primary">Cancel</button>
          <button onClick={saveCardToVault} disabled={saving} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50">
            {saving ? "Saving..." : "Save to Vault"}
          </button>
        </div>
      </div>
    );
  }

  // ── List View ──
  // Re-classify locally — vault items created without the "credit-card" tag
  // (e.g. from desktop or imports) still get routed to the Cards section if
  // their fields/title look like a card.
  const cards = items.filter(classifyAsCard);
  const cardPaths = new Set(cards.map((c) => c.pagePath));
  const identities = items.filter((i) => !cardPaths.has(i.pagePath));

  return (
    <div className="p-3 overflow-y-auto space-y-3 max-h-[480px]">
      {/* Header with refresh */}
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Identities</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setLoading(true); loadFromVault(); }}
            className="text-[10px] text-text-dim hover:text-accent transition-colors"
            title="Refresh from vault"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M14 8A6 6 0 114.8 3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M10 1l-5 3 5 3" fill="currentColor" />
            </svg>
          </button>
          <button onClick={() => setSection("new-identity")} className="text-[10px] font-medium text-accent hover:text-accent-hover transition-colors">+ Add</button>
        </div>
      </div>

      {identities.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-4 text-center">
          <p className="text-[11px] text-text-muted">No identities in vault</p>
          <button onClick={() => setSection("new-identity")} className="mt-1.5 text-[10px] font-medium text-accent hover:underline">Create one</button>
        </div>
      ) : (
        identities.map((item, idx) => {
          const isExpanded = expandedIdx === idx;
          const displayName = [item.fields.first_name, item.fields.last_name].filter(Boolean).join(" ") || item.title;
          const email = item.fields.email || "";
          return (
            <div key={item.pagePath} className="rounded-lg border border-border overflow-hidden">
              <button
                onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-accent shrink-0">
                  <circle cx="12" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M5 19c0-2.8 3.1-5 7-5s7 2.2 7 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-text-primary truncate">{displayName}</div>
                  <div className="text-[10px] text-text-dim truncate">{item.title}{email ? ` — ${email}` : ""}</div>
                </div>
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className={`text-text-dim transition-transform ${isExpanded ? "rotate-180" : ""}`}>
                  <path d="M4 6l4 4 4-4z" />
                </svg>
              </button>
              {isExpanded && (
                <div className="border-t border-border px-3 py-2 space-y-1 bg-surface">
                  {Object.entries(item.fields).map(([k, v]) => v ? (
                    <div key={k} className="flex text-[10px] py-0.5">
                      <span className="text-text-dim w-[70px] capitalize shrink-0">{k.replace(/_/g, " ")}</span>
                      <span className="text-text-primary truncate">{v}</span>
                    </div>
                  ) : null)}
                  <div className="flex gap-1.5 pt-1.5">
                    <button onClick={() => fillForm(item.fields)} className="flex-1 rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover">Fill Form</button>
                    <button
                      onClick={() => {
                        setEditingPagePath(item.pagePath);
                        setEditName(item.title.replace(/ Identity$/, ""));
                        // Pre-fill personal fields from merged fields
                        const personal: Record<string, string> = {};
                        for (const f of PERSONAL_FIELDS) {
                          const val = item.fields[f.key] || item.fields[f.label.toLowerCase()];
                          if (val) personal[f.key] = val;
                        }
                        setEditPersonal(personal);
                        // Pre-fill address fields
                        const address: Record<string, string> = {};
                        for (const f of ADDRESS_FIELDS) {
                          const val = item.fields[f.key] || item.fields[f.label.toLowerCase()];
                          if (val) address[f.key] = val;
                        }
                        setEditAddress(address);
                        setSection("edit-identity");
                      }}
                      className="rounded border border-border px-2 py-1 text-[10px] text-text-muted hover:text-text-primary transition-colors"
                    >
                      Edit
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Credit Cards */}
      <div className="flex items-center justify-between pt-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Credit Cards</h3>
        <button onClick={() => setSection("new-card")} className="text-[10px] font-medium text-accent hover:text-accent-hover transition-colors">+ Add</button>
      </div>

      {cards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-4 text-center">
          <p className="text-[11px] text-text-muted">No credit cards in vault</p>
          <button onClick={() => setSection("new-card")} className="mt-1.5 text-[10px] font-medium text-accent hover:underline">Add one</button>
        </div>
      ) : (
        cards.map((item, idx) => {
          const globalIdx = identities.length + idx;
          const isExpanded = expandedIdx === globalIdx;
          const num = (item.fields.card_number || item.fields["card number"] || "").replace(/\s/g, "");
          const last4 = num.slice(-4);
          const hasNumber = num.length >= 12;
          const masked = hasNumber ? `•••• •••• •••• ${last4}` : "Open in desktop to add card number";
          const expiry = item.fields.expiry || item.fields["expiry (mm/yy)"] || "—";
          const holderName = item.fields.card_name || item.fields["cardholder name"] || item.title;
          const brand = detectCardBrand(num);

          return (
            <div key={item.pagePath} className="space-y-1.5">
              {/* Stripe-like card visual */}
              <button
                onClick={() => setExpandedIdx(isExpanded ? null : globalIdx)}
                className="w-full text-left"
              >
                <div
                  className="relative rounded-xl p-3.5 overflow-hidden transition-shadow hover:shadow-lg"
                  style={{
                    background: brand
                      ? `linear-gradient(135deg, ${brand.color}dd 0%, ${brand.color}88 100%)`
                      : "linear-gradient(135deg, #374151 0%, #1f2937 100%)",
                  }}
                >
                  {/* Decorative circles */}
                  <div className="absolute -right-4 -top-4 h-20 w-20 rounded-full opacity-10" style={{ background: "white" }} />
                  <div className="absolute -right-2 top-6 h-14 w-14 rounded-full opacity-10" style={{ background: "white" }} />

                  {/* Brand + chip row */}
                  <div className="flex items-center justify-between mb-3">
                    {/* Chip icon */}
                    <div className="flex h-6 w-8 items-center justify-center rounded bg-yellow-300/80">
                      <div className="h-3.5 w-5 rounded-sm border border-yellow-600/40 bg-yellow-400/60" />
                    </div>
                    {/* Brand name */}
                    <span className="text-[11px] font-bold text-white/90 tracking-wider uppercase">
                      {brand?.brand ?? "Card"}
                    </span>
                  </div>

                  {/* Card number — falls back to a "no number stored" hint
                      when the classifier picked this up by tag/brand only. */}
                  <div className={`mb-3 ${hasNumber ? "text-[14px] font-mono tracking-[0.15em] text-white" : "text-[10px] italic text-white/70"}`}>
                    {masked}
                  </div>

                  {/* Bottom row: name + expiry */}
                  <div className="flex items-end justify-between">
                    <div>
                      <div className="text-[8px] uppercase text-white/50 tracking-wider">Card Holder</div>
                      <div className="text-[11px] font-medium text-white/90 uppercase tracking-wide">{holderName}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[8px] uppercase text-white/50 tracking-wider">Expires</div>
                      <div className="text-[11px] font-mono text-white/90">{expiry}</div>
                    </div>
                  </div>
                </div>
              </button>

              {/* Expanded actions */}
              {isExpanded && (
                <div className="space-y-1.5 px-1">
                  <div className="flex gap-1.5">
                    <button onClick={() => fillForm(item.fields)} className="flex-1 rounded-lg bg-accent px-2 py-1.5 text-[10px] font-medium text-white hover:bg-accent-hover transition-colors">Fill Checkout Form</button>
                    <button
                      onClick={() => {
                        const pw = item.fields.card_number || num;
                        if (pw) {
                          try {
                            chrome.runtime.sendMessage({ type: "COPY_TO_CLIPBOARD", text: pw, autoClear: true } as Message);
                          } catch {
                            navigator.clipboard.writeText(pw).catch(() => {});
                          }
                        }
                      }}
                      className="rounded-lg border border-border px-2 py-1.5 text-[10px] text-text-muted hover:text-text-primary transition-colors"
                    >
                      Copy #
                    </button>
                  </div>
                  <p className="text-[9px] text-text-dim text-center">To edit card details, open Claspt desktop app</p>
                </div>
              )}
            </div>
          );
        })
      )}

      {identities.length === 0 && cards.length === 0 && (
        <p className="text-center text-[10px] text-text-dim pt-2">
          Identities and cards are stored securely in your vault's <strong>identities</strong> folder.
        </p>
      )}
    </div>
  );
}
