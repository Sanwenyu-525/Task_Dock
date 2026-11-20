//! 图表编辑器的共享类型与纯函数。
//!
//! 与后端 `visual::normalize_graph` 的字段保持一致：node 保存 x/y/color，
//! layout 保存 direction/width/height。所有函数无副作用，便于组件测试。

export type GraphKind = "flowchart" | "architecture" | "dataflow";
export type LayoutDirection = "TB" | "LR";

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  config?: Record<string, unknown>;
  x: number;
  y: number;
  color?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface GraphLayout {
  direction: LayoutDirection;
  width?: number;
  height?: number;
}

export interface GraphContent {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: GraphLayout;
}

export const NODE_W = 160;
export const NODE_H = 56;

export interface PaletteItem {
  kind: string;
  label: string;
  hint: string;
}

export const GRAPH_PALETTES: Record<GraphKind, PaletteItem[]> = {
  flowchart: [
    { kind: "start", label: "开始", hint: "流程入口" },
    { kind: "process", label: "普通节点", hint: "执行步骤" },
    { kind: "decision", label: "判断节点", hint: "分支条件" },
    { kind: "end", label: "结束", hint: "流程出口" },
    { kind: "note", label: "说明", hint: "补充信息" },
  ],
  architecture: [
    { kind: "module", label: "模块", hint: "业务模块" },
    { kind: "service", label: "服务", hint: "后端/服务" },
    { kind: "store", label: "存储", hint: "数据库/缓存" },
    { kind: "ui", label: "界面", hint: "前端页面" },
    { kind: "external", label: "外部系统", hint: "第三方" },
  ],
  dataflow: [
    { kind: "source", label: "数据源", hint: "输入" },
    { kind: "process", label: "数据处理", hint: "转换" },
    { kind: "store", label: "数据存储", hint: "落库" },
    { kind: "sink", label: "数据出口", hint: "输出" },
  ],
};

export const NODE_COLORS: Array<{ value: string; label: string }> = [
  { value: "", label: "默认" },
  { value: "var(--accent)", label: "强调" },
  { value: "var(--status-success)", label: "成功" },
  { value: "var(--status-warning)", label: "警告" },
  { value: "var(--status-danger)", label: "危险" },
  { value: "var(--text-tertiary)", label: "中性" },
];

export const DIRECTION_OPTIONS: Array<{ value: LayoutDirection; label: string }> = [
  { value: "TB", label: "从上到下" },
  { value: "LR", label: "从左到右" },
];

export function isGraphKind(kind: string): kind is GraphKind {
  return kind === "flowchart" || kind === "architecture" || kind === "dataflow";
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 宽容解析：非法/损坏内容返回空图而不是抛错，避免编辑器白屏。 */
export function parseGraph(raw: string): GraphContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyGraph("flowchart");
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  const nodes: GraphNode[] = rawNodes
    .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
    .map((n, i) => ({
      id: String(n.id ?? `n${i + 1}`),
      label: String(n.label ?? n.id ?? `节点 ${i + 1}`),
      kind: String(n.kind ?? "process"),
      config:
        n.config && typeof n.config === "object"
          ? (n.config as Record<string, unknown>)
          : {},
      x: num(n.x, 60 + (i % 3) * 220),
      y: num(n.y, 80 + Math.floor(i / 3) * 140),
      color: typeof n.color === "string" && n.color ? n.color : undefined,
    }));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];
  const edges: GraphEdge[] = rawEdges
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e, i) => ({
      id: String(e.id ?? `e${i + 1}`),
      from: String(e.from ?? ""),
      to: String(e.to ?? ""),
      label: typeof e.label === "string" ? e.label : "",
    }))
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  const rawLayout = (obj.layout ?? {}) as Record<string, unknown>;
  const direction: LayoutDirection = rawLayout.direction === "LR" ? "LR" : "TB";
  const bounds = graphBounds(nodes);
  return {
    nodes,
    edges,
    layout: {
      direction,
      width: Math.max(320, num(rawLayout.width, Math.max(720, bounds.width + 120))),
      height: Math.max(320, num(rawLayout.height, Math.max(360, bounds.height + 120))),
    },
  };
}

export function graphBounds(nodes: GraphNode[]) {
  let width = 0;
  let height = 0;
  for (const node of nodes) {
    width = Math.max(width, node.x + NODE_W);
    height = Math.max(height, node.y + NODE_H);
  }
  return { width, height };
}

export function nextNodeId(nodes: GraphNode[]): string {
  return nextId("n", new Set(nodes.map((n) => n.id)));
}

export function nextEdgeId(edges: GraphEdge[]): string {
  return nextId("e", new Set(edges.map((e) => e.id)));
}

function nextId(prefix: string, used: Set<string>): string {
  let n = 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function emptyGraph(kind: GraphKind): GraphContent {
  const palette = GRAPH_PALETTES[kind];
  const first = palette[0];
  const last = kind === "flowchart" ? palette[3] : palette[2];
  return {
    nodes: [
      {
        id: "n1",
        label: kind === "flowchart" ? "开始" : first.label,
        kind: first.kind,
        config: {},
        x: 80,
        y: 80,
      },
      {
        id: "n2",
        label: kind === "flowchart" ? "结束" : last.label,
        kind: last.kind,
        config: {},
        x: 80,
        y: 240,
      },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", label: "" }],
    layout: { direction: "TB", width: 720, height: 420 },
  };
}

/** 按依赖层级自动布局；环上的节点回退到其当前层，避免死循环。 */
export function autoLayoutGraph(graph: GraphContent): GraphContent {
  const nodes = graph.nodes;
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, string[]>();
  nodes.forEach((n) => incoming.set(n.id, []));
  graph.edges.forEach((e) => {
    if (ids.has(e.from) && ids.has(e.to)) incoming.get(e.to)?.push(e.from);
  });
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (layers.has(id)) return layers.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length ? Math.max(...parents.map((p) => depth(p) + 1)) : 0;
    visiting.delete(id);
    layers.set(id, value);
    return value;
  };
  nodes.forEach((n) => depth(n.id));

  const byLayer = new Map<number, string[]>();
  nodes.forEach((n) => {
    const layer = layers.get(n.id) ?? 0;
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), n.id]);
  });
  const horizontal = graph.layout.direction === "LR";
  const positions = new Map<string, { x: number; y: number }>();
  for (const [layer, order] of Array.from(byLayer.entries()).sort((a, b) => a[0] - b[0])) {
    order.forEach((id, index) => {
      positions.set(
        id,
        horizontal
          ? { x: 80 + layer * 240, y: 80 + index * 120 }
          : { x: 80 + index * 220, y: 80 + layer * 140 },
      );
    });
  }
  const nextNodes = nodes.map((n) => ({ ...n, ...(positions.get(n.id) ?? {}) }));
  const bounds = graphBounds(nextNodes);
  return {
    ...graph,
    nodes: nextNodes,
    layout: {
      ...graph.layout,
      width: Math.max(720, bounds.width + 120),
      height: Math.max(360, bounds.height + 120),
    },
  };
}

/** 新建模板：返回可直接提交给后端的 sourceContent。 */
export function graphTemplate(kind: GraphKind, template: "blank" | "sample"): GraphContent {
  if (template === "blank") {
    const palette = GRAPH_PALETTES[kind];
    return {
      nodes: [
        {
          id: "n1",
          label: palette[0].label,
          kind: palette[0].kind,
          config: {},
          x: 80,
          y: 80,
        },
      ],
      edges: [],
      layout: { direction: "TB", width: 720, height: 360 },
    };
  }
  if (kind === "architecture") {
    return autoLayoutGraph({
      nodes: [
        { id: "n1", label: "外部 Agent / CLI", kind: "external", config: {}, x: 0, y: 0 },
        { id: "n2", label: "协作服务层", kind: "service", config: {}, x: 0, y: 0 },
        { id: "n3", label: "SQLite", kind: "store", config: {}, x: 0, y: 0 },
        { id: "n4", label: "规划中心 UI", kind: "ui", config: {}, x: 0, y: 0 },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", label: "" },
        { id: "e2", from: "n2", to: "n3", label: "" },
        { id: "e3", from: "n3", to: "n4", label: "" },
      ],
      layout: { direction: "LR" },
    });
  }
  if (kind === "dataflow") {
    return autoLayoutGraph({
      nodes: [
        { id: "n1", label: "数据源", kind: "source", config: {}, x: 0, y: 0 },
        { id: "n2", label: "数据处理", kind: "process", config: {}, x: 0, y: 0 },
        { id: "n3", label: "数据存储", kind: "store", config: {}, x: 0, y: 0 },
        { id: "n4", label: "数据出口", kind: "sink", config: {}, x: 0, y: 0 },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", label: "" },
        { id: "e2", from: "n2", to: "n3", label: "" },
        { id: "e3", from: "n3", to: "n4", label: "" },
      ],
      layout: { direction: "LR" },
    });
  }
  return autoLayoutGraph({
    nodes: [
      { id: "n1", label: "开始", kind: "start", config: {}, x: 0, y: 0 },
      { id: "n2", label: "收集需求", kind: "process", config: {}, x: 0, y: 0 },
      { id: "n3", label: "是否批准", kind: "decision", config: {}, x: 0, y: 0 },
      { id: "n4", label: "开发", kind: "process", config: {}, x: 0, y: 0 },
      { id: "n5", label: "结束", kind: "end", config: {}, x: 0, y: 0 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "" },
      { id: "e2", from: "n2", to: "n3", label: "" },
      { id: "e3", from: "n3", to: "n4", label: "是" },
      { id: "e4", from: "n3", to: "n5", label: "否" },
      { id: "e5", from: "n4", to: "n5", label: "" },
    ],
    layout: { direction: "TB" },
  });
}
