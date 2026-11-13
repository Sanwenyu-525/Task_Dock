/**
 * 跨应用拖入的**唯一订阅者**与所有权仲裁。
 *
 * 背景：拖入是窗口级事件，同一时刻只能有一个订阅方说得算。暂存架页与胶囊
 * 「投递区」都想要拖入，若各自订阅，就会出现「一次拖入被两个面板分别处理」
 * （重复暂存 / 投递到非预期目录）。
 *
 * 这里的规则：
 * - 全应用只建一条订阅，按需建立、无人使用时立即释放（不常驻）；
 * - 一次拖入会话在 `enter` 时**只选一个**消费者（`claim()` 为真且优先级最高），
 *   会话期间不换人；`leave` / `drop` 结束会话；
 * - `drop` 只投给**当前会话的认领者**：会话已被 `leave` 结束、或从未接受过
 *   `enter`/`over` 时不投递（fail-closed），不在松手瞬间临时抓一个消费者；
 * - 没有消费者认领时，事件被丢弃——不执行任何文件操作（fail-closed）；
 * - 坐标：系统给的是**物理像素**，这里换算成 CSS 像素再做 DOM 命中，
 *   让 100%/125%/150%/200% DPI 与多显示器共用同一套命中逻辑；
 * - 坐标缺失时传 `null`，由消费者决定拒绝，绝不臆造 `(0,0)`；
 * - `enter` 也会带上坐标：Windows OLE 只在**鼠标移动**时发 `over`，
 *   若用户进入窗口后立刻停住、或 `over` 早于目标卡片渲染，只靠 `over`
 *   驱动高亮就会一直停在「无目标」。消费者应在 `enter` 时先命中一次；
 * - 订阅/退订失败写一条去重的 WARN（不含路径），恢复后补一条 recovered；
 *   正常拖拽过程不写持久化日志。
 *
 * ## 两条数据通道（v49）
 *
 * 1. **原生桥**（`taskdock://drag-probe|drag-accepted|drag-payload`）：
 *    后端接管 Windows OLE `IDropTarget`，能拿到网页图片/链接/文本/虚拟文件。
 *    `accepted` 表示松手被受理（此时内容还在后端暂存区读取），`payload`
 *    表示内容已就绪，只带 `operationId` 与有界预览。消费者拿到后**必须**
 *    调用提交命令（暂存/目录）或放弃命令；不调用就是泄漏临时副本。
 * 2. **内置通道**（`tauri://drag-*`）：桥未安装时的降级路径，只有真实本地
 *    路径。行为与改造前完全一致（`onDrop(paths, point)`）。
 *
 * 两条通道共用同一套仲裁状态：谁在 `enter` 认领，谁拿到结果；
 * 同一 `operationId` 只投递一次，迟到的载荷立即释放。
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  logFileDropListenerFailure,
  logEvent,
  noteFileDropListenerRecovered,
} from "./diagnostics";
import type {
  DragAcceptedEvent,
  DragFailure,
  DragPayloadEvent,
  DragPayloadView,
  DragProbe,
} from "./dragPayload";
import { parseProbe, probeFromPaths } from "./dragPayload";
import { dragPayloadDiscard } from "./bridge";

/** CSS 像素坐标（相对 webview 视口左上角）。 */
export interface DropPoint {
  x: number;
  y: number;
}

/** 载荷就绪时交给消费者的元信息。 */
export interface DropPayloadMeta {
  operationId: string;
  failures: DragFailure[];
  skipped: number;
}

export interface FileDropConsumer {
  /** 稳定标识，仅用于诊断与去重（同一对象重复注册会被忽略） */
  id: string;
  /** 数值越大越优先；同一时刻只可能有一个消费者接管 */
  priority: number;
  /** 是否愿意接管本次拖入；在 enter/over 时调用，必须无副作用 */
  claim: () => boolean;
  /**
   * 进入窗口。`point` 是进入瞬间的坐标（null=系统未给出位置）：必须据此
   * 立即命中一次，因为后续 `over` 只在鼠标移动时才有，静止时不会补发。
   */
  onEnter?: (point: DropPoint | null) => void;
  /** `point` 为 null 表示系统未给出位置，UI 必须清除高亮而不是猜一个目标 */
  onOver?: (point: DropPoint | null) => void;
  onLeave?: () => void;
  /**
   * 仅**降级通道**使用：只在被认领时调用。`point` 是松手瞬间的坐标，
   * 消费者必须据此重新命中，不能沿用之前的高亮缓存。
   * `paths` 为空也必须回调，让 UI 复位高亮。
   */
  onDrop: (paths: string[], point: DropPoint | null) => void;
  /**
   * 拖入类型探测（原生桥）。**必须只用于提示，不改变命中逻辑**：
   * 高亮目标仍由坐标命中决定，避免「视觉反馈改变实际落点」。
   */
  onProbe?: (probe: DragProbe | null, point: DropPoint | null) => void;
  /**
   * 松手被受理、内容仍在后端读取。用于把 UI 切到「读取中」，
   * 此时不要开始提交，也还没有 `operationId` 之外的任何信息。
   */
  onAccepted?: (probe: DragProbe, point: DropPoint | null) => void;
  /**
   * 载荷就绪（`kind` 为任意可识别类型，包括本地文件）。
   *
   * 实现方必须在本回调内做出决定：调用 `dragPayloadCommitShelf` /
   * `dragPayloadCommitDirectory` 之一，或者 `dragPayloadDiscard`。
   * 未实现该回调时，仅 `local-files` 会回落到 `onDrop(paths, point)`，
   * 其它类型会被放弃并记一条诊断（绝不假装处理成功）。
   */
  onPayload?: (
    payload: DragPayloadView,
    point: DropPoint | null,
    meta: DropPayloadMeta,
  ) => void;
}

/** 原生桥事件名（与 Rust `dragdrop::EVENT_*` 一致）。 */
const EVENT_PROBE = "taskdock://drag-probe";
const EVENT_ACCEPTED = "taskdock://drag-accepted";
const EVENT_PAYLOAD = "taskdock://drag-payload";

let consumers: FileDropConsumer[] = [];
let owner: FileDropConsumer | null = null;
/** 内置通道的退订句柄（决定 `fileDropListening()` 语义） */
let primaryUn: (() => void) | null = null;
/** 原生桥通道的退订句柄（可能为空：桥未安装/环境不支持） */
let bridgeUns: Array<() => void> = [];
let subscribing = false;

/** 一次松手之后、载荷到达之前挂起的会话。 */
let pending: { operationId: string; consumer: FileDropConsumer; point: DropPoint | null } | null =
  null;

function pickOwner(): FileDropConsumer | null {
  let best: FileDropConsumer | null = null;
  for (const c of consumers) {
    let ok = false;
    try {
      ok = c.claim();
    } catch {
      // claim 抛错按「不认领」处理：拖放不能因为某个面板状态异常而乱投递
      ok = false;
    }
    if (!ok) continue;
    if (!best || c.priority > best.priority) best = c;
  }
  return best;
}

/** 物理像素 → CSS 像素。DPR 异常时退化为 1，宁可命中失败也不投错目录。 */
export function toCssPoint(pos: { x: number; y: number }): DropPoint {
  const dpr = window.devicePixelRatio;
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { x: pos.x / scale, y: pos.y / scale };
}

/**
 * 命中测试：返回覆盖在该点上的投递目标 id。
 * 卡片上的拖入高亮层必须 `pointer-events: none`，否则会挡住命中。
 */
export function dropTargetAt(
  point: DropPoint,
  attribute = "data-drop-target",
): string | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
    return null;
  }
  const el = document.elementFromPoint(point.x, point.y);
  const card = el?.closest?.(`[${attribute}]`) ?? null;
  return card?.getAttribute(attribute) ?? null;
}

function pointOf(pos?: { x: number; y: number }): DropPoint | null {
  // 系统没给位置时保持 null：绝不把缺失坐标当成 (0,0) 去命中。
  return pos ? toCssPoint(pos) : null;
}

/** 内置通道（只有真实本地路径）。 */
function handleLegacy(payload: {
  type: string;
  paths?: string[];
  position?: { x: number; y: number };
}): void {
  const point = pointOf(payload.position);
  // 空数组 ≠ 不支持：内置通道在 `enter`/`over` 阶段经常还没有路径，
  // 这时只能表示「类型未知」，绝不能因此把目录卡片判成不可投递。
  const probe =
    payload.paths && payload.paths.length > 0 ? probeFromPaths(payload.paths) : null;
  if (payload.type === "enter") {
    owner = pickOwner();
    owner?.onEnter?.(point);
    owner?.onProbe?.(probe, point);
    return;
  }
  if (payload.type === "over") {
    // enter 时无人认领（例如目录列表刚加载完）允许在 over 阶段补认领一次
    if (!owner) owner = pickOwner();
    owner?.onOver?.(point);
    owner?.onProbe?.(probe, point);
    return;
  }
  if (payload.type === "drop") {
    // 只投给本次会话已认领的消费者：`leave` 之后不再接受松手，
    // 也不在 drop 时临时仲裁（否则「拖出面板再松手」会被某个面板抢走）。
    const target = owner;
    owner = null;
    target?.onDrop(payload.paths ?? [], point);
    return;
  }
  // leave / 其它：结束会话并让 UI 复位
  const previous = owner;
  owner = null;
  previous?.onLeave?.();
  previous?.onProbe?.(null, null);
}

/** 原生桥的探测事件（`enter` / `over` / `leave`）。 */
function handleBridgeProbe(payload: {
  phase?: string;
  point?: { x: number; y: number };
  probe?: unknown;
}): void {
  const point = pointOf(payload.point);
  const probe = parseProbe(payload.probe);
  if (payload.phase === "enter") {
    owner = pickOwner();
    owner?.onEnter?.(point);
    owner?.onProbe?.(probe, point);
    return;
  }
  if (payload.phase === "over") {
    if (!owner) owner = pickOwner();
    owner?.onOver?.(point);
    owner?.onProbe?.(probe, point);
    return;
  }
  // leave：会话结束
  const previous = owner;
  owner = null;
  previous?.onLeave?.();
  previous?.onProbe?.(null, null);
}

/** 松手被受理：锁定消费者，等载荷就绪。 */
function handleAccepted(payload: DragAcceptedEvent): void {
  const probe = parseProbe(payload.probe);
  if (!probe || typeof payload.operationId !== "string") {
    return;
  }
  const point = pointOf(payload.point);
  const consumer = owner;
  owner = null;
  if (!consumer) {
    // 无人认领却已受理：没有消费者会提交，立刻释放后端暂存副本。
    void discardOperation(payload.operationId, "accepted-without-consumer");
    return;
  }
  pending = { operationId: payload.operationId, consumer, point };
  consumer.onAccepted?.(probe, point);
}

/** 载荷就绪：一次性投递给挂起的消费者。 */
function handlePayload(event: DragPayloadEvent): void {
  if (!event || typeof event.operationId !== "string" || !event.payload) return;
  const current = pending;
  pending = null;
  if (!current || current.operationId !== event.operationId) {
    // 会话已结束（消费者卸载 / 端口重载）：迟到载荷必须释放，不能让临时副本挂着。
    void discardOperation(event.operationId, "stale-payload");
    return;
  }
  const point = event.point ? toCssPoint(event.point) : current.point;
  const meta: DropPayloadMeta = {
    operationId: event.operationId,
    failures: Array.isArray(event.failures) ? event.failures : [],
    skipped: typeof event.skipped === "number" ? event.skipped : 0,
  };

  if (current.consumer.onPayload) {
    current.consumer.onPayload(event.payload, point, meta);
    return;
  }
  // 降级通道：老消费者只认路径，本地文件保持原样交付。
  if (event.payload.kind === "local-files") {
    current.consumer.onDrop(event.payload.paths ?? [], point);
    return;
  }
  // 消费者没实现富通道但拿到了富载荷：明确记一条，然后释放，不假装成功。
  reportUnhandled(event.payload, meta.operationId);
  void discardOperation(meta.operationId, "payload-not-handled");
}

function reportUnhandled(payload: DragPayloadView, operationId: string): void {
  logEvent({
    level: "WARN",
    module: "dragdrop",
    action: "dispatch",
    event: "drag-payload-unhandled",
    status: "failed",
    message: "拖入内容类型没有对应的消费者处理",
    operation_id: operationId,
    metadata: { kind: payload.kind },
  });
}

/** 释放后端暂存副本（失败只记日志：不影响 UI 结论）。 */
export async function discardOperation(
  operationId: string,
  reason: string,
): Promise<void> {
  try {
    await dragPayloadDiscard(operationId);
  } catch {
    // 释放失败说明后端会话已过期或已被消费：只留一条 DEBUG，不打扰用户。
    logEvent({
      level: "DEBUG",
      module: "dragdrop",
      action: "discard",
      event: "drag-payload-discard-failed",
      status: "failed",
      message: `放弃拖入会话失败（${reason}）`,
      operation_id: operationId,
    });
  }
}

/**
 * 退订失败只记录诊断（WARN 去重），不让清理路径把异常抛回 UI。
 */
function callUnlisten(un: () => void): void {
  try {
    un();
  } catch (e) {
    logFileDropListenerFailure("unlisten", e);
  }
}

/**
 * 订阅一个原生桥事件：**可选通道**，环境不支持（旧版本/桥未装/测试环境）
 * 时静默跳过，主通道（本地路径）不受影响。
 */
async function subscribeOptional(
  event: string,
  handler: (payload: unknown) => void,
): Promise<(() => void) | null> {
  try {
    const webview = getCurrentWebview() as unknown as {
      listen?: (
        name: string,
        cb: (e: { payload: unknown }) => void,
      ) => Promise<() => void>;
    };
    if (typeof webview.listen !== "function") return null;
    const un = await webview.listen(event, (e) => handler(e.payload));
    return typeof un === "function" ? un : null;
  } catch {
    // 只影响富内容通道，不写失败诊断（否则每次拖入都会污染诊断中心）。
    return null;
  }
}

async function ensureListener(): Promise<void> {
  if (primaryUn || subscribing) return;
  subscribing = true;
  try {
    const un = await getCurrentWebview().onDragDropEvent((event) => {
      handleLegacy(
        event.payload as unknown as {
          type: string;
          paths?: string[];
          position?: { x: number; y: number };
        },
      );
    });
    // 订阅成功：若此前失败过，补一条恢复事件（helper 内部只写一次）。
    noteFileDropListenerRecovered();
    if (consumers.length === 0) {
      // 订阅返回前最后一个消费者已卸载：立刻退订，不留常驻监听
      callUnlisten(un);
    } else {
      primaryUn = un;
    }
    await ensureBridgeListeners();
  } catch (e) {
    // 订阅失败（权限/平台不支持）：保持未监听，下次注册时重试，不抛给 UI。
    logFileDropListenerFailure("subscribe", e);
    primaryUn = null;
  } finally {
    subscribing = false;
  }
}

/** 富内容通道独立订阅：任何一个失败都不影响其它通道。 */
async function ensureBridgeListeners(): Promise<void> {
  if (bridgeUns.length > 0) return;
  const un1 = await subscribeOptional(EVENT_PROBE, (payload) =>
    handleBridgeProbe(payload as { phase?: string; point?: { x: number; y: number }; probe?: unknown }),
  );
  const un2 = await subscribeOptional(EVENT_ACCEPTED, (payload) =>
    handleAccepted(payload as DragAcceptedEvent),
  );
  const un3 = await subscribeOptional(EVENT_PAYLOAD, (payload) =>
    handlePayload(payload as DragPayloadEvent),
  );
  bridgeUns = [un1, un2, un3].filter((u): u is () => void => typeof u === "function");
}

function releaseListener(): void {
  const un = primaryUn;
  primaryUn = null;
  if (un) callUnlisten(un);
  const bridge = bridgeUns;
  bridgeUns = [];
  for (const u of bridge) callUnlisten(u);
  pending = null;
}

/**
 * 注册一个拖入消费者，返回注销函数（React effect 清理用）。
 * 重复注册同一对象会被忽略；最后一个注销时立即释放订阅。
 *
 * 注销会**同时**释放该消费者名下的挂起会话（若正在等后端载荷），
 * 否则面板卸载后没人提交，临时副本只能等 10 分钟 TTL 才回收。
 */
export function registerFileDropConsumer(consumer: FileDropConsumer): () => void {
  if (!consumers.includes(consumer)) consumers = [...consumers, consumer];
  void ensureListener();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumers = consumers.filter((c) => c !== consumer);
    if (owner === consumer) {
      owner = null;
      consumer.onLeave?.();
    }
    if (pending?.consumer === consumer) {
      const op = pending.operationId;
      pending = null;
      void discardOperation(op, "consumer-unregistered");
    }
    if (consumers.length === 0) releaseListener();
  };
}

/** 测试用：清空消费者与订阅状态。 */
export function __resetFileDrop(): void {
  consumers = [];
  owner = null;
  pending = null;
  releaseListener();
}

/** 测试/诊断用：当前是否有活跃订阅。 */
export function fileDropListening(): boolean {
  return primaryUn !== null || bridgeUns.length > 0;
}

/** 测试/诊断用：富内容通道是否已订阅。 */
export function fileDropBridgeListening(): boolean {
  return bridgeUns.length === 3;
}
