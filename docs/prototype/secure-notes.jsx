import { useState, useEffect, useRef, useCallback, useMemo } from "react";

const STORAGE_KEY = "securenotes-pages";

// Simple XOR obfuscation for secret blocks (visual hiding, not crypto-grade)
const obfuscate = (text, key = "vault") => {
  return btoa(
    text
      .split("")
      .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length)))
      .join("")
  );
};
const deobfuscate = (encoded, key = "vault") => {
  try {
    const decoded = atob(encoded);
    return decoded
      .split("")
      .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length)))
      .join("");
  } catch { return ""; }
};

const generateId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const formatDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.getDate();
  const mon = d.toLocaleString("en", { month: "short" });
  const yr = d.getFullYear();
  const time = d.toLocaleString("en", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${day} ${mon} ${yr}, ${time}`;
};

const DEFAULT_PAGES = [
  {
    id: generateId(),
    title: "Welcome to SecureNotes",
    content: `This is your personal notes vault.\n\nYou can write anything here — plain text, ideas, meeting notes, project plans.\n\nFor sensitive info, use secret blocks like this:\n\n:::secret[Example Card]\nCard: 4111-XXXX-XXXX-1234\nCVV: 123\nExpiry: 12/26\n:::\n\n:::secret[Gmail Password]\nmyS3cur3P@ss!\n:::\n\nSecret blocks are hidden by default. Click the eye icon to reveal, click any field to copy it instantly.`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pinned: false,
  },
];

// Parse content to find secret blocks
const parseSecrets = (content) => {
  const regex = /:::secret\[([^\]]*)\]\n([\s\S]*?):::/g;
  const secrets = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    secrets.push({
      full: match[0],
      label: match[1],
      value: match[2].trim(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return secrets;
};

// Render content with secret blocks
const ContentRenderer = ({ content }) => {
  const [revealed, setRevealed] = useState({});
  const [copied, setCopied] = useState(null);

  const secrets = useMemo(() => parseSecrets(content), [content]);

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  const toggleReveal = (idx) => {
    setRevealed((p) => ({ ...p, [idx]: !p[idx] }));
  };

  if (secrets.length === 0) {
    return <div style={styles.renderedText}>{content}</div>;
  }

  const parts = [];
  let lastEnd = 0;
  secrets.forEach((s, idx) => {
    if (s.start > lastEnd) {
      parts.push(
        <div key={`t-${idx}`} style={styles.renderedText}>
          {content.slice(lastEnd, s.start)}
        </div>
      );
    }
    const isRevealed = revealed[idx];
    const lines = s.value.split("\n").filter(Boolean);
    parts.push(
      <div key={`s-${idx}`} style={styles.secretCard}>
        <div style={styles.secretHeader}>
          <div style={styles.secretIcon}>🔒</div>
          <div style={styles.secretLabel}>{s.label}</div>
          <button
            onClick={() => toggleReveal(idx)}
            style={styles.revealBtn}
            title={isRevealed ? "Hide" : "Reveal"}
          >
            {isRevealed ? "👁" : "👁‍🗨"}
          </button>
          <button
            onClick={() => copyToClipboard(s.value, `block-${idx}`)}
            style={styles.copyAllBtn}
            title="Copy all"
          >
            {copied === `block-${idx}` ? "✓ Copied" : "Copy All"}
          </button>
        </div>
        {isRevealed && (
          <div style={styles.secretBody}>
            {lines.map((line, li) => (
              <div
                key={li}
                onClick={() => copyToClipboard(line.includes(":") ? line.split(":").slice(1).join(":").trim() : line, `${idx}-${li}`)}
                style={{
                  ...styles.secretLine,
                  ...(copied === `${idx}-${li}` ? styles.secretLineCopied : {}),
                }}
                title="Click to copy"
              >
                <span style={styles.secretLineText}>{line}</span>
                <span style={styles.copyHint}>
                  {copied === `${idx}-${li}` ? "✓" : "⎘"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
    lastEnd = s.end;
  });
  if (lastEnd < content.length) {
    parts.push(
      <div key="tail" style={styles.renderedText}>
        {content.slice(lastEnd)}
      </div>
    );
  }
  return <div>{parts}</div>;
};

// Secret block inserter modal
const SecretInserter = ({ onInsert, onClose }) => {
  const [label, setLabel] = useState("");
  const [fields, setFields] = useState([{ key: "", value: "" }]);

  const addField = () => setFields([...fields, { key: "", value: "" }]);
  const updateField = (i, k, v) => {
    const f = [...fields];
    f[i] = { ...f[i], [k]: v };
    setFields(f);
  };
  const removeField = (i) => setFields(fields.filter((_, idx) => idx !== i));

  const handleInsert = () => {
    if (!label.trim()) return;
    const lines = fields
      .filter((f) => f.value.trim())
      .map((f) => (f.key.trim() ? `${f.key}: ${f.value}` : f.value))
      .join("\n");
    const block = `\n:::secret[${label}]\n${lines}\n:::\n`;
    onInsert(block);
    onClose();
  };

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalTitle}>Add Secret Block</div>
        <input
          style={styles.modalInput}
          placeholder="Label (e.g., HDFC Credit Card)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          autoFocus
        />
        {fields.map((f, i) => (
          <div key={i} style={styles.fieldRow}>
            <input
              style={{ ...styles.modalInput, flex: 1 }}
              placeholder="Key (optional)"
              value={f.key}
              onChange={(e) => updateField(i, "key", e.target.value)}
            />
            <input
              style={{ ...styles.modalInput, flex: 2 }}
              placeholder="Value"
              value={f.value}
              onChange={(e) => updateField(i, "value", e.target.value)}
            />
            {fields.length > 1 && (
              <button onClick={() => removeField(i)} style={styles.removeFieldBtn}>×</button>
            )}
          </div>
        ))}
        <button onClick={addField} style={styles.addFieldBtn}>+ Add Field</button>
        <div style={styles.modalActions}>
          <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
          <button onClick={handleInsert} style={styles.insertBtn}>Insert</button>
        </div>
      </div>
    </div>
  );
};

export default function SecureNotes() {
  const [pages, setPages] = useState([]);
  const [activePageId, setActivePageId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [showSecretInserter, setShowSecretInserter] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const searchRef = useRef(null);
  const editorRef = useRef(null);

  // Load from storage
  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get(STORAGE_KEY);
        if (result && result.value) {
          const parsed = JSON.parse(result.value);
          setPages(parsed);
          if (parsed.length > 0) setActivePageId(parsed[0].id);
        } else {
          setPages(DEFAULT_PAGES);
          setActivePageId(DEFAULT_PAGES[0].id);
        }
      } catch {
        setPages(DEFAULT_PAGES);
        setActivePageId(DEFAULT_PAGES[0].id);
      }
      setLoading(false);
    })();
  }, []);

  // Save to storage
  const savePages = useCallback(async (newPages) => {
    setPages(newPages);
    try {
      await window.storage.set(STORAGE_KEY, JSON.stringify(newPages));
    } catch (e) {
      console.error("Save failed:", e);
    }
  }, []);

  // Keyboard shortcut: Cmd+K for search
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        handleNewPage();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pages]);

  const activePage = pages.find((p) => p.id === activePageId);

  // Search filtering
  const filteredPages = useMemo(() => {
    if (!searchQuery.trim()) return pages;
    const q = searchQuery.toLowerCase();
    return pages.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.content.toLowerCase().includes(q)
    );
  }, [pages, searchQuery]);

  // Sorted: pinned first, then by updatedAt desc
  const sortedPages = useMemo(() => {
    return [...filteredPages].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
  }, [filteredPages]);

  const handleNewPage = () => {
    const now = new Date().toISOString();
    const newPage = {
      id: generateId(),
      title: "Untitled Note",
      content: "",
      createdAt: now,
      updatedAt: now,
      pinned: false,
    };
    const updated = [newPage, ...pages];
    savePages(updated);
    setActivePageId(newPage.id);
    setEditing(true);
    setEditTitle("Untitled Note");
    setEditContent("");
  };

  const handleStartEdit = () => {
    if (!activePage) return;
    setEditing(true);
    setEditTitle(activePage.title);
    setEditContent(activePage.content);
    setTimeout(() => editorRef.current?.focus(), 50);
  };

  const handleSaveEdit = () => {
    if (!activePage) return;
    const updated = pages.map((p) =>
      p.id === activePage.id
        ? { ...p, title: editTitle, content: editContent, updatedAt: new Date().toISOString() }
        : p
    );
    savePages(updated);
    setEditing(false);
  };

  const handleCancelEdit = () => {
    setEditing(false);
  };

  const handleDeletePage = (id) => {
    const updated = pages.filter((p) => p.id !== id);
    savePages(updated);
    if (activePageId === id) {
      setActivePageId(updated.length > 0 ? updated[0].id : null);
    }
    setDeleteConfirm(null);
    setEditing(false);
  };

  const handleTogglePin = (id) => {
    const updated = pages.map((p) =>
      p.id === id ? { ...p, pinned: !p.pinned } : p
    );
    savePages(updated);
  };

  const handleInsertSecret = (block) => {
    setEditContent((prev) => prev + block);
  };

  const highlightMatch = (text, query) => {
    if (!query.trim()) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    const start = Math.max(0, idx - 30);
    const end = Math.min(text.length, idx + query.length + 30);
    const snippet = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
    return snippet;
  };

  if (loading) {
    return (
      <div style={styles.loadingScreen}>
        <div style={styles.loadingIcon}>🔐</div>
        <div style={styles.loadingText}>Loading SecureNotes…</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Sidebar */}
      <div style={{ ...styles.sidebar, width: sidebarCollapsed ? 52 : 300 }}>
        <div style={styles.sidebarHeader}>
          {!sidebarCollapsed && (
            <>
              <div style={styles.logo}>
                <span style={styles.logoIcon}>🔐</span>
                <span style={styles.logoText}>SecureNotes</span>
              </div>
            </>
          )}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            style={styles.collapseBtn}
            title={sidebarCollapsed ? "Expand" : "Collapse"}
          >
            {sidebarCollapsed ? "→" : "←"}
          </button>
        </div>

        {!sidebarCollapsed && (
          <>
            {/* Search */}
            <div style={styles.searchBox}>
              <span style={styles.searchIcon}>⌕</span>
              <input
                ref={searchRef}
                style={styles.searchInput}
                placeholder="Search notes… (⌘K)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery("")} style={styles.clearSearch}>×</button>
              )}
            </div>

            {/* New page button */}
            <button onClick={handleNewPage} style={styles.newPageBtn}>
              + New Note
            </button>

            {/* Page count */}
            <div style={styles.pageCount}>
              {searchQuery
                ? `${filteredPages.length} of ${pages.length} notes`
                : `${pages.length} note${pages.length !== 1 ? "s" : ""}`}
            </div>

            {/* Page list */}
            <div style={styles.pageList}>
              {sortedPages.map((page) => {
                const isActive = page.id === activePageId;
                const preview = page.content
                  .replace(/:::secret\[[^\]]*\][\s\S]*?:::/g, "🔒 [secret]")
                  .slice(0, 80);
                return (
                  <div
                    key={page.id}
                    onClick={() => {
                      setActivePageId(page.id);
                      if (editing) {
                        handleSaveEdit();
                        setEditing(false);
                      }
                    }}
                    style={{
                      ...styles.pageItem,
                      ...(isActive ? styles.pageItemActive : {}),
                    }}
                  >
                    <div style={styles.pageItemTop}>
                      <div style={styles.pageItemTitle}>
                        {page.pinned && <span style={styles.pinIcon}>📌</span>}
                        {searchQuery
                          ? highlightMatch(page.title, searchQuery)
                          : page.title}
                      </div>
                    </div>
                    <div style={styles.pageItemPreview}>
                      {searchQuery
                        ? highlightMatch(preview, searchQuery)
                        : preview || "Empty note"}
                    </div>
                    <div style={styles.pageItemDate}>{formatDate(page.updatedAt)}</div>
                  </div>
                );
              })}
              {sortedPages.length === 0 && searchQuery && (
                <div style={styles.noResults}>No notes match "{searchQuery}"</div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Main content */}
      <div style={styles.main}>
        {activePage ? (
          <>
            {/* Title bar */}
            <div style={styles.titleBar}>
              {editing ? (
                <input
                  style={styles.titleInput}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Note title…"
                />
              ) : (
                <div style={styles.titleText}>{activePage.title}</div>
              )}
              <div style={styles.titleActions}>
                {editing ? (
                  <>
                    <button onClick={() => setShowSecretInserter(true)} style={styles.actionBtn} title="Insert Secret Block">
                      🔒+
                    </button>
                    <button onClick={handleSaveEdit} style={styles.saveBtn}>Save</button>
                    <button onClick={handleCancelEdit} style={styles.cancelEditBtn}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button onClick={handleStartEdit} style={styles.actionBtn} title="Edit">✏️</button>
                    <button onClick={() => handleTogglePin(activePage.id)} style={styles.actionBtn} title={activePage.pinned ? "Unpin" : "Pin"}>
                      {activePage.pinned ? "📌" : "📍"}
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(activePage.id)}
                      style={styles.actionBtn}
                      title="Delete"
                    >🗑</button>
                  </>
                )}
              </div>
            </div>

            {/* Timestamps */}
            <div style={styles.timestamps}>
              <span>Created: {formatDate(activePage.createdAt)}</span>
              <span style={styles.timestampDivider}>•</span>
              <span>Updated: {formatDate(activePage.updatedAt)}</span>
            </div>

            {/* Content area */}
            <div style={styles.contentArea}>
              {editing ? (
                <div style={styles.editorContainer}>
                  <div style={styles.editorHint}>
                    Use <code style={styles.code}>:::secret[Label]</code> and <code style={styles.code}>:::</code> to create secret blocks, or click 🔒+ above
                  </div>
                  <textarea
                    ref={editorRef}
                    style={styles.editor}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    placeholder="Start writing…"
                    spellCheck={false}
                  />
                </div>
              ) : (
                <div style={styles.rendered}>
                  {activePage.content ? (
                    <ContentRenderer content={activePage.content} />
                  ) : (
                    <div style={styles.emptyNote}>
                      <div style={styles.emptyIcon}>📝</div>
                      <div>This note is empty. Click ✏️ to start writing.</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={styles.noPage}>
            <div style={styles.emptyIcon}>🔐</div>
            <div style={styles.noPageText}>No note selected</div>
            <button onClick={handleNewPage} style={styles.newPageBtnLarge}>
              + Create your first note
            </button>
          </div>
        )}
      </div>

      {/* Secret Inserter Modal */}
      {showSecretInserter && (
        <SecretInserter
          onInsert={handleInsertSecret}
          onClose={() => setShowSecretInserter(false)}
        />
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div style={styles.modalOverlay} onClick={() => setDeleteConfirm(null)}>
          <div style={styles.deleteModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.deleteTitle}>Delete this note?</div>
            <div style={styles.deleteText}>This can't be undone.</div>
            <div style={styles.modalActions}>
              <button onClick={() => setDeleteConfirm(null)} style={styles.cancelBtn}>Keep</button>
              <button onClick={() => handleDeletePage(deleteConfirm)} style={styles.deleteBtnConfirm}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    height: "100vh",
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    background: "#0d1117",
    color: "#c9d1d9",
    overflow: "hidden",
  },

  // Loading
  loadingScreen: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    background: "#0d1117",
    color: "#c9d1d9",
  },
  loadingIcon: { fontSize: 48, marginBottom: 16 },
  loadingText: { fontSize: 16, opacity: 0.6 },

  // Sidebar
  sidebar: {
    background: "#161b22",
    borderRight: "1px solid #21262d",
    display: "flex",
    flexDirection: "column",
    transition: "width 0.2s ease",
    overflow: "hidden",
    flexShrink: 0,
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 12px",
    borderBottom: "1px solid #21262d",
    minHeight: 56,
  },
  logo: { display: "flex", alignItems: "center", gap: 8 },
  logoIcon: { fontSize: 20 },
  logoText: { fontSize: 15, fontWeight: 700, color: "#e6edf3", letterSpacing: "-0.02em" },
  collapseBtn: {
    background: "none",
    border: "none",
    color: "#484f58",
    cursor: "pointer",
    fontSize: 14,
    padding: "4px 8px",
    borderRadius: 4,
  },
  searchBox: {
    position: "relative",
    margin: "12px 12px 8px",
  },
  searchIcon: {
    position: "absolute",
    left: 10,
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: 15,
    color: "#484f58",
  },
  searchInput: {
    width: "100%",
    background: "#0d1117",
    border: "1px solid #21262d",
    borderRadius: 8,
    padding: "9px 32px 9px 32px",
    color: "#c9d1d9",
    fontSize: 13,
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
  clearSearch: {
    position: "absolute",
    right: 8,
    top: "50%",
    transform: "translateY(-50%)",
    background: "none",
    border: "none",
    color: "#484f58",
    cursor: "pointer",
    fontSize: 16,
  },
  newPageBtn: {
    margin: "4px 12px 8px",
    padding: "9px 14px",
    background: "#238636",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "background 0.15s",
  },
  pageCount: {
    padding: "2px 14px 8px",
    fontSize: 11,
    color: "#484f58",
  },
  pageList: {
    flex: 1,
    overflowY: "auto",
    padding: "0 8px 12px",
  },
  pageItem: {
    padding: "10px 12px",
    borderRadius: 8,
    cursor: "pointer",
    marginBottom: 2,
    transition: "background 0.1s",
    borderLeft: "3px solid transparent",
  },
  pageItemActive: {
    background: "#1c2128",
    borderLeft: "3px solid #238636",
  },
  pageItemTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 3,
  },
  pageItemTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#e6edf3",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  pinIcon: { fontSize: 11 },
  pageItemPreview: {
    fontSize: 11,
    color: "#484f58",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    marginBottom: 3,
  },
  pageItemDate: {
    fontSize: 10,
    color: "#30363d",
  },
  noResults: {
    padding: 20,
    textAlign: "center",
    color: "#484f58",
    fontSize: 13,
  },

  // Main
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  titleBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 24px 8px",
    gap: 16,
  },
  titleText: {
    fontSize: 22,
    fontWeight: 700,
    color: "#e6edf3",
    flex: 1,
    letterSpacing: "-0.03em",
  },
  titleInput: {
    fontSize: 22,
    fontWeight: 700,
    color: "#e6edf3",
    background: "transparent",
    border: "none",
    borderBottom: "2px solid #238636",
    outline: "none",
    flex: 1,
    fontFamily: "inherit",
    padding: "2px 0",
    letterSpacing: "-0.03em",
  },
  titleActions: {
    display: "flex",
    gap: 6,
    alignItems: "center",
  },
  actionBtn: {
    background: "none",
    border: "1px solid #21262d",
    borderRadius: 6,
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: 14,
    color: "#c9d1d9",
    transition: "background 0.1s",
  },
  saveBtn: {
    background: "#238636",
    border: "none",
    borderRadius: 6,
    padding: "6px 16px",
    cursor: "pointer",
    fontSize: 13,
    color: "#fff",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  cancelEditBtn: {
    background: "none",
    border: "1px solid #21262d",
    borderRadius: 6,
    padding: "6px 14px",
    cursor: "pointer",
    fontSize: 13,
    color: "#8b949e",
    fontFamily: "inherit",
  },

  // Timestamps
  timestamps: {
    padding: "2px 24px 12px",
    fontSize: 11,
    color: "#484f58",
    display: "flex",
    gap: 4,
    borderBottom: "1px solid #21262d",
  },
  timestampDivider: { margin: "0 4px" },

  // Content
  contentArea: {
    flex: 1,
    overflow: "auto",
    padding: "0",
  },
  editorContainer: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
  editorHint: {
    padding: "10px 24px",
    fontSize: 11,
    color: "#484f58",
    background: "#161b22",
    borderBottom: "1px solid #21262d",
  },
  code: {
    background: "#21262d",
    padding: "2px 6px",
    borderRadius: 4,
    fontSize: 11,
    color: "#79c0ff",
  },
  editor: {
    flex: 1,
    padding: "20px 24px",
    background: "transparent",
    border: "none",
    color: "#c9d1d9",
    fontSize: 14,
    lineHeight: 1.7,
    resize: "none",
    outline: "none",
    fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
  },
  rendered: {
    padding: "20px 24px",
    lineHeight: 1.7,
  },
  renderedText: {
    whiteSpace: "pre-wrap",
    fontSize: 14,
    lineHeight: 1.7,
    color: "#c9d1d9",
    marginBottom: 4,
  },

  // Secret cards
  secretCard: {
    margin: "16px 0",
    border: "1px solid #f0883e40",
    borderRadius: 10,
    background: "#1c1208",
    overflow: "hidden",
  },
  secretHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    background: "#f0883e15",
    borderBottom: "1px solid #f0883e20",
  },
  secretIcon: { fontSize: 14 },
  secretLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: "#f0883e",
  },
  revealBtn: {
    background: "none",
    border: "1px solid #f0883e40",
    borderRadius: 6,
    padding: "3px 8px",
    cursor: "pointer",
    fontSize: 13,
    color: "#f0883e",
  },
  copyAllBtn: {
    background: "none",
    border: "1px solid #f0883e40",
    borderRadius: 6,
    padding: "3px 10px",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    color: "#f0883e",
    fontFamily: "inherit",
  },
  secretBody: {
    padding: "8px 10px",
  },
  secretLine: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "7px 10px",
    borderRadius: 6,
    cursor: "pointer",
    transition: "background 0.1s",
    fontSize: 13,
    color: "#e6edf3",
    marginBottom: 2,
  },
  secretLineCopied: {
    background: "#238636",
    color: "#fff",
  },
  secretLineText: { flex: 1 },
  copyHint: {
    fontSize: 14,
    color: "#484f58",
    marginLeft: 8,
  },

  // Empty states
  emptyNote: {
    textAlign: "center",
    padding: "60px 20px",
    color: "#484f58",
  },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  noPage: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#484f58",
  },
  noPageText: { fontSize: 16, marginTop: 12, marginBottom: 20 },
  newPageBtnLarge: {
    padding: "12px 24px",
    background: "#238636",
    border: "none",
    borderRadius: 10,
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },

  // Modals
  modalOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "#161b22",
    border: "1px solid #30363d",
    borderRadius: 14,
    padding: 24,
    width: 420,
    maxWidth: "90vw",
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: "#e6edf3",
    marginBottom: 16,
  },
  modalInput: {
    width: "100%",
    background: "#0d1117",
    border: "1px solid #21262d",
    borderRadius: 8,
    padding: "9px 12px",
    color: "#c9d1d9",
    fontSize: 13,
    outline: "none",
    fontFamily: "inherit",
    marginBottom: 8,
    boxSizing: "border-box",
  },
  fieldRow: {
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
  },
  removeFieldBtn: {
    background: "none",
    border: "1px solid #21262d",
    borderRadius: 6,
    color: "#f85149",
    cursor: "pointer",
    fontSize: 16,
    padding: "6px 10px",
    marginTop: 0,
  },
  addFieldBtn: {
    background: "none",
    border: "1px solid #21262d",
    borderRadius: 6,
    padding: "6px 12px",
    color: "#484f58",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "inherit",
    marginTop: 4,
    marginBottom: 16,
  },
  modalActions: {
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
  },
  cancelBtn: {
    background: "none",
    border: "1px solid #21262d",
    borderRadius: 8,
    padding: "8px 18px",
    color: "#8b949e",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: "inherit",
  },
  insertBtn: {
    background: "#238636",
    border: "none",
    borderRadius: 8,
    padding: "8px 20px",
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "inherit",
  },
  deleteModal: {
    background: "#161b22",
    border: "1px solid #30363d",
    borderRadius: 14,
    padding: 24,
    width: 340,
    textAlign: "center",
  },
  deleteTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: "#e6edf3",
    marginBottom: 8,
  },
  deleteText: {
    fontSize: 13,
    color: "#8b949e",
    marginBottom: 20,
  },
  deleteBtnConfirm: {
    background: "#da3633",
    border: "none",
    borderRadius: 8,
    padding: "8px 20px",
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "inherit",
  },
};
