// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Folder-tree helpers shared by the sidebar and its recursive FolderSection
 * nodes. Kept out of the component module so the component file only exports
 * components (enabling React Fast Refresh).
 */

/** A node in the folder tree built from the flat folder list. */
export interface FolderNode {
  /** Segment name, e.g. "aws" */
  name: string;
  /** Full path, e.g. "credentials/work/aws" */
  path: string;
  /** Child folders */
  children: FolderNode[];
}

/** Build a tree from a sorted flat folder list like ["credentials", "credentials/work", ...]. */
export function buildFolderTree(folders: string[]): FolderNode[] {
  const root: FolderNode[] = [];
  for (const folder of folders) {
    const segments = folder.split("/");
    let current = root;
    let pathSoFar = "";
    for (const seg of segments) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${seg}` : seg;
      let node = current.find((n) => n.name === seg);
      if (!node) {
        node = { name: seg, path: pathSoFar, children: [] };
        current.push(node);
      }
      current = node.children;
    }
  }
  return root;
}
