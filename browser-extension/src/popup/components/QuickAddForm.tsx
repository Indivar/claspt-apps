// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useState } from "react";
import { generatePassword, generatePassphrase, generatePin } from "@/shared/generator";

type GenMode = "password" | "passphrase" | "pin";

interface GenOpts {
  mode: GenMode;
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
  excludeProblematic: boolean;
  wordCount: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
  pinLength: number;
}

const DEFAULT_GEN_OPTS: GenOpts = {
  mode: "password",
  length: 20,
  uppercase: true,
  lowercase: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
  excludeProblematic: false,
  wordCount: 5,
  separator: "-",
  capitalize: true,
  includeNumber: false,
  pinLength: 6,
};

function runGenerator(o: GenOpts): string {
  switch (o.mode) {
    case "password":
      return generatePassword({
        length: o.length,
        uppercase: o.uppercase,
        lowercase: o.lowercase,
        digits: o.digits,
        symbols: o.symbols,
        excludeAmbiguous: o.excludeAmbiguous,
        excludeProblematic: o.excludeProblematic,
      });
    case "passphrase":
      return generatePassphrase({
        wordCount: o.wordCount,
        separator: o.separator,
        capitalize: o.capitalize,
        includeNumber: o.includeNumber,
      });
    case "pin":
      return generatePin(o.pinLength);
  }
}

interface QuickAddFormProps {
  domain: string;
  onSave: (data: { label: string; fields: Record<string, string> }) => void;
  onCancel: () => void;
}

type Template = "password" | "api_key" | "ssh_key" | "env_var" | "license_key" | "credit_card" | "custom";

const TEMPLATES: { id: Template; label: string; icon: string; fields: string[] }[] = [
  { id: "password", label: "Password", icon: "🔑", fields: ["URL", "Username", "Password"] },
  { id: "api_key", label: "API Key", icon: "🔧", fields: ["Service", "API Key", "Secret"] },
  { id: "ssh_key", label: "SSH Key", icon: "🖥️", fields: ["Host", "Username", "Private Key"] },
  { id: "env_var", label: "Env Variable", icon: "📋", fields: ["Variable", "Value"] },
  { id: "license_key", label: "License Key", icon: "📄", fields: ["Product", "License Key", "Email"] },
  { id: "credit_card", label: "Credit Card", icon: "💳", fields: ["Card Number", "Expiry", "CVV", "Name"] },
  { id: "custom", label: "Custom", icon: "✏️", fields: ["Key", "Value"] },
];

const inputClass =
  "w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim outline-none focus:border-accent";
const labelClass = "text-[10px] font-medium text-text-muted mb-0.5 block";

export function QuickAddForm({ domain, onSave, onCancel }: QuickAddFormProps) {
  const [template, setTemplate] = useState<Template | null>(null);
  const [label, setLabel] = useState(domain);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [genOpen, setGenOpen] = useState<string | null>(null); // field name whose generator panel is open
  const [genOpts, setGenOpts] = useState<GenOpts>(DEFAULT_GEN_OPTS);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ label, fields });
  };

  const updateField = (key: string, value: string) => {
    setFields({ ...fields, [key]: value });
  };

  // ── Template Picker ──
  if (!template) {
    return (
      <div className="p-3 border-t border-border space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-text-primary">Add New Credential</span>
          <button onClick={onCancel} className="text-[10px] text-text-dim hover:text-text-muted">Cancel</button>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTemplate(t.id);
                // Pre-fill URL for password template
                if (t.id === "password" && domain) {
                  setFields({ URL: `https://${domain}` });
                }
              }}
              className="flex flex-col items-center gap-1 rounded-md border border-border p-2 text-[10px] text-text-muted hover:border-accent hover:text-accent transition-colors"
            >
              <span className="text-base">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const currentTemplate = TEMPLATES.find((t) => t.id === template)!;

  // ── Field Form ──
  return (
    <form onSubmit={handleSubmit} className="p-3 border-t border-border space-y-2">
      <div className="flex items-center justify-between mb-1">
        <button
          type="button"
          onClick={() => setTemplate(null)}
          className="text-[10px] text-accent hover:underline"
        >
          ← Templates
        </button>
        <span className="text-[10px] text-text-dim">{currentTemplate.icon} {currentTemplate.label}</span>
      </div>

      <div>
        <label className={labelClass}>Label</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. GitHub Login"
          className={inputClass}
          autoFocus
        />
      </div>

      {currentTemplate.fields.map((fieldName) => (
        <div key={fieldName}>
          <label className={labelClass}>{fieldName}</label>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={fields[fieldName] || ""}
              onChange={(e) => updateField(fieldName, e.target.value)}
              placeholder={fieldName}
              className={inputClass}
            />
            {(fieldName === "Password" || fieldName === "Secret") && (
              <>
                <button
                  type="button"
                  onClick={() => updateField(fieldName, runGenerator(genOpts))}
                  className="shrink-0 rounded-md bg-accent/10 border border-accent/30 px-2 py-1.5 text-[10px] font-medium text-accent hover:bg-accent/20 transition-colors"
                  title="Generate with current options"
                >
                  Generate
                </button>
                <button
                  type="button"
                  onClick={() => setGenOpen(genOpen === fieldName ? null : fieldName)}
                  className="shrink-0 rounded-md border border-border px-2 py-1.5 text-[10px] font-medium text-text-muted hover:text-accent hover:bg-accent/5 transition-colors"
                  title="Generator options"
                  aria-label="Generator options"
                >
                  {genOpen === fieldName ? "▴" : "▾"}
                </button>
              </>
            )}
          </div>
          {genOpen === fieldName && (
            <InlineGenerator
              opts={genOpts}
              onChange={setGenOpts}
              onInsert={(val) => updateField(fieldName, val)}
            />
          )}
        </div>
      ))}

      {/* Custom: add more fields */}
      {template === "custom" && (
        <button
          type="button"
          onClick={() => {
            const n = Object.keys(fields).length + 1;
            updateField(`Field ${n}`, "");
          }}
          className="text-[10px] text-accent hover:underline"
        >
          + Add field
        </button>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text-primary"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!label.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </form>
  );
}

function InlineGenerator({
  opts,
  onChange,
  onInsert,
}: {
  opts: GenOpts;
  onChange: (next: GenOpts) => void;
  onInsert: (value: string) => void;
}) {
  const set = <K extends keyof GenOpts>(k: K, v: GenOpts[K]) => onChange({ ...opts, [k]: v });
  return (
    <div className="mt-1.5 rounded-md border border-border bg-surface-raised/60 p-2 space-y-1.5">
      <div className="flex gap-1 rounded-md border border-border overflow-hidden text-[10px]">
        {(["password", "passphrase", "pin"] as GenMode[]).map((m) => (
          <button
            key={m}
            type="button"
            className={`flex-1 py-1 font-medium transition-colors ${
              opts.mode === m ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-surface-raised"
            }`}
            onClick={() => set("mode", m)}
          >
            {m === "password" ? "Password" : m === "passphrase" ? "Phrase" : "PIN"}
          </button>
        ))}
      </div>

      {opts.mode === "password" && (
        <>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-text-muted w-12">Len {opts.length}</span>
            <input
              type="range"
              min={8}
              max={128}
              value={opts.length}
              onChange={(e) => set("length", Number(e.target.value))}
              className="flex-1 accent-accent"
            />
          </div>
          <div className="flex flex-wrap gap-2 text-[10px] text-text-secondary">
            <Mini label="A-Z" checked={opts.uppercase} onChange={(v) => set("uppercase", v)} />
            <Mini label="a-z" checked={opts.lowercase} onChange={(v) => set("lowercase", v)} />
            <Mini label="0-9" checked={opts.digits} onChange={(v) => set("digits", v)} />
            <Mini label="@#!" checked={opts.symbols} onChange={(v) => set("symbols", v)} />
          </div>
          <Mini
            label="Exclude ambiguous (0O, 1lI)"
            checked={opts.excludeAmbiguous}
            onChange={(v) => set("excludeAmbiguous", v)}
          />
          <Mini
            label={'Exclude problematic (\\\'"{}<>)'}
            checked={opts.excludeProblematic}
            onChange={(v) => set("excludeProblematic", v)}
          />
        </>
      )}

      {opts.mode === "passphrase" && (
        <>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-text-muted w-12">Words {opts.wordCount}</span>
            <input
              type="range"
              min={3}
              max={10}
              value={opts.wordCount}
              onChange={(e) => set("wordCount", Number(e.target.value))}
              className="flex-1 accent-accent"
            />
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-text-muted w-12">Sep</span>
            <select
              value={opts.separator}
              onChange={(e) => set("separator", e.target.value)}
              className="flex-1 rounded border border-border bg-surface-raised px-1.5 py-0.5 text-text-primary outline-none"
            >
              <option value="-">Hyphen (-)</option>
              <option value=" ">Space</option>
              <option value=".">Dot (.)</option>
              <option value="_">Underscore (_)</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-2 text-[10px] text-text-secondary">
            <Mini label="Capitalize" checked={opts.capitalize} onChange={(v) => set("capitalize", v)} />
            <Mini label="+ number" checked={opts.includeNumber} onChange={(v) => set("includeNumber", v)} />
          </div>
        </>
      )}

      {opts.mode === "pin" && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-text-muted w-12">Digits {opts.pinLength}</span>
          <input
            type="range"
            min={4}
            max={12}
            value={opts.pinLength}
            onChange={(e) => set("pinLength", Number(e.target.value))}
            className="flex-1 accent-accent"
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => onInsert(runGenerator(opts))}
        className="w-full rounded-md bg-accent/10 border border-accent/30 py-1 text-[11px] font-medium text-accent hover:bg-accent/20 transition-colors"
      >
        Regenerate &amp; insert
      </button>
    </div>
  );
}

function Mini({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded accent-accent"
      />
      {label}
    </label>
  );
}
