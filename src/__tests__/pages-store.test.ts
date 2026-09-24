// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePagesStore } from "@/stores/pages-store";
import * as cmd from "@/lib/commands";

vi.mock("@/lib/commands", () => ({
  listPages: vi.fn(),
  listSecrets: vi.fn(),
  readPage: vi.fn(),
  createPage: vi.fn(),
  updatePage: vi.fn(),
  deletePage: vi.fn(),
  trashRestore: vi.fn(),
  duplicatePage: vi.fn(),
  togglePin: vi.fn(),
  toggleArchive: vi.fn(),
  movePage: vi.fn(),
  updateTitle: vi.fn(),
  updateTags: vi.fn(),
  toggleEncryption: vi.fn(),
  listFolders: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
}));

const mockCmd = vi.mocked(cmd);

const fakePage = {
  meta: {
    id: "p1",
    title: "Test",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    pinned: false,
    archived: false,
    tags: [],
    folder: "general",
    encrypted: false,
  },
  content: "# Hello",
  path: "general/test.md",
};

const fakeTrashEntry = {
  id: "1700000000000-abc",
  original_path: "general/test.md",
  title: "Test",
  folder: "general",
  encrypted: false,
  deleted_at: "2026-09-20T00:00:00Z",
  purge_at: "2026-10-20T00:00:00Z",
};

const fakePageSummary = {
  meta: {
    id: "p1",
    title: "Test",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    pinned: false,
    archived: false,
    tags: [],
    folder: "general",
    encrypted: false,
  },
  path: "general/test.md",
  snippet: "Hello",
};

describe("usePagesStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePagesStore.setState({
      pages: [],
      secrets: [],
      activePage: null,
      pagesLoaded: false,
      loading: false,
      error: null,
      showArchived: false,
      folders: [],
    });
  });

  it("loadPages fetches and sets pages", async () => {
    mockCmd.listPages.mockResolvedValue([fakePageSummary]);
    await usePagesStore.getState().loadPages();
    expect(usePagesStore.getState().pages).toEqual([fakePageSummary]);
    expect(usePagesStore.getState().pagesLoaded).toBe(true);
  });

  it("loadPages sets error on failure", async () => {
    mockCmd.listPages.mockRejectedValue(new Error("fail"));
    await usePagesStore.getState().loadPages();
    expect(usePagesStore.getState().error).toBe("fail");
  });

  it("openPage loads full page content", async () => {
    mockCmd.readPage.mockResolvedValue(fakePage);
    await usePagesStore.getState().openPage("general/test.md");
    expect(usePagesStore.getState().activePage).toEqual(fakePage);
    expect(usePagesStore.getState().loading).toBe(false);
  });

  it("createPage sets active page and reloads list", async () => {
    mockCmd.createPage.mockResolvedValue(fakePage);
    mockCmd.listPages.mockResolvedValue([fakePageSummary]);
    const result = await usePagesStore.getState().createPage("Test", "general");
    expect(result).toEqual(fakePage);
    expect(usePagesStore.getState().activePage).toEqual(fakePage);
    expect(mockCmd.listPages).toHaveBeenCalled();
  });

  it("deletePage clears activePage if it matches", async () => {
    usePagesStore.setState({ activePage: fakePage });
    mockCmd.deletePage.mockResolvedValue(fakeTrashEntry);
    mockCmd.listPages.mockResolvedValue([]);
    await usePagesStore.getState().deletePage("general/test.md");
    expect(usePagesStore.getState().activePage).toBeNull();
  });

  it("deletePage keeps activePage if different path", async () => {
    usePagesStore.setState({ activePage: fakePage });
    mockCmd.deletePage.mockResolvedValue(fakeTrashEntry);
    mockCmd.listPages.mockResolvedValue([fakePageSummary]);
    await usePagesStore.getState().deletePage("other/note.md");
    expect(usePagesStore.getState().activePage).toEqual(fakePage);
  });

  it("deletePage returns true on success and false on failure", async () => {
    mockCmd.deletePage.mockResolvedValue(fakeTrashEntry);
    mockCmd.listPages.mockResolvedValue([]);
    await expect(usePagesStore.getState().deletePage("general/test.md")).resolves.toBe(
      true,
    );

    // On failure it must resolve false (so callers don't fake success) and not
    // throw — the store records the error and toasts it.
    mockCmd.deletePage.mockRejectedValue(new Error("readonly database"));
    await expect(usePagesStore.getState().deletePage("general/test.md")).resolves.toBe(
      false,
    );
    expect(usePagesStore.getState().error).toContain("readonly database");
  });

  it("togglePin updates active page if matching", async () => {
    usePagesStore.setState({ activePage: fakePage });
    const pinned = { ...fakePage, meta: { ...fakePage.meta, pinned: true } };
    mockCmd.togglePin.mockResolvedValue(pinned);
    mockCmd.listPages.mockResolvedValue([]);
    await usePagesStore.getState().togglePin("general/test.md");
    expect(usePagesStore.getState().activePage?.meta.pinned).toBe(true);
  });

  it("closePage clears activePage", () => {
    usePagesStore.setState({ activePage: fakePage });
    usePagesStore.getState().closePage();
    expect(usePagesStore.getState().activePage).toBeNull();
  });

  it("clearError resets error", () => {
    usePagesStore.setState({ error: "something" });
    usePagesStore.getState().clearError();
    expect(usePagesStore.getState().error).toBeNull();
  });

  it("setShowArchived sets flag", () => {
    usePagesStore.getState().setShowArchived(true);
    expect(usePagesStore.getState().showArchived).toBe(true);
  });

  it("loadFolders fetches folder list", async () => {
    mockCmd.listFolders.mockResolvedValue(["general", "work"]);
    await usePagesStore.getState().loadFolders();
    expect(usePagesStore.getState().folders).toEqual(["general", "work"]);
  });

  it("createFolder reloads folders", async () => {
    mockCmd.createFolder.mockResolvedValue("new-folder");
    mockCmd.listFolders.mockResolvedValue(["general", "new-folder"]);
    const result = await usePagesStore.getState().createFolder("new-folder");
    expect(result).toBe("new-folder");
    expect(mockCmd.listFolders).toHaveBeenCalled();
  });

  it("renameFolder reloads folders and pages", async () => {
    mockCmd.renameFolder.mockResolvedValue(undefined);
    mockCmd.listFolders.mockResolvedValue(["general", "renamed"]);
    mockCmd.listPages.mockResolvedValue([]);
    const result = await usePagesStore.getState().renameFolder("old", "renamed");
    expect(result).toBe(true);
    expect(mockCmd.listFolders).toHaveBeenCalled();
    expect(mockCmd.listPages).toHaveBeenCalled();
  });

  it("deleteFolder returns false on error", async () => {
    mockCmd.deleteFolder.mockRejectedValue(new Error("nope"));
    const result = await usePagesStore.getState().deleteFolder("test", "trash");
    expect(result).toBe(false);
    expect(usePagesStore.getState().error).toContain("nope");
  });

  it("loadSecrets fetches secrets", async () => {
    const secrets = [
      {
        label: "API Key",
        page_title: "Creds",
        page_path: "general/creds.md",
        folder: "general",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    mockCmd.listSecrets.mockResolvedValue(secrets);
    await usePagesStore.getState().loadSecrets();
    expect(usePagesStore.getState().secrets).toEqual(secrets);
  });
});
