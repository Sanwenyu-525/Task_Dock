//! 协作中心 · 统一可视化查看器。
//!
//! 同一套查看器承载流程图/架构图/数据流图（结构化 graph JSON 的 SVG 渲染）、
//! 交互式原型（组件 DSL + 受控事件）、Bug 标注/静态图（只读元数据）。
//! 所有内容均来自结构化 `sourceContent`，不使用 HTML/JS 执行或 `innerHTML`；
//! 原型点击只通过 `collab_prototype_dispatch` 由后端状态机推进。

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ArrowLeftRight,
  ChevronLeft,
  Download,
  History,
  Loader2,
  Maximize2,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
} from "lucide-react";
import StatusBadge from "../ui/StatusBadge";
import EmptyState from "../ui/EmptyState";
import {
  collabPrototypeDispatch,
  collabPrototypeState,
  collabVisualCompare,
  collabVisualExport,
  collabVisualRestore,
  collabVisualUpdate,
  collabVisualVersions,
  type PrototypeEvent,
  type PrototypeState,
  type VisualDiff,
  type VisualDocument,
  type VisualVersion,
} from "../../lib/collab";
import { errorMessage } from "../../lib/errors";

interface GraphNode {
  id: string;
  label?: string;
  kind?: string;
  x?: number;
  y?: number;
}
interface GraphEdge {
  id?: string;
  from: string;
  to: string;
  label?: string;
}
interface GraphContent {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  layout?: { direction?: string };
}

interface ProtoComponent {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  props?: Record<string, unknown>;
  style?: Record<string, string>;
  events?: Record<string, { action: string; target?: string; value?: unknown }>;
}
interface ProtoPage {
  id: string;
  name: string;
  components: ProtoComponent[];
}
interface ProtoContent {
  viewport?: { width?: number; height?: number };
  pages?: ProtoPage[];
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const KIND_LABEL: Record<string, string> = {
  flowchart: "流程图",
  architecture: "架构图",
  dataflow: "数据流图",
  prototype: "交互式原型",
  bug_annotation: "Bug 标注",
  static_image: "静态图片",
  diff: "版本对比",
};

function toneForStatus(status: string) {
  if (["published", "approved", "verified", "completed"].includes(status)) return "success" as const;
  if (["archived", "closed"].includes(status)) return "neutral" as const;
  if (["draft", "open"].includes(status)) return "info" as const;
  return "warning" as const;
}

function GraphCanvas({ content }: { content: GraphContent }) {
  const [zoom, setZoom] = useState(1);
  const nodes = content.nodes ?? [];
  const edges = content.edges ?? [];

  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; w: number; h: number }>();
    const cols = Math.min(3, Math.max(1, nodes.length));
    nodes.forEach((node, i) => {
      if (typeof node.x === "number" && typeof node.y === "number") {
        map.set(node.id, { x: node.x, y: node.y, w: 160, h: 56 });
      } else {
        const col = i % cols;
        const row = Math.floor(i / cols);
        map.set(node.id, { x: 32 + col * 230, y: 36 + row * 130, w: 176, h: 58 });
      }
    });
    return map;
  }, [nodes]);

  const width = Math.max(720, ...Array.from(positions.values()).map((p) => p.x + p.w + 40));
  const height = Math.max(360, ...Array.from(positions.values()).map((p) => p.y + p.h + 40));

  return (
    <div className="collab-graph-wrap">
      <div className="collab-viewer-toolbar">
        <button className="btn icon-btn" aria-label="缩小" data-tip="缩小" onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}>
          <Minus size={14} />
        </button>
        <span className="collab-zoom-label">{Math.round(zoom * 100)}%</span>
        <button className="btn icon-btn" aria-label="放大" data-tip="放大" onClick={() => setZoom((z) => Math.min(2, z + 0.1))}>
          <Plus size={14} />
        </button>
        <button className="btn icon-btn" aria-label="重置缩放" data-tip="重置缩放" onClick={() => setZoom(1)}>
          <RotateCcw size={14} />
        </button>
      </div>
      <div className="collab-graph-scroll">
        <svg
          className="collab-graph"
          width={width * zoom}
          height={height * zoom}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="结构化图表"
        >
          {edges.map((edge, index) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + from.w / 2;
            const y1 = from.y + from.h;
            const x2 = to.x + to.w / 2;
            const y2 = to.y;
            return (
              <g key={edge.id ?? `${edge.from}-${edge.to}-${index}`}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} className="collab-edge" markerEnd="url(#collab-arrow)" />
                {edge.label ? (
                  <text x={(x1 + x2) / 2 + 6} y={(y1 + y2) / 2} className="collab-edge-label">
                    {edge.label}
                  </text>
                ) : null}
              </g>
            );
          })}
          <defs>
            <marker id="collab-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" className="collab-arrow-head" />
            </marker>
          </defs>
          {nodes.map((node) => {
            const p = positions.get(node.id);
            if (!p) return null;
            return (
              <g key={node.id} transform={`translate(${p.x},${p.y})`}>
                <rect width={p.w} height={p.h} rx="10" className={`collab-node kind-${node.kind ?? "process"}`} />
                <text x={p.w / 2} y={p.h / 2 + 5} textAnchor="middle" className="collab-node-label">
                  {node.label ?? node.id}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function componentStyle(style?: Record<string, string>): CSSProperties {
  const out: CSSProperties = {};
  if (!style) return out;
  if (style.bg) out.background = style.bg;
  if (style.fg) out.color = style.fg;
  if (style.radius) out.borderRadius = style.radius;
  if (style.fontSize) out.fontSize = style.fontSize;
  if (style.fontWeight) out.fontWeight = style.fontWeight;
  if (style.padding) out.padding = style.padding;
  if (style.gap) out.gap = style.gap;
  if (style.border) out.border = style.border;
  if (style.align) {
    if (["left", "center", "right"].includes(style.align)) out.textAlign = style.align as CSSProperties["textAlign"];
    else out.alignItems = style.align;
  }
  return out;
}

function PrototypePanel({ doc }: { doc: VisualDocument }) {
  const content = parseJson<ProtoContent>(doc.sourceContent);
  const [state, setState] = useState<PrototypeState | null>(null);
  const [width, setWidth] = useState<number>(400);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError("");
    collabPrototypeState(doc.id)
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  const pages = content?.pages ?? [];
  const current = pages.find((p) => p.id === state?.currentPage) ?? pages[0];
  const modal = state?.modal ? pages.flatMap((p) => p.components).find((c) => c.id === state.modal) : null;

  const dispatch = async (event: PrototypeEvent) => {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    try {
      setState(await collabPrototypeDispatch(doc.id, state, event));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const clickComponent = (component: ProtoComponent) => {
    const ev = component.events?.onClick;
    if (ev) dispatch({ action: ev.action as PrototypeEvent["action"], target: ev.target, value: ev.value });
  };

  const renderComponent = (component: ProtoComponent) => {
    const props = component.props ?? {};
    const value = state?.values?.[component.id];
    const baseStyle: CSSProperties = {
      position: "absolute",
      left: component.x,
      top: component.y,
      width: component.w,
      height: component.h,
      ...componentStyle(component.style),
    };
    const label = String(props.label ?? props.text ?? component.id);
    switch (component.type) {
      case "heading":
        return (
          <div key={component.id} style={baseStyle} className="proto-heading" onClick={() => clickComponent(component)}>
            {label}
          </div>
        );
      case "text":
        return (
          <div key={component.id} style={baseStyle} className="proto-text" onClick={() => clickComponent(component)}>
            {label}
          </div>
        );
      case "button":
        return (
          <button key={component.id} type="button" style={baseStyle} className="proto-button" onClick={() => clickComponent(component)}>
            {label}
          </button>
        );
      case "input":
        return (
          <input
            key={component.id}
            style={baseStyle}
            className="proto-input"
            aria-label={label}
            placeholder={String(props.placeholder ?? label)}
            value={String(value ?? props.value ?? "")}
            onChange={(e) => dispatch({ action: "setValue", target: component.id, value: e.target.value })}
            onClick={(e) => e.stopPropagation()}
          />
        );
      case "switch": {
        const on = Boolean(value ?? props.value ?? false);
        return (
          <button
            key={component.id}
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            style={baseStyle}
            className={`proto-switch${on ? " is-on" : ""}`}
            onClick={() => dispatch({ action: "toggle", target: component.id })}
          >
            <span className="proto-switch-knob" />
            <span className="proto-switch-label">{label}</span>
          </button>
        );
      }
      case "badge":
        return (
          <span key={component.id} style={baseStyle} className="proto-badge">
            {label}
          </span>
        );
      case "divider":
        return <div key={component.id} style={baseStyle} className="proto-divider" />;
      case "image":
        return (
          <div key={component.id} style={baseStyle} className="proto-image">
            图片：{label}
          </div>
        );
      case "frame":
        return (
          <div key={component.id} style={baseStyle} className="proto-frame" onClick={() => clickComponent(component)}>
            {label}
          </div>
        );
      case "tabs":
        return (
          <div key={component.id} style={baseStyle} className="proto-tabs">
            <span className="proto-tab is-active">{label}</span>
          </div>
        );
      case "list":
        return (
          <div key={component.id} style={baseStyle} className="proto-list" onClick={() => clickComponent(component)}>
            {label}
          </div>
        );
      case "chart":
        return (
          <div key={component.id} style={baseStyle} className="proto-chart" aria-label={label}>
            <span style={{ height: "40%" }} />
            <span style={{ height: "70%" }} />
            <span style={{ height: "55%" }} />
          </div>
        );
      default:
        return (
          <div key={component.id} style={baseStyle} className="proto-text" onClick={() => clickComponent(component)}>
            {label}
          </div>
        );
    }
  };

  if (!content) {
    return <EmptyState title="原型内容损坏" hint="sourceContent 不是合法 JSON，无法预览。" />;
  }

  return (
    <div className="collab-prototype">
      <div className="collab-viewer-toolbar">
        <span className="collab-muted">页面：{current?.name ?? "—"}</span>
        {state ? <StatusBadge tone="info" size="sm">当前 {state.currentPage}</StatusBadge> : null}
        <div className="collab-width-switch" role="group" aria-label="原型预览宽度">
          {[320, 400, 600].map((w) => (
            <button
              key={w}
              type="button"
              className={`seg-btn ${width === w ? "active" : ""}`}
              onClick={() => setWidth(w)}
              aria-pressed={width === w}
            >
              {w}px
            </button>
          ))}
        </div>
        {busy ? <Loader2 size={14} className="spin" aria-label="处理中" /> : null}
      </div>
      {error ? <div className="collab-inline-error">{error}</div> : null}
      <div className="collab-prototype-scroll">
        <div
          className="collab-prototype-canvas"
          style={{ width, height: content.viewport?.height ?? 640 }}
          onClick={() => {
            if (state?.modal) dispatch({ action: "closeModal" });
          }}
        >
          {current?.components.map(renderComponent)}
          {modal ? (
            <div className="proto-modal-backdrop" onClick={(e) => e.stopPropagation()}>
              <div className="proto-modal" role="dialog" aria-modal="true" aria-label="原型弹窗">
                <div className="proto-modal-head">
                  <strong>{String(modal.props?.label ?? modal.id)}</strong>
                  <button className="btn ghost small" onClick={() => dispatch({ action: "closeModal" })}>
                    关闭
                  </button>
                </div>
                <div className="proto-modal-body">该弹窗由组件 {modal.id} 定义。</div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function VisualViewer({ doc, onUpdate }: { doc: VisualDocument; onUpdate?: (doc: VisualDocument) => void }) {
  const [tab, setTab] = useState<"preview" | "versions">("preview");
  const [versions, setVersions] = useState<VisualVersion[]>([]);
  const [diff, setDiff] = useState<VisualDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fromV, setFromV] = useState(1);
  const [toV, setToV] = useState(1);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(doc.title);
  const [editContent, setEditContent] = useState(doc.sourceContent);
  const [changeSummary, setChangeSummary] = useState("");

  const content = parseJson<GraphContent | ProtoContent | Record<string, unknown>>(doc.sourceContent);
  const isPrototype = doc.kind === "prototype";
  const isGraph = ["flowchart", "architecture", "dataflow"].includes(doc.kind);

  useEffect(() => {
    setEditTitle(doc.title);
    setEditContent(doc.sourceContent);
    setEditing(false);
  }, [doc.id, doc.revision]);

  const loadVersions = async () => {
    setBusy(true);
    setError("");
    try {
      const page = await collabVisualVersions(doc.id);
      setVersions(page.items);
      setFromV(Math.max(1, doc.version - 1));
      setToV(doc.version);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openVersions = () => {
    setTab("versions");
    if (!versions.length) void loadVersions();
  };

  const compare = async () => {
    setBusy(true);
    setError("");
    try {
      setDiff(await collabVisualCompare(doc.id, fromV, toV));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (version: number) => {
    setBusy(true);
    setError("");
    try {
      const next = await collabVisualRestore(doc.id, version, doc.revision);
      onUpdate?.(next);
      await loadVersions();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editTitle.trim()) {
      setError("标题不能为空");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await collabVisualUpdate(
        doc.id,
        doc.revision,
        {
          title: editTitle.trim(),
          sourceFormat: doc.sourceFormat,
          sourceContent: editContent,
        },
        changeSummary.trim() || "UI 编辑",
      );
      onUpdate?.(next);
      setEditing(false);
      setTab("versions");
      setDiff(null);
      const page = await collabVisualVersions(next.id);
      setVersions(page.items);
      setFromV(Math.max(1, next.version - 1));
      setToV(next.version);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const exportSvg = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await collabVisualExport(doc.id, isGraph ? "svg" : "json");
      const blob = new Blob([result.content], { type: isGraph ? "image/svg+xml" : "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="collab-visual-viewer">
      <div className="collab-visual-head">
        <div className="collab-visual-title">
          <strong>{doc.title}</strong>
          <StatusBadge tone={toneForStatus(doc.status)} size="sm">
            {KIND_LABEL[doc.kind] ?? doc.kind}
          </StatusBadge>
          <span className="collab-muted">v{doc.version}</span>
        </div>
        <div className="collab-viewer-actions">
          <button className={`btn ghost small ${tab === "preview" ? "is-active" : ""}`} onClick={() => setTab("preview")}>
            预览
          </button>
          <button className={`btn ghost small ${tab === "versions" ? "is-active" : ""}`} onClick={openVersions}>
            <History size={14} /> 版本
          </button>
          <button
            className="btn ghost small"
            onClick={() => {
              setTab("preview");
              if (!editing) {
                setEditTitle(doc.title);
                setEditContent(doc.sourceContent);
                setChangeSummary("");
              }
              setEditing((v) => !v);
            }}
            disabled={busy}
          >
            <Pencil size={14} /> {editing ? "退出编辑" : "编辑"}
          </button>
          <button className="btn ghost small" onClick={exportSvg} disabled={busy}>
            <Download size={14} /> 导出
          </button>
        </div>
      </div>
      {error ? <div className="collab-inline-error">{error}</div> : null}

      {tab === "preview" ? (
        <div className="collab-visual-body">
          {editing ? (
            <div className="collab-visual-edit">
              <label>
                标题
                <input className="input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
              </label>
              <label>
                源码（{doc.sourceFormat}，保存时由后端重新校验并生成新版本）
                <textarea
                  className="input collab-source-editor"
                  rows={14}
                  spellCheck={false}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
              </label>
              <label>
                版本说明
                <input className="input" placeholder="如：补充审批按钮交互" value={changeSummary} onChange={(e) => setChangeSummary(e.target.value)} />
              </label>
              <div className="collab-form-actions">
                <button className="btn small" onClick={() => void saveEdit()} disabled={busy}>
                  保存新版本
                </button>
                <button className="btn ghost small" onClick={() => setEditing(false)} disabled={busy}>
                  取消
                </button>
              </div>
            </div>
          ) : isGraph && content ? (
            <GraphCanvas content={content as GraphContent} />
          ) : isPrototype ? (
            <PrototypePanel doc={doc} />
          ) : doc.kind === "bug_annotation" || doc.kind === "static_image" ? (
            <div className="collab-readonly-artifact">
              <EmptyState
                title={KIND_LABEL[doc.kind] ?? "可视化文档"}
                hint={`结构化内容已保存（${doc.sourceFormat}，${doc.sourceContent.length} 字符）。静态资源预览需在资产协议范围内，当前先展示元数据。`}
                icon={<Maximize2 size={20} />}
              />
            </div>
          ) : (
            <pre className="collab-source-json">{doc.sourceContent}</pre>
          )}
        </div>
      ) : (
        <div className="collab-versions">
          <div className="collab-version-compare">
            <label>
              从
              <input
                type="number"
                min={1}
                max={doc.version}
                value={fromV}
                onChange={(e) => setFromV(Number(e.target.value))}
                className="input small"
              />
            </label>
            <ArrowLeftRight size={14} />
            <label>
              到
              <input
                type="number"
                min={1}
                max={doc.version}
                value={toV}
                onChange={(e) => setToV(Number(e.target.value))}
                className="input small"
              />
            </label>
            <button className="btn small" onClick={compare} disabled={busy}>
              对比
            </button>
          </div>
          {diff ? (
            <div className="collab-diff">
              <div className="collab-muted">{diff.summary}</div>
              {diff.items.map((item, i) => (
                <div key={`${item.path}-${i}`} className="collab-diff-row">
                  <StatusBadge tone={item.change === "added" ? "success" : item.change === "removed" ? "danger" : "warning"} size="sm">
                    {item.change}
                  </StatusBadge>
                  <span className="collab-diff-path">{item.path}</span>
                  <span className="collab-diff-value">{item.before ?? "—"} → {item.after ?? "—"}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="collab-version-list">
            {busy && !versions.length ? <Loader2 size={16} className="spin" /> : null}
            {versions.map((v) => (
              <div key={v.id} className="collab-version-row">
                <span className="collab-version-tag">v{v.version}</span>
                <span className="collab-version-summary">{v.changeSummary || "无说明"}</span>
                <span className="collab-muted">{v.createdAt.slice(0, 19).replace("T", " ")}</span>
                <button className="btn ghost small" onClick={() => restore(v.version)} disabled={busy || v.version === doc.version}>
                  恢复
                </button>
              </div>
            ))}
            {!versions.length && !busy ? <EmptyState title="暂无版本记录" hint="第一次修改后会生成版本快照。" /> : null}
          </div>
          <button className="btn ghost small collab-back" onClick={() => setTab("preview")}>
            <ChevronLeft size={14} /> 返回预览
          </button>
        </div>
      )}
    </div>
  );
}
