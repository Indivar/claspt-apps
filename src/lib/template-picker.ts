// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The shapes the secret template picker works with, and how the shared
 * built-in list and the owner's saved templates are brought into them.
 * Kept out of the component module so the component file only exports
 * components (enabling React Fast Refresh) and the mapping can be tested.
 */
import { SECRET_TEMPLATES, fieldName } from "@claspt/shared/secret-templates";
import type { SecretTemplateSpec } from "@claspt/shared/secret-templates";
import type { SavedSecretTemplate } from "@/lib/commands";

export interface TemplateField {
  /** What the person reads beside the box. */
  key: string;
  placeholder: string;
  /**
   * The name written into the block, when it must differ from the label.
   *
   * The reader of a secret block lower-cases every key, so a friendly label
   * like "Authenticator Key" would be stored as `authenticator key` and no
   * consumer would ever find it. The label is for the person; this is for the
   * machine, and only the login template needs them to differ.
   */
  fieldKey?: string;
  /** One line under the box, for a field nobody can guess the shape of. */
  hint?: string;
}

export interface Template {
  id: string;
  label: string;
  icon: string;
  fields: TemplateField[];
}

/** A built-in template from the shared list, in this picker's shape. */
export function fromSpec(spec: SecretTemplateSpec): Template {
  return {
    id: spec.id,
    label: spec.name,
    icon: spec.icon,
    fields: spec.fields.map((f) => ({
      key: f.label,
      fieldKey: fieldName(f) === f.label ? undefined : fieldName(f),
      placeholder: f.placeholder ?? "",
      hint: f.hint,
    })),
  };
}

/** A template the owner saved: its field keys are what is written. */
export function fromSaved(saved: SavedSecretTemplate): Template {
  return {
    id: saved.id,
    label: saved.name,
    icon: "saved",
    fields: saved.fields.map((f) => ({
      key: f.label || f.key,
      fieldKey: f.key,
      placeholder: "",
    })),
  };
}

export const CUSTOM: Template = {
  id: "custom",
  label: "Custom",
  icon: "plus",
  fields: [
    { key: "Field 1", placeholder: "" },
    { key: "Field 2", placeholder: "" },
  ],
};

/** The built-in templates and Custom, in the order the picker shows them. */
export const BUILT_IN_TEMPLATES: Template[] = [...SECRET_TEMPLATES.map(fromSpec), CUSTOM];
