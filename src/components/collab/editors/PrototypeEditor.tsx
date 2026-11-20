//! 交互式原型编辑器。
//!
//! 编辑在内存中进行；保存时把前后差异编译成一次批量 Patch，后端只生成一个版本。
//! 编辑态不执行事件，预览态通过 `PrototypeInteractionSimulator` 模拟交互。

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Download,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Redo2,
  Save,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  collabAiModify,
  collabPrototypePatch,
  collabPrototypeValidate,
  collabVisualAssetImport,
  collabVisualAssetList,
  collabVisualExport,
  collabVisualUpdate,
  type AiProposal,
  type VisualAsset,
  type VisualDocument,
} from "../../../lib/collab";
import { errorMessage } from "../../../lib/errors";
import PrototypeInteractionSimulator from "./PrototypeInteractionSimulator";
import PrototypePageManager from "./PrototypePageManager";
import PrototypePropertiesPanel from "./PrototypePropertiesPanel";
import PrototypeRenderer from "./PrototypeRenderer";
import {
  COMPONENT_PALETTE,
  createComponent,
  diffPrototype,
  duplicateComponent,
  parsePrototype,
  type ProtoComponent,
  type ProtoContent,
} from "./prototype-types";
import "./prototype-editor.css";

export interface PrototypeEditorProps {
  doc: VisualDocument;
  onSaved: (doc: VisualDocument) => void;
  onError?: (message: string) => void;
}

type DragState = {
  mode: "move" | "resize";
  id: string;
  startX: number;
  startY: number;
  base: ProtoContent;
  startW: number;
  startH: number;
  snapshot: ProtoContent;
  moved: boolean;
} | null;

export default function PrototypeEditor({ doc, onSaved, onError }: PrototypeEditorProps) {
  const [content, setContent] = useState<ProtoContent>(() => parsePrototype(doc.sourceContent));
  const contentRef = useRef(content);
  contentRef.current = content;
  const originalRef = useRef<ProtoContent>(parsePrototype(doc.sourceContent));
  const [activeId, setActiveId] = useState(() => content.pages[0]?.id ?? "page-1");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<ProtoContent[]>([]);
  const [future, setFuture] = useState<ProtoContent[]>([]);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [proposal, setProposal] = useState<AiProposal | null>(null);
  const [assets, setAssets] = useState<VisualAsset[]>([]);
  const dragRef = useRef<DragState>(null);

  useEffect(() => {
    const parsed = parsePrototype(doc.sourceContent);
    setContent(parsed);
    contentRef.current = parsed;
    originalRef.current = parsed;
    setActiveId(parsed.pages[0]?.id ?? "page-1");
    setSelectedId(null);
    setHistory([]);
    setFuture([]);
    setDirty(false);
    setError("");
    setIssues([]);
    setProposal(null);
  }, [doc.id, doc.revision, doc.sourceContent]);

  useEffect(() => {
    let cancelled = false;
    collabVisualAssetList(doc.projectId, doc.id)
      .then((list) => {
        if (!cancelled) setAssets(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc.projectId, doc.id]);

  const importAsset = async (): Promise<VisualAsset | null> => {
    setError("");
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        title: "选择图片（png/jpg/jpeg/webp/gif，≤32 MiB）",
      });
      if (typeof path !== "string") return null;
      setBusy(true);
      const asset = await collabVisualAssetImport(doc.projectId, {
        path,
        title: doc.title,
        documentId: doc.id,
      });
      setAssets((list) => [asset, ...list.filter((a) => a.id !== asset.id)]);
      return asset;
    } catch (e) {
      fail(e);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const page = useMemo(
    () => content.pages.find((p) => p.id === activeId) ?? content.pages[0],
    [content.pages, activeId],
  );
  const selected = useMemo(
    () => page?.components.find((c) => c.id === selectedId) ?? null,
    [page, selectedId],
  );
  const proposalPreview = useMemo(() => {
    if (!proposal) return null;
    const after = parsePrototype(proposal.proposedContent);
    const beforeComponents = new Set(
      content.pages.flatMap((p) => p.components.map((c) => `${p.id}/${c.id}`)),
    );
    const afterComponents = new Set(
      after.pages.flatMap((p) => p.components.map((c) => `${p.id}/${c.id}`)),
    );
    return {
      pagesBefore: content.pages.length,
      pagesAfter: after.pages.length,
      added: [...afterComponents].filter((id) => !beforeComponents.has(id)).length,
      removed: [...beforeComponents].filter((id) => !afterComponents.has(id)).length,
      retained: [...afterComponents].filter((id) => beforeComponents.has(id)).length,
    };
  }, [proposal, content]);

  const fail = (e: unknown) => {
    const message = errorMessage(e);
    setError(message);
    onError?.(message);
  };

  const pushHistory = (snapshot: ProtoContent = contentRef.current) => {
    setHistory((h) => [...h.slice(-49), snapshot]);
    setFuture([]);
    setDirty(true);
  };

  const apply = (next: ProtoContent, withHistory = true) => {
    if (withHistory) pushHistory();
    contentRef.current = next;
    setContent(next);
    setDirty(true);
  };

  const updatePage = (pageId: string, mutate: (page: ProtoContent["pages"][number]) => ProtoContent["pages"][number]) => {
    const next = {
      ...contentRef.current,
      pages: contentRef.current.pages.map((p) => (p.id === pageId ? mutate(p) : p)),
    };
    contentRef.current = next;
    setContent(next);
    setDirty(true);
  };

  const updateComponent = (id: string, mutate: (c: ProtoComponent) => ProtoComponent) => {
    if (!page) return;
    updatePage(page.id, (p) => ({
      ...p,
      components: p.components.map((c) => (c.id === id ? mutate(c) : c)),
    }));
  };

  const addComponent = (type: ProtoComponent["type"]) => {
    if (!page) return;
    if (page.components.length >= 200) {
      fail(new Error("单页组件数已达 200 上限"));
      return;
    }
    const y = selected ? Math.min(4900, selected.y + selected.h + 8) : 24 + page.components.length * 8;
    const comp = createComponent(type, page.components, 16, y);
    apply(
      {
        ...contentRef.current,
        pages: contentRef.current.pages.map((p) =>
          p.id === page.id ? { ...p, components: [...p.components, comp] } : p,
        ),
      },
    );
    setSelectedId(comp.id);
  };

  const removeSelected = () => {
    if (!page || !selectedId) return;
    apply({
      ...contentRef.current,
      pages: contentRef.current.pages.map((p) =>
        p.id === page.id
          ? { ...p, components: p.components.filter((c) => c.id !== selectedId) }
          : p,
      ),
    });
    setSelectedId(null);
  };

  const duplicateSelected = () => {
    if (!page || !selected) return;
    const copy = duplicateComponent(selected, page.components);
    apply({
      ...contentRef.current,
      pages: contentRef.current.pages.map((p) =>
        p.id === page.id ? { ...p, components: [...p.components, copy] } : p,
      ),
    });
    setSelectedId(copy.id);
  };

  const moveLayer = (direction: "up" | "down" | "top" | "bottom") => {
    if (!page || !selected) return;
    const comps = [...page.components];
    const index = comps.findIndex((c) => c.id === selected.id);
    if (index < 0) return;
    const [item] = comps.splice(index, 1);
    if (direction === "top") comps.push(item);
    else if (direction === "bottom") comps.unshift(item);
    else if (direction === "up") comps.splice(Math.min(comps.length, index + 1), 0, item);
    else comps.splice(Math.max(0, index - 1), 0, item);
    apply({
      ...contentRef.current,
      pages: contentRef.current.pages.map((p) => (p.id === page.id ? { ...p, components: comps } : p)),
    });
  };

  const addPage = () => {
    const ids = new Set(contentRef.current.pages.map((p) => p.id));
    let n = contentRef.current.pages.length + 1;
    while (ids.has(`page-${n}`)) n += 1;
    const id = `page-${n}`;
    apply({
      ...contentRef.current,
      pages: [
        ...contentRef.current.pages,
        { id, name: `页面 ${n}`, components: [] },
      ],
    });
    setActiveId(id);
    setSelectedId(null);
  };

  const renamePage = (id: string, name: string) => {
    updatePage(id, (p) => ({ ...p, name }));
  };

  const removePage = (id: string) => {
    if (contentRef.current.pages.length <= 1) return;
    const pages = contentRef.current.pages.filter((p) => p.id !== id);
    apply({ ...contentRef.current, pages });
    setActiveId(pages[0]?.id ?? "page-1");
    setSelectedId(null);
  };

  const onOverlayPointerDown = (event: ReactPointerEvent, component: ProtoComponent) => {
    if (preview) return;
    event.stopPropagation();
    setSelectedId(component.id);
    dragRef.current = {
      mode: "move",
      id: component.id,
      startX: event.clientX,
      startY: event.clientY,
      base: contentRef.current,
      startW: component.w,
      startH: component.h,
      snapshot: contentRef.current,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onResizePointerDown = (event: ReactPointerEvent, component: ProtoComponent) => {
    if (preview) return;
    event.stopPropagation();
    setSelectedId(component.id);
    dragRef.current = {
      mode: "resize",
      id: component.id,
      startX: event.clientX,
      startY: event.clientY,
      base: contentRef.current,
      startW: component.w,
      startH: component.h,
      snapshot: contentRef.current,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    const next: ProtoContent = {
      ...drag.base,
      pages: drag.base.pages.map((p) => ({
        ...p,
        components: p.components.map((c) => {
          if (c.id !== drag.id) return c;
          if (drag.mode === "resize") {
            return {
              ...c,
              w: Math.min(2000, Math.max(1, Math.round(drag.startW + dx))),
              h: Math.min(2000, Math.max(1, Math.round(drag.startH + dy))),
            };
          }
          return {
            ...c,
            x: Math.min(5000, Math.max(0, Math.round(c.x + dx))),
            y: Math.min(5000, Math.max(0, Math.round(c.y + dy))),
          };
        }),
      })),
    };
    contentRef.current = next;
    setContent(next);
    setDirty(true);
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.moved) {
      setHistory((h) => [...h.slice(-49), drag.snapshot]);
      setFuture([]);
    }
  };

  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setFuture((f) => [contentRef.current, ...f.slice(0, 49)]);
    setHistory((h) => h.slice(0, -1));
    contentRef.current = previous;
    setContent(previous);
    setDirty(true);
  };

  const redo = () => {
    const next = future[0];
    if (!next) return;
    setHistory((h) => [...h.slice(-49), contentRef.current]);
    setFuture((f) => f.slice(1));
    contentRef.current = next;
    setContent(next);
    setDirty(true);
  };

  const save = async () => {
    const ops = diffPrototype(originalRef.current, contentRef.current);
    if (!ops.length) {
      setError("没有需要保存的修改");
      return;
    }
    if (ops.length > 100) {
      setError(`修改涉及 ${ops.length} 个操作，超过单次 100 个上限；请分批保存`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await collabPrototypePatch(
        doc.id,
        doc.revision,
        ops,
        summary.trim() || `原型编辑（${ops.length} 个操作）`,
      );
      originalRef.current = parsePrototype(next.sourceContent);
      setHistory([]);
      setFuture([]);
      setDirty(false);
      setSummary("");
      onSaved(next);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const validate = async () => {
    setBusy(true);
    setError("");
    try {
      const report = await collabPrototypeValidate(doc.id);
      setIssues(report.issues);
      if (report.ok) setIssues(["交互流校验通过：没有死链或循环。"]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const exportJson = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await collabVisualExport(doc.id, "json");
      const blob = new Blob([result.content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const requestProposal = async () => {
    if (!aiInstruction.trim()) {
      setError("请填写 AI 修改要求");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setProposal(
        await collabAiModify(
          doc.id,
          aiInstruction.trim(),
          selectedId ? [selectedId] : [],
        ),
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const applyProposal = async () => {
    if (!proposal) return;
    setBusy(true);
    setError("");
    try {
      const next = await collabVisualUpdate(
        doc.id,
        doc.revision,
        {
          sourceContent: proposal.proposedContent,
          authoringMode: "ai_assisted",
          aiJobId: proposal.job.id,
        },
        proposal.summary,
      );
      setProposal(null);
      setAiInstruction("");
      setAiOpen(false);
      setDirty(false);
      onSaved(next);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
      event.preventDefault();
      removeSelected();
    }
  };

  if (!page) {
    return <div className="collab-muted">原型没有可用页面。</div>;
  }

  return (
    <div
      className="proto-editor"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <div className="proto-editor-toolbar" role="toolbar" aria-label="原型编辑工具栏">
        <button className="btn icon-btn" aria-label="撤销" data-tip="撤销（Ctrl+Z）" onClick={undo} disabled={!history.length || preview}>
          <Undo2 size={14} />
        </button>
        <button className="btn icon-btn" aria-label="重做" data-tip="重做（Ctrl+Y）" onClick={redo} disabled={!future.length || preview}>
          <Redo2 size={14} />
        </button>
        <span className="graph-toolbar-sep" />
        <button className={`btn ghost small ${preview ? "is-active" : ""}`} onClick={() => setPreview((v) => !v)}>
          {preview ? <Pencil size={14} /> : <Eye size={14} />} {preview ? "继续编辑" : "预览"}
        </button>
        <button className="btn ghost small" onClick={() => void validate()} disabled={busy || preview}>
          <ShieldCheck size={14} /> 校验交互流
        </button>
        <button className="btn ghost small" onClick={() => void exportJson()} disabled={busy}>
          <Download size={14} /> 导出 JSON
        </button>
        <div className="graph-toolbar-spacer" />
        <input
          className="input small graph-summary"
          aria-label="版本说明"
          placeholder="版本说明（可选）"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <button className="btn small" onClick={() => void save()} disabled={busy || preview}>
          {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存{dirty ? " *" : ""}
        </button>
      </div>

      {error ? <div className="collab-inline-error">{error}</div> : null}
      {issues.length ? (
        <div className="proto-issues" role="status">
          {issues.slice(0, 8).map((issue) => (
            <div key={issue}>{issue}</div>
          ))}
        </div>
      ) : null}

      {preview ? (
        <PrototypeInteractionSimulator content={content} />
      ) : (
        <>
          <PrototypePageManager
            pages={content.pages}
            activeId={page.id}
            onSelect={(id) => {
              setActiveId(id);
              setSelectedId(null);
            }}
            onAdd={addPage}
            onRename={renamePage}
            onRemove={removePage}
          />
          <div className="proto-editor-body">
            <aside className="proto-palette" aria-label="组件面板">
              <strong>添加组件</strong>
              {COMPONENT_PALETTE.map((item) => (
                <button
                  key={item.type}
                  className="proto-palette-item"
                  onClick={() => addComponent(item.type)}
                  aria-label={`添加 ${item.label}`}
                >
                  <Plus size={12} />
                  <span>{item.label}</span>
                  <em>{item.hint}</em>
                </button>
              ))}
            </aside>

            <div className="proto-canvas-wrap">
              <div
                className="proto-canvas"
                style={{ width: content.viewport.width, height: content.viewport.height }}
                data-testid="proto-canvas"
                onPointerDown={() => setSelectedId(null)}
              >
                <PrototypeRenderer page={page} />
                {page.components.map((component) => (
                  <div
                    key={component.id}
                    data-testid="proto-overlay"
                    className={`proto-overlay ${selectedId === component.id ? "is-selected" : ""}`}
                    style={{
                      left: component.x,
                      top: component.y,
                      width: component.w,
                      height: component.h,
                    }}
                    onPointerDown={(e) => onOverlayPointerDown(e, component)}
                    role="button"
                    tabIndex={-1}
                    aria-label={`选择组件 ${component.id}`}
                  >
                    {selectedId === component.id ? (
                      <span
                        className="proto-resize-handle"
                        onPointerDown={(e) => onResizePointerDown(e, component)}
                        aria-label="调整组件尺寸"
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <PrototypePropertiesPanel
              component={selected}
              pages={content.pages}
              assets={assets}
              onImportAsset={importAsset}
              onChange={(mutate) => {
                if (selected) updateComponent(selected.id, mutate);
              }}
              onDelete={removeSelected}
              onDuplicate={duplicateSelected}
              onLayer={moveLayer}
            />
          </div>
        </>
      )}

      <div className="proto-editor-foot">
        <button className="btn ghost small" onClick={() => setAiOpen(true)}>
          <Sparkles size={14} /> AI 修改{selectedId ? "选中组件" : "原型"}
        </button>
        <span className="collab-muted">
          {content.pages.length} 页 · {page.components.length} 组件 · 编辑不写库，保存生成一个版本
        </span>
      </div>

      {aiOpen ? (
        <div className="graph-ai-panel" role="dialog" aria-label="AI 修改原型">
          <div className="graph-ai-head">
            <Sparkles size={14} />
            <strong>AI 修改（本地规则生成，非模型）</strong>
            <button className="btn icon-btn" aria-label="关闭 AI 修改" onClick={() => setAiOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <textarea
            className="input"
            rows={2}
            placeholder="例：补充一句验收说明（在选中组件下方新增文本）"
            value={aiInstruction}
            onChange={(e) => setAiInstruction(e.target.value)}
          />
          <div className="collab-form-actions">
            <button className="btn small" onClick={() => void requestProposal()} disabled={busy}>
              生成建议
            </button>
            {proposal ? (
              <button className="btn small" onClick={() => void applyProposal()} disabled={busy}>
                确认应用
              </button>
            ) : null}
          </div>
          {proposal ? (
            <div className="graph-ai-proposal">
              <div>{proposal.summary}</div>
              {proposalPreview ? (
                <div className="graph-ai-preview">
                  <div>
                    页面：{proposalPreview.pagesBefore} → {proposalPreview.pagesAfter}
                  </div>
                  <div>新增组件：{proposalPreview.added}</div>
                  <div>保留组件：{proposalPreview.retained}</div>
                  <div>删除组件：{proposalPreview.removed}</div>
                </div>
              ) : null}
              <div className="collab-muted">基于 revision {proposal.baseRevision}；应用后生成新版本。</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
