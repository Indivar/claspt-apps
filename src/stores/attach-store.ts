// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The queue of files waiting for the attach dialog. The toolbar, a drop and
 * a paste all add to it; the dialog shows one file at a time and answers
 * the same questions for each, so no path can skip the encryption choice
 * or the size limit.
 */
import { create } from "zustand";
import { statSourceFile } from "@/lib/commands";
import { extForMime, extOf, type AttachSource } from "@/lib/attachments";

interface AttachStore {
  queue: AttachSource[];
  enqueue: (sources: AttachSource[]) => void;
  /** Drop the file at the head of the queue, whether attached or dismissed. */
  finish: () => void;
}

export const useAttachStore = create<AttachStore>((set) => ({
  queue: [],
  enqueue: (sources) => set((s) => ({ queue: [...s.queue, ...sources] })),
  finish: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

let nextSourceId = 1;

/** A source for a file on disk; its name, type and size come from the backend. */
export async function sourceFromPath(path: string): Promise<AttachSource> {
  const info = await statSourceFile(path);
  return {
    kind: "path",
    id: nextSourceId++,
    path,
    name: info.name,
    ext: info.ext,
    size: info.size,
  };
}

/** A source for a File from the clipboard or a drop. */
export function sourceFromFile(file: File): AttachSource {
  const ext = extOf(file.name) || extForMime(file.type);
  const name = extOf(file.name) ? file.name : `${file.name || "pasted"}.${ext}`;
  return { kind: "file", id: nextSourceId++, file, name, ext, size: file.size };
}
