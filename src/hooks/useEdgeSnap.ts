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
  containerTarget,
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

    /** 相位转移（非法转移直接拒绝，防竞态写入） */
    function setPhase(next: SnapPhase): boolean {
      if (machine.phase === next) return true;
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
     * 切换胶囊区域（**await + 结果检查 + 序号防护**）。
     * 返回 false = 后端报告未应用（含 GetWindowRgn 回读验证失败）或 IPC 失败；
     * 响应迟到且期间有更新命令：结果作废并按最新期望**重同步**一次。
     */
    async function setCapsuleRegion(mode: CapsuleRegionMode): Promise<boolean> {
      const edge = machine.edge ?? "left";
      const seq = ++regionSeq;
      desiredRegion = { mode, edge };
      let ok = false;
      try {
        ok = (await applyWindowCapsule(mode, edge)) === true;
      } catch {
        ok = false;
      }
      if (disposed) return false;
      if (seq !== regionSeq) {
        void applyWindowCapsule(desiredRegion.mode, desiredRegion.edge).catch(() => {});
        return false;
      }
      return ok;
    }

    // ── 动作：停靠 / 折叠 / 展开 / 解除 ─────────────────────

    /**
     * 停靠到某条边：撑到容器尺寸 → 贴边齐平（胶囊沿边居中）→ 区域切到轨道。
     * `phase` 由调用方决定（重启恢复直接进 docked-hidden，无反馈）。
     */
    async function dockTo(
      edge: SnapEdge,
      center: number,
      phase: "docked-visible" | "docked-hidden",
      feedback: boolean,
    ): Promise<boolean> {
      const { monitor } = await fetchRect();
      if (disposed || !monitor) return false;
      dockedMonitor = memorizeMonitor(monitor);
      const scale = dockedMonitor.scaleFactor;
      const container = capsuleContainerSize(edge);
      const want = { w: toPhysical(container.w, scale), h: toPhysical(container.h, scale) };
      let rect = await fetchRectOnly();
      if (disposed) return false;
      if (needsContainerResize({ w: rect.w, h: rect.h }, want)) {
        const target = containerTarget({ w: rect.w, h: rect.h }, want);
        try {
          await win.setSize(new PhysicalSize(target.w, target.h));
          rect = { ...rect, w: target.w, h: target.h };
        } catch {
          // 撑不到容器尺寸：区域会退化为只显示轨道（后端有同款兜底）
        }
      }
      machine.edge = edge;
      if (!setPhase(phase)) return false;
      const pos = capsuleWindowRect(edge, dockedMonitor.workArea, center, {
        w: rect.w,
        h: rect.h,
      });
      await moveWindow(pos.x, pos.y, true);
      dockedPos = { x: pos.x, y: pos.y };
      capsuleCenter = center;
      await setCapsuleRegion("rail");
      if (feedback) ui.notifyDocked(edge);
      void persistSnap(edge, phase === "docked-hidden", center);
      return true;
    }

    /** 折叠：只保留轨道（面板收起）。窗口不动，只切区域。 */
    async function collapseToRail(hidden: boolean): Promise<boolean> {
      if (!machine.edge) return false;
      const ok = await setCapsuleRegion("rail");
      setPhase(hidden ? "docked-hidden" : "docked-visible");
      void persistSnap(machine.edge, hidden, capsuleCenter);
      return ok;
    }

    /** 展开：露出轨道 + 功能面板。窗口不动，只切区域。 */
    async function expandPanel(): Promise<boolean> {
      if (!machine.edge) return false;
      if (machine.phase === "docked-revealed") return true;
      if (machine.phase !== "docked-hidden" && machine.phase !== "docked-visible") return false;
      const ok = await setCapsuleRegion("panel");
      setPhase("docked-revealed");
      leftSince = null;
      void persistSnap(machine.edge, false, capsuleCenter);
      return ok;
    }

    /** 收起功能面板（Esc / 收起按钮 / 再次点击当前分类）。 */
    async function collapsePanel(): Promise<boolean> {
      if (machine.phase !== "docked-revealed") return true;
      return collapseToRail(false);
    }

    /** 解除吸附核心：清区域 → 退出停靠 → 恢复模式尺寸并收回工作区。
     *  `targetMode` 由「打开完整页」传入（避免先恢复旧模式再切新模式的两次缩放）。 */
    async function undockCore(targetMode?: string): Promise<boolean> {
      if (!machine.edge) return false;
      pendingRestore = null; // 用户意图优先：不得再被重启恢复队列拉回停靠
      await setCapsuleRegion("off");
      setPhase("free");
      void persistSnap(null, false, null);
      // 停靠期间窗口被撑到胶囊容器尺寸：解除后恢复目标模式（默认当前模式）的尺寸
      const mode = targetMode ?? useSettingsStore.getState().settings?.mode ?? "full";
      try {
        await applyMode(mode);
      } catch {
        // 尺寸恢复失败不阻塞解除；用户可再切一次模式
      }
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
      switch (machine.phase) {
        case "free": {
          // 重启恢复：持久化的停靠边经同一路径重新停靠（无反馈）。
          if (pendingRestore) {
            const { edge, center } = pendingRestore;
            pendingRestore = null;
            const rect = await fetchRectOnly();
            if (disposed) return;
            const fallback = alongCenterOf(edge, rect);
            await dockTo(edge, center ?? fallback, "docked-hidden", false);
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
          if (
            shouldConfirmDock(machine.phase, machine.edge, sinceMove, inside, domAfterMove) &&
            machine.edge
          ) {
            await dockTo(machine.edge, alongCenterOf(machine.edge, rect), "docked-visible", true);
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
            if (deviated && !snapMoveGuard.isProgrammaticMove(rect.x, rect.y)) {
              await undockByDrag();
            }
          }
          return;
        }
        case "docked-hidden": {
          // 折叠态不需要光标轮询（点击轨道即可展开，不做悬停自动展开——
          // 悬停自动展开/收起正是历史上"来回跳动"的来源）。
          // 只做低频可见性健康检查（显示器热插拔 / 系统挪窗）。
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
          await undockCore();
          machine.edge = other;
          if (setPhase("candidate")) {
            setMagnetized(edgeDistance(rect, wa, other) <= SNAP_CANDIDATE_ENTER_DIST);
          }
          return;
        }
        // 磁吸滞回：> 42px 才解除（28–42 死区内保持停靠，避免阈值抖动）
        if (shouldLeaveMagnetRange(edgeDistance(rect, wa, edge))) {
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
      // 关闭吸附：清区域并恢复模式尺寸（窗口始终可见，不存在"留在屏外"）
      if (isDockedPhase(machine.phase)) {
        void setCapsuleRegion("off");
        void persistSnap(null, false, null);
        const mode = useSettingsStore.getState().settings?.mode ?? "full";
        void applyMode(mode).catch(() => {});
      } else {
        void setCapsuleRegion("off");
      }
      useEdgeSnapStore.getState().reset();
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
        if (snapMoveGuard.isHidden()) return; // 隐藏态不持久化
        if (isDockedPhase(useEdgeSnapStore.getState().phase)) return; // 停靠态不持久化
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

/** 兼容导出：旧调用方引用的胶囊 CSS 尺寸（现在指向分类胶囊轨道）。 */
export { RAIL_LENGTH_CSS as SNAP_CAPSULE_LENGTH_CSS, RAIL_THICKNESS_CSS as SNAP_CAPSULE_THICKNESS_CSS } from "../lib/capsuleLayout";
