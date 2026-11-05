//! 贴边吸附引擎（v0.7 · 分类胶囊）。
//!
//! 判定全部在 `lib/edgeSnap.ts` / `lib/capsuleLayout.ts`（纯函数，单测口径）；
//! 本文件只执行副作用。
//!
//! ## 架构变更（v0.7，相对 v0.6 的离屏滑出模型）
//!
//! 旧模型：隐藏 = 把窗口整体滑出屏幕，再用 Win32 区域裁成 32×120 的窄条。
//! 屏幕里留下的窄条是**窗口最右侧**的一段，所以胶囊的 DOM 定位在停靠边的
//! 对侧；展开时窗口要移回原位、胶囊还要换到另一侧——窗口移动与命中区变化
//! 在时间上无法严格对齐，"鼠标在吸附条与悬浮窗口之间来回跳动"由此而来。
//!
//! 新模型：**停靠期间窗口不移动、不缩放**。窗口贴边齐平、撑到胶囊容器尺寸
//! （400×420 / 400×484），只有 Win32 区域在变：
//! - 折叠：区域 = 轨道（56×300）；
//! - 展开：区域 = 轨道 ∪ 面板（340×440，中间 12px 间隙不连通）。
//! 区域切换是原子操作，轨道在屏幕上的位置与尺寸全程不变，命中区因此稳定。
//!
//! 由此可以删掉一批旧机制（它们只在"窗口滑出屏幕"时才需要）：
//! 离屏位置计算、restore 坐标校验、接缝禁止自动隐藏、隐藏态不可见兜底恢复。
//! 保留的仍然是：时间积分防抖、磁吸滞回、候选边判定、拖拽解除、
//! window_rect 防污染、持久化串行、busy 互斥与尾随补评估。
//!
//! ## 拖离解除的鼠标锚定（v0.7）
//!
//! 用户**拖离**胶囊的解除（`undockByDrag` 与 onMoved 的磁吸区退出路径）会先
//! `setUndockAnchor` 请求原生在拖拽循环内把窗口恢复为模式尺寸并以
//! 「标题栏中心 = 光标」对齐（`magnetic::undock_anchor_rect`）——恢复与重定位
//! 在同一拖拽帧内原子完成，用户无需松手重抓标题栏。请求未被应用（拖拽已结束
//! / 磁力层未安装）时，尺寸恢复确认后按实际窗口尺寸回退定位
//! （`undockAnchorTarget`）。按钮解除 / 打开完整页 / 托盘唤回 / 启动恢复等
//! 非拖拽路径不请求锚定，保持各自原有定位策略。

import { useEffect } from "react";
import { getCurrentWindow, cursorPosition, currentMonitor } from "@tauri-apps/api/window";
import { availableMonitors } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import {
  applyMode,
  applyWindowCapsule,
  cancelUndockAnchor,
  getSnapState,
  getWindowRect,
  notifyUiReady,
  onSnapRecall,
  saveSnapState,
  saveWindowRect,
  setMagneticDock,
  setMagneticDragConfig,
  setUndockAnchor,
  takeUndockAnchorApplied,
  type CapsuleRegionMode,
  type SnapDisplayInfo,
} from "../lib/bridge";
import { createSubscriptionScope } from "../lib/subscriptions";
import { hasAutoHideBlockingOverlay } from "../lib/overlayStack";
import { resolveWindowMode } from "../lib/windowMode";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";
import {
  SNAP_CANDIDATE_ENTER_DIST,
  SNAP_DRAG_SETTLE_MS,
  SNAP_MAGNET_MAX_LEAD,
  SNAP_MAGNET_RANGE,
  SNAP_MAGNET_RELEASE,
  SNAP_POLL_MS,
  canTransition,
  detectCandidateEdge,
  edgeDistance,
  isDockedPhase,
  isFullDockPhase,
  isHiddenPhase,
  isRectMostlyVisible,
  isSnapEdge,
  isTabPhase,
  alongDeviation,
  hasDockIntentAlongTrail,
  measureTitlebarHeight,
  rebaseAlong,
  shouldConfirmDock,
  shouldExpireCandidate,
  shouldHideAfterLeave,
  shouldLeaveMagnetRange,
  shouldSwitchDockEdge,
  shouldUndockByDrag,
  snapMoveGuard,
  undockAnchorTarget,
  type DockForm,
  type SnapArea,
  type SnapEdge,
  type SnapPhase,
  type SnapPoint,
  type SnapRect,
} from "../lib/edgeSnap";
import {
  CAPSULE_GAP_CSS,
  PANEL_EXIT_MS,
  TAB_TRANSITION_MS,
  alongCenterOf,
  capsuleContainerSize,
  capsuleRegionsPhysical,
  capsuleWindowRect,
  clampTabCenter,
  isCapsuleContainerSize,
  needsContainerResize,
  pointInCapsule,
  toPhysical,
} from "../lib/capsuleLayout";

// ── Tauri 类型结构化别名 ────────────────────────────────────

interface MonitorLike {
  name?: string | null;
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea: { position: { x: number; y: number }; size: { width: number; height: number } };
  scaleFactor?: number;
}

const toArea = (m: MonitorLike): SnapArea => ({
  x: m.position.x,
  y: m.position.y,
  w: m.size.width,
  h: m.size.height,
});

const toWorkArea = (m: MonitorLike): SnapArea => ({
  x: m.workArea.position.x,
  y: m.workArea.position.y,
  w: m.workArea.size.width,
  h: m.workArea.size.height,
});

/** 可见区域命中判定的外扩容差（CSS px）：等于轨道与面板的间隙，跨间隙不算离开。 */
const CAPSULE_HIT_SLOP = CAPSULE_GAP_CSS;

/** 单次区域 IPC 上限：后端 `apply_on_main_thread` 自身有 2s 超时，这里再兜一层，
 *  防止调用链在异常环境下永久挂起把 `busy` 卡死。 */
const REGION_IPC_TIMEOUT_MS = 3000;
/** 原生区域与 UI 失准后的有界恢复：最多 3 次，间隔指数退避（300/600/1200ms）。 */
const REGION_RECOVERY_MAX_ATTEMPTS = 3;
const REGION_RECOVERY_BASE_MS = 300;
/** 解除失败后的自动重试间隔：拖离/跨边路径不得逐 tick 重发 off（IPC 风暴）。 */
const UNDOCK_RETRY_MS = 500;
/** 停靠失败后的候选重试间隔：setSize/setPosition/区域写入不得逐拍重发。 */
const DOCK_RETRY_MS = 500;
/** 重启恢复的有界重试次数：首拍可能在窗口尚未显示时读不到 currentMonitor。 */
const RESTORE_MAX_ATTEMPTS = 6;
/** 解除后模式尺寸恢复的最大尝试次数（回读验证失败才重试）。 */
const MODE_RESTORE_MAX_ATTEMPTS = 4;

/** 停靠显示器记忆：停靠相位的几何唯一事实来源（修复 currentMonitor 错配）。 */
interface DockedMonitor {
  workArea: SnapArea;
  bounds: SnapArea;
  scaleFactor: number;
  /** 显示器可读名称（Windows 序号不稳定，仅作恢复线索之一）。 */
  name: string | null;
}

function memorizeMonitor(m: MonitorLike): DockedMonitor {
  return {
    workArea: toWorkArea(m),
    bounds: toArea(m),
    scaleFactor: typeof m.scaleFactor === "number" && m.scaleFactor > 0 ? m.scaleFactor : 1,
    name: typeof m.name === "string" && m.name.length > 0 ? m.name : null,
  };
}

/** 显示器几何是否发生真实变化（分辨率 / 任务栏 / DPI / 位置）。 */
function monitorGeometryChanged(a: DockedMonitor, m: MonitorLike): boolean {
  const wa = toWorkArea(m);
  const b = toArea(m);
  const scale = typeof m.scaleFactor === "number" && m.scaleFactor > 0 ? m.scaleFactor : 1;
  return (
    wa.x !== a.workArea.x ||
    wa.y !== a.workArea.y ||
    wa.w !== a.workArea.w ||
    wa.h !== a.workArea.h ||
    b.x !== a.bounds.x ||
    b.y !== a.bounds.y ||
    b.w !== a.bounds.w ||
    b.h !== a.bounds.h ||
    scale !== a.scaleFactor
  );
}

function displayInfoOf(m: DockedMonitor): SnapDisplayInfo {
  return {
    name: m.name,
    bounds: { x: m.bounds.x, y: m.bounds.y, w: m.bounds.w, h: m.bounds.h },
    workArea: { x: m.workArea.x, y: m.workArea.y, w: m.workArea.w, h: m.workArea.h },
    scaleFactor: m.scaleFactor,
  };
}

/**
 * 恢复时选显示器：名称 → 几何（bounds/workArea）→ 窗口当前所在屏 → 最近中心。
 * Windows 显示器序号不稳定，名称也可能缺失，因此不能依赖 `monitors[0]`。
 */
function chooseRestoreMonitor(
  saved: SnapDisplayInfo | null,
  monitors: readonly MonitorLike[],
  rect: SnapRect,
): MonitorLike {
  if (monitors.length === 0) throw new Error("no monitors");
  if (saved) {
    if (saved.name) {
      const byName = monitors.find((m) => m.name === saved.name);
      if (byName) return byName;
    }
    const b = saved.bounds;
    if (b) {
      const byBounds = monitors.find((m) => {
        const a = toArea(m);
        return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
      });
      if (byBounds) return byBounds;
    }
    const wa = saved.workArea;
    if (wa) {
      const byWork = monitors.find((m) => {
        const a = toWorkArea(m);
        return a.x === wa.x && a.y === wa.y && a.w === wa.w && a.h === wa.h;
      });
      if (byWork) return byWork;
    }
  }
  return monitorForRect(rect, monitors);
}

/** 设置值 → 停靠形态；缺失/未知值一律回退到胶囊（老用户默认兼容）。 */
function dockFormFromSetting(v: unknown): DockForm {
  return v === "full" ? "full" : "capsule";
}

/**
 * 按矩形与各显示器的交集选目标屏：多屏/主副屏分辨率不同/显示器断开时，
 * 不能拿 `monitors[0]`（主屏）的尺寸套到副屏。完全离屏时退化为「中心最近」。
 */
function monitorForRect(rect: SnapRect, monitors: readonly MonitorLike[]): MonitorLike {
  if (monitors.length <= 1) return monitors[0] as MonitorLike;
  let best = monitors[0] as MonitorLike;
  let bestArea = -1;
  for (const m of monitors) {
    const a = toArea(m);
    const ix = Math.max(0, Math.min(rect.x + rect.w, a.x + a.w) - Math.max(rect.x, a.x));
    const iy = Math.max(0, Math.min(rect.y + rect.h, a.y + a.h) - Math.max(rect.y, a.y));
    const area = ix * iy;
    if (area > bestArea) {
      bestArea = area;
      best = m;
    }
  }
  if (bestArea > 0) return best;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const m of monitors) {
    const a = toArea(m);
    const d = Math.hypot(cx - (a.x + a.w / 2), cy - (a.y + a.h / 2));
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best;
}

/** 引擎内部状态机（restore 坐标已不再需要：窗口不离开停靠位）。 */
interface SnapMachine {
  phase: SnapPhase;
  edge: SnapEdge | null;
}

// ── 持久化写串行（模块级）：杜绝异步乱序旧值覆盖新值 ────────

let writeChain: Promise<void> = Promise.resolve();

/** 引擎实例世代（StrictMode 双重挂载）：旧实例的清理不得覆盖新实例的区域设置。 */
let engineEpoch = 0;

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const run = writeChain.then(task, task); // 前序失败不阻塞后续写入
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function persistSnap(
  edge: SnapEdge | null,
  hidden: boolean,
  center: number | null,
  extra: {
    centerRatio?: number | null;
    display?: SnapDisplayInfo | null;
    form?: "capsule" | "tab" | null;
  } = {},
): Promise<void> {
  return enqueueWrite(async () => {
    try {
      await saveSnapState(edge ?? "none", hidden, center, extra);
    } catch {
      // 持久化失败不阻塞吸附行为（重启后最多回到可见态）
    }
  });
}

export function useEdgeSnap(enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      // 吸附关闭：磁力（吸引 + 阻力）必须**完全**停用，窗口按系统默认拖拽。
      // 卸载/切换开关都走这里，避免"关掉开关但原生仍在拉扯窗口"的残留。
      void setMagneticDragConfig(
        false,
        SNAP_MAGNET_RANGE,
        SNAP_MAGNET_MAX_LEAD,
        SNAP_MAGNET_RELEASE,
      ).catch(() => {});
      void setMagneticDock(null).catch(() => {});
      return;
    }
    // 本次挂载的世代号：清理时若已有更新实例接管，旧实例不得再写区域。
    const epoch = ++engineEpoch;
    const win = getCurrentWindow();
    const ui = useEdgeSnapStore.getState();

    let disposed = false;
    let busy = false; // 评估/移动互斥（tick、onMoved、点击、undock）
    let queuedEval: (() => Promise<unknown>) | null = null; // busy 期间尾随补评估
    let lastMoveAt = 0; // 最近 onMoved（含程序移动；拖拽活动信号）
    let lastMoveTarget: SnapPoint | null = null; // 最近一次成功程序移动目标（幂等）
    let domPointerAt = 0; // 最近 DOM 指针事件时刻（原生拖拽期间不产生 → 松手信号）
    let leftSince: number | null = null; // 连续离开胶囊可见区起点
    let healthCheckTick = 0; // 健康检查计数（每 20 tick ≈3s 一次）
    let pendingRestore: {
      edge: SnapEdge;
      center: number | null;
      centerRatio: number | null;
      display: SnapDisplayInfo | null;
      /** 重启前的形态：Edge Tab 恢复为标签；其余按胶囊。 */
      form: "capsule" | "tab";
    } | null = null;

    // ── Edge Tab 过渡与拖动（与胶囊共用同一窗口/区域/Win32 磁力层）───────────
    /** 过渡期间禁止并发形态提交；动画结束/失败后必定复位。 */
    let tabAnimating = false;
    let tabDragging = false;
    /** 拖动起点沿边中心（物理 px）；每次按下重置。 */
    let tabDragBase: number | null = null;
    /** 本次按下是否真的移动过窗口：仅此时在松手后持久化位置。 */
    let tabDragMoved = false;
    let restoreAttempts = 0; // 重启恢复的有界重试计数
    let dockedMonitor: DockedMonitor | null = null; // 停靠显示器记忆
    let dockedPos: SnapPoint | null = null; // 停靠时窗口目标位置（偏离判定基准）
    let dockedSize: { w: number; h: number } | null = null; // 停靠时窗口尺寸（识别程序缩放）
    let capsuleCenter: number | null = null; // 胶囊沿边中心（物理像素）
    /** 当前实际停靠形态（偏好存于设置；停靠成功后才切换实际形态）。 */
    let dockedForm: DockForm = "capsule";
    /**
     * 本次停靠会话的**临时形态覆盖**（胶囊「完整面板」/ 面板「收缩为胶囊」）。
     *
     * 只影响当前停靠会话，**绝不写持久化 `snap_display_mode`**：`dockTo` 在无覆盖时
     * 按持久化偏好选形态，有覆盖时按覆盖值。正常解除（进入 free）或换边解除后自动
     * 清空，因此「胶囊 → 临时展开 → 拖离 → 再吸附」会回到用户默认偏好；
     * 长期偏好只由设置页 / 右键菜单（`requestDockForm`）更新。
     */
    let sessionFormOverride: DockForm | null = null;
    /** 形态切换事务序号：快速连切时旧事务不得回滚/提示、覆盖新目标。 */
    let formSwitchSeq = 0;
    let magnetizedNow = false; // candidate 是否在磁吸区（≤28；仅在变化时同步 store）
    /** 最近一次写入 snap_state 的沿边中心（沿边重定位只在变化时落库）。 */
    let persistedCenter: number | null = null;

    /**
     * 停靠态持久化：附带显示器身份/几何与沿边中心比例（P2-4）。
     * 分辨率或 DPI 变化后，比例能重算出有效坐标，避免用过期绝对像素；
     * 旧记录没有这些字段，恢复逻辑仍按 `center` / 当前窗口所在屏回退。
     */
    function persistDockedSnap(
      edge: SnapEdge,
      hidden: boolean,
      center: number | null,
      form: "capsule" | "tab" = "capsule",
    ): void {
      const m = dockedMonitor;
      let centerRatio: number | null = null;
      let display: SnapDisplayInfo | null = null;
      if (m) {
        if (center !== null) {
          const vertical = edge === "left" || edge === "right";
          const span = vertical ? m.workArea.h : m.workArea.w;
          if (span > 0) {
            const origin = vertical ? m.workArea.y : m.workArea.x;
            centerRatio = (center - origin) / span;
          }
        }
        display = displayInfoOf(m);
      }
      persistedCenter = center;
      void persistSnap(edge, hidden, center, { centerRatio, display, form });
    }
    /**
     * 拖拽期间曾观察到「法向位移超过解除阈值」：折叠态（docked-hidden）不做
     * 光标轮询，靠这个一次性标记在静止后补一次解除判定（拖出后不会停在半脱开）。
     */
    let undockCheckDue = false;
    /**
     * 自由窗口的拖拽轨迹：`lastSeenRect` 是上一拍观测到的窗口矩形（松手后的静止
     * 位置），`gestureStartRect` 是本次手势的起点。用于区分「主动拖向边缘」与
     * 「沿边平行拖动 / 只被磁力吸进吸附区」——后者不得因此吸附并收缩。
     */
    let lastSeenRect: SnapRect | null = null;
    let gestureStartRect: SnapRect | null = null;
    /** 本次手势已观测到的矩形（有界），用于判定最近轨迹方向。 */
    const GESTURE_TRAIL_MAX = 8;
    let gestureTrail: SnapRect[] = [];
    /**
     * 按下时的真实窗口矩形：快速拖动时首个 `onMoved` 可能已是合并后的大位移，
     * 不能拿它当手势起点。按下时先记 `lastSeenRect`，再用一次轻量原生读取校正
     * （观测到移动之前的读数才有效）。
     */
    let pressOriginRect: SnapRect | null = null;
    let pressOriginAt = 0;
    let pressOriginToken = 0;
    /**
     * 解除后的**几何恢复后台事务**（v0.7.1 capsule-redock 修复）。
     *
     * 区域与相位提交仍在引擎互斥区（busy）内完成；尺寸恢复要等原生拖拽循环
     * 退出（≥220ms 静默）再加稳定回读（400–600ms），若继续占住 busy，期间的
     * onMoved 评估会被全部丢弃、`lastSeenRect` 冻结在解除触发位——用户紧接着
     * 抓起恢复后的窗口反向拖动时，新手势的起点被污染，吸附意图判定必然失效
     *（「拖离后无法重新吸附」的根因）。恢复因此脱离 busy：不阻塞评估、不改
     * 状态机，只在完成前延迟候选确认（`restoreInFlight`），避免两路几何写入
     * 交错。`restoreGen` 使重复解除/卸载后迟到的恢复自行作废。
     */
    let restoreGen = 0;
    let restoreInFlight = false;
    let restoreDone: Promise<void> = Promise.resolve();
    /**
     * 解除提交后用户是否已按下过窗口（任意 pointerdown）。置位后跳过
     * 「锚定未应用」的兜底重定位——用户已抓住窗口，程序性搬动会与手势打架。
     */
    let undockUserInteracted = false;
    const machine: SnapMachine = { phase: "free", edge: null };

    // ── 启动显示门 ──────────────────────────────────────────
    // 后端在「上次退出为停靠态」时先把窗口裁成 1×1 空白区域（窗口可见但屏幕上
    // 没有主窗口像素），直到本 hook 确认恢复结论（已按胶囊几何完成停靠、或确认
    // 无需/无法恢复）才撤销。否则会先露出完整主窗口再缩成胶囊——正是停靠态
    // 仍看到主窗口矩形的启动路径。
    let readySent = false;
    function markReady(): void {
      if (readySent) return;
      readySent = true;
      void notifyUiReady().catch(() => {
        // 失败不重试：后端 BLANK_REGION_FALLBACK_MS 后兜底撤销空白区域。
      });
    }

    function syncUi() {
      ui.sync({
        phase: machine.phase,
        candidateEdge: machine.phase === "candidate" ? machine.edge : null,
        magnetized: machine.phase === "candidate" ? magnetizedNow : false,
        dockedEdge: isDockedPhase(machine.phase) ? machine.edge : null,
      });
    }

    /**
     * 把停靠位同步给原生磁力层（`WM_MOVING` 里的脱离阻力基准）。
     * 阻力只对「已停靠且齐平位已知」的窗口生效；停靠失败 / 解除 / 卸载都必须清掉，
     * 否则下一次普通拖拽会被当成"从停靠位往外拉"而突然变沉。
     */
    function syncMagnetDock(): void {
      if (isDockedPhase(machine.phase) && machine.edge && dockedPos) {
        void setMagneticDock(machine.edge, dockedPos.x, dockedPos.y).catch(() => {});
      } else {
        void setMagneticDock(null).catch(() => {});
      }
    }

    /** 磁吸强度仅在跨越阈值时同步（拖拽期间 onMoved 高频，避免逐帧渲染） */
    function setMagnetized(v: boolean): void {
      if (magnetizedNow === v) return;
      magnetizedNow = v;
      syncUi();
    }

    /**
     * 相位转移（非法转移直接拒绝，防竞态写入）。
     * 进入 free 等价于「UI 认为窗口已是完整矩形」，因此原生区域失准时拒绝——
     * 不能把「发出了 off 请求」当成「Win32 已取消裁剪」。
     */
    function setPhase(next: SnapPhase): boolean {
      if (machine.phase === next) return true;
      // 停靠相位必须带停靠边：App 只看相位进入胶囊布局，缺边时主界面会被隐藏，
      // 而原生区域可能仍是轨道/面板——这正是「翼片里泄露完整工作区控件」的来源。
      // 把不变量锁在唯一提交点，缺边时宁可留在当前相位并走失败回滚。
      if (isDockedPhase(next) && !machine.edge) return false;
      if (next === "free" && regionUnknown) return false;
      if (!canTransition(machine.phase, next)) return false;
      const wasDocked = isDockedPhase(machine.phase);
      machine.phase = next;
      invariantRecoveryAttempts = 0;
      invariantRecoveryAt = 0;
      if (next === "free") {
        machine.edge = null;
        dockedMonitor = null;
        dockedPos = null;
        dockedSize = null;
        capsuleCenter = null;
        leftSince = null;
        dockedForm = "capsule";
        // 停靠会话结束：临时形态覆盖随之失效，下次吸附回到持久化偏好。
        sessionFormOverride = null;
        if (wasDocked) {
          // 解除提交 = 新一轮自由窗口生涯的开始：上一轮停靠会话的手势数据
          // （起点冻结在解除触发位、轨迹属于拖离手势）不得参与下一轮吸附的
          // 意图判定。起点置空后由下一个 onMoved 用最新 lastSeenRect 重建，
          // 「拖离后首次重新吸附」因此与普通自由窗口首次吸附同一口径。
          // candidate→free（提示超时/滞回退出）不是解除，不在此列。
          gestureStartRect = null;
          gestureTrail = [];
          pressOriginRect = null;
          undockUserInteracted = false;
        }
      }
      if (machine.phase !== "candidate") magnetizedNow = false;
      syncUi();
      return true;
    }

    async function fetchRect(): Promise<{ rect: SnapRect; monitor: MonitorLike | null }> {
      const [pos, size, monitor] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        currentMonitor(),
      ]);
      return { rect: { x: pos.x, y: pos.y, w: size.width, h: size.height }, monitor };
    }

    /** 轻量矩形读取（2 次 IPC；显示器信息用停靠记忆）。 */
    async function fetchRectOnly(): Promise<SnapRect> {
      const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
      return { x: pos.x, y: pos.y, w: size.width, h: size.height };
    }

    /**
     * 记录拖拽按下时的真实窗口矩形。
     * 只在自由/候选态的可拖拽区域触发，普通点击不会多发起 IPC。
     * `lastSeenRect` 先作为同步兜底；异步读取只在「按下后尚未观测到移动」时生效，
     * 避免把拖动中的位置当起点。
     */
    function capturePressOrigin(): void {
      pressOriginAt = Date.now();
      pressOriginRect = lastSeenRect ? { ...lastSeenRect } : null;
      const token = ++pressOriginToken;
      void fetchRectOnly()
        .then((rect) => {
          if (disposed || token !== pressOriginToken) return;
          // 已经有移动观测、或 IPC 回包太慢（窗口可能已在拖动中），都不采用。
          // 例外：移动来自引擎自身的程序性写入（解除后的几何恢复/兜底定位），
          // 不是用户在拖——读到的仍是「按下时窗口所在位置」，应当采用。
          if (Date.now() - pressOriginAt > 120) return;
          if (lastMoveAt > pressOriginAt && !snapMoveGuard.isProgrammaticMove(rect.x, rect.y)) {
            return;
          }
          pressOriginRect = rect;
        })
        .catch(() => {
          // 读不到位置只影响起点精度，保留 lastSeenRect 兜底。
        });
    }

    /** 程序移动：幂等（同目标跳过）、登记防污染守卫、失败返回 false。 */
    async function moveWindow(x: number, y: number, force = false): Promise<boolean> {
      if (
        !force &&
        lastMoveTarget &&
        Math.abs(lastMoveTarget.x - x) <= 1 &&
        Math.abs(lastMoveTarget.y - y) <= 1
      ) {
        return true;
      }
      snapMoveGuard.noteProgrammaticMove(x, y);
      try {
        await win.setPosition(new PhysicalPosition(x, y));
        lastMoveTarget = { x, y };
        return true;
      } catch {
        lastMoveTarget = null; // 移动失败：位置缓存立即失效
        return false;
      }
    }

    /**
     * 尺寸写入 + 回读确认（容差 2 物理像素）。成功返回**回读后的实际矩形**
     * （调用方据此继续做位置判断，避免为同一状态再发一次读 IPC）；失败返回 null。
     * 原生拖拽循环内 `setSize` 可能被吞掉：不读回就提交会得到「偏好是面板、
     * 实际仍是 400 宽」，随后展开区域必然越界。失败由调用方回滚。
     */
    async function resizeVerified(w: number, h: number): Promise<SnapRect | null> {
      try {
        await win.setSize(new PhysicalSize(w, h));
      } catch {
        return null;
      }
      if (disposed) return null;
      try {
        const rect = await fetchRectOnly();
        if (disposed) return null;
        if (Math.abs(rect.w - w) > 2 || Math.abs(rect.h - h) > 2) {
          console.warn("[edge-snap] 尺寸写入未生效", {
            want: { w, h },
            actual: { w: rect.w, h: rect.h },
          });
          return null;
        }
        return rect;
      } catch {
        return null;
      }
    }

    /** 位置写入 + 回读确认（容差 1 物理像素）。 */
    async function moveVerified(x: number, y: number): Promise<boolean> {
      if (!(await moveWindow(x, y, true))) return false;
      if (disposed) return false;
      try {
        const rect = await fetchRectOnly();
        if (disposed) return false;
        if (Math.abs(rect.x - x) > 1 || Math.abs(rect.y - y) > 1) {
          console.warn("[edge-snap] 位置写入未生效", {
            want: { x, y },
            actual: { x: rect.x, y: rect.y },
          });
          return false;
        }
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 展开面板前的容器保证：先把窗口撑到胶囊容器尺寸并贴边，再请求 panel 区域。
     * 展开区域需要窗口容纳「轨道 + 间隙 + 面板」（左右边 ≥404 CSS px）；尺寸
     * 不足时后端会明确拒绝。这里每一步都回读确认，失败即返回 false，调用方
     * 保持折叠态/回滚，绝不提交「React 是面板、原生只有翼片」的假成功。
     */
    async function ensureCapsuleGeometry(
      edge: SnapEdge,
      m: DockedMonitor,
      center: number,
    ): Promise<boolean> {
      const container = capsuleContainerSize(edge);
      const want = {
        w: toPhysical(container.w, m.scaleFactor),
        h: toPhysical(container.h, m.scaleFactor),
      };
      const cur = await fetchRectOnly();
      if (disposed) return false;
      if (needsContainerResize({ w: cur.w, h: cur.h }, want)) {
        if (!(await resizeVerified(want.w, want.h))) return false;
      }
      const pos = capsuleWindowRect(edge, m.workArea, center, want);
      if (Math.abs(cur.x - pos.x) > 1 || Math.abs(cur.y - pos.y) > 1) {
        if (!(await moveVerified(pos.x, pos.y))) return false;
      }
      dockedPos = { x: pos.x, y: pos.y };
      dockedSize = want;
      capsuleCenter = center;
      return true;
    }

    /** 保存「有效可见」矩形（串行写队列；停靠期间不写，见 useWindowPersistence）。 */
    async function saveVisibleRect(r: SnapRect): Promise<void> {
      return enqueueWrite(async () => {
        try {
          if (snapMoveGuard.isPersistenceSuppressed()) return; // 回滚/隐藏期不写用户几何
          // 胶囊容器尺寸不是用户窗口几何：解除后 set_size 被拖拽循环吞掉时，
          // 绝不能让 400×420 覆盖用户真实的 window_rect。
          if (isCapsuleContainerSize(r, window.devicePixelRatio || 1)) return;
          const monitors = await availableMonitors();
          if (!isRectMostlyVisible(r, monitors.map(toArea))) return;
          await saveWindowRect({ x: r.x, y: r.y, w: r.w, h: r.h });
        } catch {
          // 忽略
        }
      });
    }

    // ── 胶囊区域（唯一的视觉状态开关）───────────────────────

    // 序号以页面加载时刻为基数：WebView 重载后仍大于上一次会话的序号，
    // 避免原生侧「已见最大序号」把重载后的新请求误判为旧请求。
    let regionSeq = Math.floor(performance.timeOrigin * 1000);
    let desiredRegion: { mode: CapsuleRegionMode; edge: SnapEdge } = { mode: "off", edge: "left" };
    /**
     * 最近一次确认过的停靠边：仅用于 `off`（清区域）的占位参数。
     * 原生侧 `off` 与方向无关，但缺边时仍必须能发出清理请求，否则停靠边丢失的
     * 异常态会把窗口永久留在轨道/面板裁剪里，连关闭吸附都无法恢复。
     * rail/panel 仍严禁缺边写入（那会把窗口裁成错误方向）。
     */
    let lastKnownEdge: SnapEdge | null = null;
    /**
     * 原生区域是否与 UI 相位失准（写入/回读失败且校准也失败）。
     * 为 true 时：禁止把相位推进到任何「需要假定某个区域已生效」的状态，
     * 尤其禁止进入 free（free 会被 UI 解读为完整窗口）；按有界退避自动校准。
     */
    let regionUnknown = false;
    let regionRecoveryAttempts = 0;
    let regionRecoveryAt = 0;
    /** 失准错误态是否已提示（恢复成功后复位，避免自动重试刷屏）。 */
    let regionFailureNotified = false;
    /** 自动解除（拖离 / 跨边）失败后的下次允许时刻；用户显式解除不受此限制。 */
    let undockRetryAt = 0;
    /** 停靠失败后的候选重试时刻：失败路径也要有界退避，不能逐 tick 重试。 */
    let dockRetryAt = 0;
    /** 「停靠相位缺停靠边」异常恢复的下次允许时刻（有界退避，不逐 tick 写区域）。 */
    let invariantRecoveryAt = 0;
    /** 异常恢复自动尝试次数：用尽后停自动、只保留手动重新校准入口。 */
    let invariantRecoveryAttempts = 0;

    /** 记录「原生区域与 UI 失准」；首次进入时安排一次有界恢复。 */
    function setRegionUnknown(v: boolean): void {
      if (regionUnknown === v) return;
      regionUnknown = v;
      ui.setRegionUnsynced(v);
      if (v) {
        regionRecoveryAttempts = 0;
        regionRecoveryAt = Date.now() + REGION_RECOVERY_BASE_MS;
      } else {
        regionRecoveryAttempts = 0;
        regionRecoveryAt = 0;
        regionFailureNotified = false;
      }
    }

    /** 区域失准的可见错误态：只提示一次，并提供可操作的重新校准入口。 */
    function notifyRegionFailure(): void {
      if (regionFailureNotified || disposed) return;
      regionFailureNotified = true;
      useUiStore.getState().showToast("停靠区域未恢复，窗口可能显示不完整", {
        kind: "error",
        code: "dock_region",
        action: {
          label: "重新校准",
          run: () => {
            runExclusive(async () => {
              if (isDockedPhase(machine.phase) && !machine.edge) {
                await recoverDockedWithoutEdge();
                return;
              }
              const target = regionForPhase(machine.phase);
              const ok = await setCapsuleRegion(target);
              if (ok) regionFailureNotified = false;
              else notifyRegionFailure();
            });
          },
        },
      });
    }

    /**
     * 停靠相位但停靠边丢失（不变量被破坏）的恢复路径。
     * **不猜方向**重建轨道/面板：唯一安全做法是先确认原生已恢复整窗（off + 回读），
     * 再把 UI 退回 free 并恢复用户尺寸。成功后才提交状态；失败保留失准标记并给出
     * 可操作的重新校准入口，绝不把「发了 off 请求」当成「原生已取消裁剪」。
     */
    async function recoverDockedWithoutEdge(): Promise<boolean> {
      if (!isDockedPhase(machine.phase) || machine.edge) return false;
      const scale = dockedMonitor?.scaleFactor ?? 1;
      const mode = resolveWindowMode(useSettingsStore.getState().settings?.mode);
      const offOk = await setCapsuleRegion("off");
      if (disposed) return false;
      if (!offOk) {
        notifyRegionFailure();
        return false;
      }
      if (!setPhase("free")) {
        notifyRegionFailure();
        return false;
      }
      persistedCenter = null;
      undockCheckDue = false;
      void setMagneticDock(null).catch(() => {});
      void persistSnap(null, false, null);
      await restoreUserSize(scale, mode);
      await clampIntoWorkArea();
      return true;
    }

    /**
     * 单次区域应用（带 IPC 超时）。
     * 超时/异常一律返回 false：调用方不得把「发出了请求」当成「原生已生效」；
     * 迟到的 invoke 结果由 `regionSeq` 作废，且 `seq` 随请求下发到原生侧，
     * 由原生单调序号再拦截一次真正落地的旧写入。
     */
    async function applyRegionWithTimeout(
      mode: CapsuleRegionMode,
      edge: SnapEdge,
      seq: number,
    ): Promise<boolean> {
      let timer: number | undefined;
      try {
        const result = await Promise.race([
          applyWindowCapsule(mode, edge, seq),
          new Promise<boolean>((resolve) => {
            timer = window.setTimeout(() => resolve(false), REGION_IPC_TIMEOUT_MS);
          }),
        ]);
        return result === true;
      } catch {
        return false;
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    }

    /**
     * 切换胶囊区域（**await + 结果检查 + 序号防护 + 超时**）。
     * 返回 false = 后端报告未应用（含 GetWindowRgn 回读验证失败）、IPC 异常/超时、
     * 或被原生乱序保护丢弃；
     * 响应迟到且期间有更新命令：结果作废并按最新期望**重同步**一次。
     * 成功时同步清除「区域失准」标记；失败时标记失准并交给有界恢复。
     */
    async function setCapsuleRegion(mode: CapsuleRegionMode): Promise<boolean> {
      // 缺边时不猜测方向：rail/panel 按左/右/上/下任写一种都会把窗口裁成错误形态，
      // 直接报告失败，由调用方回滚到最近确认成功的相位。
      // 例外是 off：原生侧 off 与方向无关（直接恢复整窗），缺边时也允许清理，
      // 否则「停靠边丢失 + 原生仍裁剪」的异常态无法自救（关闭吸附/卸载也清不掉）。
      const edge = machine.edge;
      if (!edge && mode !== "off") return false;
      if (edge) lastKnownEdge = edge;
      const effectiveEdge: SnapEdge = edge ?? lastKnownEdge ?? pendingRestore?.edge ?? "left";
      const seq = ++regionSeq;
      desiredRegion = { mode, edge: effectiveEdge };
      const ok = await applyRegionWithTimeout(mode, effectiveEdge, seq);
      if (disposed) return false;
      if (seq !== regionSeq) {
        void applyRegionWithTimeout(desiredRegion.mode, desiredRegion.edge, regionSeq);
        return false;
      }
      setRegionUnknown(!ok);
      return ok;
    }

    /**
     * 有界恢复：区域失准后按 300/600/1200ms 退避最多校准 3 次，随后停止自动重试
     * （用户下一次显式操作仍会重新尝试）。恢复目标是**当前相位对应的区域**，
     * 而不是无条件写 off——后者会把「原生仍是轨道」错配成完整窗口。
     */
    async function recoverRegionIfDue(): Promise<void> {
      if (disposed || !regionUnknown) return;
      if (regionRecoveryAttempts >= REGION_RECOVERY_MAX_ATTEMPTS) return;
      if (Date.now() < regionRecoveryAt) return;
      const target = regionForPhase(machine.phase);
      if (await setCapsuleRegion(target)) return;
      if (disposed || !regionUnknown) return;
      regionRecoveryAttempts += 1;
      if (regionRecoveryAttempts >= REGION_RECOVERY_MAX_ATTEMPTS) {
        regionRecoveryAt = Number.POSITIVE_INFINITY;
        console.warn("[edge-snap] 原生胶囊区域连续校准失败，已停止自动重试", {
          phase: machine.phase,
          edge: machine.edge,
          mode: target,
        });
        // 自动退避用尽：保留失准状态并暴露可操作的重新校准入口，
        // 不让用户面对「界面完整但仍被裁剪」且无出口的窗口。
        notifyRegionFailure();
        return;
      }
      regionRecoveryAt = Date.now() + REGION_RECOVERY_BASE_MS * 2 ** regionRecoveryAttempts;
    }

    /** 相位 → 区域形态的唯一映射（恢复时据此把区域校准回已提交状态）。 */
    function regionForPhase(phase: SnapPhase): CapsuleRegionMode {
      if (phase === "docked-full") return "off";
      if (phase === "docked-tab") return "tab";
      if (phase === "docked-revealed") return "panel";
      if (isDockedPhase(phase)) return "rail";
      return "off";
    }

    /**
     * 回滚半成立的停靠上下文（移动/区域失败后调用）。
     * 仍处在 candidate 时保留候选边——提示气泡不该因为一次 IPC 失败而闪断；
     * 其余相位一律清空，绝不留「React 以为停靠、原生其实没停靠」的中间态。
     */
    function abortDock(prevEdge: SnapEdge | null): void {
      machine.edge = machine.phase === "candidate" ? prevEdge : null;
      dockedMonitor = null;
      dockedPos = null;
      dockedSize = null;
      capsuleCenter = null;
      dockedForm = "capsule";
      sessionFormOverride = null;
      syncUi();
    }

    /**
     * 区域 → 相位的提交协议：**先应用 Win32 区域并校验回读结果，成功后才提交
     * React 相位**。失败时先校准回与当前相位一致的形态（= 上一个已确认区域）；
     * 若校准也失败，**保持当前相位并标记区域失准**，绝不再把「发了 off 请求」
     * 当成「原生已取消裁剪」而进入 free——那正是「React 完整窗口 / 原生仍残留
     * 裁剪」的错配来源。失准状态由 `recoverRegionIfDue` 有界恢复。
     */
    async function setRegionThenPhase(mode: CapsuleRegionMode, next: SnapPhase): Promise<boolean> {
      if (await setCapsuleRegion(mode)) {
        if (setPhase(next)) return true;
        // 区域已经按新形态裁好，但状态机拒绝这次转移：立刻把区域退回与**当前**
        // 相位一致的形态。否则窗口停在轨道、React 却仍是展开态（或反之），
        // 正是本协议要消除的错配。
        const restore = regionForPhase(machine.phase);
        if (restore !== mode) await setCapsuleRegion(restore);
        return false;
      }
      if (disposed) return false;
      const restore = regionForPhase(machine.phase);
      // 目标形态就是当前相位应有的形态（没有别的已确认状态可退）：
      // 不重复写第二次，直接交给有界恢复。
      if (restore !== mode && (await setCapsuleRegion(restore))) return false;
      return false;
    }

    // ── 动作：停靠 / 折叠 / 展开 / 解除 ─────────────────────

    /** 把矩形钳制进指定工作区；中心不在该工作区时原样返回（不跨屏搬窗口）。 */
    function clampToWorkArea(r: SnapRect, wa: SnapArea): SnapRect {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      if (cx < wa.x || cx > wa.x + wa.w || cy < wa.y || cy > wa.y + wa.h) return r;
      return {
        ...r,
        x: Math.max(wa.x, Math.min(r.x, wa.x + wa.w - r.w)),
        y: Math.max(wa.y, Math.min(r.y, wa.y + wa.h - r.h)),
      };
    }

    /**
     * 停靠半途失败后的几何回滚：恢复用户窗口的尺寸与位置。
     * - 先读回当前实际矩形，只对**确实变化**的那一维发一次 IPC（不重复 setSize/setPosition）；
     * - 回滚前登记 `noteGeometryRollback`，在有限时间内抑制 window_rect 持久化，
     *   即便回滚本身失败也不会把「容器尺寸 + 贴边位置」写进用户几何；
     * - 每项失败只记录一次警告、不自动重试（有界）。
     */
    async function restoreDockGeometry(prev: SnapRect, wa: SnapArea): Promise<boolean> {
      snapMoveGuard.noteGeometryRollback();
      const target = clampToWorkArea(prev, wa);
      let current: SnapRect | null = null;
      try {
        current = await fetchRectOnly();
      } catch {
        // 读不回就按「两维都变了」处理（两段各最多一次，仍是有界）
      }
      if (disposed) return false;
      let ok = true;
      let actual = current;
      if (!current || current.w !== target.w || current.h !== target.h) {
        // setSize「返回成功」不等于实际生效：必须回读确认后才算恢复；
        // 回读结果直接复用于下面的位置判断，不为同一状态重复发读 IPC。
        actual = await resizeVerified(target.w, target.h);
        if (!actual) {
          ok = false;
          console.warn("[edge-snap] 停靠回滚恢复窗口尺寸失败", { target });
          // 尺寸恢复失败仍要尽力恢复位置：不能让窗口停在贴边坐标上。
          actual = current;
        }
      }
      if (disposed) return false;
      if (!actual || actual.x !== target.x || actual.y !== target.y) {
        // 位置同样回读确认；失败不把恢复结果当成功。
        if (!(await moveVerified(target.x, target.y))) {
          ok = false;
          console.warn("[edge-snap] 停靠回滚恢复窗口位置失败", { target });
        }
      }
      return ok;
    }

    /**
     * 完整面板停靠：保持用户窗口尺寸（仅在超出可用区时收敛），贴边齐平，
     * 关闭 Win32 裁剪（区域 off），相位进入 `docked-full`。
     *
     * `fromDocked=true` 表示「已停靠的胶囊 → 完整面板」的原地切换：失败时不清
     * 停靠边、不调用 `abortDock`，而是恢复旧几何并把区域校准回旧相位，避免
     * UI 仍在胶囊/原生却已变整窗的错配。
     */
    async function dockFull(
      edge: SnapEdge,
      center: number,
      feedback: boolean,
      fromDocked = false,
      monitorOverride: MonitorLike | null = null,
    ): Promise<boolean> {
      const { monitor } = monitorOverride ? { monitor: monitorOverride } : await fetchRect();
      if (disposed || !monitor) return false;
      const prevEdge = machine.edge;
      const prevMonitor = dockedMonitor;
      const prevDockedPos = dockedPos;
      const prevDockedSize = dockedSize;
      const prevCenter = capsuleCenter;
      dockedMonitor = memorizeMonitor(monitor);
      const scale = dockedMonitor.scaleFactor;
      const wa = dockedMonitor.workArea;
      let rect = await fetchRectOnly();
      if (disposed) return false;
      const prevRect = { ...rect };

      const rollback = async () => {
        await restoreDockGeometry(prevRect, wa);
        dockedMonitor = prevMonitor;
        dockedPos = prevDockedPos;
        dockedSize = prevDockedSize;
        capsuleCenter = prevCenter;
        if (fromDocked) {
          // 区域若已被切到 off（或提交协议已按旧相位回退），再兜一次旧相位区域，
          // 保证「React 仍停靠 / 原生也仍按停靠形态裁剪」。
          if (isDockedPhase(machine.phase)) {
            await setCapsuleRegion(regionForPhase(machine.phase));
          }
          return;
        }
        dockRetryAt = Date.now() + DOCK_RETRY_MS;
        abortDock(prevEdge);
      };

      // 胶囊容器尺寸不是用户窗口几何：从胶囊形态原地切换或重启恢复时，
      // 先恢复用户的模式尺寸，再按该尺寸贴边（不拉满全高、不强改宽度）。
      if (isCapsuleContainerSize(rect, scale)) {
        const mode = resolveWindowMode(useSettingsStore.getState().settings?.mode);
        const restored = await restoreModeSize(mode, scale);
        if (disposed) return false;
        if (!restored) {
          await rollback();
          return false;
        }
        rect = await fetchRectOnly();
        if (disposed) return false;
      }

      // 超出可用区时才收敛尺寸；正常模式下完全保留用户宽度/高度。
      const w = Math.max(1, Math.min(rect.w, wa.w));
      const h = Math.max(1, Math.min(rect.h, wa.h));
      if (w !== rect.w || h !== rect.h) {
        if (!(await resizeVerified(w, h))) {
          await rollback();
          return false;
        }
        rect = { ...rect, w, h };
      }

      machine.edge = edge;
      const pos = capsuleWindowRect(edge, wa, center, { w, h });
      if (!(await moveVerified(pos.x, pos.y))) {
        await rollback();
        return false;
      }
      dockedPos = { x: pos.x, y: pos.y };
      dockedSize = { w, h };
      capsuleCenter = center;
      // 区域最后提交：off 成功后才进入 docked-full，失败时提交协议会自动
      // 把区域校准回当前相位（胶囊切换时仍是 rail）。
      if (!(await setRegionThenPhase("off", "docked-full"))) {
        await rollback();
        return false;
      }
      dockedForm = "full";
      dockRetryAt = 0;
      if (feedback) ui.notifyDocked(edge);
      persistDockedSnap(edge, false, center);
      syncMagnetDock();
      return true;
    }

    /**
     * 已停靠的完整面板 → 胶囊：缩回容器尺寸、重算轨道区域、进入 docked-hidden。
     * 任一步失败都恢复完整面板几何并把区域退回 off，绝不留下半尺寸/半裁剪窗口。
     */
    async function switchDockedToCapsule(): Promise<boolean> {
      // Edge Tab 的恢复走独立过渡（restoreFromTab），不在这里重新缩放窗口。
      if (tabAnimating || machine.phase === "docked-tab") return false;
      const edge = machine.edge;
      const m = dockedMonitor;
      if (!edge || !m) return false;
      const prevRect = await fetchRectOnly();
      if (disposed) return false;
      const center = capsuleCenter ?? alongCenterOf(edge, prevRect);
      const container = capsuleContainerSize(edge);
      const want = {
        w: toPhysical(container.w, m.scaleFactor),
        h: toPhysical(container.h, m.scaleFactor),
      };
      const rollback = async () => {
        await restoreDockGeometry(prevRect, m.workArea);
        if (machine.phase === "docked-full") await setCapsuleRegion("off");
        dockedPos = { x: prevRect.x, y: prevRect.y };
        dockedSize = { w: prevRect.w, h: prevRect.h };
        capsuleCenter = center;
      };
      if (!(await resizeVerified(want.w, want.h))) {
        await rollback();
        return false;
      }
      const pos = capsuleWindowRect(edge, m.workArea, center, want);
      if (!(await moveVerified(pos.x, pos.y))) {
        await rollback();
        return false;
      }
      if (!(await setRegionThenPhase("rail", "docked-hidden"))) {
        await rollback();
        return false;
      }
      dockedPos = { x: pos.x, y: pos.y };
      dockedSize = want;
      capsuleCenter = center;
      dockedForm = "capsule";
      leftSince = null;
      persistDockedSnap(edge, true, center);
      syncMagnetDock();
      return true;
    }

    /**
     * 停靠形态切换的唯一入口（仅在已停靠时生效）。
     * 浮动态只更新偏好、不移动窗口；已停靠时原地切换形态。
     */
    async function applyDockForm(form: DockForm): Promise<boolean> {
      if (!isDockedPhase(machine.phase) || !machine.edge) return false;
      const alreadyFull = machine.phase === "docked-full";
      if (dockedForm === form && alreadyFull === (form === "full")) return true;
      if (form === "full") {
        const center =
          capsuleCenter ?? alongCenterOf(machine.edge, await fetchRectOnly());
        return dockFull(machine.edge, center, false, true);
      }
      return switchDockedToCapsule();
    }

    /** 已提交（真实生效）的形态以相位为准，而不是可能失败的偏好值。 */
    function committedDockForm(): DockForm {
      return machine.phase === "docked-full" ? "full" : "capsule";
    }

    /**
     * **长期偏好**的形态切换事务（设置页 / 右键菜单 / 托盘）。
     *
     * 偏好只是「目标」；实际生效形态以相位为准。切换失败时把偏好回滚到已提交
     * 形态，UI 选中态因此不会出现「设置已是完整面板、窗口仍是胶囊」的假选中。
     * `formSwitchSeq` 保证快速连切时旧事务的失败回滚/提示不会盖住新目标。
     * 明确的偏好优先于本次会话的临时覆盖：进入这里即清掉临时形态，避免旧临时
     * 状态反向覆盖用户刚选定的默认吸附方式。
     */
    async function requestDockForm(form: DockForm): Promise<boolean> {
      if (disposed) return false;
      sessionFormOverride = null;
      // 浮动态没有形态可切：偏好就是目标，窗口不动（下次停靠按新偏好生效）。
      if (!isDockedPhase(machine.phase) || !machine.edge) return true;
      const seq = ++formSwitchSeq;
      const result = await runExclusiveResult(() => applyDockForm(form));
      if (disposed || seq !== formSwitchSeq) return result === true;
      // 引擎持续忙碌（延后）时不回滚偏好：那是"没执行"，不是"执行失败"。
      if (result === undefined) return false;
      if (result) return true;
      const committed = committedDockForm();
      const current = useSettingsStore.getState().settings?.snap_display_mode;
      if (current !== committed) {
        void useSettingsStore
          .getState()
          .update({ snap_display_mode: committed })
          .catch((err) => console.warn("[edge-snap] 回滚停靠形态偏好失败", err));
      }
      useUiStore
        .getState()
        .showToast("停靠形态切换失败，已保持原形态", { kind: "error", code: "dock_form" });
      return false;
    }

    /**
     * **本次停靠会话**的临时形态切换（胶囊「完整面板」/ 面板「收缩为胶囊」）。
     *
     * 与 `requestDockForm` 的差别只在语义，不在算法：两者都复用 `applyDockForm`
     * 的几何与相位事务，但这里**不写 `snap_display_mode`**。成功后才登记
     * `sessionFormOverride`；失败时实际几何已由 `applyDockForm` 回滚，偏好保持
     * 不变（本来就没改过），绝不把临时意图冒充长期配置。
     */
    async function requestSessionForm(form: DockForm): Promise<boolean> {
      if (disposed || tabAnimating) return false;
      if (!isDockedPhase(machine.phase) || !machine.edge) return false;
      const seq = ++formSwitchSeq;
      const result = await runExclusiveResult(() => applyDockForm(form));
      if (disposed || seq !== formSwitchSeq) return result === true;
      // 引擎持续忙碌（延后到下一轮）时既不改实际形态也不登记覆盖。
      if (result === undefined) return false;
      if (result) {
        sessionFormOverride = form;
        return true;
      }
      useUiStore
        .getState()
        .showToast("停靠形态切换失败，已保持原形态", { kind: "error", code: "dock_form" });
      return false;
    }

    /**
     * 停靠到某条边：撑到容器尺寸 → 贴边齐平（胶囊沿边居中）→ 区域切到轨道。
     * `phase` 由调用方决定（重启恢复直接进 docked-hidden，无反馈）。
     * 任一后续步骤失败都必须回滚已发生的尺寸/位置变化，避免留下一个被放大
     * 且贴边的普通窗口（以及被污染的 window_rect）。
     *
     * 用户偏好为「完整面板」时不走容器尺寸路径，直接按完整窗口停靠。
     */
    async function dockTo(
      edge: SnapEdge,
      center: number,
      phase: "docked-visible" | "docked-hidden" | "docked-tab",
      feedback: boolean,
      /**
       * 未显式指定时按「本次停靠会话的临时覆盖 → 持久化偏好」决定形态：
       * 临时覆盖由胶囊按钮登记、解除停靠即失效；重启恢复与普通再吸附都走偏好。
       */
      form: DockForm = sessionFormOverride ??
        dockFormFromSetting(useSettingsStore.getState().settings?.snap_display_mode),
      monitorOverride: MonitorLike | null = null,
    ): Promise<boolean> {
      if (form === "full") return dockFull(edge, center, feedback, false, monitorOverride);
      const { monitor } = monitorOverride ? { monitor: monitorOverride } : await fetchRect();
      if (disposed || !monitor) return false;
      const prevEdge = machine.edge;
      dockedMonitor = memorizeMonitor(monitor);
      const scale = dockedMonitor.scaleFactor;
      const container = capsuleContainerSize(edge);
      const want = { w: toPhysical(container.w, scale), h: toPhysical(container.h, scale) };
      let rect = await fetchRectOnly();
      if (disposed) return false;
      // 用户窗口矩形（事务起点）：任何失败都回到这里，而不是停在半途尺寸
      const prevRect = { ...rect };
      if (needsContainerResize({ w: rect.w, h: rect.h }, want)) {
        // 停在容器尺寸（不是「只补不足」）：Aero Snap 的半屏尺寸也在停靠时收拢，
        // 否则停靠期会留下 1280×690 之类的异常大窗口。
        // 回读确认后才能继续：拖拽循环吞掉 setSize 会让窗口停在 400 宽，
        // 随后展开面板时后端明确拒绝（区域越界），UI 与原生形态开始分叉。
        if (!(await resizeVerified(want.w, want.h))) {
          await restoreDockGeometry(prevRect, dockedMonitor.workArea);
          dockRetryAt = Date.now() + DOCK_RETRY_MS;
          abortDock(prevEdge);
          return false;
        }
        rect = { ...rect, w: want.w, h: want.h };
      }
      machine.edge = edge;
      const pos = capsuleWindowRect(edge, dockedMonitor.workArea, center, {
        w: rect.w,
        h: rect.h,
      });
      // 移动失败 = 窗口没落到贴边齐平位。区域按**窗口局部坐标**裁剪，轨道会画在
      // 屏幕错误位置；更糟的是 dockedPos 成为幻影基准，下一拍偏离判定
      // （|rect - dockedPos| > 24）必然成立 → 误判「用户拖离」并自动解除。
      if (!(await moveVerified(pos.x, pos.y))) {
        await restoreDockGeometry(prevRect, dockedMonitor.workArea);
        dockRetryAt = Date.now() + DOCK_RETRY_MS;
        abortDock(prevEdge);
        return false;
      }
      dockedPos = { x: pos.x, y: pos.y };
      dockedSize = { w: rect.w, h: rect.h };
      capsuleCenter = center;
      dockedForm = "capsule";
      // 区域成功后才提交停靠相位；失败时回滚几何 + 清掉本次半成立的停靠上下文
      const mode = phase === "docked-tab" ? "tab" : "rail";
      if (!(await setRegionThenPhase(mode, phase))) {
        await restoreDockGeometry(prevRect, dockedMonitor.workArea);
        dockRetryAt = Date.now() + DOCK_RETRY_MS;
        abortDock(prevEdge);
        return false;
      }
      dockRetryAt = 0;
      if (feedback) ui.notifyDocked(edge);
      persistDockedSnap(edge, phase === "docked-hidden", center, phase === "docked-tab" ? "tab" : "capsule");
      // 停靠事务已提交（区域已生效、窗口已齐平）：现在才把基准交给原生磁力层
      syncMagnetDock();
      return true;
    }

    /** 折叠：只保留轨道（面板收起）。窗口不动，只切区域。 */
    async function collapseToRail(hidden: boolean): Promise<boolean> {
      if (tabAnimating) return false;
      if (!machine.edge) return false;
      // Edge Tab 不属于「可折叠胶囊」，恢复只能走 restoreFromTab。
      if (machine.phase === "docked-tab") return false;
      // 完整面板没有「折叠为轨道」概念；收缩入口是形态切换（→ 胶囊）。
      if (machine.phase === "docked-full") return false;
      const ok = await setRegionThenPhase("rail", hidden ? "docked-hidden" : "docked-visible");
      if (ok) persistDockedSnap(machine.edge, hidden, capsuleCenter);
      return ok;
    }

    /** 展开：先确认容器尺寸/贴边位置，再切出轨道 + 功能面板区域。 */
    async function expandPanel(): Promise<boolean> {
      if (tabAnimating || machine.phase === "docked-tab") return false;
      const edge = machine.edge;
      if (!edge) return false;
      // 完整面板本身就是完整界面，无需再「展开面板」。
      if (machine.phase === "docked-full") return false;
      if (machine.phase === "docked-revealed") return true;
      if (machine.phase !== "docked-hidden" && machine.phase !== "docked-visible") return false;
      const m = dockedMonitor;
      if (!m) return false;
      // 展开区域要求窗口能容纳 56 + 8 + 340 CSS px；容器尺寸未真实生效时
      // 后端会明确拒绝（不再静默退化成「只裁轨道」）。所以先撑窗口并回读，
      // 失败就保持折叠，绝不推进到「React 面板 / 原生翼片」的分叉态。
      const rect = await fetchRectOnly();
      if (disposed) return false;
      const center = capsuleCenter ?? alongCenterOf(edge, rect);
      if (!(await ensureCapsuleGeometry(edge, m, center))) {
        useUiStore
          .getState()
          .showToast("面板空间不足，暂时保持折叠", { kind: "error", code: "dock_panel" });
        return false;
      }
      // 展开不依赖分类状态：`useCapsuleStore.active` 恒有值，托盘 / 热键 / 重启恢复
      // 只切相位也能拿到明确面板，不存在「区域已裁好、面板内容为空」的空白态。
      const ok = await setRegionThenPhase("panel", "docked-revealed");
      if (!ok) return false;
      leftSince = null;
      persistDockedSnap(edge, false, center);
      return true;
    }

    /** 收起功能面板（Esc / 收起按钮 / 再次点击当前分类）。 */
    async function collapsePanel(): Promise<boolean> {
      if (tabAnimating) return false;
      if (machine.phase !== "docked-revealed") return true;
      return collapseToRail(false);
    }

    // ── Edge Tab 形态事务 ────────────────────────────────────────────────
    // 窗口尺寸/位置在停靠期间保持不变：收起只是「轨道侧滑出可视区」+
    // 「标签在贴边处渐显」，动画结束后才把 Win32 区域收紧到标签矩形。
    // 恢复复用同一套插值与区域协议（rail 是 tab 的超集，先扩区域再动画）。
    function tabReducedMotion(): boolean {
      return typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    }

    function delay(ms: number): Promise<void> {
      return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    }

    /** 收起为极简标签：Capsule（轨道/面板）→ Edge Tab。 */
    async function collapseToTab(): Promise<boolean> {
      if (disposed || tabAnimating) return false;
      const edge = machine.edge;
      if (!edge || !dockedMonitor) return false;
      if (
        machine.phase !== "docked-visible" &&
        machine.phase !== "docked-hidden" &&
        machine.phase !== "docked-revealed"
      ) {
        return false;
      }
      tabAnimating = true;
      try {
        if (machine.phase === "docked-revealed") {
          // 面板先自然收合（保留挂载 + 离场动画），再切回轨道区域；
          // 否则相位提前推进会让 CapsuleDock 立即卸载面板，出现「突然消失」。
          const store = useEdgeSnapStore.getState();
          if (!tabReducedMotion()) {
            store.setPanelExiting(true);
            await delay(PANEL_EXIT_MS);
            if (disposed) {
              store.setPanelExiting(false);
              return false;
            }
          }
          const regionOk = await setRegionThenPhase("rail", "docked-visible");
          // 区域提交后再放开挂载：失败时面板重新可见，不会停在透明态。
          store.setPanelExiting(false);
          if (!regionOk) return false;
        }
        undockCheckDue = false;
        let ok: boolean;
        if (tabReducedMotion()) {
          // 减少动态：直接提交形态，不保留任何过渡态。
          ok = await setRegionThenPhase("tab", "docked-tab");
        } else {
          useEdgeSnapStore.getState().setTabTransition("to-tab");
          await delay(TAB_TRANSITION_MS + 20);
          if (disposed) return false;
          ok = await setRegionThenPhase("tab", "docked-tab");
          useEdgeSnapStore.getState().setTabTransition(null);
          // 失败时 setRegionThenPhase 已把区域回滚为当前相位（rail）；
          // 移除过渡类后轨道重新可见，不会留下半截动画。
        }
        if (!ok) return false;
        leftSince = null;
        persistDockedSnap(edge, false, capsuleCenter, "tab");
        syncMagnetDock();
        return true;
      } finally {
        tabAnimating = false;
      }
    }

    /** 点击标签恢复：Edge Tab → Capsule 轨道（复用同一套过渡与区域协议）。 */
    async function restoreFromTab(): Promise<boolean> {
      if (disposed || tabAnimating) return false;
      const edge = machine.edge;
      const m = dockedMonitor;
      const size = dockedSize;
      if (!edge || !m || !size || machine.phase !== "docked-tab") return false;
      tabAnimating = true;
      try {
        const rect = await fetchRectOnly();
        if (disposed) return false;
        const scale = m.scaleFactor;
        const center = clampTabCenter(
          edge,
          m.workArea,
          capsuleCenter ?? alongCenterOf(edge, rect),
          scale,
        );
        // 拖动只允许沿边位移，但收到 OS 舍入/健康检查校准后仍可能差几像素：
        // 动画开始前先归位到贴边基准（一次写入 + 回读，不用逐帧命令）。
        const pos = capsuleWindowRect(edge, m.workArea, center, size);
        if (rect.x !== pos.x || rect.y !== pos.y) {
          if (!(await moveVerified(pos.x, pos.y))) return false;
          if (disposed) return false;
        }
        dockedPos = { x: pos.x, y: pos.y };
        dockedSize = { w: size.w, h: size.h };
        capsuleCenter = center;
        let ok: boolean;
        if (tabReducedMotion()) {
          ok = await setRegionThenPhase("rail", "docked-visible");
        } else {
          // rail ⊇ tab：先扩区域，标签外观不变，随后轨道从屏外滑入。
          if (!(await setCapsuleRegion("rail"))) return false;
          if (disposed) return false;
          useEdgeSnapStore.getState().setTabTransition("from-tab");
          await delay(TAB_TRANSITION_MS + 20);
          if (disposed) return false;
          ok = setPhase("docked-visible");
          if (!ok) {
            // 状态机拒绝：把区域退回标签，避免留下「整条轨道可点击但界面只有标签」。
            await setCapsuleRegion("tab");
          }
          useEdgeSnapStore.getState().setTabTransition(null);
        }
        if (!ok) return false;
        leftSince = null;
        persistDockedSnap(edge, false, center, "capsule");
        syncMagnetDock();
        return true;
      } finally {
        tabAnimating = false;
      }
    }

    /** 按下标签：记录沿边基准；任何形态切换都被 `tabAnimating`/相位阻止。 */
    function beginTabDrag(): void {
      if (machine.phase !== "docked-tab" || tabAnimating) return;
      tabDragging = true;
      tabDragBase = capsuleCenter;
      tabDragMoved = false;
    }

    /** 沿边拖动：只改沿边中心，法向（X 轴/贴边位置）保持不变。 */
    function dragTabBy(deltaCss: number): void {
      if (!tabDragging || machine.phase !== "docked-tab") return;
      const edge = machine.edge;
      const m = dockedMonitor;
      const size = dockedSize;
      if (!edge || !m || !size) return;
      const scale = m.scaleFactor;
      const fallbackRect = {
        x: dockedPos?.x ?? 0,
        y: dockedPos?.y ?? 0,
        w: size.w,
        h: size.h,
      };
      const base = tabDragBase ?? capsuleCenter ?? alongCenterOf(edge, fallbackRect);
      const center = clampTabCenter(edge, m.workArea, base + deltaCss * scale, scale);
      const pos = capsuleWindowRect(edge, m.workArea, center, size);
      dockedPos = { x: pos.x, y: pos.y };
      capsuleCenter = center;
      tabDragMoved = true;
      void moveWindow(pos.x, pos.y, true);
    }

    function endTabDrag(): void {
      const moved = tabDragging && tabDragMoved;
      tabDragging = false;
      tabDragBase = null;
      tabDragMoved = false;
      // 拖动只改沿边位置：松手即持久化，保证重启后的标签与真实窗口位置一致。
      if (moved && !tabAnimating && machine.phase === "docked-tab" && machine.edge) {
        persistDockedSnap(machine.edge, false, capsuleCenter, "tab");
      }
    }

    /**
     * 解除后恢复模式尺寸（**回读验证 + 有界重试**）。
     *
     * 解除是在 `onMoved` 里同步触发的，此时原生拖拽循环
     * （`WM_NCLBUTTONDOWN(HTCAPTION)`）仍持有窗口：`set_size` 可能被系统
     * 直接吞掉，`apply_mode` 仍返回成功。单次调用不足以证明「尺寸已恢复」，
     * 必须回读实际矩形；仍在胶囊容器尺寸时等窗口静止后有界重试（350/700ms）。
     * 每次尝试都抑制 `window_rect` 持久化：失败也绝不把容器尺寸写成用户几何。
     */
    async function restoreModeSize(mode: string, scale: number): Promise<boolean> {
      const wait = (ms: number) =>
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, ms);
        });
      /**
       * 等到原生移动/拖拽静止：解除可能在 `WM_NCLBUTTONDOWN` 拖拽循环内触发，
       * 此时 `set_size` 会被系统忽略。`lastMoveAt` 由 onMoved 同步更新，
       * 静止 ≥ SNAP_DRAG_SETTLE_MS 才认为拖拽循环已释放窗口。
       */
      const waitForSettle = async (maxMs: number) => {
        const deadline = Date.now() + maxMs;
        while (
          Date.now() - lastMoveAt < SNAP_DRAG_SETTLE_MS &&
          Date.now() < deadline
        ) {
          await wait(120);
        }
      };
      for (let attempt = 0; attempt < MODE_RESTORE_MAX_ATTEMPTS; attempt += 1) {
        await waitForSettle(1500);
        snapMoveGuard.noteGeometryRollback();
        try {
          await applyMode(mode);
        } catch (err) {
          console.warn("[edge-snap] 解除后恢复模式尺寸失败", { mode, attempt, err });
        }
        if (disposed) return false;
        try {
          const rect = await fetchRectOnly();
          if (!isCapsuleContainerSize(rect, scale)) {
            // 原生拖拽循环可能在 set_size 之后把窗口恢复成**拖拽起始尺寸**：
            // 立刻回读会看到 700，但松手后又被回弹成 525（真机复现）。
            // 再等一个稳定窗口后二次回读，确认尺寸没有被拖拽循环回弹。
            await wait(600);
            if (disposed) return false;
            try {
              const stable = await fetchRectOnly();
              if (!isCapsuleContainerSize(stable, scale)) return true;
            } catch {
              // 二次回读失败按未生效处理，继续有界重试
            }
          }
        } catch {
          // 读不回按未生效处理，继续有界重试
        }
        if (attempt < MODE_RESTORE_MAX_ATTEMPTS - 1) {
          await wait(300 + attempt * 300);
        }
      }
      // 重试用尽仍停在容器尺寸：延长抑制，避免随后把容器尺寸写进 window_rect。
      snapMoveGuard.noteGeometryRollback();
      console.warn("[edge-snap] 解除后窗口仍停在胶囊容器尺寸，已停止重试", { mode });
      return false;
    }

    /**
     * 解除吸附后恢复**用户自由窗口尺寸**（P2-2）。
     *
     * 胶囊容器的 404×440 不是用户尺寸：`window_rect` 只在浮动态写入，停靠期
     * 容器尺寸被持久化层显式拒绝，因此该记录仍保留用户最后一次自由尺寸。
     * 缺失、非法或是容器尺寸时回退到模式预设尺寸（旧行为）。
     * 与 `restoreModeSize` 一样做回读 + 有界重试，防止拖拽循环吞掉 `setSize`
     * 后把错误尺寸留给 `window_rect`。
     */
    async function restoreUserSize(scale: number, fallbackMode: string): Promise<boolean> {
      let saved: SnapRect | null = null;
      try {
        saved = await getWindowRect();
      } catch {
        saved = null;
      }
      if (disposed) return false;
      if (!saved || saved.w <= 0 || saved.h <= 0 || isCapsuleContainerSize(saved, scale)) {
        return restoreModeSize(fallbackMode, scale);
      }
      let target = { ...saved };
      try {
        const monitors = await availableMonitors();
        if (disposed) return false;
        if (monitors.length > 0) {
          // 空间不足可临时约束，但只约束本次恢复目标，不写回偏好。
          const wa = toWorkArea(monitorForRect(saved, monitors));
          target = { ...saved, w: Math.min(saved.w, wa.w), h: Math.min(saved.h, wa.h) };
        }
      } catch {
        // 读不到显示器：按原尺寸恢复，后续 clampIntoWorkArea 兜底
      }
      const wait = (ms: number) =>
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, ms);
        });
      for (let attempt = 0; attempt < MODE_RESTORE_MAX_ATTEMPTS; attempt += 1) {
        const deadline = Date.now() + 1500;
        while (Date.now() - lastMoveAt < SNAP_DRAG_SETTLE_MS && Date.now() < deadline) {
          await wait(120);
        }
        snapMoveGuard.noteGeometryRollback();
        if (await resizeVerified(target.w, target.h)) {
          // 原生拖拽循环可能在写入后回弹到拖拽起始尺寸：等稳定窗口再确认一次。
          await wait(400);
          if (disposed) return false;
          try {
            const stable = await fetchRectOnly();
            if (
              Math.abs(stable.w - target.w) <= 2 &&
              Math.abs(stable.h - target.h) <= 2
            ) {
              return true;
            }
          } catch {
            // 二次回读失败按未生效处理，继续有界重试
          }
        }
        if (attempt < MODE_RESTORE_MAX_ATTEMPTS - 1) {
          await wait(300 + attempt * 300);
        }
      }
      snapMoveGuard.noteGeometryRollback();
      console.warn("[edge-snap] 解除后用户尺寸未恢复，已停止重试", { target });
      return false;
    }

    /**
     * 解除后把窗口以鼠标为锚点重新定位（标题栏中心 = 光标）。
     *
     * 仅作为**原生拖拽锚定未应用**时的回退（请求时拖拽已结束 / 子类化未安装）：
     * 用实际恢复后的窗口尺寸（回读，而非理论模式尺寸）与实测标题栏高度计算，
     * 目标经 `undockAnchorTarget` 钳制进工作区（窗口完整可见优先，光标保持窗内）。
     */
    async function anchorRestoredWindowToCursor(scale: number): Promise<void> {
      try {
        const [cursor, rect, monitor] = await Promise.all([
          cursorPosition(),
          fetchRectOnly(),
          currentMonitor(),
        ]);
        if (disposed || !monitor) return;
        const wa = toWorkArea(monitor);
        const target = undockAnchorTarget(
          cursor,
          { w: rect.w, h: rect.h },
          toPhysical(measureTitlebarHeight(), scale),
          wa,
        );
        if (target.x === rect.x && target.y === rect.y) return;
        if (await moveWindow(target.x, target.y, true)) {
          void saveVisibleRect({ ...rect, x: target.x, y: target.y });
        }
      } catch {
        // 定位失败不阻塞解除：窗口仍由 clampIntoWorkArea 保证可见
      }
    }

    /**
     * 解除吸附核心：清区域 → 退出停靠 → 恢复模式尺寸并收回工作区。
     * `targetMode` 由「打开完整页」传入（避免先恢复旧模式再切新模式的两次缩放）。
     *
     * `anchorCursor=true`（仅用户拖离路径）：先请求原生在拖拽循环内做鼠标锚定
     * （恢复模式尺寸 + 标题栏中心对齐光标，一个拖拽帧内原子完成）；拖拽已结束
     * 导致请求没被应用时，尺寸恢复确认后回退到 `anchorRestoredWindowToCursor`。
     * 按钮解除 / 打开完整页 / 托盘唤回等路径保持各自原有定位，不传该参数。
     */
    async function undockCore(targetMode?: string, anchorCursor = false): Promise<boolean> {
      // 停靠相位缺停靠边属于不变量被破坏：不猜方向，走安全恢复（off 回读 → free）。
      if (!machine.edge) {
        if (!isDockedPhase(machine.phase)) return false;
        return recoverDockedWithoutEdge();
      }
      // 停靠期形态与缩放系数：setPhase(free) 会清空 dockedMonitor / 相位，先取出来。
      const wasFull = machine.phase === "docked-full";
      const scale = dockedMonitor?.scaleFactor ?? 1;
      pendingRestore = null; // 用户意图优先：不得再被重启恢复队列拉回停靠
      // 停靠期间窗口被撑到胶囊容器尺寸：解除后恢复目标模式（默认当前模式）的尺寸
      const mode = targetMode ?? resolveWindowMode(useSettingsStore.getState().settings?.mode);
      // 区域必须真的清掉才算解除：失败时保持停靠相位（轨道仍可见可用），
      // 不允许出现「原生已裁成轨道 / React 显示完整主窗口」的假解除。
      let offOk = await setCapsuleRegion("off");
      if (!offOk) offOk = await setCapsuleRegion("off"); // 有界重试一次
      if (!offOk) {
        // 两次都失败：保持停靠相位（区域仍是轨道），并给自动路径一个重试间隔，
        // 避免拖离/跨边判定在每个 tick 都重发 off。
        undockRetryAt = Date.now() + UNDOCK_RETRY_MS;
        if (anchorCursor) void cancelUndockAnchor().catch(() => {});
        return false;
      }
      undockRetryAt = 0;
      // 拖离路径：请求原生鼠标锚定。在区域清理之后发出——锚定帧到来时窗口
      // 区域已恢复整窗，不会出现「轨道裁剪贴在锚定后新位置」的瞬时错位。
      // 请求是否被消费由 takeUndockAnchorApplied 在尺寸恢复后确认。
      let anchorRequested = false;
      if (anchorCursor) {
        try {
          anchorRequested = await setUndockAnchor(mode, measureTitlebarHeight());
        } catch {
          anchorRequested = false; // IPC 异常按无锚定处理，解除流程照常
        }
      }
      setPhase("free");
      // 已解除：立刻清掉原生阻力基准（后续普通拖拽不得再被"停靠位"牵制）
      void setMagneticDock(null).catch(() => {});
      persistedCenter = null;
      undockCheckDue = false;
      void persistSnap(null, false, null);
      // ── 几何恢复：后台事务，不占用引擎互斥区（capsule-redock 根因修复）──────
      // busy 只保护「区域 + 相位」这一提交点。尺寸恢复要等原生拖拽循环退出
      // （≥220ms 静默）加稳定回读（400–600ms），过去占住 busy 期间所有 onMoved
      // 评估被丢弃、lastSeenRect 冻结在解除触发位，用户立即反向拖动的新手势
      // 起点被污染，吸附意图判定失效（拖离后无法重新吸附）。恢复脱离 busy 后
      // 评估持续流动；`restoreInFlight` 让候选确认延迟到恢复完成，避免两路
      // 几何写入交错；`restoreGen` 使重复解除/卸载后迟到的恢复自行作废。
      //
      // 尺寸恢复规则（P2-2，三条路径各自独立）：
      // 1) 明确指定 targetMode（打开完整页等）：沿用既有规则，按目标模式尺寸；
      // 2) 完整面板 → 自由：窗口本来就是用户尺寸，不做任何重置；
      // 3) 胶囊 → 自由：恢复 **用户最后一次自由尺寸**（window_rect），而不是
      //    把 404×440 容器尺寸或模式预设当成用户尺寸。
      const gen = ++restoreGen;
      restoreInFlight = true;
      restoreDone = (async () => {
        try {
          const sizeRestored =
            targetMode !== undefined
              ? await restoreModeSize(mode, scale)
              : wasFull
                ? true
                : await restoreUserSize(scale, mode);
          if (disposed || gen !== restoreGen) return;
          await clampIntoWorkArea();
          if (disposed || gen !== restoreGen) return;
          if (!sizeRestored) {
            // 重试用尽：区域已确认解除（offOk），但模式尺寸仍未恢复。这里把
            // 四件事分开记录，避免把「解除成功」误当成「几何已复原」：
            // 区域 / 尺寸 / 工作区可见性 / 是否已持久化。
            let inWorkArea = false;
            try {
              const rect = await fetchRectOnly();
              const monitors = await availableMonitors();
              inWorkArea = monitors.length > 0 && isRectMostlyVisible(rect, monitors.map(toArea));
            } catch {
              // 读不回按「无法确认」处理
            }
            console.warn("[edge-snap] 解除完成但模式尺寸未恢复", {
              mode,
              regionUndocked: true,
              sizeRestored: false,
              inWorkArea,
              persisted: false, // 容器尺寸在持久化路径被显式拒绝
            });
          }
          if (anchorRequested) {
            let applied = false;
            try {
              applied = await takeUndockAnchorApplied();
            } catch {
              applied = false;
            }
            // 原生没在拖拽循环内应用（拖拽在请求前已结束等）：按实际恢复后的
            // 尺寸回退定位。已应用时窗口在拖拽中就已标题栏居中跟手，不得再动。
            // 用户解除后已按下过窗口（准备拖动/点击）时同样不动：程序性搬动
            // 会与用户手势打架，窗口可见性由 clampIntoWorkArea 兜底。
            if (!applied && !undockUserInteracted) await anchorRestoredWindowToCursor(scale);
          }
        } finally {
          if (gen === restoreGen) restoreInFlight = false;
        }
      })();
      return true;
    }

    /**
     * 沿边重定位提交：停靠期窗口允许**沿边**滑动（法向由原生磁力钳住），
     * 松手后沿边位置属于用户意图，必须写回基准与持久化——否则解除判定、
     * 断连恢复、重启恢复都会回到旧位置。
     *
     * 只更新**沿边分量**：法向基准必须始终保持真实齐平位，拖动中的弹性位移
     * 绝不能写进基准（否则解除判定的零点会被越推越远，越拉越容易脱开）。
     */
    function commitAlong(rect: SnapRect): void {
      const edge = machine.edge;
      if (!edge || !dockedPos) return;
      if (Math.abs(alongDeviation(rect, dockedPos, edge)) >= 1) {
        dockedPos = rebaseAlong(rect, dockedPos, edge);
        capsuleCenter = alongCenterOf(edge, rect);
      }
      // 拖动中只更新内存基准；落库与原生下发在静止后**只做一次**
      // （用 persistedCenter 而不是"本次是否位移"判定，否则拖动中先更新基准、
      //   静止后位移已归零，就永远等不到那次落库）。
      if (Date.now() - lastMoveAt < SNAP_DRAG_SETTLE_MS) return;
      const center = capsuleCenter;
      if (center === null) return;
      if (persistedCenter !== null && Math.abs(persistedCenter - center) < 1) return;
      // 原生基准的沿边分量同步（阻力只用法向，但基准要保持真实）
      syncMagnetDock();
      // 沿边重定位也要带上显示器身份与比例（P2-4），否则下一次恢复会丢掉
      // 这些字段，只能退回绝对像素。
      persistDockedSnap(
        edge,
        isHiddenPhase(machine.phase),
        center,
        isTabPhase(machine.phase) ? "tab" : "capsule",
      );
    }

    /** 解除后把窗口收回工作区（模式尺寸可能比胶囊容器大，贴边位置会溢出）。 */
    async function clampIntoWorkArea(): Promise<void> {
      try {
        const rect = await fetchRectOnly();
        if (disposed) return;
        const monitors = await availableMonitors();
        if (disposed || monitors.length === 0) return;
        const areas = monitors.map(toArea);
        if (isRectMostlyVisible(rect, areas)) return;
        // 选与窗口相交最大的显示器，而不是主屏：多屏时窗口可能本就在副屏上，
        // 拿主屏可用区套坐标会把用户窗口硬拉回主屏。
        const wa = toWorkArea(monitorForRect(rect, monitors as MonitorLike[]));
        const x = Math.max(wa.x, Math.min(rect.x, wa.x + wa.w - rect.w));
        const y = Math.max(wa.y, Math.min(rect.y, wa.y + wa.h - rect.h));
        await moveWindow(x, y, true);
        void saveVisibleRect({ x, y, w: rect.w, h: rect.h });
      } catch {
        // 尽力而为
      }
    }

    /** 拖拽解除：用户把胶囊拖离停靠位超过阈值。不内推——窗口已在用户手上。
     *  唯一使用鼠标锚定的解除路径（原生拖拽循环内对齐，未应用时回退定位）。
     *  几何恢复在后台事务里收尾（不占 busy），可见矩形保存随之延后：
     *  恢复完成后的矩形才是用户真正的自由窗口几何。 */
    async function undockByDrag(): Promise<void> {
      if (!(await undockCore(undefined, true))) return;
      const settled = restoreDone;
      void settled.then(async () => {
        if (disposed) return;
        try {
          const rect = await fetchRectOnly();
          if (!disposed) void saveVisibleRect(rect);
        } catch {
          // 持久化钩子会在后续 onMoved/onResized 里兜底保存
        }
      });
    }

    /**
     * 显示器断连 / 窗口被系统挪到屏外时的兜底：按停靠记忆重新贴边。
     * 新架构窗口始终可见，这里只处理"可见性真的丢了"的异常。
     */
    async function recoverVisibility(): Promise<void> {
      try {
        const rect = await fetchRectOnly();
        const monitors = await availableMonitors();
        if (disposed || monitors.length === 0) return;
        if (isRectMostlyVisible(rect, monitors.map(toArea))) return;
        const monitor = monitorForRect(rect, monitors as MonitorLike[]);
        dockedMonitor = memorizeMonitor(monitor);
        const wa = dockedMonitor.workArea;
        const scale = dockedMonitor.scaleFactor;
        const edge = machine.edge ?? "left";
        const center =
          capsuleCenter ?? (edge === "left" || edge === "right" ? wa.y + wa.h / 2 : wa.x + wa.w / 2);
        // 完整面板按当前窗口尺寸收敛到可用区；胶囊相位按新显示器 DPI 回到容器尺寸。
        const want = isFullDockPhase(machine.phase)
          ? { w: Math.max(1, Math.min(rect.w, wa.w)), h: Math.max(1, Math.min(rect.h, wa.h)) }
          : (() => {
              const container = capsuleContainerSize(edge);
              return {
                w: toPhysical(container.w, scale),
                h: toPhysical(container.h, scale),
              };
            })();
        if (want.w !== rect.w || want.h !== rect.h) {
          // 回读确认尺寸真的生效；失败不更新停靠记忆（下一轮再校准）。
          if (!(await resizeVerified(want.w, want.h))) return;
          if (disposed) return;
        }
        const pos = capsuleWindowRect(edge, wa, center, want);
        if (!(await moveVerified(pos.x, pos.y))) return;
        if (disposed) return;
        dockedPos = { x: pos.x, y: pos.y };
        dockedSize = want;
        capsuleCenter = center;
      } catch {
        // 下轮 tick 重试
      }
    }

    // ── 评估：tick 与 onMoved（busy 互斥 + 尾随补评估）────────

    async function tickBody(): Promise<void> {
      if (disposed) return;
      // 停靠相位必须带停靠边：缺边时先走唯一的安全恢复（off 回读 → free），
      // 否则后续区域校准会一直拒绝写入（不猜方向），异常态永远无法收口。
      if (isDockedPhase(machine.phase) && !machine.edge) {
        if (Date.now() >= invariantRecoveryAt && invariantRecoveryAttempts < REGION_RECOVERY_MAX_ATTEMPTS) {
          const ok = await recoverDockedWithoutEdge();
          if (disposed) return;
          if (ok) {
            invariantRecoveryAttempts = 0;
            invariantRecoveryAt = 0;
          } else {
            invariantRecoveryAttempts += 1;
            if (invariantRecoveryAttempts >= REGION_RECOVERY_MAX_ATTEMPTS) {
              // 自动通道用尽：停止重试，保留失准错误态与手动“重新校准”入口。
              invariantRecoveryAt = Number.POSITIVE_INFINITY;
            } else {
              invariantRecoveryAt =
                Date.now() + Math.min(REGION_RECOVERY_BASE_MS * 2 ** invariantRecoveryAttempts, 5000);
            }
          }
        }
        return;
      }
      // 原生区域失准：先按退避做一次有界校准；失败也不把相位推进到
      // 「假定完整窗口」的状态（见 setPhase 的 free 守卫）。
      await recoverRegionIfDue();
      if (disposed) return;
      switch (machine.phase) {
        case "free": {
          // 重启恢复：持久化的停靠边经同一路径重新停靠（无反馈）。
          // 首拍可能在窗口尚未显示时 `currentMonitor()` 返回 null；失败时**不丢弃**
          // pendingRestore，按 DOCK_RETRY_MS 有界重试，成功后（或次数用尽）才清除。
          if (pendingRestore && Date.now() >= dockRetryAt) {
            const { edge, center, centerRatio, display } = pendingRestore;
            // 首拍可能窗口尚未显示：`currentMonitor` 为 null 时保留待恢复状态，
            // 按 DOCK_RETRY_MS 有界重试（不提前放弃，也不无限重发 IPC）。
            const current = await currentMonitor().catch(() => null);
            if (disposed) return;
            const rect = await fetchRectOnly();
            if (disposed) return;
            if (!current) {
              restoreAttempts += 1;
              dockRetryAt = Date.now() + DOCK_RETRY_MS;
              if (restoreAttempts >= RESTORE_MAX_ATTEMPTS) {
                pendingRestore = null;
                console.warn("[edge-snap] 重启恢复等待显示器超时，已停止重试", { edge });
                // 放弃恢复：清掉陈旧停靠记录，避免每次启动都重复尝试（并再次空白）。
                persistedCenter = null;
                void persistSnap(null, false, null);
                markReady();
              }
              return;
            }
            // 恢复目标显示器：先按记录的身份/几何选，找不到再按窗口当前所在屏。
            const monitors = await availableMonitors().catch(() => []);
            if (disposed) return;
            if (monitors.length === 0) {
              restoreAttempts += 1;
              dockRetryAt = Date.now() + DOCK_RETRY_MS;
              if (restoreAttempts >= RESTORE_MAX_ATTEMPTS) {
                pendingRestore = null;
                persistedCenter = null;
                // 没有可用显示器：陈旧记录无法恢复，清掉以免每次启动重复空白恢复。
                void persistSnap(null, false, null);
                markReady();
              }
              return;
            }
            const monitor = chooseRestoreMonitor(display, monitors, rect);
            const wa = toWorkArea(monitor);
            const vertical = edge === "left" || edge === "right";
            const span = vertical ? wa.h : wa.w;
            const origin = vertical ? wa.y : wa.x;
            // 优先用比例：分辨率/DPI/任务栏变化后旧绝对像素已失真；比例仍能
            // 落在同一条边的相对位置。旧记录没有比例，才退回绝对中心（仍要求
            // 落在目标屏沿边跨度内，否则按当前窗口中心重算）。
            let target: number | null = null;
            if (centerRatio !== null && span > 0) {
              target = origin + Math.min(Math.max(centerRatio, 0), 1) * span;
            } else if (center !== null && center >= origin && center <= origin + span) {
              target = center;
            }
            const fallback = alongCenterOf(edge, rect);
            const ok = await dockTo(
              edge,
              target ?? fallback,
              pendingRestore.form === "tab" ? "docked-tab" : "docked-hidden",
              false,
              // Edge Tab 优先于「完整面板」偏好：先恢复标签形态（容器尺寸），
              // 用户点开后再按既有入口进入面板/完整面板。
              pendingRestore.form === "tab" ? "capsule" : undefined,
              monitor,
            );
            if (ok) {
              pendingRestore = null;
              restoreAttempts = 0;
              // 停靠几何与轨道区域已生效：现在才放行窗口显示（不会露出主窗口）
              markReady();
            } else {
              restoreAttempts += 1;
              dockRetryAt = Date.now() + DOCK_RETRY_MS;
              if (restoreAttempts >= RESTORE_MAX_ATTEMPTS) {
                pendingRestore = null;
                persistedCenter = null;
                console.warn("[edge-snap] 重启恢复停靠连续失败，已停止重试", {
                  edge,
                  attempts: restoreAttempts,
                });
                // 放弃恢复：陈旧停靠记录已不可用，清掉后再放行显示，
                // 避免每次启动都重复一次「空白 → 恢复失败」的循环。
                void persistSnap(null, false, null);
                markReady();
              }
            }
          }
          return;
        }
        case "candidate": {
          // 光标读取失败（受限会话等环境）不得卡死整个确认路径：按「不在窗内」
          // 处理，松手判定交给更可靠的 DOM 指针哨兵（拖拽期间无指针事件，恢复
          // 即松手）。否则 candidate 既不确认也不超时，吸附提示永久残留。
          const cursor = await cursorPosition().catch(() => null);
          if (disposed) return;
          const now = Date.now();
          const sinceMove = now - lastMoveAt;
          const { rect, monitor } = await fetchRect();
          if (disposed || !monitor) return;
          // 静默期后收到过 DOM 指针事件 = 原生拖拽已结束（拖拽期间无 DOM 指针事件）
          const domAfterMove = domPointerAt > lastMoveAt;
          const inside =
            cursor !== null &&
            cursor.x >= rect.x && cursor.x <= rect.x + rect.w && cursor.y >= rect.y && cursor.y <= rect.y + rect.h;
          // 区域失准期间不再反复尝试停靠（每次尝试都会写区域）：先让有界恢复
          // 把原生校准回当前相位，恢复成功后的下一拍再走正常确认。
          // 解除后的几何恢复（后台事务）未收尾时同样延迟：恢复与停靠都在写
          // 窗口尺寸/位置，交错会让双方回读验证互相失败。恢复有界（等静默
          // 1500ms + 稳定回读 ×4 次重试），延迟期间候选提示保持，用户意图不丢。
          if (
            !regionUnknown &&
            !restoreInFlight &&
            now >= dockRetryAt &&
            shouldConfirmDock(machine.phase, machine.edge, sinceMove, inside, domAfterMove) &&
            machine.edge
          ) {
            await dockTo(machine.edge, alongCenterOf(machine.edge, rect), "docked-visible", true);
          } else if (
            !regionUnknown &&
            !restoreInFlight &&
            shouldExpireCandidate(machine.phase, sinceMove)
          ) {
            setPhase("free"); // 提示兜底超时：松手光标未离开窗口时不永久残留
          }
          return;
        }
        case "docked-visible":
        case "docked-revealed": {
          // 光标读取失败按「离开交互区」处理（有 450ms 连续离开确认兜底，
          // 不会立刻收起）；同 candidate：读取异常不得中止本拍其余判定
          //（拖离解除、沿边重定位都依赖这拍继续执行）。
          const cursor = await cursorPosition().catch(() => null);
          if (disposed) return;
          const now = Date.now();
          const edge = machine.edge;
          if (!edge) return;
          if (!dockedMonitor) {
            const { monitor } = await fetchRect();
            if (!monitor) return;
            dockedMonitor = memorizeMonitor(monitor);
          }
          const m = dockedMonitor;
          const rect = await fetchRectOnly();
          if (disposed) return;
          // 命中判定用**可见区域**（折叠只有轨道、展开是轨道∪面板）：
          // 窗口矩形在折叠态有 400×420，按整窗判定会让自动收起永远不触发。
          const regions = capsuleRegionsPhysical(
            rect.w,
            rect.h,
            edge,
            machine.phase === "docked-revealed",
            m.scaleFactor,
          );
          const local = cursor ? { x: cursor.x - rect.x, y: cursor.y - rect.y } : null;
          // 外扩容差 = 轨道与面板之间的间隙宽度：鼠标从轨道移到面板不会被判成离开
          const inZone = local !== null && pointInCapsule(local, regions, CAPSULE_HIT_SLOP);
          if (inZone) {
            leftSince = null;
          } else if (leftSince === null) {
            leftSince = now;
          }
          // 展开态（docked-revealed）改为**用户主动关闭**：面板承载任务、Agent 状态、
          // 剪贴板这类需要持续查看的内容，鼠标移出、焦点切到别的应用或长时间无操作
          // 都不得自动收起；关闭只经由重复点当前分类 / 收起按钮 / Escape。
          // 折叠态轨道（docked-visible）保留原有「空闲收成触发条」行为，避免窗口
          // 一直露在屏幕上（用户主动收起后仍保持折叠）。
          // 菜单/对话框交互中同样不收起（hasAutoHideBlockingOverlay 只对折叠态生效）。
          const overlayOpen = hasAutoHideBlockingOverlay();
          if (
            machine.phase === "docked-visible" &&
            !inZone &&
            !overlayOpen &&
            shouldHideAfterLeave(leftSince, now)
          ) {
            await collapseToRail(true); // 折叠态空闲：收成触发条
            return;
          }
          // 沿边重定位：停靠期窗口可沿边滑动，松手后把沿边位置写回基准。
          commitAlong(rect);
          // 拖离解除：**法向**位移超过阈值且非程序移动 = 用户拖离意图。
          // 只看法向——沿边滑动 24px 不是拖离（旧实现按两轴绝对值会误解除），
          // 阈值与原生 `COMMIT_DRAG_CSS` 同值，两套规则指向同一物理量。
          const sinceMove = now - lastMoveAt;
          if (dockedPos && sinceMove >= SNAP_DRAG_SETTLE_MS) {
            if (shouldUndockByDrag(rect, dockedPos, edge)) {
              if (now >= undockRetryAt && !snapMoveGuard.isProgrammaticMove(rect.x, rect.y)) {
                await undockByDrag();
              }
            } else {
              undockCheckDue = false;
            }
          }
          // 显示器工作区/DPI 低频校准（P2-3）：拖动中不做，避免抢用户位置。
          if (sinceMove >= SNAP_DRAG_SETTLE_MS && ++healthCheckTick % 20 === 0) {
            await refreshDockedMonitor();
          }
          return;
        }
        case "docked-hidden": {
          // 折叠态不需要光标轮询（点击轨道即可展开，不做悬停自动展开——
          // 悬停自动展开/收起正是历史上"来回跳动"的来源）。
          // 只保留两类低成本检查：
          // 1) 拖拽收尾的一次性解除判定（`undockCheckDue` 由 handleMoved 置位）——
          //    原生磁力未达阈值时会回弹贴平，这里只处理真正被拖离的；
          // 2) 低频可见性健康检查（显示器热插拔 / 系统挪窗）。
          if (undockCheckDue || (undockRetryAt > 0 && Date.now() >= undockRetryAt)) {
            const rect = await fetchRectOnly();
            if (disposed) return;
            const settled = Date.now() - lastMoveAt >= SNAP_DRAG_SETTLE_MS;
            if (settled) {
              const deviated =
                machine.edge !== null &&
                dockedPos !== null &&
                shouldUndockByDrag(rect, dockedPos, machine.edge);
              if (deviated && Date.now() >= undockRetryAt) {
                await undockByDrag();
                undockCheckDue = false;
                return;
              }
              if (!deviated) {
                undockCheckDue = false;
                undockRetryAt = 0; // 已回到停靠位：无需再补解除
              }
            }
            // 折叠态同样支持沿边重定位（拖动中只更新内存基准）
            commitAlong(rect);
          }
          if (++healthCheckTick % 20 === 0) {
            await refreshDockedMonitor();
            await recoverVisibility();
          }
          return;
        }
        case "docked-tab": {
          // Edge Tab：不轮询光标、不自动展开/收起（手动形态）。
          // 拖动由 `dragTabBy` 直接控制窗口沿边位置；静止后只落库一次。
          if (tabAnimating) return;
          if (Date.now() - lastMoveAt >= SNAP_DRAG_SETTLE_MS) {
            const rect = await fetchRectOnly();
            if (disposed) return;
            commitAlong(rect);
          }
          if (++healthCheckTick % 20 === 0) {
            await refreshDockedMonitor();
            await recoverVisibility();
          }
          return;
        }
        case "docked-full": {
          // 完整面板：不轮询光标、不自动收缩（鼠标移出必须保持完整）。
          // 只保留拖拽收尾的解除判定与低频几何/可用区校准。
          const rect = await fetchRectOnly();
          if (disposed) return;
          const settled = Date.now() - lastMoveAt >= SNAP_DRAG_SETTLE_MS;
          if (settled) {
            if (undockCheckDue || (undockRetryAt > 0 && Date.now() >= undockRetryAt)) {
              const deviated =
                machine.edge !== null &&
                dockedPos !== null &&
                shouldUndockByDrag(rect, dockedPos, machine.edge);
              if (deviated && Date.now() >= undockRetryAt) {
                await undockByDrag();
                undockCheckDue = false;
                return;
              }
              if (!deviated) {
                undockCheckDue = false;
                undockRetryAt = 0;
              }
            }
            commitAlong(rect);
          }
          if (settled && ++healthCheckTick % 20 === 0) {
            // 分辨率变更 / 显示器断开 / 任务栏改位：刷新停靠显示器记忆并
            // 让完整面板仍在可用区内贴边（refresh 内部会调用 ensureFullDockFits）。
            // 拖动中不做（`settled=false`），避免和用户的沿边拖动抢位置。
            await refreshDockedMonitor();
            await recoverVisibility();
          }
          return;
        }
      }
    }

    /**
     * 完整面板的低频几何校准：只在实际偏离时写窗口 API（不是每拍轮询）。
     * 处理分辨率变更、副屏 DPI 变化、任务栏位置变化后「贴边但越界/离缝」的情况。
     */
    async function ensureFullDockFits(): Promise<boolean> {
      const edge = machine.edge;
      if (!edge || !dockedMonitor) return true;
      const rect = await fetchRectOnly();
      if (disposed) return true;
      const wa = dockedMonitor.workArea;
      const w = Math.max(1, Math.min(rect.w, wa.w));
      const h = Math.max(1, Math.min(rect.h, wa.h));
      const center = capsuleCenter ?? alongCenterOf(edge, rect);
      const pos = capsuleWindowRect(edge, wa, center, { w, h });
      const sizeChanged = w !== rect.w || h !== rect.h;
      const moved = pos.x !== rect.x || pos.y !== rect.y;
      if (!sizeChanged && !moved) return true;
      if (sizeChanged) {
        // setSize 成功不代表生效：回读不通过就不提交新的贴边几何。
        if (!(await resizeVerified(w, h))) return false;
        if (disposed) return false;
      }
      if (!(await moveVerified(pos.x, pos.y))) return false;
      if (disposed) return false;
      dockedPos = { x: pos.x, y: pos.y };
      dockedSize = { w, h };
      capsuleCenter = center;
      return true;
    }

    /**
     * 停靠态低频几何校准（P2-3）：显示器工作区/DPI/分辨率/任务栏变化后，
     * 记忆里的 `dockedMonitor` 会过期。这里按窗口当前所在屏重新取几何，
     * 仅当真实变化时才重新贴边：
     * - 胶囊：容器尺寸随 DPI 变化，位置随可用区变化（重算并回读校验）；
     * - 完整面板：收敛到新可用区并保持贴边。
     * 沿边中心按旧/新可用区比例映射，分辨率变化后不会跑到区外。
     * 校准失败不写记忆，交给下一轮健康检查重试，避免"记了新值但几何没跟上"。
     */
    async function refreshDockedMonitor(): Promise<void> {
      const edge = machine.edge;
      if (!edge || !isDockedPhase(machine.phase)) return;
      let monitors: MonitorLike[];
      try {
        monitors = await availableMonitors();
      } catch {
        return;
      }
      if (disposed || monitors.length === 0) return;
      const rect = await fetchRectOnly();
      if (disposed) return;
      const monitor = monitorForRect(rect, monitors);
      const prev = dockedMonitor;
      if (prev && !monitorGeometryChanged(prev, monitor)) return;
      const next = memorizeMonitor(monitor);
      const vertical = edge === "left" || edge === "right";
      let ratio: number | null = null;
      if (capsuleCenter !== null && prev) {
        const prevWA = prev.workArea;
        const prevSpan = vertical ? prevWA.h : prevWA.w;
        const prevOrigin = vertical ? prevWA.y : prevWA.x;
        if (prevSpan > 0) {
          ratio = Math.min(Math.max((capsuleCenter - prevOrigin) / prevSpan, 0), 1);
        }
      }
      const span = vertical ? next.workArea.h : next.workArea.w;
      const origin = vertical ? next.workArea.y : next.workArea.x;
      const center = ratio !== null ? origin + ratio * span : alongCenterOf(edge, rect);
      dockedMonitor = next;
      const ok =
        machine.phase === "docked-full"
          ? await ensureFullDockFits()
          : await ensureCapsuleGeometry(edge, next, center);
      if (disposed) return;
      if (!ok) {
        dockedMonitor = prev;
        return;
      }
      const after = await fetchRectOnly();
      if (disposed) return;
      commitAlong(after);
      persistDockedSnap(
        edge,
        isHiddenPhase(machine.phase),
        capsuleCenter ?? center,
        isTabPhase(machine.phase) ? "tab" : "capsule",
      );
      syncMagnetDock();
    }

    async function handleMoved(): Promise<void> {
      const { rect, monitor } = await fetchRect();
      if (disposed || !monitor) return;
      const wa = toWorkArea(monitor);
      // 手势起点在监听器里同步记录（首拍评估可能被 busy 丢弃，不能在这里补判）。
      if (!gestureStartRect) gestureStartRect = lastSeenRect ?? { ...rect };
      lastSeenRect = { ...rect };
      if (isDockedPhase(machine.phase)) {
        const edge = machine.edge;
        if (!edge) return;
        // 程序性尺寸变化（外部模式切换 / 缩放）不是拖离意图：右/下边缩小宽度
        // 会制造 >38 的“离开磁吸区”假象。这里先按当前形态收敛尺寸并重新贴边，
        // 再清掉偏离标记，避免误解除停靠。
        if (
          dockedSize &&
          (Math.abs(rect.w - dockedSize.w) > 1 || Math.abs(rect.h - dockedSize.h) > 1)
        ) {
          const full = machine.phase === "docked-full";
          const container = capsuleContainerSize(edge);
          const want = full
            ? { w: Math.min(rect.w, wa.w), h: Math.min(rect.h, wa.h) }
            : {
                w: toPhysical(container.w, monitor.scaleFactor ?? 1),
                h: toPhysical(container.h, monitor.scaleFactor ?? 1),
              };
          if (want.w !== rect.w || want.h !== rect.h) {
            // 程序性收敛同样要回读确认：尺寸没真正生效时不能提交新几何。
            if (!(await resizeVerified(want.w, want.h))) return;
            if (disposed) return;
          }
          const center = capsuleCenter ?? alongCenterOf(edge, rect);
          const pos = capsuleWindowRect(edge, wa, center, want);
          if (!(await moveVerified(pos.x, pos.y))) return;
          if (disposed) return;
          dockedPos = { x: pos.x, y: pos.y };
          dockedSize = want;
          capsuleCenter = center;
          undockCheckDue = false;
          undockRetryAt = 0;
          return;
        }
        // 拖离意图标记：法向位移越过解除阈值就置位，由 tick 在静止后收尾。
        // 折叠态（docked-hidden）不做轮询，没有这个标记就会"拖出去停在半脱开"。
        if (dockedPos && shouldUndockByDrag(rect, dockedPos, edge)) {
          undockCheckDue = true;
        }
        const other = detectCandidateEdge(rect, wa);
        // 跨边切换必须先真正离开当前边的磁吸区：窗口仍齐平在当前边时，
        // 角落处另一条边的距离也可能为 0，仅按「更近」判定会把沿边上下
        // 拖动误判成换边（先解除停靠、松手后按偏好重新吸附 → 变回胶囊）。
        if (other && other !== edge && shouldSwitchDockEdge(rect, wa, edge)) {
          // 拖向另一条边：先完整解除（清区域 + 恢复尺寸 + 清持久化），
          // 再进入新边候选——只改 phase 会留下胶囊区域，窗口仍是裁剪形态。
          // 解除没成功就必须停在原边：先改 machine.edge，下一拍 tick 会按新边
          // 几何做命中判定，而原生区域还裁在旧边 → 轨道与判定区错开，
          // 光标明明停在可见胶囊上却被判成「离开」，面板被误收起。
          // 失败后的 1s 冷却避免拖拽期间每个 onMoved 都重发 off。
          if (Date.now() < undockRetryAt) return;
          if (!(await undockCore())) return;
          machine.edge = other;
          if (setPhase("candidate")) {
            setMagnetized(edgeDistance(rect, wa, other) <= SNAP_CANDIDATE_ENTER_DIST);
          }
          return;
        }
        // 磁吸滞回：> EXIT_DIST 才解除（进入/退出阈值间的死区保持停靠，
        // 避免阈值抖动）。onMoved 驱动 = 拖拽进行中，走鼠标锚定解除。
        if (
          Date.now() >= undockRetryAt &&
          shouldLeaveMagnetRange(edgeDistance(rect, wa, edge))
        ) {
          await undockCore(undefined, true);
        }
        return;
      }
      // free / candidate：滞回判定
      const detected = detectCandidateEdge(rect, wa);
      // 程序性移动（解除后的几何恢复 / 兜底定位等引擎写入）不是用户手势：
      // 不入轨迹、不评吸附意图——否则恢复事务把窗口搬近某条边时会被误判成
      // 「用户拖向边缘」而凭空进入候选、静默后自动停靠。
      const programmaticMove = snapMoveGuard.isProgrammaticMove(rect.x, rect.y);
      if (!programmaticMove) {
        // 记录本次手势的观测轨迹（有界）；最近两拍的方向用于拒绝「被磁力带回 /
        // 平行擦边」这类没有主动靠拢意图的拖动。
        gestureTrail.push({ ...rect });
        if (gestureTrail.length > GESTURE_TRAIL_MAX) gestureTrail.shift();
      }
      if (machine.phase === "candidate" && machine.edge) {
        if (detected && detected !== machine.edge) {
          machine.edge = detected; // 更近的另一条边（拖过角落）
          setMagnetized(edgeDistance(rect, wa, detected) <= SNAP_CANDIDATE_ENTER_DIST);
          return;
        }
        const d = edgeDistance(rect, wa, machine.edge);
        if (shouldLeaveMagnetRange(d)) {
          setPhase("free"); // > 42 才退出 candidate（滞回死区防抖）
        } else {
          setMagnetized(d <= SNAP_CANDIDATE_ENTER_DIST);
        }
        return;
      }
      if (detected && !programmaticMove) {
        // 几何命中（进入吸附区）不等于吸附意图：自由窗口贴边平行拖动，或只是
        // 被磁力领先吸进阈值，都不应因此吸附并收缩。只有相对手势起点向该边
        // 净位移超过「磁力领先上限 + 余量」才进入候选；明确拖向边缘的释放
        // 仍由 `shouldConfirmDock` 在静止后正常确认。
        // 起点优先用「按下时」的真实矩形，而不是首个观测点：快速拖动时首拍可能
        // 已是合并后的大位移，净位移会被算小而漏判成「没往边缘去」。
        const start = gestureStartRect ?? lastSeenRect ?? rect;
        if (
          !hasDockIntentAlongTrail(start, gestureTrail, wa, detected, monitor.scaleFactor ?? 1)
        )
          return;
        machine.edge = detected;
        setPhase("candidate");
        setMagnetized(edgeDistance(rect, wa, detected) <= SNAP_CANDIDATE_ENTER_DIST);
      }
    }

    /** 互斥执行；busy 期间记录最近一个评估，释放后尾随补跑（不丢关键移动更新）。 */
    const runExclusive = (fn: () => Promise<unknown>): void => {
      if (disposed) return;
      if (busy) {
        queuedEval = fn;
        return;
      }
      busy = true;
      Promise.resolve()
        .then(fn)
        .catch(() => {})
        .finally(() => {
          busy = false;
          const q = queuedEval;
          queuedEval = null;
          if (q && !disposed) runExclusive(q);
        });
    };

    /**
     * 需要拿到结果的互斥执行（形态切换等用户显式操作）。
     *
     * 与 `runExclusive` 的差别：忙时**有界等待**而不是把任务塞进尾随队列——
     * 尾随队列没有返回值，调用方无从判断成功/失败，就无法做偏好回滚。
     * 等待上限 1s；仍忙则返回 `undefined`（延后到下一轮用户操作），
     * 绝不并发执行几何写入。
     */
    async function runExclusiveResult<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (disposed) return undefined;
      for (let i = 0; busy && i < 40; i += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
      }
      if (disposed) return undefined;
      if (busy) {
        console.warn("[edge-snap] 引擎持续忙碌，停靠形态切换已延后");
        return undefined;
      }
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
        const q = queuedEval;
        queuedEval = null;
        if (q && !disposed) runExclusive(q);
      }
    }

    const runTick = (): void => runExclusive(tickBody);

    // ── 订阅 ────────────────────────────────────────────────

    const scope = createSubscriptionScope();
    scope.add(
      win.onMoved(() => {
        const now = Date.now();
        // 手势边界在监听器里同步判定：busy 时 `runExclusive` 只保留最后一次
        // 评估，若把起点判定放进 handleMoved，首拍被丢弃会丢失真实起点。
        // 按下即新起点（不受上一次手势 220ms 静止窗口影响）：快速拖动时首个
        // onMoved 可能已是合并后的大位移，只有按下时的矩形才是真实起点。
        const pressIsNew = pressOriginRect !== null && pressOriginAt > lastMoveAt;
        if (lastSeenRect === null || now - lastMoveAt >= SNAP_DRAG_SETTLE_MS || pressIsNew) {
          gestureStartRect = (pressIsNew ? pressOriginRect : lastSeenRect) ?? null;
          gestureTrail = [];
        }
        lastMoveAt = now; // 同步记录：拖拽活动信号不受 busy 影响
        runExclusive(handleMoved);
      }),
    );
    // 唤回：托盘/快捷键 → 展开功能面板（窗口本身始终可见，无需"找回"）
    scope.add(onSnapRecall(() => runExclusive(expandPanel)));

    // DOM 指针事件哨兵：原生标题栏拖拽（Win32 移动循环）期间 WebView2 收不到
    // 指针事件；恢复收到 = 拖拽已结束。用于磁吸释放确认。
    const onDomPointer = (): void => {
      domPointerAt = Date.now();
    };
    // 按下时记录真实窗口矩形（手势起点）。只在自由/候选态的拖拽区域触发：
    // 普通点击与停靠态的拖离/沿边拖动已有各自路径，不需要额外 IPC。
    const onDomPointerDown = (event: PointerEvent): void => {
      domPointerAt = Date.now();
      if (machine.phase !== "free" && machine.phase !== "candidate") return;
      // 解除后用户触碰窗口任意位置即视为接管：锚定兜底重定位让位（见
      // undockCore 的恢复事务）。程序性搬动不该与用户操作同时发生。
      undockUserInteracted = true;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest("[data-tauri-drag-region]")) return;
      capturePressOrigin();
    };
    window.addEventListener("pointermove", onDomPointer, { passive: true });
    window.addEventListener("pointerdown", onDomPointerDown, { passive: true });

    // 重启恢复：读取持久化 snap_state，交给 tick 串行执行（避免与 onMoved 竞态）。
    void (async () => {
      try {
        const saved = await getSnapState();
        if (disposed) return;
        if (saved && isSnapEdge(saved.edge)) {
          pendingRestore = {
            edge: saved.edge,
            center:
              typeof saved.center === "number" && Number.isFinite(saved.center)
                ? saved.center
                : null,
            centerRatio:
              typeof saved.centerRatio === "number" && Number.isFinite(saved.centerRatio)
                ? saved.centerRatio
                : null,
            display: saved.display ?? null,
            form: saved.form === "tab" ? "tab" : "capsule",
          };
        } else {
          // 无停靠记录：窗口无需等恢复，立即放行显示
          markReady();
        }
      } catch {
        // 读取失败按未停靠处理（不阻塞窗口显示）
        markReady();
      }
    })();

    ui.setReveal(() => runExclusive(expandPanel));
    ui.setCollapse(() => runExclusive(collapsePanel));
    ui.setUndock((mode) => runExclusive(() => undockCore(mode)));
    // 形态入口（胶囊轨道 / 完整面板按钮）：**本次停靠会话的临时切换**，不改写
    // 持久化 `snap_display_mode`；设置页与右键菜单仍走 `requestDockForm`（长期偏好）。
    // 两种入口复用同一套几何与相位事务，只是成功/失败后的偏好处理不同。
    ui.setFormSwitch((form) => {
      void requestSessionForm(form);
    });
    // Edge Tab：与 reveal/collapse 相同，进入引擎串行队列，避免和 tick / 停靠事务竞争。
    ui.setTabActions({
      collapse: () => {
        void runExclusiveResult(() => collapseToTab());
      },
      restore: () => {
        void runExclusiveResult(() => restoreFromTab());
      },
      beginDrag: beginTabDrag,
      dragBy: dragTabBy,
      endDrag: endTabDrag,
    });

    const unsubSettings = useSettingsStore.subscribe((state, prev) => {
      if (disposed) return;
      const nextForm = dockFormFromSetting(state.settings?.snap_display_mode);
      const prevForm = dockFormFromSetting(prev.settings?.snap_display_mode);
      if (nextForm !== prevForm) {
        // 浮动态：只记住偏好，不强行移动窗口；已停靠：原地切换形态。
        void requestDockForm(nextForm);
      }
      // 完整面板贴边后改变模式尺寸：apply_mode 只改尺寸不会重新贴齐，
      // 用同一事务重新算一次齐平位置（胶囊态由容器尺寸接管，无需处理）。
      if (state.settings?.mode !== prev.settings?.mode) {
        runExclusive(async () => {
          if (machine.phase !== "docked-full" || !machine.edge) return;
          const center = capsuleCenter ?? alongCenterOf(machine.edge, await fetchRectOnly());
          await dockFull(machine.edge, center, false, true);
        });
      }
    });

    // 磁力参数下发（一次，非逐帧）：原生侧据此在 WM_MOVING 里修正移动矩形。
    void setMagneticDragConfig(
      true,
      SNAP_MAGNET_RANGE,
      SNAP_MAGNET_MAX_LEAD,
      SNAP_MAGNET_RELEASE,
    ).catch(() => {
      // 下发失败只影响手感（退化为纯阈值吸附），不影响停靠正确性
    });

    // 记录启动时的静止矩形：用户第一次拖拽的手势起点（只读一次，不轮询）。
    // 之后每次 onMoved 都会刷新，程序性移动同样会有 onMoved，起点不会过期。
    void fetchRectOnly()
      .then((rect) => {
        if (!disposed) lastSeenRect = rect;
      })
      .catch(() => {});

    const timer = window.setInterval(runTick, SNAP_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("pointermove", onDomPointer);
      window.removeEventListener("pointerdown", onDomPointerDown);
      scope.dispose();
      unsubSettings();
      ui.setReveal(null);
      ui.setCollapse(null);
      ui.setUndock(null);
      ui.setFormSwitch(null);
      ui.setTabActions({
        collapse: null,
        restore: null,
        beginDrag: null,
        dragBy: null,
        endDrag: null,
      });
      ui.setTabTransition(null);
      snapMoveGuard.setHidden(false);
      // 磁力层随引擎一起停用：残留的停靠基准会让下一次普通拖拽被"拉住"。
      // 与区域一样延后一个宏任务再决定——StrictMode 重挂载时新实例会先递增
      // 世代号，旧实例此时不得把新实例刚打开的参数关掉（IPC 顺序不保证）。
      // 延迟一个宏任务再决定是否清区域：StrictMode 会在同一轮里立即重挂载新实例
      // （世代号前进），此时旧实例的 off 会覆盖新实例的 rail/panel，
      // 造成「Win32 已恢复整窗 / React 进了胶囊」。仅当无人接管时才清理。
      const myEpoch = epoch;
      const wasDocked = isDockedPhase(machine.phase);
      window.setTimeout(() => {
        if (engineEpoch !== myEpoch) return;
        void setMagneticDock(null).catch(() => {});
        void setMagneticDragConfig(
          false,
          SNAP_MAGNET_RANGE,
          SNAP_MAGNET_MAX_LEAD,
          SNAP_MAGNET_RELEASE,
        ).catch(() => {});
        if (wasDocked) {
          void setCapsuleRegion("off");
          void persistSnap(null, false, null);
          const mode = resolveWindowMode(useSettingsStore.getState().settings?.mode);
          void applyMode(mode).catch(() => {});
        } else {
          void setCapsuleRegion("off");
        }
        useEdgeSnapStore.getState().reset();
      }, 0);
    };
  }, [enabled]);
}

/** 窗口位置/大小持久化（防抖 + 防污染）。
 *
 * - 程序 setPosition（吸附引擎/模式切换等）触发的 onMoved 不写入 window_rect
 *   （snapMoveGuard 目标匹配 + TTL 过期兜底）；
 * - **停靠期间一律不写**：此时窗口被撑成胶囊容器（400×420），不是用户窗口几何；
 * - 保存前用 isRectMostlyVisible 校验（多屏 / 负坐标 / 断连防护）。
 */
export function useWindowPersistence() {
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: number | undefined;
    let disposed = false;

    const saveNow = async () => {
      try {
        if (snapMoveGuard.isPersistenceSuppressed()) return; // 隐藏态 / 停靠回滚期间不持久化
        if (isDockedPhase(useEdgeSnapStore.getState().phase)) return; // 停靠态不持久化
        const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
        const rect = { x: pos.x, y: pos.y, w: size.width, h: size.height };
        if (snapMoveGuard.isProgrammaticMove(rect.x, rect.y)) return; // 程序移动不污染
        // 胶囊容器尺寸不是用户几何（解除后尺寸未恢复时的兜底，见 restoreModeSize）
        if (isCapsuleContainerSize(rect, window.devicePixelRatio || 1)) return;
        const monitors = await availableMonitors();
        if (!isRectMostlyVisible(rect, monitors.map(toArea))) return;
        await saveWindowRect(rect);
      } catch {
        // 忽略
      }
    };

    const schedule = () => {
      if (disposed) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void saveNow();
      }, 600);
    };

    const scope = createSubscriptionScope();
    scope.add(win.onMoved(schedule));
    scope.add(win.onResized(schedule));
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      scope.dispose();
    };
  }, []);
}

/** 兼容导出：旧调用方引用的胶囊 CSS 尺寸（现在指向分类胶囊轨道）。 */
export { RAIL_LENGTH_CSS as SNAP_CAPSULE_LENGTH_CSS, RAIL_THICKNESS_CSS as SNAP_CAPSULE_THICKNESS_CSS } from "../lib/capsuleLayout";
