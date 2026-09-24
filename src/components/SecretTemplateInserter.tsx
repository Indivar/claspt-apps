// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Modal for inserting a new `:::secret[...]:::` block into the editor from a
 * built-in template (the shared list the extension uses too), one the owner
 * saved under Settings › Automation › Templates, or a fully custom set of
 * fields.
 *
 * The user fills in field values, then the block is inserted at the cursor as
 * plaintext markdown — encryption of the values happens later, on save, in the
 * backend secret-block pipeline. Password-like fields offer an inline generator
 * button. This component never handles encryption itself.
 */
import { useCallback, useEffect, useState } from "react";
import { useUIStore } from "@/stores/ui-store";
import { insertAtCursor } from "@/components/editor/editor-api";
import { CloseIcon } from "@/components/ui/icons";
import { InlineGenerateButton } from "@/components/generator/InlineGenerateButton";
import { isGeneratable } from "@/components/generator/generatable";
import { TotpPreview } from "@/components/secret/TotpPreview";
import { TOTP_FIELD_NAMES } from "@claspt/shared/credential-fields";
import { oneLine } from "@claspt/shared/secret-templates";
import { getTemplates } from "@/lib/commands";
import { BUILT_IN_TEMPLATES, fromSaved } from "@/lib/template-picker";
import type { Template } from "@/lib/template-picker";

/** Whether this field holds an authenticator key, by any accepted spelling. */
function isTotpField(key: string): boolean {
  return (TOTP_FIELD_NAMES as readonly string[]).includes(key.trim().toLowerCase());
}

/** Renders the small SVG icon associated with a template category. */
function TemplateIcon({ type }: { type: string }) {
  const cls = "w-5 h-5 text-text-muted";
  switch (type) {
    case "globe":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M2 8h12M8 2c2 2.5 2 9.5 0 12M8 2c-2 2.5-2 9.5 0 12"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
      );
    case "card":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <rect
            x="1"
            y="3"
            width="14"
            height="10"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M1 7h14" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "bank":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <path
            d="M2 6l6-4 6 4H2zM3 13h10M4 6v7M8 6v7M12 6v7"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
    case "key":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <circle cx="5" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M8 8h6M12 6v4M14 6v4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "terminal":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <rect
            x="1"
            y="2"
            width="14"
            height="12"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M4 6l3 2.5L4 11M9 11h3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "wifi":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <path
            d="M1 5.5a10 10 0 0114 0M3.5 8a6.5 6.5 0 019 0M6 10.5a3 3 0 014 0"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="13" r="1" fill="currentColor" />
        </svg>
      );
    case "id":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <rect
            x="1"
            y="3"
            width="14"
            height="10"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <circle cx="5.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M9 7h4M9 9.5h3"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "mail":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <rect
            x="1.5"
            y="3"
            width="13"
            height="10"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M2 4.5l6 4.5 6-4.5" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    case "server":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <rect
            x="2"
            y="2"
            width="12"
            height="5"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <rect
            x="2"
            y="9"
            width="12"
            height="5"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <circle cx="5" cy="4.5" r="0.8" fill="currentColor" />
          <circle cx="5" cy="11.5" r="0.8" fill="currentColor" />
        </svg>
      );
    case "database":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <ellipse
            cx="8"
            cy="4"
            rx="5.5"
            ry="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </svg>
      );
    case "gear":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
    case "licence":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <path
            d="M4 1.5h5l3.5 3.5v9.5H4z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M9 1.5V5h3.5M6 8.5h4M6 11h4"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
    case "wallet":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <rect
            x="1.5"
            y="4"
            width="13"
            height="9"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M1.5 6.5h13M11 9.5h2"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
    case "saved":
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <path
            d="M8 2l1.8 3.7 4.2.6-3 2.9.7 4.1L8 11.4l-3.7 1.9.7-4.1-3-2.9 4.2-.6z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none">
          <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

/** Inner component that manages field editing state. */
function FieldEditor({
  template,
  onInsert,
  onCancel,
}: {
  template: Template;
  onInsert: (text: string) => void;
  onCancel: () => void;
}) {
  const isCustom = template.id === "custom";
  const [label, setLabel] = useState(isCustom ? "" : template.label);
  const [fields, setFields] = useState(
    isCustom
      ? [{ key: "", value: "" }]
      : template.fields.map((f) => ({ key: f.fieldKey ?? f.key, value: "" })),
  );

  // Block fields are single lines; a pasted key or seed phrase is joined.
  const updateField = useCallback((index: number, key: string, value: string) => {
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { key, value: oneLine(value) } : f)),
    );
  }, []);

  const addField = useCallback(() => {
    setFields((prev) => [...prev, { key: "", value: "" }]);
  }, []);

  const removeField = useCallback((index: number) => {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleInsert = useCallback(() => {
    const lines = fields
      .filter((f) => f.key.trim() || f.value.trim())
      .map((f) => (f.key.trim() ? `${f.key}: ${f.value}` : f.value));
    const block = `:::secret[${label}]\n${lines.join("\n")}\n:::\n`;
    onInsert(block);
  }, [label, fields, onInsert]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-text-muted">Label</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={isCustom ? "e.g. My Secret" : ""}
          className="focus-accent w-full rounded-lg border border-border/60 bg-surface px-3 py-2 text-[13px] text-text-primary outline-none"
          autoFocus
        />
      </div>
      <div className="space-y-2">
        {fields.map((field, i) => (
          <div key={i}>
            <div className="flex items-center gap-2">
              {isCustom ? (
                <input
                  type="text"
                  value={field.key}
                  placeholder="Key"
                  onChange={(e) => updateField(i, e.target.value, field.value)}
                  className="focus-accent w-28 shrink-0 rounded-lg border border-border/60 bg-surface px-2 py-1.5 text-right text-[11px] text-text-primary outline-none"
                />
              ) : (
                <span className="w-28 shrink-0 text-right text-xs text-text-muted">
                  {template.fields[i]?.key}
                </span>
              )}
              <input
                type="text"
                value={field.value}
                placeholder={isCustom ? "Value" : (template.fields[i]?.placeholder ?? "")}
                onChange={(e) => updateField(i, field.key, e.target.value)}
                className="focus-accent flex-1 rounded-lg border border-border/60 bg-surface px-3 py-1.5 text-[13px] text-text-primary outline-none"
              />
              {isGeneratable(field.key) && (
                <InlineGenerateButton
                  fieldKey={field.key}
                  onValue={(v) => updateField(i, field.key, v)}
                />
              )}
              {isCustom && (
                <button
                  onClick={() => removeField(i)}
                  disabled={fields.length <= 1}
                  className="shrink-0 rounded p-1 text-text-muted hover:bg-surface-overlay hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                  title="Remove field"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M4 8h8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
            </div>
            {template.fields[i]?.hint && !field.value.trim() && (
              <p className="ml-[7.5rem] mt-1 text-[11px] leading-relaxed text-text-muted">
                {template.fields[i]?.hint}
              </p>
            )}
            {isTotpField(field.key) && (
              <div className="ml-[7.5rem]">
                <TotpPreview secret={field.value} />
              </div>
            )}
          </div>
        ))}
        {isCustom && (
          <button
            onClick={addField}
            className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-border py-1.5 text-xs text-text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 3v10M3 8h10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            Add field
          </button>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg px-4 py-1.5 text-[13px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
        >
          Cancel
        </button>
        <button
          onClick={handleInsert}
          className="rounded-lg bg-accent px-5 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover hover:shadow-md active:scale-95"
        >
          Insert
        </button>
      </div>
    </div>
  );
}

/**
 * Template picker modal. Shows the template grid, then a field editor for the
 * chosen template, and inserts the resulting secret block at the editor cursor.
 */
export function SecretTemplateInserter() {
  const { templatePickerOpen, setTemplatePickerOpen } = useUIStore();
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);

  // Close on Escape
  useEffect(() => {
    if (!templatePickerOpen) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setSelectedTemplate(null);
        setTemplatePickerOpen(false);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [templatePickerOpen, setTemplatePickerOpen]);

  // The owner's saved templates (Settings › Automation › Templates), after
  // the built-in ones. A vault without any, or a failed read, shows the
  // built-ins alone.
  const [saved, setSaved] = useState<Template[]>([]);
  useEffect(() => {
    if (!templatePickerOpen) return;
    let cancelled = false;
    getTemplates()
      .then((list) => {
        if (!cancelled) setSaved(list.map(fromSaved));
      })
      .catch(() => {
        if (!cancelled) setSaved([]);
      });
    return () => {
      cancelled = true;
    };
  }, [templatePickerOpen]);

  if (!templatePickerOpen) return null;

  const handleInsert = (text: string) => {
    insertAtCursor(text);
    setSelectedTemplate(null);
    setTemplatePickerOpen(false);
  };

  const handleCancel = () => {
    setSelectedTemplate(null);
    setTemplatePickerOpen(false);
  };

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50">
      <div className="modal-card w-[520px] overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
          <h2 className="text-[13px] font-semibold text-text-primary">
            {selectedTemplate ? selectedTemplate.label : "Insert Secret Block"}
          </h2>
          <button onClick={handleCancel} className="icon-btn p-1 text-text-muted">
            <CloseIcon />
          </button>
        </div>

        <div className="px-5 py-4">
          {selectedTemplate ? (
            <FieldEditor
              template={selectedTemplate}
              onInsert={handleInsert}
              onCancel={() => setSelectedTemplate(null)}
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {[...BUILT_IN_TEMPLATES, ...saved].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTemplate(t)}
                  className="flex items-center gap-3 rounded-xl border border-border/60 px-4 py-3 text-left transition-all hover:border-accent hover:bg-accent/5 hover:shadow-sm active:scale-[0.98]"
                >
                  <TemplateIcon type={t.icon} />
                  <span className="text-[13px] font-medium text-text-primary">
                    {t.label}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
