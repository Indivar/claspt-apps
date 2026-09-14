// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * GeneratorPanel — top-level mount point for the secret generator modal.
 *
 * Watches the UI store's `generatorOpen` flag and renders {@link GeneratorContent}
 * only when the generator is open (keeping the modal fully unmounted otherwise).
 */
import { useUIStore } from "@/stores/ui-store";
import { GeneratorContent } from "./GeneratorContent";

/** Conditionally mounts the generator modal based on UI store state. */
export function GeneratorPanel() {
  const generatorOpen = useUIStore((s) => s.generatorOpen);

  if (!generatorOpen) return null;

  return <GeneratorContent />;
}
