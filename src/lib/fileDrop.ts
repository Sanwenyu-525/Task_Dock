//! 系统文件拖入的**唯一订阅者**与所有权仲裁。
//!
//! 背景：`onDragDropEvent` 是 Webview 级事件，同一时刻只能有一个订阅方说得算。
//! 暂存架页与胶囊「文件投递」都想要 OS 文件拖入，若各自订阅，就会出现
//! 「一次拖入被两个面板分别处理」（重复暂存 / 投递到非预期目录）。
//!
//! 这里的规则：
//! - 全应用只建一条 Webview 订阅，按需建立、无人使用时立即释放（不常驻）；
//! - 一次拖入会话在 `enter` 时**只选一个**消费者（`claim()` 为真且优先级最高），
//!   会话期间不换人；`leave` / `drop` 结束会话；
//! - `drop` 只投给**当前会话的认领者**：会话已被 `leave` 结束、或从未接受过
//!   `enter`/`over` 时不投递（fail-closed），不在松手瞬间临时抓一个消费者；
//! - 没有消费者认领时，事件被丢弃——不执行任何文件操作（fail-closed）；
//! - 坐标：Tauri 给的是**物理像素**，这里换算成 CSS 像素再做 DOM 命中，
//!   让 100%/125%/150%/200% DPI 与多显示器共用同一套命中逻辑；
//! - 坐标缺失（系统未给出位置）时传 `null`，由消费者决定拒绝，绝不臆造 `(0,0)`；
//! - 订阅/退订本身失败时写一条去重的 WARN（不含路径），恢复后补一条 recovered；
//!   正常拖拽过程不写持久化日志，失败后下次注册仍会重试。
//!
//! 不使用 HTML5 `dragover` / `drop`：Windows 上从资源管理器拖入的文件不会带
//! `dataTransfer.files` 的可用路径，只有 Tauri 的原生事件才是真实来源。

import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  logFileDropListenerFailure,
  noteFileDropListenerRecovered,
} from "./diagnostics";

/** CSS 像素坐标（相对 webview 视口左上角）。 */
export interface DropPoint {
  x: number;
  y: number;
}

export interface FileDropConsumer {
  /** 稳定标识，仅用于诊断与去重（同一对象重复注册会被忽略） */
  id: string;
  /** 数值越大越优先；同一时刻只可能有一个消费者接管 */
  priority: number;
  /** 是否愿意接管本次拖入；在 enter/over 时调用，必须无副作用 */
  claim: () => boolean;
  onEnter?: () => void;
  /** `point` 为 null 表示系统未给出位置，UI 必须清除高亮而不是猜一个目标 */
  onOver?: (point: DropPoint | null) => void;
  onLeave?: () => void;
  /**
   * 只在被认领时调用。`point` 是**松手瞬间**的坐标（可能为 null），
   * 消费者必须据此重新命中，不能沿用之前的高亮缓存。
   * `paths` 为空也必须回调，让 UI 复位高亮。
   */
  onDrop: (paths: string[], point: DropPoint | null) => void;
}

let consumers: FileDropConsumer[] = [];
let owner: FileDropConsumer | null = null;
let unlisten: (() => void) | null = null;
let subscribing = false;

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

function handle(payload: {
  type: string;
  paths?: string[];
  position?: { x: number; y: number };
}): void {
  // 系统没给位置时保持 null：绝不把缺失坐标当成 (0,0) 去命中。
  const point: DropPoint | null = payload.position ? toCssPoint(payload.position) : null;
  if (payload.type === "enter") {
    owner = pickOwner();
    owner?.onEnter?.();
    return;
  }
  if (payload.type === "over") {
    // enter 时无人认领（例如目录列表刚加载完）允许在 over 阶段补认领一次
    if (!owner) owner = pickOwner();
    owner?.onOver?.(point);
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
}

/**
 * 退订失败只记录诊断（WARN 去重），不让清理路径把异常抛回 UI。
 * 订阅成功后的「立即退订」（消费者在返回前卸载）也走这里，语义一致。
 */
function callUnlisten(un: () => void): void {
  try {
    un();
  } catch (e) {
    logFileDropListenerFailure("unlisten", e);
  }
}

async function ensureListener(): Promise<void> {
  if (unlisten || subscribing) return;
  subscribing = true;
  try {
    const un = await getCurrentWebview().onDragDropEvent((event) => {
      handle(event.payload as unknown as { type: string; paths?: string[]; position?: { x: number; y: number } });
    });
    // 订阅成功：若此前失败过，补一条恢复事件（helper 内部只写一次）。
    noteFileDropListenerRecovered();
    if (consumers.length === 0) {
      // 订阅返回前最后一个消费者已卸载：立刻退订，不留常驻监听
      callUnlisten(un);
    } else {
      unlisten = un;
    }
  } catch (e) {
    // 订阅失败（权限/平台不支持）：保持未监听，下次注册时重试，不抛给 UI。
    // 只记录订阅阶段本身，正常 enter/over/drop 不写持久化日志。
    logFileDropListenerFailure("subscribe", e);
    unlisten = null;
  } finally {
    subscribing = false;
  }
}

function releaseListener(): void {
  const un = unlisten;
  unlisten = null;
  if (un) callUnlisten(un);
}

/**
 * 注册一个拖入消费者，返回注销函数（React effect 清理用）。
 * 重复注册同一对象会被忽略；最后一个注销时立即释放 Webview 订阅。
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
    if (consumers.length === 0) releaseListener();
  };
}

/** 测试用：清空消费者与订阅状态。 */
export function __resetFileDrop(): void {
  consumers = [];
  owner = null;
  releaseListener();
}

/** 测试/诊断用：当前是否有活跃订阅。 */
export function fileDropListening(): boolean {
  return unlisten !== null;
}
