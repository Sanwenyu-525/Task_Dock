//! 知识库子页：知识库 CRUD、文档导入/索引/检索、原文查看与关联。
//!
//! 原文边界在 UI 也要说清楚：引用模式只索引原文件；导入模式由知识库托管副本；
//! 删除文档不删除用户原文件。导入报告按 imported/skipped/duplicate/failed 如实展示。

import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Download,
  FilePlus2,
  FolderPlus,
  Link2,
  Pencil,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  capabilityDocumentCreateText,
  capabilityDocumentDelete,
  capabilityDocumentGet,
  capabilityDocumentImportCapture,
  capabilityDocumentImportFile,
  capabilityDocumentImportFolder,
  capabilityDocumentImportNote,
  capabilityDocumentList,
  capabilityDocumentReindex,
  capabilityKbCreate,
  capabilityKbDelete,
  capabilityKbList,
  capabilityKbRebuild,
  capabilityKbSetFavorite,
  capabilityKbUpdate,
  capabilityKnowledgeLinkAdd,
  capabilityKnowledgeLinkRemove,
  capabilityKnowledgeSearch,
  capabilityKnowledgeStats,
  workspaceProjectList,
  type KnowledgeBase,
  type KnowledgeBaseKind,
  type KnowledgeDocStatus,
  type KnowledgeDocument,
  type KnowledgeDocumentDetail,
  type KnowledgeSearchPage,
  type KnowledgeSourceMode,
  type KnowledgeStats,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useLocale } from "../../hooks/useLocale";
import { AgentOperationHighlight } from "../agents/operations/AgentOperationHighlight";
import {
  ConfirmDialog,
  Dialog,
  EmptyState,
  SearchField,
  Select,
  StatusBadge,
} from "../ui";
import { pickFolder } from "../../lib/filesWorkspace/folderPicker";

type ImportKind = "file" | "folder" | "note" | "capture" | "text";

function statusTone(status: KnowledgeDocStatus): "success" | "warning" | "danger" {
  if (status === "indexed") return "success";
  if (status === "pending") return "warning";
  return "danger";
}

function sourceLabel(t: (key: "cap.doc.source.file" | "cap.doc.source.folder" | "cap.doc.source.note" | "cap.doc.source.capture" | "cap.doc.source.text") => string, kind: string) {
  switch (kind) {
    case "file":
      return t("cap.doc.source.file");
    case "folder":
      return t("cap.doc.source.folder");
    case "note":
      return t("cap.doc.source.note");
    case "capture":
      return t("cap.doc.source.capture");
    default:
      return t("cap.doc.source.text");
  }
}

export default function KnowledgeSection() {
  const { t } = useLocale();
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [docTotal, setDocTotal] = useState(0);
  const [docQuery, setDocQuery] = useState("");
  const [docStatus, setDocStatus] = useState<"" | KnowledgeDocStatus>("");
  const [searchResult, setSearchResult] = useState<KnowledgeSearchPage | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [kbDialog, setKbDialog] = useState<{ mode: "create" | "edit" } | null>(null);
  const [kbName, setKbName] = useState("");
  const [kbDescription, setKbDescription] = useState("");
  const [kbKind, setKbKind] = useState<KnowledgeBaseKind>("personal");
  const [kbProjectId, setKbProjectId] = useState("");
  const [kbWorkspaceId, setKbWorkspaceId] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [importKind, setImportKind] = useState<ImportKind | null>(null);
  const [importPath, setImportPath] = useState("");
  const [importMode, setImportMode] = useState<KnowledgeSourceMode>("reference");
  const [importTitle, setImportTitle] = useState("");
  const [importNoteId, setImportNoteId] = useState("");
  const [importCaptureId, setImportCaptureId] = useState("");
  const [importText, setImportText] = useState("");
  const [deleteKbOpen, setDeleteKbOpen] = useState(false);
  const [deleteDocOpen, setDeleteDocOpen] = useState(false);
  const [linkKind, setLinkKind] = useState<"task" | "project" | "note" | "agent_session" | "workflow" | "file">("task");
  const [linkId, setLinkId] = useState("");
  const [linkLabel, setLinkLabel] = useState("");

  const selectedBase = useMemo(
    () => bases.find((item) => item.id === selectedId) ?? null,
    [bases, selectedId],
  );

  const loadLists = useCallback(async (keepSelection = true) => {
    setLoading(true);
    setError(null);
    try {
      const [nextStats, nextBases] = await Promise.all([
        capabilityKnowledgeStats(),
        capabilityKbList(),
      ]);
      setStats(nextStats);
      setBases(nextBases);
      setSelectedId((previous) => {
        if (keepSelection && previous && nextBases.some((item) => item.id === previous)) {
          return previous;
        }
        return nextBases[0]?.id ?? null;
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDocs = useCallback(
    async (kbId: string, query: string, status: "" | KnowledgeDocStatus) => {
      try {
        const page = await capabilityDocumentList(kbId, {
          query: query.trim() || undefined,
          status: status || undefined,
          limit: 100,
        });
        setDocs(page.documents);
        setDocTotal(page.total);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [],
  );

  useEffect(() => {
    void loadLists(false);
  }, [loadLists]);

  useEffect(() => {
    void workspaceProjectList()
      .then((response) =>
        setProjects(response.projects.map((project) => ({ id: project.id, name: project.name }))),
      )
      .catch(() => {
        // 项目列表只用于绑定选择；失败不影响已有知识库浏览。
      });
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDocs([]);
      setDocTotal(0);
      return;
    }
    setSearchResult(null);
    void loadDocs(selectedId, docQuery, docStatus);
  }, [selectedId, docQuery, docStatus, loadDocs]);

  const selectDoc = useCallback(async (id: string) => {
    try {
      setSelectedDoc(await capabilityDocumentGet(id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  // 全局搜索「知识」结果：一次性定位到对应知识库与文档。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "knowledge") return;
    const docId = pendingLocate.id;
    const kbId = pendingLocate.parentId ?? null;
    consumeLocate();
    if (kbId) setSelectedId(kbId);
    void selectDoc(docId);
  }, [pendingLocate, consumeLocate, selectDoc]);

  async function runSearch() {
    if (!selectedId) return;
    const query = docQuery.trim();
    if (!query) {
      setSearchResult(null);
      await loadDocs(selectedId, "", docStatus);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setSearchResult(
        await capabilityKnowledgeSearch(query, { kbIds: [selectedId], limit: 50 }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function openCreateKb() {
    setKbName("");
    setKbDescription("");
    setKbKind("personal");
    setKbProjectId("");
    setKbWorkspaceId("");
    setKbDialog({ mode: "create" });
  }

  function openEditKb() {
    if (!selectedBase) return;
    setKbName(selectedBase.name);
    setKbDescription(selectedBase.description);
    setKbKind(selectedBase.kind);
    setKbProjectId(selectedBase.projectId ?? "");
    setKbWorkspaceId(selectedBase.workspaceId ?? "");
    setKbDialog({ mode: "edit" });
  }

  function bindingName(base: KnowledgeBase): string | null {
    const id = base.kind === "project" ? base.projectId : base.kind === "workspace" ? base.workspaceId : null;
    if (!id) return null;
    return projects.find((project) => project.id === id)?.name ?? id;
  }

  async function submitKb() {
    if (!kbName.trim()) {
      setError(t("cap.kb.nameRequired"));
      return;
    }
    if (kbKind === "project" && !kbProjectId) {
      setError(t("cap.kb.projectRequired"));
      return;
    }
    if (kbKind === "workspace" && !kbWorkspaceId) {
      setError(t("cap.kb.workspaceRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const binding =
        kbKind === "project"
          ? { projectId: kbProjectId, workspaceId: null }
          : kbKind === "workspace"
            ? { projectId: null, workspaceId: kbWorkspaceId }
            : { projectId: null, workspaceId: null };
      if (kbDialog?.mode === "edit" && selectedBase) {
        await capabilityKbUpdate(selectedBase.id, {
          name: kbName,
          description: kbDescription,
          kind: kbKind,
          ...binding,
        });
        setNotice(t("cap.kb.updated"));
      } else {
        const created = await capabilityKbCreate({
          name: kbName,
          description: kbDescription,
          kind: kbKind,
          ...binding,
        });
        setNotice(t("cap.kb.created"));
        setSelectedId(created.id);
      }
      setKbDialog(null);
      await loadLists(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleFavorite(base: KnowledgeBase) {
    try {
      await capabilityKbSetFavorite(base.id, !base.favorite);
      await loadLists(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function submitImport() {
    if (!selectedId || !importKind) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const report =
        importKind === "file"
          ? await capabilityDocumentImportFile(
              selectedId,
              importPath.trim(),
              importMode,
              importTitle.trim() || undefined,
            )
          : importKind === "folder"
            ? await capabilityDocumentImportFolder(selectedId, importPath.trim(), importMode)
            : importKind === "note"
              ? await capabilityDocumentImportNote(selectedId, importNoteId.trim())
              : importKind === "capture"
                ? await capabilityDocumentImportCapture(selectedId, importCaptureId.trim())
                : await capabilityDocumentCreateText(
                    selectedId,
                    importTitle.trim(),
                    importText,
                  );
      setNotice(
        t("cap.kb.importReport", {
          imported: report.imported,
          skipped: report.skipped,
          duplicates: report.duplicates,
          failed: report.failed,
        }),
      );
      const firstFailure = report.items.find((item) => item.status === "failed");
      if (firstFailure) {
        setError(`${firstFailure.path}：${firstFailure.reason}`);
      }
      setImportKind(null);
      setImportPath("");
      setImportTitle("");
      setImportNoteId("");
      setImportCaptureId("");
      setImportText("");
      await loadLists(true);
      if (selectedId) await loadDocs(selectedId, docQuery, docStatus);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function choosePath(kind: "file" | "folder") {
    if (kind === "file") {
      try {
        const selected = await open({ multiple: false, directory: false, title: t("cap.kb.pickFile") });
        if (typeof selected === "string") setImportPath(selected);
      } catch (e) {
        setError(errorMessage(e));
      }
      return;
    }
    const result = await pickFolder({ title: t("cap.kb.pickFolder") });
    if (result.status === "ok") setImportPath(result.path);
    else if (result.status === "invalid") {
      setError(t("cap.kb.pickFailed", { error: result.message ?? result.reason }));
    }
  }

  async function deleteKb() {
    if (!selectedBase) return;
    setBusy(true);
    try {
      const result = await capabilityKbDelete(selectedBase.id);
      setNotice(
        t("cap.kb.deleteReport", {
          docs: result.deletedDocs,
          copies: result.deletedCopies,
        }),
      );
      setDeleteKbOpen(false);
      setSelectedId(null);
      setSelectedDoc(null);
      await loadLists(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteDoc() {
    if (!selectedDoc) return;
    setBusy(true);
    try {
      const result = await capabilityDocumentDelete(selectedDoc.id);
      setNotice(
        result.deletedCopy ? t("cap.doc.deletedWithCopy") : t("cap.doc.deletedIndexOnly"),
      );
      setDeleteDocOpen(false);
      setSelectedDoc(null);
      await loadLists(true);
      if (selectedId) await loadDocs(selectedId, docQuery, docStatus);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function reindexDoc() {
    if (!selectedDoc) return;
    setBusy(true);
    try {
      await capabilityDocumentReindex(selectedDoc.id);
      await selectDoc(selectedDoc.id);
      setNotice(t("cap.doc.reindexed"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function rebuildKb() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const result = await capabilityKbRebuild(selectedId);
      setNotice(
        t("cap.kb.rebuildReport", {
          indexed: result.indexed,
          failed: result.failed,
        }),
      );
      await loadLists(true);
      await loadDocs(selectedId, docQuery, docStatus);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function addLink() {
    if (!selectedDoc || !linkId.trim()) return;
    setBusy(true);
    try {
      const links = await capabilityKnowledgeLinkAdd(
        selectedDoc.id,
        linkKind,
        linkId.trim(),
        linkLabel.trim(),
      );
      setSelectedDoc({ ...selectedDoc, links });
      setLinkId("");
      setLinkLabel("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeLink(linkIdValue: string) {
    if (!selectedDoc) return;
    setBusy(true);
    try {
      const links = await capabilityKnowledgeLinkRemove(selectedDoc.id, linkIdValue);
      setSelectedDoc({ ...selectedDoc, links });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const shownDocs: KnowledgeDocument[] = docs; // 搜索命中在独立区域渲染

  return (
    <div className="cap-section">
      <div className="cap-stat-row">
        <div className="cap-stat">
          <strong>{stats?.kbCount ?? "—"}</strong>
          {t("cap.kb.stats.kb")}
        </div>
        <div className="cap-stat">
          <strong>{stats?.docCount ?? "—"}</strong>
          {t("cap.kb.stats.docs")}
        </div>
        <div className="cap-stat">
          <strong>{stats?.indexedCount ?? "—"}</strong>
          {t("cap.kb.stats.indexed")}
        </div>
        <div className="cap-stat">
          <strong>{stats?.chunkCount ?? "—"}</strong>
          {t("cap.kb.stats.chunks")}
        </div>
      </div>

      <div className="cap-toolbar">
        <button type="button" className="btn sm primary" onClick={openCreateKb}>
          <FilePlus2 size={13} aria-hidden="true" /> {t("cap.kb.new")}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={loading || busy}
          onClick={() => void loadLists(true)}
        >
          <RefreshCw size={13} aria-hidden="true" /> {t("cap.refresh")}
        </button>
        <span className="cap-toolbar-spacer" />
        {notice ? <span className="cap-muted">{notice}</span> : null}
      </div>

      {error ? (
        <div className="cap-warning" role="alert">
          <X size={13} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" className="btn xs" onClick={() => setError(null)}>
            {t("common.close")}
          </button>
        </div>
      ) : null}

      <div className="cap-split">
        <div className="cap-col">
          <div className="cap-col-head">
            <span>{t("cap.kb.listTitle")}</span>
            <span className="cap-muted">{bases.length}</span>
          </div>
          <div className="cap-list">
            {bases.map((base) => (
              <button
                key={base.id}
                type="button"
                className={`cap-list-item${base.id === selectedId ? " active" : ""}`}
                onClick={() => setSelectedId(base.id)}
              >
                <span className="cap-list-title">
                  <Star
                    size={12}
                    fill={base.favorite ? "currentColor" : "none"}
                    aria-hidden="true"
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleFavorite(base);
                    }}
                  />
                  <span className="cap-ellipsis">{base.name}</span>
                </span>
                <span className="cap-list-meta">
                  {t(`cap.kb.kind.${base.kind}` as "cap.kb.kind.personal")}
                  {bindingName(base) ? ` · ${bindingName(base)}` : ""} ·{" "}
                  {t("cap.kb.docCount", { count: base.docCount })}
                </span>
              </button>
            ))}
          </div>
          {!loading && bases.length === 0 ? (
            <EmptyState
              title={t("cap.kb.empty")}
              hint={t("cap.kb.emptyHint")}
              icon={<FilePlus2 size={18} />}
            />
          ) : null}
        </div>

        <div className="cap-col">
          <div className="cap-col-head">
            <span className="cap-ellipsis">{selectedBase?.name ?? t("cap.kb.select")}</span>
            <span className="cap-muted">{docTotal}</span>
          </div>
          {selectedBase ? (
            <>
              <div className="cap-toolbar">
                <button type="button" className="btn xs" onClick={() => setImportKind("file")}>
                  <Upload size={12} /> {t("cap.kb.importFile")}
                </button>
                <button type="button" className="btn xs" onClick={() => setImportKind("folder")}>
                  <FolderPlus size={12} /> {t("cap.kb.importFolder")}
                </button>
                <button type="button" className="btn xs" onClick={() => setImportKind("note")}>
                  <Download size={12} /> {t("cap.kb.importNote")}
                </button>
                <button type="button" className="btn xs" onClick={() => setImportKind("capture")}>
                  <Download size={12} /> {t("cap.kb.importCapture")}
                </button>
                <button type="button" className="btn xs" onClick={() => setImportKind("text")}>
                  <FilePlus2 size={12} /> {t("cap.kb.addText")}
                </button>
              </div>
              <div className="cap-toolbar">
                <SearchField
                  value={docQuery}
                  onChange={setDocQuery}
                  ariaLabel={t("cap.doc.searchPlaceholder")}
                  placeholder={t("cap.doc.searchPlaceholder")}
                  size="compact"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runSearch();
                    if (event.key === "Escape") {
                      setDocQuery("");
                      setSearchResult(null);
                    }
                  }}
                />
                <button type="button" className="btn xs" disabled={busy} onClick={() => void runSearch()}>
                  <Search size={12} /> {t("cap.search")}
                </button>
                <Select
                  value={docStatus}
                  options={[
                    { value: "", label: t("common.all") },
                    { value: "indexed", label: t("cap.doc.status.indexed") },
                    { value: "pending", label: t("cap.doc.status.pending") },
                    { value: "failed", label: t("cap.doc.status.failed") },
                  ]}
                  onChange={(value) => setDocStatus(value as "" | KnowledgeDocStatus)}
                  ariaLabel={t("cap.doc.statusTitle")}
                  size="sm"
                />
                <span className="cap-toolbar-spacer" />
                <button type="button" className="btn xs" disabled={busy} onClick={() => void rebuildKb()}>
                  <RefreshCw size={12} /> {t("cap.kb.rebuild")}
                </button>
                <button type="button" className="btn xs" onClick={openEditKb}>
                  <Pencil size={12} /> {t("cap.edit")}
                </button>
                <button
                  type="button"
                  className="btn xs"
                  onClick={() => setDeleteKbOpen(true)}
                >
                  <Trash2 size={12} /> {t("cap.delete")}
                </button>
              </div>
              {searchResult ? (
                <div className="cap-hits">
                  <div className="cap-muted">
                    {t("cap.search.summary", {
                      total: searchResult.total,
                      query: searchResult.query,
                    })}
                  </div>
                  {searchResult.hits.map((hit) => (
                    <button
                      key={hit.docId}
                      type="button"
                      className="cap-hit"
                      onClick={() => void selectDoc(hit.docId)}
                    >
                      <span className="cap-list-title">{hit.title}</span>
                      <span className="cap-hit-snippet">{hit.snippet}</span>
                      <span className="cap-muted">
                        {hit.kbName} · {t("cap.search.offset", { offset: hit.chunkOffset })}
                      </span>
                    </button>
                  ))}
                  {searchResult.hits.length === 0 ? (
                    <EmptyState title={t("cap.search.noResults")} />
                  ) : null}
                </div>
              ) : (
                <div className="cap-list">
                  {shownDocs.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      className={`cap-list-item${selectedDoc?.id === doc.id ? " active" : ""}`}
                      onClick={() => void selectDoc(doc.id)}
                    >
                      <span className="cap-list-title">
                        <StatusBadge tone={statusTone(doc.status)} size="sm">
                          {t(`cap.doc.status.${doc.status}` as "cap.doc.status.indexed")}
                        </StatusBadge>
                        <span className="cap-ellipsis">{doc.title}</span>
                        {/* Agent 正在写入该文档时展示来源与状态；布局不变。 */}
                        <AgentOperationHighlight resourceKind="knowledge" resourceId={doc.id} />
                      </span>
                      <span className="cap-list-meta">
                        {sourceLabel(t, doc.sourceKind)} ·{" "}
                        {t(`cap.doc.mode.${doc.sourceMode}` as "cap.doc.mode.reference")} ·{" "}
                        {doc.chunkCount} {t("cap.doc.chunksUnit")}
                      </span>
                      {doc.error ? <span className="cap-muted cap-danger">{doc.error}</span> : null}
                    </button>
                  ))}
                  {docs.length === 0 && !loading ? (
                    <EmptyState
                      title={t("cap.doc.empty")}
                      hint={t("cap.doc.emptyHint")}
                      icon={<Upload size={18} />}
                    />
                  ) : null}
                </div>
              )}
            </>
          ) : (
            <EmptyState title={t("cap.kb.select")} hint={t("cap.kb.selectHint")} />
          )}
        </div>

        <div className="cap-col">
          <div className="cap-col-head">
            <span>{t("cap.doc.detailTitle")}</span>
            {selectedDoc ? (
              <button
                type="button"
                className="icon-btn sm"
                aria-label={t("common.close")}
                onClick={() => setSelectedDoc(null)}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
          {selectedDoc ? (
            <div className="cap-detail">
              <div className="cap-card">
                <div className="cap-card-title">
                  <span className="cap-ellipsis">{selectedDoc.title}</span>
                  <StatusBadge tone={statusTone(selectedDoc.status)} size="sm">
                    {t(`cap.doc.status.${selectedDoc.status}` as "cap.doc.status.indexed")}
                  </StatusBadge>
                </div>
                <dl className="cap-kv">
                  <dt>{t("cap.doc.sourceTitle")}</dt>
                  <dd data-tip={selectedDoc.sourcePath ?? undefined}>
                    {sourceLabel(t, selectedDoc.sourceKind)} ·{" "}
                    {selectedDoc.sourcePath ?? t("cap.doc.inline")}
                  </dd>
                  <dt>{t("cap.doc.modeTitle")}</dt>
                  <dd>{t(`cap.doc.mode.${selectedDoc.sourceMode}` as "cap.doc.mode.reference")}</dd>
                  <dt>{t("cap.kb.binding")}</dt>
                  <dd>
                    {selectedBase
                      ? `${t(`cap.kb.kind.${selectedBase.kind}` as "cap.kb.kind.personal")}${
                          bindingName(selectedBase) ? ` · ${bindingName(selectedBase)}` : ""
                        }`
                      : "—"}
                  </dd>
                  <dt>{t("cap.doc.size")}</dt>
                  <dd>{selectedDoc.sizeBytes} B</dd>
                  <dt>{t("cap.doc.chunks")}</dt>
                  <dd>{selectedDoc.chunkCount}</dd>
                  <dt>{t("cap.doc.indexedAt")}</dt>
                  <dd>{selectedDoc.indexedAt ?? "—"}</dd>
                </dl>
                <div className="cap-inline">
                  <button type="button" className="btn xs" disabled={busy} onClick={() => void reindexDoc()}>
                    <RefreshCw size={12} /> {t("cap.doc.reindex")}
                  </button>
                  <button type="button" className="btn xs" onClick={() => setDeleteDocOpen(true)}>
                    <Trash2 size={12} /> {t("cap.delete")}
                  </button>
                </div>
              </div>
              <div className="cap-card">
                <div className="cap-card-title">{t("cap.doc.content")}</div>
                <pre className="cap-content">{selectedDoc.content || t("cap.doc.noContent")}</pre>
                {selectedDoc.truncated ? (
                  <span className="cap-muted">{t("cap.doc.contentTruncated")}</span>
                ) : null}
              </div>
              <div className="cap-card">
                <div className="cap-card-title">
                  <Link2 size={12} /> {t("cap.doc.links")}
                </div>
                {selectedDoc.links.map((link) => (
                  <div key={link.id} className="cap-inline">
                    <span className="cap-muted">
                      {link.targetKind} · {link.targetId}
                      {link.label ? ` · ${link.label}` : ""}
                    </span>
                    <button
                      type="button"
                      className="icon-btn sm"
                      aria-label={t("cap.doc.removeLink")}
                      onClick={() => void removeLink(link.id)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <div className="cap-form">
                  <label>
                    {t("cap.doc.linkTarget")}
                    <div className="cap-inline">
                      <Select
                        value={linkKind}
                        options={[
                          { value: "task", label: "task" },
                          { value: "project", label: "project" },
                          { value: "note", label: "note" },
                          { value: "agent_session", label: "agent_session" },
                          { value: "workflow", label: "workflow" },
                          { value: "file", label: "file" },
                        ]}
                        onChange={(value) => setLinkKind(value as typeof linkKind)}
                        ariaLabel={t("cap.doc.linkTarget")}
                        size="sm"
                      />
                      <input
                        className="ws-input"
                        value={linkId}
                        onChange={(event) => setLinkId(event.target.value)}
                        placeholder={t("cap.doc.linkId")}
                      />
                    </div>
                  </label>
                  <label>
                    {t("cap.doc.linkLabel")}
                    <input
                      className="ws-input"
                      value={linkLabel}
                      onChange={(event) => setLinkLabel(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy || !linkId.trim()}
                    onClick={() => void addLink()}
                  >
                    <Link2 size={12} /> {t("cap.doc.addLink")}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState title={t("cap.doc.select")} hint={t("cap.doc.selectHint")} />
          )}
        </div>
      </div>

      <Dialog
        open={kbDialog !== null}
        onClose={() => setKbDialog(null)}
        title={kbDialog?.mode === "edit" ? t("cap.kb.editTitle") : t("cap.kb.newTitle")}
        size="sm"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setKbDialog(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void submitKb()}>
              {t("cap.save")}
            </button>
          </>
        }
      >
        <div className="cap-form">
          <label>
            {t("cap.name")}
            <input
              className="ws-input"
              value={kbName}
              autoFocus
              maxLength={80}
              onChange={(event) => setKbName(event.target.value)}
            />
          </label>
          <label>
            {t("cap.description")}
            <textarea
              className="ws-input"
              rows={3}
              maxLength={500}
              value={kbDescription}
              onChange={(event) => setKbDescription(event.target.value)}
            />
          </label>
          <label>
            {t("cap.kb.kindLabel")}
            <Select
              value={kbKind}
              options={[
                { value: "personal", label: t("cap.kb.kind.personal") },
                { value: "project", label: t("cap.kb.kind.project") },
                { value: "workspace", label: t("cap.kb.kind.workspace") },
              ]}
              onChange={(value) => {
                const next = value as KnowledgeBaseKind;
                setKbKind(next);
                // 类型变化时清除不匹配的绑定，避免「project 仍挂着旧 workspace」。
                if (next !== "project") setKbProjectId("");
                if (next !== "workspace") setKbWorkspaceId("");
              }}
              ariaLabel={t("cap.kb.kindLabel")}
              block
            />
          </label>
          {kbKind === "project" ? (
            <label>
              {t("cap.kb.projectLabel")}
              <Select
                value={kbProjectId}
                options={[
                  { value: "", label: t("cap.kb.projectPlaceholder") },
                  ...projects.map((project) => ({ value: project.id, label: project.name })),
                ]}
                onChange={setKbProjectId}
                ariaLabel={t("cap.kb.projectLabel")}
                block
              />
            </label>
          ) : null}
          {kbKind === "workspace" ? (
            <label>
              {t("cap.kb.workspaceLabel")}
              <Select
                value={kbWorkspaceId}
                options={[
                  { value: "", label: t("cap.kb.workspacePlaceholder") },
                  ...projects.map((project) => ({ value: project.id, label: project.name })),
                ]}
                onChange={setKbWorkspaceId}
                ariaLabel={t("cap.kb.workspaceLabel")}
                block
              />
            </label>
          ) : null}
          {kbKind !== "personal" ? (
            <p className="cap-muted">{t("cap.kb.bindingHint")}</p>
          ) : null}
        </div>
      </Dialog>

      <Dialog
        open={importKind !== null}
        onClose={() => setImportKind(null)}
        title={
          importKind === "folder"
            ? t("cap.kb.importFolder")
            : importKind === "note"
              ? t("cap.kb.importNote")
              : importKind === "capture"
                ? t("cap.kb.importCapture")
                : importKind === "text"
                  ? t("cap.kb.addText")
                  : t("cap.kb.importFile")
        }
        size="md"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setImportKind(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void submitImport()}>
              {t("cap.import")}
            </button>
          </>
        }
      >
        <div className="cap-form">
          {importKind === "file" || importKind === "folder" ? (
            <>
              <label>
                {t("cap.kb.importPath")}
                <div className="cap-inline">
                  <input
                    className="ws-input"
                    value={importPath}
                    onChange={(event) => setImportPath(event.target.value)}
                    placeholder={t("cap.kb.importPathHint")}
                  />
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => void choosePath(importKind)}
                  >
                    {t("cap.browse")}
                  </button>
                </div>
              </label>
              <label>
                {t("cap.kb.importMode")}
                <Select
                  value={importMode}
                  options={[
                    { value: "reference", label: t("cap.doc.mode.reference") },
                    { value: "imported", label: t("cap.doc.mode.imported") },
                  ]}
                  onChange={(value) => setImportMode(value as KnowledgeSourceMode)}
                  ariaLabel={t("cap.kb.importMode")}
                  block
                />
              </label>
              <p className="cap-muted">{t("cap.kb.importModeHint")}</p>
              {importKind === "file" ? (
                <label>
                  {t("cap.kb.importTitleOptional")}
                  <input
                    className="ws-input"
                    value={importTitle}
                    maxLength={200}
                    onChange={(event) => setImportTitle(event.target.value)}
                  />
                </label>
              ) : null}
            </>
          ) : null}
          {importKind === "note" ? (
            <label>
              {t("cap.kb.noteId")}
              <input
                className="ws-input"
                value={importNoteId}
                onChange={(event) => setImportNoteId(event.target.value)}
              />
            </label>
          ) : null}
          {importKind === "capture" ? (
            <label>
              {t("cap.kb.captureId")}
              <input
                className="ws-input"
                value={importCaptureId}
                onChange={(event) => setImportCaptureId(event.target.value)}
              />
            </label>
          ) : null}
          {importKind === "text" ? (
            <>
              <label>
                {t("cap.name")}
                <input
                  className="ws-input"
                  value={importTitle}
                  maxLength={200}
                  onChange={(event) => setImportTitle(event.target.value)}
                />
              </label>
              <label>
                {t("cap.kb.textContent")}
                <textarea
                  className="ws-input"
                  rows={8}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                />
              </label>
            </>
          ) : null}
          <p className="cap-muted">{t("cap.kb.noDeleteOriginal")}</p>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteKbOpen}
        title={t("cap.kb.deleteTitle", { name: selectedBase?.name ?? "" })}
        detail={t("cap.kb.deleteDetail")}
        danger
        busy={busy}
        confirmLabel={t("cap.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void deleteKb()}
        onCancel={() => setDeleteKbOpen(false)}
      />

      <ConfirmDialog
        open={deleteDocOpen}
        title={t("cap.doc.deleteTitle", { name: selectedDoc?.title ?? "" })}
        detail={
          selectedDoc?.sourceMode === "imported"
            ? t("cap.doc.deleteImportedDetail")
            : t("cap.doc.deleteReferenceDetail")
        }
        danger
        busy={busy}
        confirmLabel={t("cap.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void deleteDoc()}
        onCancel={() => setDeleteDocOpen(false)}
      />
    </div>
  );
}
