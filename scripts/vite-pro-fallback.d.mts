// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { Plugin } from "vite";
export const PRO_MODULES: Record<string, string>;
export function moduleKey(specifier: string, importer: string | undefined): string | null;
export function resolveProModule(key: string): string;
export function proFallback(): Plugin;
