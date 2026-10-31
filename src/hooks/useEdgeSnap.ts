//! 贴边吸附引擎（v0.6 · Smart Dock Capsule · 系统性修复版）。
//!
//! 判定全部在 `lib/edgeSnap.ts`（纯函数，单测口径）；本文件只执行副作用。
//! 五相状态机：free / candidate / docked-visible / docked-hidden / docked-revealed。
//!
//! 前两轮已建立的机制（时间积分防抖、磁吸滞回、停靠显示器记忆、
//! window_rect 防污染、关闭吸附安全展开、snap_state/window_rect 兼容）
//! 详见 lib/edgeSnap.ts 与验收文档；此处不赘述。
//!
//! 本轮（系统性修复）新增：
//! 1. **胶囊区域裁剪**：隐藏时经 `apply_window_capsule` 把主窗口 Win32 区域
//!    收窄为停靠边上的短胶囊——区域外不绘制、不接收鼠标，消除"整窗切片
//!    在胶囊以外露出内容/残留命中区"的结构性问题（选择依据见 ADR）。
//! 2. **多屏接缝安全降级**：停靠边外侧紧贴另一台显示器（内部接缝）时
//!    **允许停靠但禁止自动隐藏**（滑出会整体进入邻屏）；邻屏断连后 3s
//!    重检恢复自动隐藏；隐藏中接缝形成 → 健康检查立即安全展开。
//! 3. **唤回**：托盘/快捷键发现窗口"可见但大部分在屏外"时下发 `snap-recall`，
//!    引擎安全展开（仅 show/focus 找不回屏外窗口）。
//! 4. **持久化串行**：snap_state/window_rect 写入经模块级 promise 链串行，
//!    杜绝异步乱序旧值覆盖新值。
//! 5. **恢复兜底**：显示器断连/restore 失效时按停靠显示器记忆齐平位展开，
//!    不再因缺 restore 坐标而永久不可见。
//! 6. **IPC 收敛**：free 相位 0 次轮询 IPC；停靠/隐藏相位不再每 tick 调
//!    currentMonitor（用停靠显示器记忆）；健康检查降频到每 20 tick。

import { useEffect } from "react";
import { getCurrentWindow, cursorPosition, currentMonitor } from "@tauri-apps/api/window";
import { availableMonitors, type Window } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  applyWindowCapsule,
  getSnapState,
  onSnapRecall,
  saveSnapState,
  saveWindowRect,
} from "../lib/bridge";
import { createSubscriptionScope } from "../lib/subscriptions";
import { topOverlay } from "../lib/overlayStack";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import {
  CAPSULE_LENGTH_CSS,
  SNAP_CANDIDATE_ENTER_DIST,
  SNAP_CORRIDOR_MARGIN,
  SNAP_DRAG_SETTLE_MS,
  SNAP_HIDE_MARGIN,
  SNAP_POLL_MS,
  SNAP_PULL_IN_DELAY_MS,
  SNAP_PULL_IN_GAP,
  SNAP_SEAM_RECHECK_MS,
  SNAP_UNDOCK_NUDGE,
  approachPositionFor,
  canTransition,
  capsuleLengthPhysical,
  capsuleStripPhysical,
  clampDockedPosition,
  cursorInCapsuleCorridor,
  cursorNearCapsule,
  cursorOverWindow,
  detectCandidateEdge,
  edgeDistance,
  findAdjacentMonitorAcrossEdge,
  hiddenPositionFor,
  isDockedPhase,
  isMoveSettling,
  isRectMostlyVisible,
  isRevealProtected,
  isSnapEdge,
  shouldConfirmDock,
  shouldExpireCandidate,
  shouldHideAfterLeave,
  shouldLeaveMagnetRange,
  shouldRevealByDwell,
  snapMoveGuard,
  type SnapArea,
  type SnapEdge,
  type SnapPhase,
  type SnapPoint,
  type SnapRect,
} from "../lib/edgeSnap";

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

/** 停靠显示器记忆：停靠/隐藏相位的几何唯一事实来源（修复 currentMonitor 错配）。 */
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

/** 引擎内部状态机。 */
interface SnapMachine {
  phase: SnapPhase;
  edge: SnapEdge | null;
  /** 隐藏前的可见位置（物理像素；仅在确认当前可见后写入） */
  restore: SnapPoint | null;
}

// ── 持久化写串行（模块级）：杜绝异步乱序旧值覆盖新值 ────────

let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const run = writeChain.then(task, task); // 前序失败不阻塞后续写入
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function persistSnap(edge: SnapEdge | null, hidden: boolean): Promise<void> {
  return enqueueWrite(async () => {
    try {
      await saveSnapState(edge ?? "none", hidden);
    } catch {
      // 持久化失败不阻塞吸附行为（重启后最多回到可见态）
    }
  });
}

export function useEdgeSnap(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const win = getCurrentWindow();
    const ui = useEdgeSnapStore.getState();

    let disposed = false;
    let busy = false; // 评估/移动互斥（tick、onMoved、reveal 点击、undock）
    let queuedEval: (() => Promise<unknown>) | null = null; // busy 期间尾随补评估
    let lastMoveAt = 0; // 最近 onMoved（含程序移动；拖拽活动信号）
    let lastEngineMoveAt = 0; // 最近一次引擎程序移动完成时刻（坐标静默期基准）
    let lastMoveTarget: SnapPoint | null = null; // 最近一次成功程序移动目标（幂等）
    let domPointerAt = 0; // 最近 DOM 指针事件时刻（原生拖拽期间不产生 → 松手信号）
    let revealArmSince: number | null = null; // 唤出驻留起点（null = 不在唤出区）
    let leftSince: number | null = null; // 连续离开有效区起点
    let revealedAt = 0; // 最近一次 reveal 完成时刻（保护期基准）
    let healthCheckTick = 0; // 健康检查计数（每 20 tick ≈3s 一次）
    let pendingRestore: SnapEdge | null = null; // 重启恢复边（tick 串行消费）
    let dockedMonitor: DockedMonitor | null = null; // 停靠显示器记忆
    let seamDock = false; // 内部接缝停靠：允许吸附但禁止自动隐藏
    let seamRecheckAt = 0; // 接缝重检时刻（邻屏断连后恢复自动隐藏）
    let magnetizedNow = false; // candidate 是否在磁吸区（≤28；仅在变化时同步 store）
    const machine: SnapMachine = { phase: "free", edge: null, restore: null };

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

    /** 相位转移（非法转移直接拒绝，防竞态写入） */
    function setPhase(next: SnapPhase): boolean {
      if (machine.phase === next) return true;
      if (!canTransition(machine.phase, next)) return false;
      machine.phase = next;
      if (next === "free") {
        machine.edge = null;
        machine.restore = null;
        dockedMonitor = null;
        revealArmSince = null;
        leftSince = null;
        seamDock = false;
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

    /** 轻量矩形读取（2 次 IPC；显示器信息用停靠记忆，供停靠/隐藏相位使用）。 */
    async function fetchRectOnly(): Promise<SnapRect> {
      const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
      return { x: pos.x, y: pos.y, w: size.width, h: size.height };
    }

    /** 程序移动：幂等（同目标跳过）、登记防污染守卫、失败返回 false。 */
    async function moveWindow(x: number, y: number): Promise<boolean> {
      if (
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
        lastEngineMoveAt = Date.now();
        return true;
      } catch {
        lastMoveTarget = null; // 移动失败：位置缓存立即失效
        return false;
      }
    }

    /** 保存「有效可见」矩形（串行写队列；持久化钩子另有双保险）。 */
    async function saveVisibleRect(r: SnapRect): Promise<void> {
      return enqueueWrite(async () => {
        try {
          const monitors = await availableMonitors();
          if (!isRectMostlyVisible(r, monitors.map(toArea))) return;
          await saveWindowRect({ x: r.x, y: r.y, w: r.w, h: r.h });
        } catch {
          // 忽略
        }
      });
    }

    /** 胶囊区域期望状态与操作序号（防过期命令覆盖新状态，需求 4.4）。 */
    let capsuleSeq = 0;
    let desiredCapsule: { enabled: boolean; edge: SnapEdge } = { enabled: false, edge: "left" };

    /**
     * 胶囊区域开关（**await + 结果检查 + 序号防护**，替换旧的 fire-and-forget）。
     * - 返回 false = 后端报告未应用（含 GetWindowRgn 回读验证失败）或 IPC 失败；
     * - 响应迟到且期间有更新命令：结果作废并按最新期望**重同步**一次，
     *   杜绝旧 hidden 裁剪覆盖新展开状态。
     */
    async function setCapsuleRegion(enabled: boolean, edge: SnapEdge): Promise<boolean> {
      const seq = ++capsuleSeq;
      desiredCapsule = { enabled, edge };
      let ok = false;
      try {
        ok = (await applyWindowCapsule(enabled, edge)) === true;
      } catch {
        ok = false;
      }
      if (disposed) return false;
      if (seq !== capsuleSeq) {
        // 过期响应：以最新期望重同步（raw 调用，不再递增序号）
        void applyWindowCapsule(desiredCapsule.enabled, desiredCapsule.edge).catch(() => {});
        return false;
      }
      return ok;
    }

    /**
     * 等待窗口位置落定（OS 已处理移动）。根因防护：setPosition 跨进程异步，
     * 若在移动被主线程处理前读取坐标（尤其是区域自愈/验证），会拿到完全
     * 可见的旧位置——真机截图中"全高浅色竖条"的第一根因。
     * 有界轮询（50ms × 最多 600ms），失败由调用方回退。
     */
    async function waitForPosition(target: SnapPoint, deadlineMs = 600): Promise<boolean> {
      const start = Date.now();
      for (;;) {
        if (disposed) return false;
        const pos = await win.outerPosition();
        if (disposed) return false;
        if (Math.abs(pos.x - target.x) <= 1 && Math.abs(pos.y - target.y) <= 1) return true;
        if (Date.now() - start >= deadlineMs) return false;
        await sleep(50);
      }
    }

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    // ── 动作：停靠 / 隐藏 / 唤出 / 解除 / 恢复 ───────────────

    /**
     * 确认停靠（磁吸释放）：candidate → docked-visible。
     * 两段式齐平（gap>12px：先到距边 8px、70ms 后贴紧）——"啪一下"锁边感。
     * 接缝判定：停靠边外侧紧贴邻屏时允许停靠但禁止自动隐藏（安全降级）。
     */
    async function confirmDock(rect: SnapRect): Promise<void> {
      const edge = machine.edge;
      if (!edge) return;
      pendingRestore = null; // 已主动停靠：重启恢复队列作废
      const { monitor } = await fetchRect();
      if (disposed || !monitor) {
        setPhase("free");
        return;
      }
      const wa = toWorkArea(monitor);
      dockedMonitor = memorizeMonitor(monitor);
      // 接缝判定（每次停靠时评估一次；后续由 tick 低频重检）
      try {
        const monitors = await availableMonitors();
        seamDock =
          findAdjacentMonitorAcrossEdge(dockedMonitor.bounds, edge, monitors.map(toArea)) !== null;
      } catch {
        seamDock = false; // 查询失败按桌面外边缘处理（applyHide 还有同款闸门兜底）
      }
      seamRecheckAt = Date.now();
      const docked = clampDockedPosition(rect, wa, edge);
      if (!setPhase("docked-visible")) return;
      const gap = Math.abs(edgeDistance(rect, wa, edge));
      if (gap > SNAP_PULL_IN_GAP + 4) {
        const approach = approachPositionFor(rect, wa, edge, SNAP_PULL_IN_GAP);
        if (!(await moveWindow(approach.x, approach.y))) {
          return; // 移动失败：保持 docked-visible，realign 兜底
        }
        await sleep(SNAP_PULL_IN_DELAY_MS);
        if (disposed) return;
      }
      if (gap > 1 && !(await moveWindow(docked.x, docked.y))) {
        return; // 贴紧失败：保持 docked-visible，下一轮 realign 重试
      }
      // 停靠完成才反馈（短暂、轻量；reveal 路径不经过这里，不重复反馈）
      ui.notifyDocked(edge);
      void persistSnap(edge, false);
      void saveVisibleRect(docked);
    }

    /**
     * 滑出隐藏。提交协议（需求 4.1）：
     * 1. 闸门：当前位置「大部分可见」+ 接缝判定；
     * 2. setPosition 隐藏目标；
     * 3. **等待坐标落定**（OS 已处理移动，自愈/验证以真实位置为准）；
     * 4. **原生裁剪并验证**（apply_window_capsule 内含 GetWindowRgn 回读）；
     * 5. 全部成功才提交 docked-hidden 与持久化。
     * 任一步失败：回滚到原可见位置、restore 作废、保持 docked-visible——
     * **绝不以整条切片形态停留在隐藏态**（真机失败用例）。
     */
    async function applyHide(): Promise<boolean> {
      if (!machine.edge) return false;
      const { rect, monitor } = await fetchRect();
      if (disposed || !monitor) return false;
      const monitors = await availableMonitors();
      if (disposed) return false;
      const areas = monitors.map(toArea);
      if (!isRectMostlyVisible(rect, areas)) return false;
      const edge = machine.edge;
      dockedMonitor = memorizeMonitor(monitor);
      // 接缝闸门：内部边缘不得自动隐藏
      if (findAdjacentMonitorAcrossEdge(dockedMonitor.bounds, edge, areas)) {
        seamDock = true;
        seamRecheckAt = Date.now();
        return false;
      }
      const strip = capsuleStripPhysical(dockedMonitor.scaleFactor);
      const hidden = hiddenPositionFor(rect, dockedMonitor.workArea, edge, strip);
      const revert = async (): Promise<false> => {
        machine.restore = null;
        await moveWindow(rect.x, rect.y); // 回滚到原可见位置（防长条残留）
        return false;
      };
      machine.restore = { x: rect.x, y: rect.y };
      if (!(await moveWindow(hidden.x, hidden.y))) return revert();
      if (!(await waitForPosition({ x: hidden.x, y: hidden.y }))) return revert();
      // 原生裁剪：失败（含后端回读验证失败）不得提交隐藏态
      if (!(await setCapsuleRegion(true, edge))) return revert();
      snapMoveGuard.setHidden(true);
      setPhase("docked-hidden");
      seamDock = false;
      void persistSnap(edge, true);
      return true;
    }

    /** 区域清除带一次重试（失败时后端自愈兜底：宽限窗外窗口可见必清除）。 */
    async function clearCapsuleWithRetry(edge: SnapEdge): Promise<boolean> {
      if (await setCapsuleRegion(false, edge)) return true;
      await sleep(300);
      if (disposed) return false;
      return setCapsuleRegion(false, edge);
    }

    /**
     * 唤出到可见位置（restore 优先，失效则用停靠显示器记忆齐平位）。
     * 提交协议（需求 4.2）：移动 → **等待坐标落定** → **验证清除裁剪** →
     * 提交 docked-revealed。清除失败：回滚到隐藏位并重开裁剪，保持
     * "隐藏态 = 胶囊形态"的一致性，不留下半展开的胶囊形窗口。
     * 移动在前、清裁剪在后：飞行期间区域仍为胶囊（随窗口移动），无整条切片闪烁。
     */
    async function revealToVisible(): Promise<boolean> {
      if (machine.phase !== "docked-hidden" || !machine.edge) return false;
      const edge = machine.edge;
      const rect = await fetchRectOnly();
      if (disposed) return false;
      const m = dockedMonitor;
      if (!m) return false;
      let target: SnapRect | null = null;
      const r = machine.restore;
      if (r) {
        const cand = { x: r.x, y: r.y, w: rect.w, h: rect.h };
        const monitors = await availableMonitors();
        if (disposed) return false;
        if (isRectMostlyVisible(cand, monitors.map(toArea))) target = cand;
      }
      if (!target) target = clampDockedPosition(rect, m.workArea, edge);
      const rollbackToHidden = async (): Promise<false> => {
        await moveWindow(rect.x, rect.y); // 回滚到隐藏位
        await setCapsuleRegion(true, edge); // 重开裁剪，保持隐藏态形态一致
        return false;
      };
      if (!(await moveWindow(target.x, target.y))) return false;
      if (!(await waitForPosition({ x: target.x, y: target.y }))) return rollbackToHidden();
      if (!(await clearCapsuleWithRetry(edge))) return rollbackToHidden();
      snapMoveGuard.setHidden(false);
      setPhase("docked-revealed");
      revealArmSince = null;
      leftSince = null;
      revealedAt = Date.now();
      void persistSnap(edge, false);
      void saveVisibleRect(target);
      return true;
    }

    /** 停靠中沿边拖动后松手 → 重新齐平（幂等：已齐平时不动）。 */
    async function realignDocked(): Promise<void> {
      const edge = machine.edge;
      if (!edge || !dockedMonitor) return;
      const rect = await fetchRectOnly();
      if (disposed) return;
      const docked = clampDockedPosition(rect, dockedMonitor.workArea, edge);
      if (Math.abs(docked.x - rect.x) <= 2 && Math.abs(docked.y - rect.y) <= 2) return;
      if (await moveWindow(docked.x, docked.y)) {
        if (machine.phase === "docked-visible") void saveVisibleRect(docked);
      }
    }

    /**
     * 隐藏中异常恢复（显示器断连 / 接缝形成 / restore 失效）：
     * restore 可见 → 回 restore；否则按停靠显示器记忆齐平位展开。
     * 不因缺 restore 坐标而永久保留不可见窗口。
     */
    async function recoverHiddenWindow(): Promise<void> {
      try {
        const size = await win.outerSize();
        const monitors = await availableMonitors();
        const edge = machine.edge ?? "left";
        let target: SnapPoint | null = null;
        const r = machine.restore;
        if (r) {
          const cand = { x: r.x, y: r.y, w: size.width, h: size.height };
          if (isRectMostlyVisible(cand, monitors.map(toArea))) target = { x: r.x, y: r.y };
        }
        if (!target && dockedMonitor) {
          const rect = await fetchRectOnly();
          const docked = clampDockedPosition(rect, dockedMonitor.workArea, edge);
          target = { x: docked.x, y: docked.y };
        }
        if (!target || disposed) return;
        if (await moveWindow(target.x, target.y)) {
          if (!(await waitForPosition(target))) return; // 未落定：下轮 tick 重试
          snapMoveGuard.setHidden(false);
          // 转移表不允许 docked-hidden → docked-visible（唤出必须经 revealed），
          // 异常恢复同样走 docked-revealed 语义（可见、光标离开后可再隐藏）
          setPhase("docked-revealed");
          revealArmSince = null;
          leftSince = null;
          revealedAt = Date.now();
          // 区域清除失败时窗口仍是胶囊形态：已重试一次；仍失败则依赖后端
          // 自愈（宽限窗外窗口可见时下次 apply 必清除）兜底，状态保持一致
          await clearCapsuleWithRetry(edge);
          void persistSnap(machine.edge, false);
        }
      } catch {
        // 下一个 tick 重试
      }
    }

    /** 明确操作解除吸附（标题栏磁铁）：隐藏态先安全展开，再退出停靠并内推。 */
    async function undockByUser(): Promise<void> {
      if (!machine.edge) return;
      pendingRestore = null; // 用户意图优先：不得再被重启恢复队列拉回隐藏
      if (machine.phase === "docked-hidden" && !(await revealToVisible())) return;
      const edge = machine.edge;
      const { rect, monitor } = await fetchRect();
      if (disposed || !monitor) return;
      // 内推：离开磁吸区（> 42px），避免松手即重新吸附。不能用 clampDockedPosition
      // 收边（它会把垂直于边的坐标拉回齐平位，抵消内推）；改为移动前校验可见性。
      const nudged: SnapRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      if (edge === "left") nudged.x += SNAP_UNDOCK_NUDGE;
      if (edge === "right") nudged.x -= SNAP_UNDOCK_NUDGE;
      if (edge === "top") nudged.y += SNAP_UNDOCK_NUDGE;
      if (edge === "bottom") nudged.y -= SNAP_UNDOCK_NUDGE;
      setPhase("free");
      void persistSnap(null, false);
      const monitors = await availableMonitors();
      if (
        !disposed &&
        isRectMostlyVisible(nudged, monitors.map(toArea)) &&
        (await moveWindow(nudged.x, nudged.y))
      ) {
        void saveVisibleRect(nudged);
      }
    }

    // ── 评估：tick 与 onMoved（busy 互斥 + 尾随补评估）────────

    async function tickBody(): Promise<void> {
      if (disposed) return;
      switch (machine.phase) {
        case "free": {
          // 重启恢复：持久化的隐藏态经同一闸门重新隐藏（无反馈、不弹提示）；
          // 接缝处 applyHide 会拒绝并降级为"停靠不隐藏"。
          if (pendingRestore) {
            const edge = pendingRestore;
            pendingRestore = null;
            machine.edge = edge;
            if (!(await applyHide())) {
              machine.edge = null;
              // 接缝降级时保留停靠记录（hidden=false）；其他失败清除隐藏态
              void persistSnap(seamDock ? edge : null, false);
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
          if (
            shouldConfirmDock(
              machine.phase,
              machine.edge,
              sinceMove,
              cursorOverWindow(cursor, rect, 0),
              domAfterMove,
            )
          ) {
            await confirmDock(rect);
          } else if (shouldExpireCandidate(machine.phase, sinceMove)) {
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
          // 显示器信息用停靠记忆（省 1 次 IPC/tick）；缺失时重建一次
          if (!dockedMonitor) {
            const { monitor } = await fetchRect();
            if (!monitor) return;
            dockedMonitor = memorizeMonitor(monitor);
          }
          const m = dockedMonitor;
          const rect = await fetchRectOnly();
          if (disposed) return;
          const strip = capsuleStripPhysical(m.scaleFactor);
          // 有效交互区 = 窗口(外扩 margin) ∪ 胶囊走廊（覆盖胶囊↔展开窗口过渡带）
          const inWindow = cursorOverWindow(cursor, rect, SNAP_HIDE_MARGIN);
          const inCorridor = cursorInCapsuleCorridor(
            cursor,
            m.workArea,
            edge,
            rect,
            strip,
            SNAP_CORRIDOR_MARGIN,
          );
          const inZone = inWindow || inCorridor;
          if (inZone) {
            leftSince = null;
          } else if (leftSince === null) {
            leftSince = now;
          }
          const overlayOpen = topOverlay() !== undefined; // 菜单/对话框交互中不隐藏
          const settling = isMoveSettling(lastEngineMoveAt, now); // 程序移动后坐标可能未刷新
          const protecting =
            machine.phase === "docked-revealed" && isRevealProtected(revealedAt, now);
          if (
            !inZone &&
            !protecting &&
            !overlayOpen &&
            !settling &&
            shouldHideAfterLeave(leftSince, now)
          ) {
            // 接缝停靠：禁止自动隐藏；低频重检（邻屏断连后恢复）
            if (seamDock) {
              if (now - seamRecheckAt >= SNAP_SEAM_RECHECK_MS) {
                seamRecheckAt = now;
                try {
                  const monitors = await availableMonitors();
                  seamDock =
                    findAdjacentMonitorAcrossEdge(m.bounds, edge, monitors.map(toArea)) !== null;
                } catch {
                  // 查询失败维持降级，下轮再检
                }
              }
              if (seamDock) return;
            }
            await applyHide(); // 连续离开确认后再次隐藏（不重复反馈）
            return;
          }
          const sinceMove = now - lastMoveAt;
          if (machine.edge && sinceMove >= SNAP_DRAG_SETTLE_MS) await realignDocked();
          return;
        }
        case "docked-hidden": {
          const cursor = await cursorPosition();
          if (disposed) return;
          const rect = await fetchRectOnly();
          if (disposed) return;
          // 停靠显示器记忆缺失（异常路径）：尝试用当前显示器重建
          if (!dockedMonitor) {
            const { monitor } = await fetchRect();
            dockedMonitor = monitor ? memorizeMonitor(monitor) : null;
          }
          const m = dockedMonitor;
          if (!m) {
            await recoverHiddenWindow();
            return;
          }
          const edge = machine.edge ?? "left";
          // 健康检查（每 20 tick ≈3s）：
          //  a) 停靠显示器断连 → 恢复；
          //  b) 停靠边缘出现新邻屏（接缝形成，隐藏不再成立）→ 恢复。
          if (++healthCheckTick % 20 === 0) {
            try {
              const monitors = await availableMonitors();
              const areas = monitors.map(toArea);
              const alive = areas.some(
                (b) =>
                  b.x < m.bounds.x + m.bounds.w &&
                  b.x + b.w > m.bounds.x &&
                  b.y < m.bounds.y + m.bounds.h &&
                  b.y + b.h > m.bounds.y,
              );
              const seam = findAdjacentMonitorAcrossEdge(m.bounds, edge, areas) !== null;
              if (!alive || seam) {
                await recoverHiddenWindow();
                return;
              }
            } catch {
              // 查询失败按存活处理，下轮再查
            }
          }
          // 唤出判定：边缘距离（胶囊厚度+接近带，随 DPI）+ **胶囊区段**双约束
          //（修复旧实现按整窗跨度判定、把整条屏幕边缘都当成唤出区）
          const near = cursorNearCapsule(cursor, m.workArea, edge, rect, {
            thicknessPhys: capsuleStripPhysical(m.scaleFactor),
            lengthPhys: capsuleLengthPhysical(m.scaleFactor),
            margin: SNAP_CORRIDOR_MARGIN,
          });
          if (near) {
            if (revealArmSince === null) revealArmSince = Date.now();
            // 驻留确认 + 坐标静默期双闸：静止悬停稳定后才展开
            if (
              shouldRevealByDwell(revealArmSince, Date.now()) &&
              !isMoveSettling(lastEngineMoveAt, Date.now())
            ) {
              await revealToVisible();
            }
          } else {
            revealArmSince = null; // 离开唤出区即重置驻留
          }
          return;
        }
      }
    }

    async function handleMoved(): Promise<void> {
      const { rect, monitor } = await fetchRect();
      if (disposed || !monitor) return;
      const wa = toWorkArea(monitor);
      if (machine.phase === "docked-hidden") return; // 隐藏窗口不可拖动
      if (isDockedPhase(machine.phase)) {
        const edge = machine.edge;
        if (!edge) return;
        const other = detectCandidateEdge(rect, wa);
        if (other && other !== edge) {
          // 拖向另一条边：解除并立即进入新边候选
          void persistSnap(null, false);
          setPhase("free");
          machine.edge = other;
          setPhase("candidate");
          setMagnetized(edgeDistance(rect, wa, other) <= SNAP_CANDIDATE_ENTER_DIST);
          return;
        }
        // 磁吸滞回：> 42px 才解除（28–42 死区内保持停靠，避免阈值抖动）
        const d = edgeDistance(rect, wa, edge);
        if (shouldLeaveMagnetRange(d)) {
          void persistSnap(null, false);
          setPhase("free");
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
    // 唤回：托盘/快捷键发现窗口"可见但大部分在屏外"时安全展开
    scope.add(onSnapRecall(() => runExclusive(revealToVisible)));

    // DOM 指针事件哨兵：原生标题栏拖拽（Win32 移动循环）期间 WebView2 收不到
    // 指针事件；恢复收到 = 拖拽已结束。用于磁吸释放确认，不需要 DOM mouseup
    // 一定可达，也不引入任何全局鼠标 Hook。
    const onDomPointer = (): void => {
      domPointerAt = Date.now();
    };
    window.addEventListener("pointermove", onDomPointer, { passive: true });
    window.addEventListener("pointerdown", onDomPointer, { passive: true });

    // 重启恢复：读取持久化 snap_state，交给 tick 串行执行（避免与 onMoved
    // 启动竞态；candidate 相位下等待其先落定）。恢复路径不弹反馈。
    void (async () => {
      try {
        const saved = await getSnapState();
        if (disposed) return;
        if (saved?.hidden && isSnapEdge(saved.edge)) pendingRestore = saved.edge;
      } catch {
        // 忽略：读取失败按无隐藏态处理
      }
    })();

    ui.setUndock(() => runExclusive(undockByUser));
    ui.setReveal(() => runExclusive(revealToVisible));

    const timer = window.setInterval(runTick, SNAP_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("pointermove", onDomPointer);
      window.removeEventListener("pointerdown", onDomPointer);
      scope.dispose();
      ui.setUndock(null);
      ui.setReveal(null);
      snapMoveGuard.setHidden(false);
      // 关闭吸附时若已隐藏，先安全展开再清持久化；停靠可见态只清记录；
      // 无论何种相位都关闭胶囊区域（幂等，防残留裁剪形态）
      if (machine.phase === "docked-hidden") {
        void safeExpandAfterDisable(win, machine.edge, machine.restore);
      } else if (isDockedPhase(machine.phase)) {
        void persistSnap(null, false);
      }
      setCapsuleRegion(false, machine.edge ?? "left");
      useEdgeSnapStore.getState().reset();
    };
  }, [enabled]);
}

/** 关闭吸附后的安全展开（effect 已销毁，尽力而为，不依赖引擎状态）。 */
async function safeExpandAfterDisable(
  win: Window,
  edge: SnapEdge | null,
  restore: SnapPoint | null,
): Promise<void> {
  try {
    const [pos, size, monitor] = await Promise.all([
      win.outerPosition(),
      win.outerSize(),
      currentMonitor(),
    ]);
    let target: SnapPoint | null = null;
    if (restore) {
      const monitors = await availableMonitors();
      const cand = { x: restore.x, y: restore.y, w: size.width, h: size.height };
      if (isRectMostlyVisible(cand, monitors.map(toArea))) target = { x: restore.x, y: restore.y };
    }
    if (!target && monitor) {
      const docked = clampDockedPosition(
        { x: pos.x, y: pos.y, w: size.width, h: size.height },
        toWorkArea(monitor),
        edge ?? "left",
      );
      target = { x: docked.x, y: docked.y };
    }
    if (!target) return; // 无显示器信息：保留现状，交由系统窗口管理
    snapMoveGuard.noteProgrammaticMove(target.x, target.y);
    await win.setPosition(new PhysicalPosition(target.x, target.y));
    await persistSnap(null, false);
    await saveWindowRect({ x: target.x, y: target.y, w: size.width, h: size.height });
  } catch {
    // 尽力而为
  }
}

/** 窗口位置/大小持久化（防抖 + 防污染）。
 *
 * - 程序 setPosition（吸附引擎/模式切换等）触发的 onMoved 不写入 window_rect
 *   （snapMoveGuard 目标匹配 + TTL 过期兜底）；
 * - 隐藏态一律不写（隐藏位置按定义屏外）；
 * - 保存前用 isRectMostlyVisible 校验（多屏 / 负坐标 / 断连防护）。
 */
export function useWindowPersistence() {
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: number | undefined;
    let disposed = false;

    const saveNow = async () => {
      try {
        if (snapMoveGuard.isHidden()) return; // 隐藏态不持久化
        const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
        const rect = { x: pos.x, y: pos.y, w: size.width, h: size.height };
        if (snapMoveGuard.isProgrammaticMove(rect.x, rect.y)) return; // 程序移动不污染
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

/** 胶囊 CSS 几何（供样式/文档对齐引用；实际几何计算在 lib/edgeSnap）。 */
export const SNAP_CAPSULE_THICKNESS_CSS = 32;
export const SNAP_CAPSULE_LENGTH_CSS = CAPSULE_LENGTH_CSS;
