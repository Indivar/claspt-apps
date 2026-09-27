// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * A request to open the convert-to-secret dialog on a range of the active
 * editor. The context menu owns the dialog; the encrypted-page band and the
 * paste bar ask for it through here.
 */
import { create } from "zustand";

export interface ConvertRequest {
  from: number;
  to: number;
}

interface ConvertStore {
  request: ConvertRequest | null;
  requestConvert: (from: number, to: number) => void;
  clearRequest: () => void;
}

export const useConvertStore = create<ConvertStore>((set) => ({
  request: null,
  requestConvert: (from, to) => set({ request: { from, to } }),
  clearRequest: () => set({ request: null }),
}));
