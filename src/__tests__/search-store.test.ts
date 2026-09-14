// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSearchStore } from "@/stores/search-store";
import * as cmd from "@/lib/commands";

vi.mock("@/lib/commands", () => ({
  searchPages: vi.fn(),
  rebuildSearchIndex: vi.fn(),
}));

const mockSearchPages = vi.mocked(cmd.searchPages);
const mockRebuildSearchIndex = vi.mocked(cmd.rebuildSearchIndex);

describe("useSearchStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSearchStore.setState({
      query: "",
      results: [],
      isOpen: false,
      scope: "all",
      loading: false,
      selectedIndex: 0,
      searchHighlight: null,
    });
  });

  it("has correct initial state", () => {
    const state = useSearchStore.getState();
    expect(state.query).toBe("");
    expect(state.results).toEqual([]);
    expect(state.isOpen).toBe(false);
    expect(state.scope).toBe("all");
    expect(state.loading).toBe(false);
  });

  it("setQuery updates query", () => {
    useSearchStore.getState().setQuery("hello");
    expect(useSearchStore.getState().query).toBe("hello");
  });

  it("search returns results and resets selectedIndex", async () => {
    const fakeResults = [
      {
        page_id: "1",
        title: "Test",
        snippet: "...",
        folder: "general",
        path: "a.md",
        score: 1.0,
      },
    ];
    mockSearchPages.mockResolvedValue(fakeResults);

    await useSearchStore.getState().search("test");

    expect(mockSearchPages).toHaveBeenCalledWith("test", "all", true, 40);
    expect(useSearchStore.getState().results).toEqual(fakeResults);
    expect(useSearchStore.getState().loading).toBe(false);
    expect(useSearchStore.getState().selectedIndex).toBe(0);
  });

  it("search with empty query clears results", async () => {
    useSearchStore.setState({
      results: [
        { page_id: "1", title: "T", snippet: "", folder: "", path: "", score: 1 },
      ],
    });
    await useSearchStore.getState().search("  ");
    expect(useSearchStore.getState().results).toEqual([]);
    expect(mockSearchPages).not.toHaveBeenCalled();
  });

  it("search handles errors gracefully", async () => {
    mockSearchPages.mockRejectedValue(new Error("network"));
    await useSearchStore.getState().search("fail");
    expect(useSearchStore.getState().results).toEqual([]);
    expect(useSearchStore.getState().loading).toBe(false);
  });

  it("open/close/toggle manage isOpen", () => {
    useSearchStore.getState().open();
    expect(useSearchStore.getState().isOpen).toBe(true);

    useSearchStore.getState().close();
    expect(useSearchStore.getState().isOpen).toBe(false);
    expect(useSearchStore.getState().query).toBe("");
    expect(useSearchStore.getState().results).toEqual([]);
  });

  it("toggle flips isOpen", () => {
    useSearchStore.getState().toggle();
    expect(useSearchStore.getState().isOpen).toBe(true);
    useSearchStore.getState().toggle();
    expect(useSearchStore.getState().isOpen).toBe(false);
  });

  it("setScope updates scope", () => {
    useSearchStore.getState().setScope({ folder: "work" });
    expect(useSearchStore.getState().scope).toEqual({ folder: "work" });
  });

  it("rebuildIndex calls cmd.rebuildSearchIndex", async () => {
    mockRebuildSearchIndex.mockResolvedValue(42);
    const count = await useSearchStore.getState().rebuildIndex();
    expect(count).toBe(42);
    expect(mockRebuildSearchIndex).toHaveBeenCalledOnce();
  });

  it("setSelectedIndex updates index", () => {
    useSearchStore.getState().setSelectedIndex(3);
    expect(useSearchStore.getState().selectedIndex).toBe(3);
  });

  it("setSearchHighlight updates highlight", () => {
    useSearchStore.getState().setSearchHighlight("keyword");
    expect(useSearchStore.getState().searchHighlight).toBe("keyword");
  });
});
