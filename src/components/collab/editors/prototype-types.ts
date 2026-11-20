//! 原型编辑器的共享类型、组件模板与「本地内容 → 批量 Patch」编译。
//!
//! 保存时把编辑前后的差异编译成一次批量 Patch，后端只产生一个版本；
//! 任一操作非法时后端整体失败，不会保存一半。

import type { PatchOp } from "../../../lib/collab";

export const COMPONENT_TYPES = [
  "heading",
  "text",
  "button",
  "input",
  "switch",
  "badge",
  "divider",
  "image",
  "frame",
  "tabs",
  "list",
  "chart",
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export interface ProtoEvent {
  action: string;
  target?: string;
  value?: unknown;
}

export interface ProtoComponent {
  id: string;
  type: ComponentType;
  x: number;
  y: number;
  w: number;
  h: number;
  props: Record<string, string | number | boolean>;
  style: Record<string, string>;
  events: Record<string, ProtoEvent>;
}

export interface ProtoPage {
  id: string;
  name: string;
  components: ProtoComponent[];
}

export interface ProtoContent {
  schemaVersion: number;
  viewport: { width: number; height: number };
  pages: ProtoPage[];
  state: Record<string, unknown>;
}

export const COMPONENT_PALETTE: Array<{
  type: ComponentType;
  label: string;
  hint: string;
}> = [
  { type: "heading", label: "Heading", hint: "标题" },
  { type: "text", label: "Text", hint: "正文" },
  { type: "button", label: "Button", hint: "按钮" },
  { type: "input", label: "Input", hint: "输入框" },
  { type: "switch", label: "Switch", hint: "开关" },
  { type: "badge", label: "Badge", hint: "徽标" },
  { type: "divider", label: "Divider", hint: "分割线" },
  { type: "image", label: "Image", hint: "图片" },
  { type: "frame", label: "Frame", hint: "容器/弹窗" },
  { type: "tabs", label: "Tabs", hint: "标签页" },
  { type: "list", label: "List", hint: "列表" },
  { type: "chart", label: "Chart", hint: "图表" },
];

export const EVENT_ACTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "无" },
  { value: "navigate", label: "页面导航" },
  { value: "openModal", label: "打开弹窗" },
  { value: "closeModal", label: "关闭弹窗" },
  { value: "toggle", label: "开关切换" },
  { value: "setValue", label: "写入值" },
];

export const STYLE_KEYS = [
  "bg",
  "fg",
  "radius",
  "fontSize",
  "fontWeight",
  "padding",
  "gap",
  "align",
  "border",
] as const;

export type StyleKey = (typeof STYLE_KEYS)[number];

const DEFAULT_SIZE: Record<ComponentType, { w: number; h: number }> = {
  heading: { w: 300, h: 40 },
  text: { w: 300, h: 60 },
  button: { w: 140, h: 40 },
  input: { w: 300, h: 40 },
  switch: { w: 300, h: 36 },
  badge: { w: 80, h: 24 },
  divider: { w: 300, h: 2 },
  image: { w: 300, h: 160 },
  frame: { w: 300, h: 120 },
  tabs: { w: 300, h: 36 },
  list: { w: 300, h: 120 },
  chart: { w: 300, h: 160 },
};

export function nextComponentId(components: ProtoComponent[]): string {
  const used = new Set(components.map((c) => c.id));
  let n = 1;
  while (used.has(`c${n}`)) n += 1;
  return `c${n}`;
}

export function createComponent(
  type: ComponentType,
  components: ProtoComponent[],
  x = 16,
  y = 24,
): ProtoComponent {
  const size = DEFAULT_SIZE[type];
  const label =
    COMPONENT_PALETTE.find((p) => p.type === type)?.label ?? type;
  const props: Record<string, string | number | boolean> =
    type === "heading" || type === "text"
      ? { text: label }
      : type === "image"
        ? { label: "图片", assetId: "" }
        : type === "input"
          ? { label, placeholder: "请输入" }
          : type === "switch"
            ? { label: "开关" }
            : type === "divider"
              ? {}
              : { label };
  return {
    id: nextComponentId(components),
    type,
    x,
    y,
    w: size.w,
    h: size.h,
    props,
    style: {},
    events: {},
  };
}

export function duplicateComponent(
  component: ProtoComponent,
  components: ProtoComponent[],
): ProtoComponent {
  return {
    ...component,
    id: nextComponentId(components),
    x: Math.min(5000, component.x + 16),
    y: Math.min(5000, component.y + 16),
    props: { ...component.props },
    style: { ...component.style },
    events: JSON.parse(JSON.stringify(component.events)) as Record<string, ProtoEvent>,
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseComponent(raw: unknown, index: number): ProtoComponent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const type = COMPONENT_TYPES.includes(obj.type as ComponentType)
    ? (obj.type as ComponentType)
    : "text";
  const propsObj = (obj.props ?? {}) as Record<string, unknown>;
  const props: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(propsObj)) {
    if (["string", "number", "boolean"].includes(typeof value)) {
      props[key] = value as string | number | boolean;
    }
  }
  const styleObj = (obj.style ?? {}) as Record<string, unknown>;
  const style: Record<string, string> = {};
  for (const key of STYLE_KEYS) {
    const value = styleObj[key];
    if (typeof value === "string") style[key] = value;
  }
  const eventsObj = (obj.events ?? {}) as Record<string, unknown>;
  const events: Record<string, ProtoEvent> = {};
  for (const [key, value] of Object.entries(eventsObj)) {
    if (value && typeof value === "object" && typeof (value as ProtoEvent).action === "string") {
      events[key] = value as ProtoEvent;
    }
  }
  return {
    id: String(obj.id ?? `c${index + 1}`),
    type,
    x: num(obj.x, 16),
    y: num(obj.y, 16 + index * 12),
    w: num(obj.w, DEFAULT_SIZE[type].w),
    h: num(obj.h, DEFAULT_SIZE[type].h),
    props,
    style,
    events,
  };
}

export function parsePrototype(raw: string): ProtoContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyPrototype();
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const rawPages = Array.isArray(obj.pages) ? obj.pages : [];
  const pages: ProtoPage[] = rawPages
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p, i) => ({
      id: String(p.id ?? `page-${i + 1}`),
      name: String(p.name ?? `页面 ${i + 1}`),
      components: (Array.isArray(p.components) ? p.components : [])
        .map((c, ci) => parseComponent(c, ci))
        .filter((c): c is ProtoComponent => !!c),
    }));
  const viewport = (obj.viewport ?? {}) as Record<string, unknown>;
  return {
    schemaVersion: 1,
    viewport: {
      width: num(viewport.width, 400),
      height: num(viewport.height, 640),
    },
    pages: pages.length ? pages : emptyPrototype().pages,
    state:
      obj.state && typeof obj.state === "object"
        ? (obj.state as Record<string, unknown>)
        : {},
  };
}

export function emptyPrototype(): ProtoContent {
  return {
    schemaVersion: 1,
    viewport: { width: 400, height: 640 },
    pages: [{ id: "page-1", name: "首页", components: [] }],
    state: {},
  };
}

export function prototypeTemplate(): ProtoContent {
  return {
    schemaVersion: 1,
    viewport: { width: 400, height: 640 },
    pages: [
      {
        id: "page-1",
        name: "确认",
        components: [
          {
            id: "c1",
            type: "heading",
            x: 16,
            y: 24,
            w: 320,
            h: 40,
            props: { text: "方案确认" },
            style: { fontSize: "20px", fontWeight: "bold" },
            events: {},
          },
          {
            id: "c2",
            type: "text",
            x: 16,
            y: 76,
            w: 320,
            h: 60,
            props: { text: "请确认方案内容后进入开发。" },
            style: { fontSize: "13px" },
            events: {},
          },
          {
            id: "c3",
            type: "switch",
            x: 16,
            y: 156,
            w: 320,
            h: 36,
            props: { label: "同意进入开发" },
            style: {},
            events: {},
          },
          {
            id: "c4",
            type: "button",
            x: 16,
            y: 212,
            w: 140,
            h: 40,
            props: { label: "确认", variant: "primary" },
            style: { bg: "var(--accent)", radius: "8px" },
            events: { onClick: { action: "navigate", target: "page-2" } },
          },
        ],
      },
      {
        id: "page-2",
        name: "完成",
        components: [
          {
            id: "c5",
            type: "heading",
            x: 16,
            y: 24,
            w: 320,
            h: 40,
            props: { text: "已确认" },
            style: { fontSize: "20px", fontWeight: "bold" },
            events: {},
          },
          {
            id: "c6",
            type: "button",
            x: 16,
            y: 88,
            w: 140,
            h: 40,
            props: { label: "返回" },
            style: { radius: "8px" },
            events: { onClick: { action: "navigate", target: "page-1" } },
          },
        ],
      },
    ],
    state: {},
  };
}

function componentPatch(before: ProtoComponent, after: ProtoComponent): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (before.x !== after.x) patch.x = after.x;
  if (before.y !== after.y) patch.y = after.y;
  if (before.w !== after.w) patch.w = after.w;
  if (before.h !== after.h) patch.h = after.h;
  if (JSON.stringify(before.props) !== JSON.stringify(after.props)) patch.props = after.props;
  if (JSON.stringify(before.style) !== JSON.stringify(after.style)) patch.style = after.style;
  if (JSON.stringify(before.events) !== JSON.stringify(after.events)) patch.events = after.events;
  return patch;
}

/**
 * 编辑前后差异 → 一次批量 Patch。
 * 组件新增/删除按页面归属；页面新增携带完整组件；改名用 page_rename。
 */
export function diffPrototype(before: ProtoContent, after: ProtoContent): PatchOp[] {
  const ops: PatchOp[] = [];
  const beforePages = new Map(before.pages.map((p) => [p.id, p]));
  const afterPages = new Map(after.pages.map((p) => [p.id, p]));

  for (const page of after.pages) {
    const old = beforePages.get(page.id);
    if (!old) {
      ops.push({
        op: "page_add",
        page: {
          id: page.id,
          name: page.name,
          components: page.components,
        },
      });
      continue;
    }
    if (old.name !== page.name) {
      ops.push({ op: "page_rename", pageId: page.id, name: page.name });
    }
    const oldComps = new Map(old.components.map((c) => [c.id, c]));
    const newComps = new Map(page.components.map((c) => [c.id, c]));
    for (const comp of old.components) {
      if (!newComps.has(comp.id)) {
        ops.push({ op: "remove", pageId: page.id, componentId: comp.id });
      }
    }
    for (const comp of page.components) {
      const oldComp = oldComps.get(comp.id);
      if (!oldComp) {
        ops.push({
          op: "add",
          pageId: page.id,
          component: comp as unknown as Record<string, unknown>,
        });
        continue;
      }
      const patch = componentPatch(oldComp, comp);
      if (Object.keys(patch).length) {
        ops.push({
          op: "update",
          pageId: page.id,
          componentId: comp.id,
          patch,
        });
      }
    }
  }
  for (const page of before.pages) {
    if (!afterPages.has(page.id)) {
      ops.push({ op: "page_remove", pageId: page.id });
    }
  }
  return ops;
}

/** 本地预览状态机（与服务端 dispatch 语义一致，用于未保存内容预览）。 */
export function dispatchLocalEvent(
  content: ProtoContent,
  state: { currentPage: string; modal: string | null; values: Record<string, unknown> },
  event: ProtoEvent,
): { currentPage: string; modal: string | null; values: Record<string, unknown> } {
  const next = { ...state, values: { ...state.values } };
  const pageIds = new Set(content.pages.map((p) => p.id));
  const componentIds = new Set(
    content.pages.flatMap((p) => p.components.map((c) => c.id)),
  );
  switch (event.action) {
    case "navigate":
      if (event.target && pageIds.has(event.target)) {
        next.currentPage = event.target;
        next.modal = null;
      }
      break;
    case "openModal":
      if (event.target && componentIds.has(event.target)) next.modal = event.target;
      break;
    case "closeModal":
      next.modal = null;
      break;
    case "toggle":
      if (event.target) next.values[event.target] = !next.values[event.target];
      break;
    case "setValue":
      if (event.target) next.values[event.target] = event.value;
      break;
    default:
      break;
  }
  return next;
}
