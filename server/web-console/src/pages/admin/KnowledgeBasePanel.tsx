import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  api,
  describeError,
  getToken,
  uploadKbDocument,
  type KbCategory,
  type KbCategorySection,
  type KbDocument,
} from "../../api";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCategoryFallback(category: string): string {
  return category
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function StatusPill({ doc, stale }: { doc: KbDocument; stale: boolean }) {
  if (doc.status === "failed") {
    return <span className="pill off" title={doc.error ?? undefined}>Failed</span>;
  }
  if (doc.status === "ready") {
    if (stale) {
      return (
        <span
          className="pill off"
          title={`Indexed with ${doc.embed_model}; the embedding model has changed. Re-index to use this document.`}
        >
          Re-index needed
        </span>
      );
    }
    return <span className="pill on">Ready · {doc.chunk_count} chunks</span>;
  }
  return <span className="pill">Processing…</span>;
}

/** Admin panel to upload reference documents the AI dispatcher retrieves from (RAG). */
export function KnowledgeBasePanel() {
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [categorySections, setCategorySections] = useState<KbCategorySection[]>([]);
  const [embedModel, setEmbedModel] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("post_order");
  const [propertyCode, setPropertyCode] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadCategoryRef = useRef<string | null>(null);

  const categoryOptions = useMemo(
    () => categorySections.flatMap((section) => section.categories),
    [categorySections],
  );
  const categoryById = useMemo(() => {
    const map = new Map<string, KbCategory>();
    for (const option of categoryOptions) {
      map.set(option.id, option);
    }
    return map;
  }, [categoryOptions]);
  const knownCategoryIds = useMemo(() => new Set(categoryOptions.map((option) => option.id)), [categoryOptions]);
  const docsByCategory = useMemo(() => {
    const map = new Map<string, KbDocument[]>();
    for (const doc of docs) {
      const rows = map.get(doc.category);
      if (rows) {
        rows.push(doc);
      } else {
        map.set(doc.category, [doc]);
      }
    }
    return map;
  }, [docs]);
  const unknownDocs = useMemo(
    () => docs.filter((doc) => !knownCategoryIds.has(doc.category)),
    [docs, knownCategoryIds],
  );

  async function reload() {
    try {
      const res = await api.listKbDocuments();
      setDocs(res.documents);
      setCategorySections(res.category_sections);
      setEmbedModel(res.embed_model);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  // Poll while any document is still being processed so the status pill settles.
  useEffect(() => {
    if (!docs.some((d) => d.status === "processing")) {
      return;
    }
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [docs]);

  useEffect(() => {
    if (categoryOptions.length > 0 && !categoryOptions.some((option) => option.id === category)) {
      setCategory(categoryOptions[0]!.id);
    }
  }, [category, categoryOptions]);

  function categoryLabel(categoryId: string): string {
    return categoryById.get(categoryId)?.label ?? formatCategoryFallback(categoryId);
  }

  function startUpload(categoryId?: string) {
    if (busy) {
      return;
    }
    const selectedCategory = categoryId ?? categoryOptions.find((option) => option.id === category)?.id;
    if (!selectedCategory) {
      setError("Categories have not loaded yet. Please wait a moment and try again.");
      return;
    }
    uploadCategoryRef.current = selectedCategory;
    setCategory(selectedCategory);
    fileRef.current?.click();
  }

  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const uploadCategory = uploadCategoryRef.current ?? category;
      await uploadKbDocument(file, {
        title: title.trim() || file.name,
        category: uploadCategory,
        propertyCode: propertyCode.trim() || undefined,
      });
      setTitle("");
      setPropertyCode("");
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      uploadCategoryRef.current = null;
      setBusy(false);
    }
  }

  async function onDelete(doc: KbDocument) {
    if (!window.confirm(`Delete “${doc.title}” from the knowledge base?`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteKbDocument(doc.id);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onReindex(doc: KbDocument) {
    setBusy(true);
    setError(null);
    try {
      await api.reindexKbDocument(doc.id);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDownload(doc: KbDocument) {
    const token = getToken();
    try {
      const res = await fetch(`/v1/admin/kb/documents/${doc.id}/file`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        setError(`Could not download “${doc.title}”.`);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError(`Could not download “${doc.title}”.`);
    }
  }

  function renderDocumentTable(rows: KbDocument[], showCategory = false) {
    return (
      <table className="kb-document-table">
        <thead>
          <tr>
            <th>Document</th>
            {showCategory && <th>Category</th>}
            <th>Property</th>
            <th>Size</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((doc) => (
            <tr key={doc.id}>
              <td>
                <strong>{doc.title}</strong>
                {doc.filename && (
                  <div className="tx-sub" style={{ opacity: 0.7 }}>
                    {doc.filename}
                  </div>
                )}
              </td>
              {showCategory && <td>{categoryLabel(doc.category)}</td>}
              <td>{doc.property_code ?? "—"}</td>
              <td>{formatBytes(doc.byte_size)}</td>
              <td>
                <StatusPill
                  doc={doc}
                  stale={!!doc.embed_model && !!embedModel && doc.embed_model !== embedModel}
                />
              </td>
              <td>
                <div className="cell-actions">
                  <button className="btn sm" onClick={() => onDownload(doc)} disabled={busy}>
                    Download
                  </button>
                  <button className="btn sm" onClick={() => onReindex(doc)} disabled={busy}>
                    Re-index
                  </button>
                  <button className="btn sm danger" onClick={() => onDelete(doc)} disabled={busy}>
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const selectedCategory = categoryById.get(category);

  return (
    <div>
      <div className="panel-head">
        <h2>Knowledge Base</h2>
        <span className="count">{docs.length} documents</span>
      </div>
      <p className="panel-desc">
        Upload reference PDFs for the AI dispatcher, organized by radio operations, safety,
        policies, client/site information, radio codes, call types, and laws. Each document is
        indexed into searchable passages, and only the passages relevant to a given radio
        transmission are sent to the AI at dispatch time. Tag a document with a property code to
        favour it when that property is mentioned on the air.
      </p>

      {error && <div className="banner error">{error}</div>}

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf"
        hidden
        disabled={busy}
        onChange={onUpload}
      />

      <div className="card kb-upload-card">
        <h3>Add a PDF</h3>
        <p className="field-hint">
          Choose a category first, then upload the PDF. You can also use the "Upload here" button
          inside any section below to preselect that category.
        </p>
        <div className="form-row">
          <div className="field kb-title-field">
            <label htmlFor="kb-title">Title</label>
            <input
              id="kb-title"
              type="text"
              value={title}
              placeholder="e.g. Oakridge Mall post orders"
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="field kb-category-field">
            <label htmlFor="kb-category">Category</label>
            <select
              id="kb-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={busy || categoryOptions.length === 0}
            >
              {categorySections.map((section) => (
                <optgroup key={section.id} label={section.label}>
                  {section.categories.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="field kb-property-field">
            <label htmlFor="kb-property">Property code (optional)</label>
            <input
              id="kb-property"
              type="text"
              value={propertyCode}
              placeholder="e.g. 1019"
              onChange={(e) => setPropertyCode(e.target.value)}
              disabled={busy}
            />
          </div>
          <button
            type="button"
            className="btn kb-upload-button"
            onClick={() => startUpload()}
            disabled={busy || categoryOptions.length === 0}
          >
            {busy ? "Working…" : "Choose PDF to upload"}
          </button>
        </div>
        {selectedCategory && (
          <p className="field-hint kb-selected-category">
            Selected category: <strong>{selectedCategory.label}</strong> —{" "}
            {selectedCategory.description}
          </p>
        )}
      </div>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : (
        <div className="kb-sections">
          {categorySections.map((section) => {
            const sectionCount = section.categories.reduce(
              (total, option) => total + (docsByCategory.get(option.id)?.length ?? 0),
              0,
            );
            return (
              <section className="card kb-category-section" key={section.id}>
                <div className="kb-section-head">
                  <div>
                    <h3>{section.label}</h3>
                    <p>{section.description}</p>
                  </div>
                  <span className="kb-section-count">{sectionCount} files</span>
                </div>
                <div className="kb-category-grid">
                  {section.categories.map((option) => {
                    const rows = docsByCategory.get(option.id) ?? [];
                    return (
                      <div className="kb-category-card" key={option.id}>
                        <div className="kb-category-head">
                          <div>
                            <h4>{option.label}</h4>
                            <p>{option.description}</p>
                          </div>
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => startUpload(option.id)}
                            disabled={busy}
                          >
                            Upload here
                          </button>
                        </div>
                        {rows.length === 0 ? (
                          <div className="kb-category-empty">No files in this category yet.</div>
                        ) : (
                          renderDocumentTable(rows)
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          {unknownDocs.length > 0 && (
            <section className="card kb-category-section">
              <div className="kb-section-head">
                <div>
                  <h3>Uncategorized or legacy files</h3>
                  <p>Files with category values that are not in the current knowledge base catalog.</p>
                </div>
                <span className="kb-section-count">{unknownDocs.length} files</span>
              </div>
              {renderDocumentTable(unknownDocs, true)}
            </section>
          )}

          {docs.length === 0 && (
            <div className="empty">No documents yet. Use a section's upload button to get started.</div>
          )}
        </div>
      )}
    </div>
  );
}
