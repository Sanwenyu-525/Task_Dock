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
//! - 展开：区域 = 轨道 ∪ 面板（336×420，中间 8px 间隙不连通）。
//! 区域切换是原子操作，轨道在屏幕上的位置与尺寸全程不变，命中区因此稳定。
//!
//! 由此可以删掉一批旧机制（它们只在"窗口滑出屏幕"时才需要）：
//! 离屏位置计算、restore 坐标校验、接缝禁止自动隐藏、隐藏态不可见兜底恢复。
//! 保留的仍然是：时间积分防抖、磁吸滞回、候选边判定、拖拽解除、
//! window_rect 防污染、持久化串行、busy 互斥与尾随补评估。

import { useEffect } from "react";
import { getCurrentWindow, cursorPosition, currentMonitor } from "@tauri-apps/api/window";
import { availableMonitors } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import {
  applyMode,
  applyWindowCapsule,
  getSnapState,
  onSnapRecall,
  saveSnapState,
  saveWindowRect,
  type CapsuleRegionMode,
} from "../lib/bridge";
import { createSubscriptionScope } from "../lib/subscriptions";
import { topOverlay } from "../lib/overlayStack";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { useSettingsStore } from "../store/useSettingsStore";
import {
  SNAP_CANDIDATE_ENTER_DIST,
  SNAP_DRAG_SETTLE_MS,
  SNAP_POLL_MS,
  SNAP_UNDOCK_DRAG_PX,
  canTransition,
  detectCandidateEdge,
  edgeDistance,
  isDockedPhase,
  isRectMostlyVisible,
  isSnapEdge,
  shouldConfirmDock,
  shouldExpireCandidate,
  shouldHideAfterLeave,
  shouldLeaveMagnetRange,
  snapMoveGuard,
  type SnapArea,
  type SnapEdge,
  type SnapPhase,
  type SnapPoint,
  type SnapRect,
} from "../lib/edgeSnap";
import {
  CAPSULE_GAP_CSS,
  alongCenterOf,
  capsuleContainerSize,
  capsuleRegionsPhysical,
  capsuleWindowRect,
  isCapsuleContainerSize,
  needsContainerResize,
  pointInCapsule,
  toPhysical,
} from "../lib/capsuleLayout";

// ── Tauri 类型结构化别名 ────────────────────────────────────

interface MonitorLike {
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
}

function memorizeMonitor(m: MonitorLike): DockedMonitor {
  return {
    workArea: toWorkArea(m),
    bounds: toArea(m),
    scaleFactor: typeof m.scaleFactor === "number" && m.scaleFactor > 0 ? m.scaleFactor : 1,
  };
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
): Promise<void> {
  return enqueueWrite(async () => {
    try {
      await saveSnapState(edge ?? "none", hidden, center);
    } catch {
      // 持久化失败不阻塞吸附行为（重启后最多回到可见态）
    }
  });
}

export function useEdgeSnap(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
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
    let pendingRestore: { edge: SnapEdge; center: number | null } | null = null;
    let restoreAttempts = 0; // 重启恢复的有界重试计数
    let dockedMonitor: DockedMonitor | null = null; // 停靠显示器记忆
    let dockedPos: SnapPoint | null = null; // 停靠时窗口目标位置（偏离判定基准）
    let capsuleCenter: number | null = null; // 胶囊沿边中心（物理像素）
    let magnetizedNow = false; // candidate 是否在磁吸区（≤28；仅在变化时同步 store）
    const machine: SnapMachine = { phase: "free", edge: null };

    function syncUi() {
      ui.sync({
        phase: machine.phase,
        candidateEdge: machine.phase === "candidate" ? machine.edge : null,
        magnetized: machine.phase === "candidate" ? magnetizedNow : false,
        dockedEdge: isDockedPhase(machine.phase) ? machine.edge : null,
      });
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
      // 停靠相位必须带停靠边：App 以 (phase, dockedEdge) 判定是否进入胶囊模式，
      // 缺边时既不能隐藏主界面、也没有胶囊可渲染。这里把不变量锁在唯一提交点，
      // 而不是让 UI 层各自兜底。
      if (isDockedPhase(next) && !machine.edge) return false;
      if (next === "free" && regionUnknown) return false;
      if (!canTransition(machine.phase, next)) return false;
      machine.phase = next;
      if (next === "free") {
        machine.edge = null;
        dockedMonitor = null;
        dockedPos = null;
        capsuleCenter = null;
        leftSince = null;
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

    let regionSeq = 0;
    let desiredRegion: { mode: CapsuleRegionMode; edge: SnapEdge } = { mode: "off", edge: "left" };
    /**
     * 原生区域是否与 UI 相位失准（写入/回读失败且校准也失败）。
     * 为 true 时：禁止把相位推进到任何「需要假定某个区域已生效」的状态，
     * 尤其禁止进入 free（free 会被 UI 解读为完整窗口）；按有界退避自动校准。
     */
    let regionUnknown = false;
    let regionRecoveryAttempts = 0;
    let regionRecoveryAt = 0;
    /** 自动解除（拖离 / 跨边）失败后的下次允许时刻；用户显式解除不受此限制。 */
    let undockRetryAt = 0;
    /** 停靠失败后的候选重试时刻：失败路径也要有界退避，不能逐 tick 重试。 */
    let dockRetryAt = 0;

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
      }
    }

    /**
     * 单次区域应用（带 IPC 超时）。
     * 超时/异常一律返回 false：调用方不得把「发出了请求」当成「原生已生效」；
     * 迟到的 invoke 结果由 `regionSeq` 作废，不会覆盖后续状态。
     */
    async function applyRegionWithTimeout(mode: CapsuleRegionMode, edge: SnapEdge): Promise<boolean> {
      let timer: number | undefined;
      try {
        const result = await Promise.race([
          applyWindowCapsule(mode, edge),
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
     * 返回 false = 后端报告未应用（含 GetWindowRgn 回读验证失败）、IPC 异常/超时；
     * 响应迟到且期间有更新命令：结果作废并按最新期望**重同步**一次。
     * 成功时同步清除「区域失准」标记；失败时标记失准并交给有界恢复。
     */
    async function setCapsuleRegion(mode: CapsuleRegionMode): Promise<boolean> {
      const edge = machine.edge ?? "left";
      const seq = ++regionSeq;
      desiredRegion = { mode, edge };
      const ok = await applyRegionWithTimeout(mode, edge);
      if (disposed) return false;
      if (seq !== regionSeq) {
        void applyWindowCapsule(desiredRegion.mode, desiredRegion.edge).catch(() => {});
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
        return;
      }
      regionRecoveryAt = Date.now() + REGION_RECOVERY_BASE_MS * 2 ** regionRecoveryAttempts;
    }

    /** 相位 → 区域形态的唯一映射（恢复时据此把区域校准回已提交状态）。 */
    function regionForPhase(phase: SnapPhase): CapsuleRegionMode {
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
      capsuleCenter = null;
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
      if (!current || current.w !== target.w || current.h !== target.h) {
        try {
          await win.setSize(new PhysicalSize(target.w, target.h));
          if (current) current = { ...current, w: target.w, h: target.h };
        } catch {
          ok = false;
          console.warn("[edge-snap] 停靠回滚恢复窗口尺寸失败", { target });
        }
      }
      if (!current || current.x !== target.x || current.y !== target.y) {
        if (!(await moveWindow(target.x, target.y, true))) {
          ok = false;
          console.warn("[edge-snap] 停靠回滚恢复窗口位置失败", { target });
        }
      }
      return ok;
    }

    /**
     * 停靠到某条边：撑到容器尺寸 → 贴边齐平（胶囊沿边居中）→ 区域切到轨道。
     * `phase` 由调用方决定（重启恢复直接进 docked-hidden，无反馈）。
     * 任一后续步骤失败都必须回滚已发生的尺寸/位置变化，避免留下一个被放大
     * 且贴边的普通窗口（以及被污染的 window_rect）。
     */
    async function dockTo(
      edge: SnapEdge,
      center: number,
      phase: "docked-visible" | "docked-hidden",
      feedback: boolean,
    ): Promise<boolean> {
      const { monitor } = await fetchRect();
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
        try {
          // 停在容器尺寸（不是「只补不足」）：Aero Snap 的半屏尺寸也在停靠时收拢，
          // 否则停靠期会留下 1280×690 之类的异常大窗口。
          await win.setSize(new PhysicalSize(want.w, want.h));
          rect = { ...rect, w: want.w, h: want.h };
        } catch {
          // 撑不到容器尺寸：区域会退化为只显示轨道（后端有同款兜底）
        }
      }
      machine.edge = edge;
      const pos = capsuleWindowRect(edge, dockedMonitor.workArea, center, {
        w: rect.w,
        h: rect.h,
      });
      // 移动失败 = 窗口没落到贴边齐平位。区域按**窗口局部坐标**裁剪，轨道会画在
      // 屏幕错误位置；更糟的是 dockedPos 成为幻影基准，下一拍偏离判定
      // （|rect - dockedPos| > 24）必然成立 → 误判「用户拖离」并自动解除。
      if (!(await moveWindow(pos.x, pos.y, true))) {
        await restoreDockGeometry(prevRect, dockedMonitor.workArea);
        dockRetryAt = Date.now() + DOCK_RETRY_MS;
        abortDock(prevEdge);
        return false;
      }
      dockedPos = { x: pos.x, y: pos.y };
      capsuleCenter = center;
      // 区域成功后才提交停靠相位；失败时回滚几何 + 清掉本次半成立的停靠上下文
      if (!(await setRegionThenPhase("rail", phase))) {
        await restoreDockGeometry(prevRect, dockedMonitor.workArea);
        dockRetryAt = Date.now() + DOCK_RETRY_MS;
        abortDock(prevEdge);
        return false;
      }
      dockRetryAt = 0;
      if (feedback) ui.notifyDocked(edge);
      void persistSnap(edge, phase === "docked-hidden", center);
      return true;
    }

    /** 折叠：只保留轨道（面板收起）。窗口不动，只切区域。 */
    async function collapseToRail(hidden: boolean): Promise<boolean> {
      if (!machine.edge) return false;
      const ok = await setRegionThenPhase("rail", hidden ? "docked-hidden" : "docked-visible");
      if (ok) void persistSnap(machine.edge, hidden, capsuleCenter);
      return ok;
    }

    /** 展开：露出轨道 + 功能面板。窗口不动，只切区域。 */
    async function expandPanel(): Promise<boolean> {
      if (!machine.edge) return false;
      if (machine.phase === "docked-revealed") return true;
      if (machine.phase !== "docked-hidden" && machine.phase !== "docked-visible") return false;
      // 展开不依赖分类状态：`useCapsuleStore.active` 恒有值，托盘 / 热键 / 重启恢复
      // 只切相位也能拿到明确面板，不存在「区域已裁好、面板内容为空」的空白态。
      const ok = await setRegionThenPhase("panel", "docked-revealed");
      if (!ok) return false;
      leftSince = null;
      void persistSnap(machine.edge, false, capsuleCenter);
      return true;
    }

    /** 收起功能面板（Esc / 收起按钮 / 再次点击当前分类）。 */
    async function collapsePanel(): Promise<boolean> {
      if (machine.phase !== "docked-revealed") return true;
      return collapseToRail(false);
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

    /** 解除吸附核心：清区域 → 退出停靠 → 恢复模式尺寸并收回工作区。
     *  `targetMode` 由「打开完整页」传入（避免先恢复旧模式再切新模式的两次缩放）。 */
    async function undockCore(targetMode?: string): Promise<boolean> {
      if (!machine.edge) return false;
      // 停靠期缩放系数：setPhase(free) 会清空 dockedMonitor，先取出来用于尺寸回读。
      const scale = dockedMonitor?.scaleFactor ?? 1;
      pendingRestore = null; // 用户意图优先：不得再被重启恢复队列拉回停靠
      // 区域必须真的清掉才算解除：失败时保持停靠相位（轨道仍可见可用），
      // 不允许出现「原生已裁成轨道 / React 显示完整主窗口」的假解除。
      let offOk = await setCapsuleRegion("off");
      if (!offOk) offOk = await setCapsuleRegion("off"); // 有界重试一次
      if (!offOk) {
        // 两次都失败：保持停靠相位（区域仍是轨道），并给自动路径一个重试间隔，
        // 避免拖离/跨边判定在每个 tick 都重发 off。
        undockRetryAt = Date.now() + UNDOCK_RETRY_MS;
        return false;
      }
      undockRetryAt = 0;
      setPhase("free");
      void persistSnap(null, false, null);
      // 停靠期间窗口被撑到胶囊容器尺寸：解除后恢复目标模式（默认当前模式）的尺寸
      const mode = targetMode ?? useSettingsStore.getState().settings?.mode ?? "full";
      await restoreModeSize(mode, scale);
      await clampIntoWorkArea();
      return true;
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
        const wa = toWorkArea(monitors[0] as MonitorLike);
        const x = Math.max(wa.x, Math.min(rect.x, wa.x + wa.w - rect.w));
        const y = Math.max(wa.y, Math.min(rect.y, wa.y + wa.h - rect.h));
        await moveWindow(x, y, true);
        void saveVisibleRect({ x, y, w: rect.w, h: rect.h });
      } catch {
        // 尽力而为
      }
    }

    /** 拖拽解除：用户把胶囊拖离停靠位超过阈值。不内推——窗口已在用户手上。 */
    async function undockByDrag(): Promise<void> {
      if (!(await undockCore())) return;
      const rect = await fetchRectOnly();
      if (disposed) return;
      void saveVisibleRect(rect);
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
        const wa = toWorkArea(monitors[0] as MonitorLike);
        const edge = machine.edge ?? "left";
        const center = capsuleCenter ?? (edge === "left" || edge === "right" ? wa.y + wa.h / 2 : wa.x + wa.w / 2);
        const pos = capsuleWindowRect(edge, wa, center, { w: rect.w, h: rect.h });
        if (await moveWindow(pos.x, pos.y, true)) {
          dockedPos = { x: pos.x, y: pos.y };
          capsuleCenter = center;
        }
      } catch {
        // 下轮 tick 重试
      }
    }

    // ── 评估：tick 与 onMoved（busy 互斥 + 尾随补评估）────────

    async function tickBody(): Promise<void> {
      if (disposed) return;
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
            const { edge, center } = pendingRestore;
            const rect = await fetchRectOnly();
            if (disposed) return;
            const fallback = alongCenterOf(edge, rect);
            const ok = await dockTo(edge, center ?? fallback, "docked-hidden", false);
            if (ok) {
              pendingRestore = null;
              restoreAttempts = 0;
            } else {
              restoreAttempts += 1;
              dockRetryAt = Date.now() + DOCK_RETRY_MS;
              if (restoreAttempts >= RESTORE_MAX_ATTEMPTS) {
                pendingRestore = null;
                console.warn("[edge-snap] 重启恢复停靠连续失败，已停止重试", {
                  edge,
                  attempts: restoreAttempts,
                });
              }
            }
          }
          return;
        }
        case "candidate": {
          const cursor = await cursorPosition();
          if (disposed) return;
          const now = Date.now();
          const sinceMove = now - lastMoveAt;
          const { rect, monitor } = await fetchRect();
          if (disposed || !monitor) return;
          // 静默期后收到过 DOM 指针事件 = 原生拖拽已结束（拖拽期间无 DOM 指针事件）
          const domAfterMove = domPointerAt > lastMoveAt;
          const inside = cursor.x >= rect.x && cursor.x <= rect.x + rect.w && cursor.y >= rect.y && cursor.y <= rect.y + rect.h;
          // 区域失准期间不再反复尝试停靠（每次尝试都会写区域）：先让有界恢复
          // 把原生校准回当前相位，恢复成功后的下一拍再走正常确认。
          if (
            !regionUnknown &&
            now >= dockRetryAt &&
            shouldConfirmDock(machine.phase, machine.edge, sinceMove, inside, domAfterMove) &&
            machine.edge
          ) {
            await dockTo(machine.edge, alongCenterOf(machine.edge, rect), "docked-visible", true);
          } else if (!regionUnknown && shouldExpireCandidate(machine.phase, sinceMove)) {
            setPhase("free"); // 提示兜底超时：松手光标未离开窗口时不永久残留
          }
          return;
        }
        case "docked-visible":
        case "docked-revealed": {
          const cursor = await cursorPosition();
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
          const local = { x: cursor.x - rect.x, y: cursor.y - rect.y };
          // 外扩容差 = 轨道与面板之间的间隙宽度：鼠标从轨道移到面板不会被判成离开
          const inZone = pointInCapsule(local, regions, CAPSULE_HIT_SLOP);
          if (inZone) {
            leftSince = null;
          } else if (leftSince === null) {
            leftSince = now;
          }
          const overlayOpen = topOverlay() !== undefined; // 菜单/对话框交互中不收起
          if (!inZone && !overlayOpen && shouldHideAfterLeave(leftSince, now)) {
            await collapseToRail(true); // 收起面板，回到轨道常驻
            return;
          }
          // 拖离解除：偏离停靠位超过阈值且非程序移动 = 用户拖离意图
          const sinceMove = now - lastMoveAt;
          if (dockedPos && sinceMove >= SNAP_DRAG_SETTLE_MS) {
            const deviated =
              Math.abs(rect.x - dockedPos.x) > SNAP_UNDOCK_DRAG_PX ||
              Math.abs(rect.y - dockedPos.y) > SNAP_UNDOCK_DRAG_PX;
            if (
              deviated &&
              now >= undockRetryAt &&
              !snapMoveGuard.isProgrammaticMove(rect.x, rect.y)
            ) {
              await undockByDrag();
            }
          }
          return;
        }
        case "docked-hidden": {
          // 折叠态不需要光标轮询（点击轨道即可展开，不做悬停自动展开——
          // 悬停自动展开/收起正是历史上"来回跳动"的来源）。
          // 只做低频可见性健康检查（显示器热插拔 / 系统挪窗）。
          // 例外：上一次解除失败后窗口可能已被判为「离开」而收起，
          // 这里按冷却间隔补一次偏离检测，避免停在「想解除但一直收着」。
          if (undockRetryAt > 0 && Date.now() >= undockRetryAt) {
            const rect = await fetchRectOnly();
            if (disposed) return;
            const deviated =
              dockedPos !== null &&
              (Math.abs(rect.x - dockedPos.x) > SNAP_UNDOCK_DRAG_PX ||
                Math.abs(rect.y - dockedPos.y) > SNAP_UNDOCK_DRAG_PX);
            if (deviated) {
              await undockByDrag();
              return;
            }
            undockRetryAt = 0; // 已回到停靠位：无需再补解除
          }
          if (++healthCheckTick % 20 === 0) await recoverVisibility();
          return;
        }
      }
    }

    async function handleMoved(): Promise<void> {
      const { rect, monitor } = await fetchRect();
      if (disposed || !monitor) return;
      const wa = toWorkArea(monitor);
      if (isDockedPhase(machine.phase)) {
        const edge = machine.edge;
        if (!edge) return;
        const other = detectCandidateEdge(rect, wa);
        if (other && other !== edge) {
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
        // 磁吸滞回：> 42px 才解除（28–42 死区内保持停靠，避免阈值抖动）
        if (
          Date.now() >= undockRetryAt &&
          shouldLeaveMagnetRange(edgeDistance(rect, wa, edge))
        ) {
          await undockCore();
        }
        return;
      }
      // free / candidate：滞回判定
      const detected = detectCandidateEdge(rect, wa);
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
      if (detected) {
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

    const runTick = (): void => runExclusive(tickBody);

    // ── 订阅 ────────────────────────────────────────────────

    const scope = createSubscriptionScope();
    scope.add(
      win.onMoved(() => {
        lastMoveAt = Date.now(); // 同步记录：拖拽活动信号不受 busy 影响
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
    window.addEventListener("pointermove", onDomPointer, { passive: true });
    window.addEventListener("pointerdown", onDomPointer, { passive: true });

    // 重启恢复：读取持久化 snap_state，交给 tick 串行执行（避免与 onMoved 竞态）。
    void (async () => {
      try {
        const saved = await getSnapState();
        if (disposed) return;
        if (saved && isSnapEdge(saved.edge)) {
          pendingRestore = {
            edge: saved.edge,
            center: typeof saved.center === "number" && Number.isFinite(saved.center) ? saved.center : null,
          };
        }
      } catch {
        // 忽略：读取失败按未停靠处理
      }
    })();

    ui.setReveal(() => runExclusive(expandPanel));
    ui.setCollapse(() => runExclusive(collapsePanel));
    ui.setUndock((mode) => runExclusive(() => undockCore(mode)));

    const timer = window.setInterval(runTick, SNAP_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("pointermove", onDomPointer);
      window.removeEventListener("pointerdown", onDomPointer);
      scope.dispose();
      ui.setReveal(null);
      ui.setCollapse(null);
      ui.setUndock(null);
      snapMoveGuard.setHidden(false);
      // 延迟一个宏任务再决定是否清区域：StrictMode 会在同一轮里立即重挂载新实例
      // （世代号前进），此时旧实例的 off 会覆盖新实例的 rail/panel，
      // 造成「Win32 已恢复整窗 / React 进了胶囊」。仅当无人接管时才清理。
      const myEpoch = epoch;
      const wasDocked = isDockedPhase(machine.phase);
      window.setTimeout(() => {
        if (engineEpoch !== myEpoch) return;
        if (wasDocked) {
          void setCapsuleRegion("off");
          void persistSnap(null, false, null);
          const mode = useSettingsStore.getState().settings?.mode ?? "full";
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
