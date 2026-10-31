//! 贴边吸附引擎（v0.6 · Smart Dock Capsule）。
//!
//! 架构：判定全部在 `lib/edgeSnap.ts`（纯函数，单测口径）；本文件只执行
//! 副作用（窗口移动、持久化、UI 同步）。五相状态机：
//! free / candidate / docked-visible / docked-hidden / docked-revealed。
//!
//! 本版（智能状态胶囊与磁吸专项）解决的三类根因：
//!
//! 1. **悬停抖动**（docked-hidden → revealed → hidden 循环）：
//!    - 旧逻辑单点采样直接触发动作；现在所有转换都有时间积分：
//!      唤出需驻留 ≥ SNAP_REVEAL_DWELL_MS；隐藏需连续离开有效交互区
//!      ≥ SNAP_HIDE_LEAVE_MS；展开后还有 SNAP_REVEAL_PROTECT_MS 保护期；
//!    - reveal/hide 判定在程序移动后的坐标静默期内跳过（setPosition 跨进程
//!      异步，outerPosition 可能短暂返回旧值）；
//!    - 有效交互区 = 窗口矩形(外扩 margin) ∪ 胶囊走廊（沿边区段 × 法向带），
//!      覆盖胶囊与展开窗口之间的过渡走廊；
//!    - 弹层栈非空（菜单/对话框交互中）不自动隐藏。
//!
//! 2. **停靠显示器错配**：窗口隐藏后大部分矩形在停靠显示器之外，
//!    `currentMonitor()` 按「重叠最大」可能返回另一台显示器（尤其停靠边
//!    另一侧有屏时）。现在 hide 时记录停靠显示器（workArea/bounds/DPI），
//!    hidden 相位所有几何用记忆值，恢复/展开后再刷新。
//!
//! 3. **磁吸手感**：进入 28px / 退出 42px 滞回；candidate 相位区分磁吸区
//!    （≤28，强提示）与预览带（28–42）；松手确认 = 静默期 +（光标出窗 或
//!    DOM 指针事件恢复——原生拖拽期间 WebView2 收不到指针事件，恢复即松手）；
//!    确认后两段式齐平（先到距边 8px，70ms 后贴紧），非逐帧动画。
//!
//! 其余不变量沿用上一专项：隐藏态绝不二次隐藏（可见性闸门）、
//! window_rect 防污染（snapMoveGuard + isRectMostlyVisible + 后端同口径）、
//! 关闭吸附安全展开、snap_state/window_rect 兼容。

import { useEffect } from "react";
import { getCurrentWindow, cursorPosition, currentMonitor } from "@tauri-apps/api/window";
import { availableMonitors, type Window } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getSnapState, saveSnapState, saveWindowRect } from "../lib/bridge";
import { createSubscriptionScope } from "../lib/subscriptions";
import { topOverlay } from "../lib/overlayStack";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import {
  CAPSULE_THICKNESS_CSS,
  SNAP_CANDIDATE_ENTER_DIST,
  SNAP_CORRIDOR_MARGIN,
  SNAP_DRAG_SETTLE_MS,
  SNAP_HIDE_MARGIN,
  SNAP_POLL_MS,
  SNAP_PULL_IN_DELAY_MS,
  SNAP_PULL_IN_GAP,
  SNAP_UNDOCK_NUDGE,
  approachPositionFor,
  canTransition,
  capsuleRevealDistPhysical,
  capsuleStripPhysical,
  clampDockedPosition,
  cursorInCapsuleCorridor,
  cursorNearTriggerStrip,
  cursorOverWindow,
  detectCandidateEdge,
  edgeDistance,
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

/** 停靠显示器记忆：hidden 相位的几何唯一事实来源（修复 currentMonitor 错配）。 */
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

async function persistSnap(edge: SnapEdge | null, hidden: boolean): Promise<void> {
  try {
    await saveSnapState(edge ?? "none", hidden);
  } catch {
    // 持久化失败不阻塞吸附行为（重启后最多回到可见态）
  }
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
    let healthCheckTick = 0; // 隐藏态显示器健康检查计数（每 20 tick 一次）
    let pendingRestore: SnapEdge | null = null; // 重启恢复边（tick 串行消费）
    let dockedMonitor: DockedMonitor | null = null; // 停靠显示器记忆
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
        lastMoveTarget = null;
        return false;
      }
    }

    /** 保存「有效可见」矩形（引擎主动保存路径；持久化钩子另有双保险）。 */
    async function saveVisibleRect(r: SnapRect): Promise<void> {
      try {
        const monitors = await availableMonitors();
        if (!isRectMostlyVisible(r, monitors.map(toArea))) return;
        await saveWindowRect({ x: r.x, y: r.y, w: r.w, h: r.h });
      } catch {
        // 忽略
      }
    }

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    // ── 动作：停靠 / 隐藏 / 唤出 / 解除 ──────────────────────

    /**
     * 确认停靠（磁吸释放）：candidate → docked-visible。
     * 两段式齐平：距边较远时先到 gap 处、短暂停顿后贴紧——磁吸「吸入」手感。
     * 只用 2 次 setPosition（非逐帧动画，不与系统拖拽竞争）。
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
      const docked = clampDockedPosition(rect, wa, edge);
      if (!setPhase("docked-visible")) return;
      const gap = Math.abs(edgeDistance(rect, wa, edge));
      if (gap > SNAP_PULL_IN_GAP + 4) {
        // 第一段：移到距边 gap=8px 处（沿边坐标保持 clamp）
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
      // 停靠完成才反馈（短暂、轻量）
      ui.notifyDocked(edge);
      void persistSnap(edge, false);
      void saveVisibleRect(docked);
    }

    /**
     * 滑出隐藏。核心闸门：当前位置必须「大部分可见」——隐藏态/屏外位置
     * 绝不二次隐藏，restore 永不指向屏外坐标。strip = 胶囊物理宽度
     * （CSS 32px × DPI），保证胶囊内容不被窗口边界裁切。
     */
    async function applyHide(): Promise<boolean> {
      if (!machine.edge) return false;
      const { rect, monitor } = await fetchRect();
      if (disposed || !monitor) return false;
      const monitors = await availableMonitors();
      if (disposed) return false;
      if (!isRectMostlyVisible(rect, monitors.map(toArea))) return false;
      const edge = machine.edge;
      dockedMonitor = memorizeMonitor(monitor);
      const strip = capsuleStripPhysical(dockedMonitor.scaleFactor);
      const hidden = hiddenPositionFor(rect, dockedMonitor.workArea, edge, strip);
      machine.restore = { x: rect.x, y: rect.y };
      if (!(await moveWindow(hidden.x, hidden.y))) {
        machine.restore = null;
        return false;
      }
      snapMoveGuard.setHidden(true);
      setPhase("docked-hidden");
      void persistSnap(edge, true);
      return true;
    }

    /**
     * 唤出到可见位置（restore 优先，失效则用停靠显示器记忆齐平位）。
     * 成功后进入保护期（防 reveal→hide 循环），清驻留/离开计时。
     */
    async function revealToVisible(): Promise<boolean> {
      if (machine.phase !== "docked-hidden" || !machine.edge) return false;
      const edge = machine.edge;
      const { rect, monitor } = await fetchRect();
      if (disposed) return false;
      const m = dockedMonitor ?? (monitor ? memorizeMonitor(monitor) : null);
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
      if (!(await moveWindow(target.x, target.y))) return false;
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
      if (!edge) return;
      const { rect, monitor } = await fetchRect();
      if (disposed || !monitor) return;
      const docked = clampDockedPosition(rect, toWorkArea(monitor), edge);
      if (Math.abs(docked.x - rect.x) <= 2 && Math.abs(docked.y - rect.y) <= 2) return;
      if (await moveWindow(docked.x, docked.y)) {
        if (machine.phase === "docked-visible") void saveVisibleRect(docked);
      }
    }

    /** 隐藏中停靠显示器丢失（断连）：restore 仍可见则回退，否则保留状态等重试。 */
    async function recoverHiddenWindow(): Promise<void> {
      const r = machine.restore;
      if (!r) return;
      try {
        const size = await win.outerSize();
        const monitors = await availableMonitors();
        const cand = { x: r.x, y: r.y, w: size.width, h: size.height };
        if (!isRectMostlyVisible(cand, monitors.map(toArea))) return;
        if (await moveWindow(r.x, r.y)) {
          snapMoveGuard.setHidden(false);
          // 转移表不允许 docked-hidden → docked-visible（唤出必须经 revealed），
          // 断连恢复同样走 docked-revealed 语义（可见、光标离开后可再隐藏）
          setPhase("docked-revealed");
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
      const cursor = await cursorPosition();
      if (disposed) return;
      const now = Date.now();
      switch (machine.phase) {
        case "free": {
          // 重启恢复：持久化的隐藏态经同一闸门重新隐藏（无反馈、不弹提示）
          if (pendingRestore) {
            const edge = pendingRestore;
            pendingRestore = null;
            machine.edge = edge;
            if (!(await applyHide())) {
              machine.edge = null; // 当前位置无效/移动失败：清除隐藏态避免每次启动重试
              void persistSnap(null, false);
            }
          }
          return;
        }
        case "candidate": {
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
          const { rect, monitor } = await fetchRect();
          if (disposed || !monitor) return;
          const edge = machine.edge;
          if (!edge) return;
          const strip = capsuleStripPhysical(dockedMonitor?.scaleFactor ?? monitor.scaleFactor ?? 1);
          // 有效交互区 = 窗口(外扩 margin) ∪ 胶囊走廊（覆盖胶囊↔展开窗口过渡带）
          const inWindow = cursorOverWindow(cursor, rect, SNAP_HIDE_MARGIN);
          const inCorridor = cursorInCapsuleCorridor(
            cursor,
            toWorkArea(monitor),
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
            await applyHide(); // 连续离开确认后再次隐藏（不重复反馈）
            return;
          }
          const sinceMove = now - lastMoveAt;
          if (machine.edge && sinceMove >= SNAP_DRAG_SETTLE_MS) await realignDocked();
          return;
        }
        case "docked-hidden": {
          const { rect, monitor } = await fetchRect();
          if (disposed) return;
          // 停靠显示器记忆缺失（异常路径）：尝试用当前显示器重建
          if (!dockedMonitor) {
            dockedMonitor = monitor ? memorizeMonitor(monitor) : null;
          }
          const m = dockedMonitor;
          if (!m) {
            await recoverHiddenWindow();
            return;
          }
          // 健康检查（每 20 tick ≈3s）：停靠显示器已断连 → 走恢复路径
          if (++healthCheckTick % 20 === 0) {
            try {
              const monitors = await availableMonitors();
              const alive = monitors.some((x) => {
                const b = toArea(x);
                return (
                  b.x < m.bounds.x + m.bounds.w &&
                  b.x + b.w > m.bounds.x &&
                  b.y < m.bounds.y + m.bounds.h &&
                  b.y + b.h > m.bounds.y
                );
              });
              if (!alive) {
                await recoverHiddenWindow();
                return;
              }
            } catch {
              // 查询失败按存活处理，下轮再查
            }
          }
          // 唤出判定：边缘距离（胶囊厚度+接近带，随 DPI）+ 胶囊区段双约束
          const near = cursorNearTriggerStrip(cursor, m.workArea, machine.edge ?? "left", rect, {
            revealDist: capsuleRevealDistPhysical(m.scaleFactor),
            segmentMargin: SNAP_CORRIDOR_MARGIN,
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
      // 关闭吸附时若已隐藏，先安全展开再清持久化；停靠可见态只清记录
      if (machine.phase === "docked-hidden") {
        void safeExpandAfterDisable(win, machine.edge, machine.restore);
      } else if (isDockedPhase(machine.phase)) {
        void persistSnap(null, false);
      }
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

/** 胶囊 CSS 厚度（供样式/文档对齐引用；实际几何计算在 lib/edgeSnap）。 */
export const SNAP_CAPSULE_THICKNESS_CSS = CAPSULE_THICKNESS_CSS;
