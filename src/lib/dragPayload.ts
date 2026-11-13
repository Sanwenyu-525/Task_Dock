/**
 * 通用跨应用拖入的**前端契约**（与 Rust `dragdrop::payload` 一一对应）。
 *
 * 这里只做三件事：
 * 1. 类型定义与窄化（判别式 `kind`）；
 * 2. 悬停提示与「能否投递到文件夹」的判定（与后端 `can_drop_to_directory` 同源同义）；
 * 3. 事件载荷的防御性解析（后端字段异常时退化为「未识别」，绝不当成可投递）。
 *
 * 不做的事：**不从视图里重建内容**。文本/HTML/图片/虚拟文件的真实内容始终留在
 * 后端暂存区，前端只拿 `operationId` 去提交，避免截断预览被误当成全文。
 */

/** 载荷里单条可投递项目（虚拟文件 / 图片）。 */
export interface DragItemView {
  name: string;
  size: number;
  /** `virtual-file` | `image` */
  itemKind: string;
  mime?: string;
  width?: number;
  height?: number;
}

export interface MixedPart {
  kind: string;
  count: number;
  label: string;
}

/** 与后端 `DragPayloadView` 的判别式联合（`kind` 用 kebab-case）。 */
export type DragPayloadView =
  | { kind: "local-files"; paths: string[]; count: number }
  | { kind: "virtual-files"; items: DragItemView[]; count: number }
  | { kind: "image"; items: DragItemView[]; count: number }
  | { kind: "url"; url: string; isImage: boolean }
  | {
      kind: "html";
      textPreview: string;
      hadImage: boolean;
      imageUrl?: string;
    }
  | { kind: "text"; textPreview: string; chars: number }
  | { kind: "mixed"; parts: MixedPart[] }
  | { kind: "unsupported"; formats: string[]; reason: string; code: string };

/** 拖入过程中的类型探测（enter/over/leave），高频且只带元信息。 */
export interface DragProbe {
  kind: string;
  count: number;
  /** 松手即可暂存（文本/链接也可以） */
  canShelf: boolean;
  /** 能否直接投递到真实文件夹（只有会变成文件的类型为 true） */
  canDirectory: boolean;
  /** 系统实际提供的格式名（只有名字，不含内容） */
  formats: string[];
}

export interface DragFailure {
  code: string;
  scope: string;
  format?: string;
  reason: string;
}

export interface DragAcceptedEvent {
  operationId: string;
  point?: { x: number; y: number };
  probe: DragProbe;
}

export interface DragPayloadEvent {
  operationId: string;
  point?: { x: number; y: number };
  payload: DragPayloadView;
  failures: DragFailure[];
  skipped: number;
}

/** 前端提示用的载荷类别（比 `kind` 更粗，便于人类理解）。 */
export type DragLabel =
  | "files"
  | "virtual"
  | "image"
  | "link"
  | "text"
  | "mixed"
  | "unsupported";

export function labelOf(kind: string): DragLabel {
  switch (kind) {
    case "local-files":
      return "files";
    case "virtual-files":
      return "virtual";
    case "image":
      return "image";
    case "url":
      return "link";
    case "text":
    case "html":
      return "text";
    case "mixed":
      return "mixed";
    default:
      return "unsupported";
  }
}

/**
 * 与后端 `DragPayloadView::can_drop_to_directory` 完全同义：
 * 链接与文本**不会**被隐式写成文件，因此目录卡片必须明确拒绝。
 */
export function canDropToDirectory(view: {
  kind: string;
  parts?: MixedPart[];
}): boolean {
  if (view.kind === "local-files" || view.kind === "virtual-files" || view.kind === "image") {
    return true;
  }
  if (view.kind === "mixed") {
    return (view.parts ?? []).some(
      (p) =>
        p.kind === "local-files" || p.kind === "virtual-files" || p.kind === "image",
    );
  }
  return false;
}

/**
 * 载荷条数：只用于「正在复制/移动 N 项」这类真实计数文案与进度守卫，
 * 不做内容重建（内容始终留在后端暂存区）。
 */
export function payloadCount(view: DragPayloadView): number {
  if (
    view.kind === "local-files" ||
    view.kind === "virtual-files" ||
    view.kind === "image"
  ) {
    return view.count;
  }
  if (view.kind === "mixed") {
    return view.parts.reduce((sum, part) => sum + part.count, 0);
  }
  return 1;
}

/** 从本地路径事件构造一个探测结果（桥未安装时的降级路径）。 */export function probeFromPaths(paths: string[]): DragProbe {
  return {
    kind: paths.length > 0 ? "local-files" : "unsupported",
    count: paths.length,
    canShelf: paths.length > 0,
    canDirectory: paths.length > 0,
    formats: [],
  };
}

/** 后端字段缺失/类型异常时退化为「未识别」，绝不猜成可投递。 */
export function parseProbe(raw: unknown): DragProbe | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== "string") return null;
  const count = typeof o.count === "number" && o.count >= 0 ? o.count : 0;
  const formats = Array.isArray(o.formats)
    ? o.formats.filter((f): f is string => typeof f === "string").slice(0, 8)
    : [];
  return {
    kind: o.kind,
    count,
    canShelf: o.canShelf === true,
    canDirectory: o.canDirectory === true,
    formats,
  };
}

/** 只用于诊断展示：格式名列表，最长 8 项，纯文本。 */
export function formatsLabel(probe: DragProbe | null): string {
  if (!probe || probe.formats.length === 0) return "";
  return probe.formats.join(" · ");
}

/** 目录卡片不可投递时的统一文案（与后端拒绝理由一致，不做成功承诺）。 */
export const DIRECTORY_REJECT_MESSAGE = "此内容不能直接投递到文件夹";
