//! 图表可视化编辑器（flowchart / architecture / dataflow）。
//!
//! 只在内存中编辑，点击「保存」才调用 `collabVisualUpdate` 生成新版本；
//! 拖拽过程不写数据库。AI 修改先取候选内容，用户确认后才落库。

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Download,
  Eye,
  LayoutGrid,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Redo2,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import Select from "../../ui/Select";
import {
  collabAiModify,
  collabVisualExport,
  collabVisualUpdate,
  type AiProposal,
  type VisualDocument,
} from "../../../lib/collab";
import { errorMessage } from "../../../lib/errors";
import GraphPreview from "./GraphPreview";
import {
  DIRECTION_OPTIONS,
  GRAPH_PALETTES,
  NODE_COLORS,
  NODE_H,
  NODE_W,
  autoLayoutGraph,
  graphBounds,
  isGraphKind,
  nextEdgeId,
  nextNodeId,
  parseGraph,
  type GraphContent,
  type GraphNode,
  type LayoutDirection,
} from "./graph-types";
import "./graph-editor.css";

export interface GraphEditorProps {
  doc: VisualDocument;
  onSaved: (doc: VisualDocument) => void;
  onError?: (message: string) => void;
}

type DragState =
  | {
      kind: "node";
      startX: number;
      startY: number;
      base: GraphContent;
      ids: string[];
      snapshot: GraphContent;
      moved: boolean;
    }
  | {
      kind: "pan";
      startX: number;
      startY: number;
      panStart: { x: number; y: number };
      moved: boolean;
    }
  | null;

export default function GraphEditor({ doc, onSaved, onError }: GraphEditorProps) {
  const kind = isGraphKind(doc.kind) ? doc.kind : "flowchart";
  const palette = GRAPH_PALETTES[kind];
  const [graph, setGraph] = useState<GraphContent>(() => parseGraph(doc.sourceContent));
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [history, setHistory] = useState<GraphContent[]>([]);
  const [future, setFuture] = useState<GraphContent[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [proposal, setProposal] = useState<AiProposal | null>(null);
  const dragRef = useRef<DragState>(null);

  useEffect(() => {
    setGraph(parseGraph(doc.sourceContent));
    setHistory([]);
    setFuture([]);
    setSelectedIds([]);
    setSelectedEdgeId(null);
    setDirty(false);
    setProposal(null);
    setError("");
  }, [doc.id, doc.revision, doc.sourceContent]);

  const selectedNode = useMemo(
    () => graph.nodes.find((n) => n.id === selectedIds[0]) ?? null,
    [graph.nodes, selectedIds],
  );
  const selectedEdge = useMemo(
    () => graph.edges.find((e) => e.id === selectedEdgeId) ?? null,
    [graph.edges, selectedEdgeId],
  );
  const proposalPreview = useMemo(() => {
    if (!proposal) return null;
    const after = parseGraph(proposal.proposedContent);
    const beforeIds = new Set(graph.nodes.map((n) => n.id));
    const afterIds = new Set(after.nodes.map((n) => n.id));
    const beforeLabels = new Map(graph.nodes.map((n) => [n.id, n.label]));
    return {
      added: after.nodes.filter((n) => !beforeIds.has(n.id)),
      removed: graph.nodes.filter((n) => !afterIds.has(n.id)),
      changed: after.nodes.filter(
        (n) => beforeLabels.has(n.id) && beforeLabels.get(n.id) !== n.label,
      ),
      newEdges: after.edges.filter((e) => !graph.edges.some((x) => x.id === e.id)),
    };
  }, [proposal, graph]);
  const bounds = useMemo(() => graphBounds(graph.nodes), [graph.nodes]);
  const canvasWidth = Math.max(320, graph.layout.width ?? bounds.width + 120);
  const canvasHeight = Math.max(320, graph.layout.height ?? bounds.height + 120);

  const fail = (e: unknown) => {
    const message = errorMessage(e);
    setError(message);
    onError?.(message);
  };

  const pushHistory = (snapshot: GraphContent = graphRef.current) => {
    setHistory((h) => [...h.slice(-49), snapshot]);
    setFuture([]);
    setDirty(true);
  };

  const apply = (next: GraphContent, withHistory = true) => {
    if (withHistory) pushHistory();
    graphRef.current = next;
    setGraph(next);
    setDirty(true);
  };

  const updateNode = (id: string, mutate: (node: GraphNode) => GraphNode) => {
    const next: GraphContent = {
      ...graphRef.current,
      nodes: graphRef.current.nodes.map((n) => (n.id === id ? mutate(n) : n)),
    };
    graphRef.current = next;
    setGraph(next);
    setDirty(true);
  };

  const addNode = (nodeKind: string, label: string) => {
    const current = graphRef.current;
    if (current.nodes.length >= 200) {
      fail(new Error("节点数已达 200 上限"));
      return;
    }
    const boundsNow = graphBounds(current.nodes);
    const id = nextNodeId(current.nodes);
    const node: GraphNode = {
      id,
      label: current.nodes.some((n) => n.label === label) ? `${label} ${current.nodes.length + 1}` : label,
      kind: nodeKind,
      config: {},
      x: Math.min(4800, Math.max(60, boundsNow.width ? boundsNow.width + 40 : 80)),
      y: 80,
    };
    apply({ ...current, nodes: [...current.nodes, node] });
    setSelectedIds([id]);
    setSelectedEdgeId(null);
  };

  const deleteSelection = () => {
    const current = graphRef.current;
    if (selectedEdgeId) {
      apply({ ...current, edges: current.edges.filter((e) => e.id !== selectedEdgeId) });
      setSelectedEdgeId(null);
      return;
    }
    if (!selectedIds.length) return;
    const ids = new Set(selectedIds);
    apply({
      ...current,
      nodes: current.nodes.filter((n) => !ids.has(n.id)),
      edges: current.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)),
    });
    setSelectedIds([]);
  };

  const connect = (targetId: string) => {
    if (!connectFrom || connectFrom === targetId) {
      setConnectFrom(null);
      return;
    }
    const current = graphRef.current;
    const exists = current.edges.some((e) => e.from === connectFrom && e.to === targetId);
    if (!exists) {
      apply({
        ...current,
        edges: [
          ...current.edges,
          { id: nextEdgeId(current.edges), from: connectFrom, to: targetId, label: "" },
        ],
      });
    }
    setConnectFrom(null);
  };

  const onNodePointerDown = (event: ReactPointerEvent, node: GraphNode) => {
    if (preview) return;
    event.stopPropagation();
    if (connectFrom) {
      connect(node.id);
      return;
    }
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    let ids = selectedIds;
    if (additive) {
      ids = selectedIds.includes(node.id)
        ? selectedIds.filter((id) => id !== node.id)
        : [...selectedIds, node.id];
    } else if (!selectedIds.includes(node.id)) {
      ids = [node.id];
    }
    setSelectedIds(ids);
    setSelectedEdgeId(null);
    dragRef.current = {
      kind: "node",
      startX: event.clientX,
      startY: event.clientY,
      base: graphRef.current,
      ids,
      snapshot: graphRef.current,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onCanvasPointerDown = (event: ReactPointerEvent) => {
    if (preview) return;
    if (event.target === event.currentTarget) {
      setSelectedIds([]);
      setSelectedEdgeId(null);
      setConnectFrom(null);
    }
    dragRef.current = {
      kind: "pan",
      startX: event.clientX,
      startY: event.clientY,
      panStart: pan,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / zoom;
    const dy = (event.clientY - drag.startY) / zoom;
    if (drag.kind === "pan") {
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      setPan({ x: drag.panStart.x + dx, y: drag.panStart.y + dy });
      return;
    }
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    const ids = new Set(drag.ids);
    const next: GraphContent = {
      ...drag.base,
      nodes: drag.base.nodes.map((n) =>
        ids.has(n.id)
          ? {
              ...n,
              x: Math.min(5000, Math.max(0, Math.round(n.x + dx))),
              y: Math.min(5000, Math.max(0, Math.round(n.y + dy))),
            }
          : n,
      ),
    };
    graphRef.current = next;
    setGraph(next);
    setDirty(true);
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "node" && drag.moved) {
      setHistory((h) => [...h.slice(-49), drag.snapshot]);
      setFuture([]);
    }
  };

  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setFuture((f) => [graphRef.current, ...f.slice(0, 49)]);
    setHistory((h) => h.slice(0, -1));
    graphRef.current = previous;
    setGraph(previous);
    setDirty(true);
  };

  const redo = () => {
    const next = future[0];
    if (!next) return;
    setHistory((h) => [...h.slice(-49), graphRef.current]);
    setFuture((f) => f.slice(1));
    graphRef.current = next;
    setGraph(next);
    setDirty(true);
  };

  const applyLayout = () => {
    apply(autoLayoutGraph(graphRef.current));
  };

  const changeDirection = (direction: LayoutDirection) => {
    const current = graphRef.current;
    apply({ ...current, layout: { ...current.layout, direction } });
  };

  const resizeCanvas = (width: number, height: number) => {
    const current = graphRef.current;
    apply({
      ...current,
      layout: {
        ...current.layout,
        width: Math.min(6000, Math.max(320, Math.round(width))),
        height: Math.min(6000, Math.max(320, Math.round(height))),
      },
    });
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await collabVisualUpdate(
        doc.id,
        doc.revision,
        {
          title: doc.title,
          sourceContent: JSON.stringify(graphRef.current),
          sourceFormat: "json",
        },
        summary.trim() || "图表编辑",
      );
      setDirty(false);
      setSummary("");
      onSaved(next);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const exportFile = async (format: "svg" | "json") => {
    setBusy(true);
    setError("");
    try {
      const result = await collabVisualExport(doc.id, format);
      const blob = new Blob([result.content], {
        type: format === "svg" ? "image/svg+xml" : "application/json",
      });
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
      setProposal(await collabAiModify(doc.id, aiInstruction.trim(), selectedIds));
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
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelection();
    }
    if (event.key === "Escape") setConnectFrom(null);
  };

  const layerStyle: CSSProperties = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transformOrigin: "0 0",
    width: canvasWidth,
    height: canvasHeight,
  };

  return (
    <div className="graph-editor" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="graph-editor-toolbar" role="toolbar" aria-label="图表编辑工具栏">
        <button className="btn icon-btn" aria-label="撤销" data-tip="撤销（Ctrl+Z）" onClick={undo} disabled={!history.length || preview}>
          <Undo2 size={14} />
        </button>
        <button className="btn icon-btn" aria-label="重做" data-tip="重做（Ctrl+Y）" onClick={redo} disabled={!future.length || preview}>
          <Redo2 size={14} />
        </button>
        <span className="graph-toolbar-sep" />
        <button
          className={`btn icon-btn ${connectFrom ? "is-active" : ""}`}
          aria-label="创建连接"
          data-tip="选择节点后创建连接"
          onClick={() => setConnectFrom(selectedIds.length === 1 ? selectedIds[0] : null)}
          disabled={preview || selectedIds.length !== 1}
        >
          <Link2 size={14} />
        </button>
        <button className="btn icon-btn" aria-label="删除选中" data-tip="删除选中（Delete）" onClick={deleteSelection} disabled={preview || (!selectedIds.length && !selectedEdgeId)}>
          <Trash2 size={14} />
        </button>
        <button className="btn ghost small" onClick={applyLayout} disabled={preview}>
          <LayoutGrid size={14} /> 自动布局
        </button>
        <span className="graph-toolbar-sep" />
        <button className="btn ghost small" onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.1).toFixed(2))))}>
          缩小
        </button>
        <span className="collab-zoom-label">{Math.round(zoom * 100)}%</span>
        <button className="btn ghost small" onClick={() => setZoom((z) => Math.min(2, Number((z + 0.1).toFixed(2))))}>
          放大
        </button>
        <span className="graph-toolbar-sep" />
        <button className={`btn ghost small ${preview ? "is-active" : ""}`} onClick={() => setPreview((v) => !v)}>
          {preview ? <Pencil size={14} /> : <Eye size={14} />} {preview ? "继续编辑" : "预览"}
        </button>
        <button className="btn ghost small" onClick={() => void exportFile("svg")} disabled={busy}>
          <Download size={14} /> 导出 SVG
        </button>
        <button className="btn ghost small" onClick={() => void exportFile("json")} disabled={busy}>
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
          {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存
          {dirty ? " *" : ""}
        </button>
      </div>

      {error ? <div className="collab-inline-error">{error}</div> : null}
      {connectFrom ? (
        <div className="graph-hint">
          正在从「{graph.nodes.find((n) => n.id === connectFrom)?.label ?? connectFrom}」创建连接：点击目标节点
          <button className="btn ghost small" onClick={() => setConnectFrom(null)}>
            取消
          </button>
        </div>
      ) : null}

      {preview ? (
        <GraphPreview graph={graph} />
      ) : (
        <div className="graph-editor-body">
          <aside className="graph-palette" aria-label="组件面板">
            <strong>添加节点</strong>
            {palette.map((item) => (
              <button
                key={item.kind}
                className="graph-palette-item"
                onClick={() => addNode(item.kind, item.label)}
                aria-label={`添加${item.label}`}
              >
                <Plus size={12} />
                <span>{item.label}</span>
                <em>{item.hint}</em>
              </button>
            ))}
            <div className="graph-palette-meta">
              画布 {canvasWidth}×{canvasHeight}
            </div>
          </aside>

          <div
            className="graph-canvas"
            onPointerDown={onCanvasPointerDown}
            data-testid="graph-canvas"
            aria-label="图表画布"
          >
            <div className="graph-layer" style={layerStyle}>
              <svg className="graph-edges" width={canvasWidth} height={canvasHeight}>
                <defs>
                  <marker id="g-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 z" className="graph-arrow-head" />
                  </marker>
                </defs>
                {graph.edges.map((edge) => {
                  const from = graph.nodes.find((n) => n.id === edge.from);
                  const to = graph.nodes.find((n) => n.id === edge.to);
                  if (!from || !to) return null;
                  const horizontal = graph.layout.direction === "LR";
                  const x1 = horizontal ? from.x + NODE_W : from.x + NODE_W / 2;
                  const y1 = horizontal ? from.y + NODE_H / 2 : from.y + NODE_H;
                  const x2 = horizontal ? to.x : to.x + NODE_W / 2;
                  const y2 = horizontal ? to.y + NODE_H / 2 : to.y;
                  return (
                    <g key={edge.id}>
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        className={`graph-edge ${selectedEdgeId === edge.id ? "is-selected" : ""}`}
                        markerEnd="url(#g-arrow)"
                      />
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        className="graph-edge-hit"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSelectedEdgeId(edge.id);
                          setSelectedIds([]);
                        }}
                      />
                      {edge.label ? (
                        <text x={(x1 + x2) / 2 + 4} y={(y1 + y2) / 2 - 4} className="graph-edge-label">
                          {edge.label}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
              {graph.nodes.map((node) => (
                <div
                  key={node.id}
                  data-testid="graph-node"
                  className={`graph-node kind-${node.kind} ${
                    selectedIds.includes(node.id) ? "is-selected" : ""
                  }`}
                  style={{
                    left: node.x,
                    top: node.y,
                    ...(node.color ? { borderColor: node.color } : {}),
                  }}
                  onPointerDown={(e) => onNodePointerDown(e, node)}
                  role="button"
                  tabIndex={-1}
                  aria-label={`节点 ${node.label}`}
                >
                  <span className="graph-node-title">{node.label}</span>
                  <span className="graph-node-kind">{node.kind}</span>
                </div>
              ))}
            </div>
          </div>

          <aside className="graph-properties" aria-label="属性面板">
            <strong>属性</strong>
            {selectedNode ? (
              <div className="graph-prop-group">
                <label>
                  标题
                  <input
                    className="input"
                    value={selectedNode.label}
                    onFocus={() => pushHistory()}
                    onChange={(e) => updateNode(selectedNode.id, (n) => ({ ...n, label: e.target.value }))}
                  />
                </label>
                <label>
                  类型
                  <Select
                    value={selectedNode.kind}
                    options={palette.map((p) => ({ value: p.kind, label: p.label }))}
                    onChange={(value) => {
                      pushHistory();
                      updateNode(selectedNode.id, (n) => ({ ...n, kind: value }));
                    }}
                    ariaLabel="节点类型"
                    size="sm"
                    block
                  />
                </label>
                <label>
                  描述
                  <textarea
                    className="input"
                    rows={2}
                    value={String(selectedNode.config?.description ?? "")}
                    onFocus={() => pushHistory()}
                    onChange={(e) =>
                      updateNode(selectedNode.id, (n) => ({
                        ...n,
                        config: { ...(n.config ?? {}), description: e.target.value },
                      }))
                    }
                  />
                </label>
                <label>
                  节点配置（JSON）
                  <textarea
                    key={`${selectedNode.id}-config`}
                    className="input small"
                    rows={3}
                    defaultValue={JSON.stringify(selectedNode.config ?? {}, null, 2)}
                    onBlur={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value);
                        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                          throw new Error("must be object");
                        }
                        pushHistory();
                        updateNode(selectedNode.id, (n) => ({
                          ...n,
                          config: parsed as Record<string, unknown>,
                        }));
                        setError("");
                      } catch {
                        setError("节点配置必须是 JSON 对象");
                      }
                    }}
                  />
                </label>
                <div className="graph-color-row" role="group" aria-label="节点颜色">
                  {NODE_COLORS.map((color) => (
                    <button
                      key={color.label}
                      type="button"
                      className={`graph-color-dot ${selectedNode.color === color.value || (!selectedNode.color && !color.value) ? "is-active" : ""}`}
                      style={color.value ? { background: color.value } : undefined}
                      aria-label={`颜色 ${color.label}`}
                      data-tip={color.label}
                      onClick={() => {
                        pushHistory();
                        updateNode(selectedNode.id, (n) => ({ ...n, color: color.value || undefined }));
                      }}
                    />
                  ))}
                </div>
                <div className="graph-two-col">
                  <label>
                    X
                    <input
                      className="input small"
                      type="number"
                      value={selectedNode.x}
                      onFocus={() => pushHistory()}
                      onChange={(e) =>
                        updateNode(selectedNode.id, (n) => ({ ...n, x: Number(e.target.value) || 0 }))
                      }
                    />
                  </label>
                  <label>
                    Y
                    <input
                      className="input small"
                      type="number"
                      value={selectedNode.y}
                      onFocus={() => pushHistory()}
                      onChange={(e) =>
                        updateNode(selectedNode.id, (n) => ({ ...n, y: Number(e.target.value) || 0 }))
                      }
                    />
                  </label>
                </div>
                <button
                  className="btn small"
                  onClick={() => {
                    setSelectedIds([selectedNode.id]);
                    setAiOpen(true);
                  }}
                >
                  <Sparkles size={14} /> AI 修改选中节点
                </button>
              </div>
            ) : selectedEdge ? (
              <div className="graph-prop-group">
                <label>
                  连接文字
                  <input
                    className="input"
                    value={selectedEdge.label ?? ""}
                    onFocus={() => pushHistory()}
                    onChange={(e) =>
                      apply(
                        {
                          ...graphRef.current,
                          edges: graphRef.current.edges.map((edge) =>
                            edge.id === selectedEdge.id ? { ...edge, label: e.target.value } : edge,
                          ),
                        },
                        false,
                      )
                    }
                  />
                </label>
                <button className="btn ghost small" onClick={deleteSelection}>
                  <Trash2 size={14} /> 删除连接
                </button>
              </div>
            ) : (
              <div className="collab-muted">选择一个节点或连线查看属性。</div>
            )}

            <div className="graph-prop-group">
              <strong>布局</strong>
              <label>
                方向
                <Select
                  value={graph.layout.direction}
                  options={DIRECTION_OPTIONS}
                  onChange={(value) => changeDirection(value as LayoutDirection)}
                  ariaLabel="布局方向"
                  size="sm"
                  block
                />
              </label>
              <div className="graph-two-col">
                <label>
                  画布宽
                  <input
                    className="input small"
                    type="number"
                    min={320}
                    max={6000}
                    value={canvasWidth}
                    onFocus={() => pushHistory()}
                    onChange={(e) => resizeCanvas(Number(e.target.value), canvasHeight)}
                  />
                </label>
                <label>
                  画布高
                  <input
                    className="input small"
                    type="number"
                    min={320}
                    max={6000}
                    value={canvasHeight}
                    onFocus={() => pushHistory()}
                    onChange={(e) => resizeCanvas(canvasWidth, Number(e.target.value))}
                  />
                </label>
              </div>
            </div>
          </aside>
        </div>
      )}

      {aiOpen ? (
        <div className="graph-ai-panel" role="dialog" aria-label="AI 修改选中节点">
          <div className="graph-ai-head">
            <Sparkles size={14} />
            <strong>AI 修改（{selectedIds.length} 个选中节点）</strong>
            <button className="btn icon-btn" aria-label="关闭 AI 修改" onClick={() => setAiOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="collab-muted">当前为本地规则生成（非模型）；生成结果需确认后才会保存。</div>
          <textarea
            className="input"
            rows={2}
            placeholder="例：复核 -> 归档（新增节点并连接到选中节点）"
            value={aiInstruction}
            onChange={(e) => setAiInstruction(e.target.value)}
          />
          <div className="collab-form-actions">
            <button className="btn small" onClick={() => void requestProposal()} disabled={busy}>
              {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} 生成建议
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
                  <div>新增节点：{proposalPreview.added.map((n) => n.label).join("、") || "无"}</div>
                  <div>修改节点：{proposalPreview.changed.map((n) => n.label).join("、") || "无"}</div>
                  <div>
                    删除节点：{proposalPreview.removed.map((n) => n.label).join("、") || "无"}
                  </div>
                  <div>新增连线：{proposalPreview.newEdges.length} 条</div>
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
