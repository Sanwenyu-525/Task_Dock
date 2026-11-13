//! 收集箱「文件」子页（胶囊内）——文件投递部分。
//!
//! 职责：把 Windows 资源管理器里拖来的文件/文件夹，**直接**落到用户配置好的真实目录。
//! 与「快速收集」互补：那边存文字/链接/待办，这边只搬文件，不写库、不进暂存架。
//!
//! 设计约束（详见 docs/shelf/README.md §12）：
//! - 拖入走 `lib/fileDrop` 的**唯一** Webview 订阅，本面板只是其中一个消费者；
//!   命中不到具体卡片就什么都不做（fail-closed），绝不猜测目标目录；
//! - 命中只认 `data-drop-target` 卡片，高亮层 `pointer-events: none` 不挡命中；
//! - 结果内联展示（成功/跳过/失败逐项原因 + 打开目标目录），不依赖 Toast：
//!   胶囊窗口被 Win32 裁剪，浮层提示可能落在可见区域之外；
//! - 面板卸载只释放拖放订阅与定时器；在途投递的进度与结果由 store 持有，
//!   重开面板仍能看到，底层文件操作不会被界面卸载打断。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Folder,
  FolderInput,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  dropTargetAt,
  registerFileDropConsumer,
  type DropPoint,
} from "../../lib/fileDrop";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";
import { DropdownMenu } from "../ui";
import DropTargetForm from "../shelf/DropTargetForm";
import type { ShelfDropTarget } from "../../lib/bridge";
import { openFullApp } from "./actions";
import InboxRecentShelf, { SHELF_RECENT_DROP_ZONE } from "./InboxRecentShelf";
import { EmptyState } from "./PanelKit";

/** 表单与底栏共用：底栏按钮通过 form 属性提交，不在表单里再放一套主操作。 */
const FORM_ID = "cap-drop-target-form";

/** 卡片上只留最有辨识度的一段路径：`…\父目录\名称`，完整路径放 title。 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…\\${parts.slice(-2).join("\\")}`;
}

export default function InboxDropPane() {
  const { t } = useLocale();
  /** 结果条的状态标签：跳过 / 部分完成都不能被说成成功。 */
  const statusLabel: Record<string, string> = {
    ok: t("capsule.inboxDrop.status.ok"),
    skipped: t("capsule.inboxDrop.status.skipped"),
    failed: t("capsule.inboxDrop.status.failed"),
    partial: t("capsule.inboxDrop.status.partial"),
  };
  const targets = useDropTargetsStore((s) => s.targets);
  const loading = useDropTargetsStore((s) => s.loading);
  const loaded = useDropTargetsStore((s) => s.loaded);
  const error = useDropTargetsStore((s) => s.error);
  const ops = useDropTargetsStore((s) => s.ops);
  const reports = useDropTargetsStore((s) => s.reports);
  const reportNames = useDropTargetsStore((s) => s.reportNames);
  const lastTargetId = useDropTargetsStore((s) => s.lastTargetId);
  const load = useDropTargetsStore((s) => s.load);
  const drop = useDropTargetsStore((s) => s.drop);
  const remove = useDropTargetsStore((s) => s.remove);
  const move = useDropTargetsStore((s) => s.move);
  const openDir = useDropTargetsStore((s) => s.openDir);
  const clearReport = useDropTargetsStore((s) => s.clearReport);
  const requestManage = useDropTargetsStore((s) => s.requestManage);

  const [overId, setOverId] = useState<string | null>(null);
  /** 落点是否在「最近暂存」接收区：与 overId 互斥，由同一套实时命中决定。 */
  const [shelfOver, setShelfOver] = useState(false);
  /** 原生拖入会话进行中（enter 已到、leave/drop 未到）。 */
  const [dragging, setDragging] = useState(false);
  /**
   * 应用内拖出（最近暂存行 → 卡片）的前置信号。
   * 该路径的 `shelf_drag_out` 在 UI 线程执行 `DoDragDrop`，tao 会把原生
   * enter/over/drop 全部缓冲到拖拽结束后才派发——拖拽期间面板收不到任何原生
   * 事件。没有这个前置信号，整段拖拽里界面完全静止（看起来「不能投递」）。
   */
  const [localDrag, setLocalDrag] = useState(false);
  /** 拖拽进行中（原生会话或应用内拖出）：卡片/接收区的可投递形态只看这一个值。 */
  const dragActive = dragging || localDrag;
  /** null=不在表单里；"new"=新增；其余为目标 id=编辑 */
  const [editing, setEditing] = useState<string | null>(null);
  /** 表单在途状态：底栏按钮与表单共享，避免重复提交/取消丢失。 */
  const [formBusy, setFormBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  /** 「重试失败项」在途：同一批次只允许一个重试（drop 内部还有同目标单飞兜底）。 */
  const [retryBusy, setRetryBusy] = useState(false);
  const overRef = useRef<string | null>(null);
  /**
   * 最后一次 enter/over 的坐标（CSS 像素）。拖拽期间目标列表晚到、卡片被
   * 隐藏/删除、面板滚动都会让上一次命中失效，用它重算，不必等鼠标再动一次。
   */
  const lastPoint = useRef<DropPoint | null>(null);
  /** 应用内拖出的兜底复位计时器（后端 OLE 循环卡死时不能让面板永久停在拖拽形态）。 */
  const localDragTimer = useRef<number | null>(null);
  /** 投递列表滚动容器：滚动会改变卡片位置，需要按最后一次坐标重算命中。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * 一次原生拖入会话只允许执行一次落点动作。
   * fileDrop 在 drop 后已结束会话，这里再兜一层：重复/迟到的 drop 不得
   * 重复投递或重复暂存；新会话必须由 enter（或 enter 未认领时的 over）开启。
   */
  const dropSession = useRef({ active: false, handled: false });
  const timers = useRef(new Set<number>());
  /** 卸载后不再更新任何本地状态：投递可能在面板关闭后才返回（结果由 store 保留）。 */
  const alive = useRef(true);
  useEffect(() => {
    // StrictMode 下 effect 会「清理 → 重跑」一次，必须在这里重新置真。
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const visible = useMemo(
    () => targets.filter((t) => t.show_in_capsule),
    [targets],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 提示 3.2s 自动消失；卸载时清掉全部计时器（不对已卸载组件 setState）
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => window.clearTimeout(t));
      pending.clear();
    };
  }, []);

  const flash = useCallback((msg: string) => {
    if (!alive.current) return;
    setNotice(msg);
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      setNotice((n) => (n === msg ? null : n));
    }, 3200);
    timers.current.add(t);
  }, []);

  const setOver = useCallback((id: string | null) => {
    // 高频 over 事件只在实际换卡时触发一次渲染，避免拖入时反复重排
    if (overRef.current === id) return;
    overRef.current = id;
    setOverId(id);
  }, []);

  /** 只命中「当前显示的卡片」，隐藏目标不接收投递。 */
  const hitVisible = useCallback((point: DropPoint): string | null => {
    const id = dropTargetAt(point);
    if (!id) return null;
    const list = useDropTargetsStore.getState().targets;
    return list.some((t) => t.id === id && t.show_in_capsule) ? id : null;
  }, []);

  /** 只认本面板的「最近暂存」接收区；其它 data-drop-zone 不参与路由。 */
  const hitShelfZone = useCallback(
    (point: DropPoint): boolean =>
      dropTargetAt(point, "data-drop-zone") === SHELF_RECENT_DROP_ZONE,
    [],
  );

  /**
   * 悬停高亮的唯一入口：每次都用当前坐标重新命中，卡片与接收区互斥。
   * `over` 是高频事件，但 `setOver` 只在换卡时触发渲染，布尔高亮同理。
   */
  const applyOver = useCallback(
    (point: DropPoint | null) => {
      lastPoint.current = point;
      if (!point) {
        setOver(null);
        setShelfOver(false);
        return;
      }
      const id = hitVisible(point);
      setOver(id);
      setShelfOver(id === null && hitShelfZone(point));
    },
    [hitShelfZone, hitVisible, setOver],
  );

  /**
   * 用最后一次已知坐标重算命中。
   *
   * 为什么需要：`over` 由 OLE 在**鼠标移动**时驱动（wry 不节流也不补发），
   * 而 `enter` 只有一次。只要命中发生在「目标卡片还没渲染」（面板刚打开、
   * 目标列表 IPC 晚到）或「布局刚变化」（列表更新、面板滚动）的时刻，
   * `overId` 就会停在 null，用户看到的是「鼠标明明在卡片上，界面却一直提示
   * 把文件拖到卡片上」，直到再动一下鼠标才恢复。这里在已知状态变化后补算一次，
   * 不改变坐标换算、也不改变松手时按实时坐标重新命中的规则。
   */
  const rehit = useCallback(() => {
    if (!dropSession.current.active) return;
    const point = lastPoint.current;
    if (point) applyOver(point);
  }, [applyOver]);

  // 视图切换（进入表单、目标被隐藏/删除）时旧高亮立即失效：
  // 已不在列表里的卡片不能继续显示「松开即投递到…」。
  useEffect(() => {
    if (editing !== null) {
      setOver(null);
      setShelfOver(false);
      setDragging(false);
      setLocalDrag(false);
      return;
    }
    if (overRef.current && !visible.some((t) => t.id === overRef.current)) {
      setOver(null);
    }
    // 目标列表在拖拽期间才就绪/变化：按最后一次坐标补算一次命中。
    rehit();
  }, [editing, visible, setOver, rehit]);

  // 拖拽期间滚动投递列表会改变卡片位置：同样按最后一次坐标重算，
  // 避免高亮停在一张已经移走的卡片上。监听只在会话期间存在，结束即释放。
  useEffect(() => {
    if (!dragging) return;
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", rehit, { passive: true });
    return () => el.removeEventListener("scroll", rehit);
  }, [dragging, rehit]);

  /** 应用内拖出开始：原生事件被 DoDragDrop 阻塞，先用前置信号给出可投递形态。 */
  const beginLocalDrag = useCallback(() => {
    if (!alive.current) return;
    setOver(null);
    setShelfOver(false);
    setLocalDrag(true);
    if (localDragTimer.current !== null) window.clearTimeout(localDragTimer.current);
    // 与 useShelfDragOut 的看门狗同量级：OLE 循环若始终不返回，界面不能永久停在拖拽态。
    localDragTimer.current = window.setTimeout(() => {
      localDragTimer.current = null;
      setLocalDrag(false);
    }, 30_000);
  }, []);

  const endLocalDrag = useCallback(() => {
    if (localDragTimer.current !== null) {
      window.clearTimeout(localDragTimer.current);
      localDragTimer.current = null;
    }
    setLocalDrag(false);
  }, []);

  useEffect(
    () => () => {
      if (localDragTimer.current !== null) {
        window.clearTimeout(localDragTimer.current);
        localDragTimer.current = null;
      }
    },
    [],
  );

  const submit = useCallback(
    async (targetId: string, paths: string[]) => {
      const target = useDropTargetsStore.getState().targets.find((t) => t.id === targetId);
      if (!target) return;
      if (!target.available) {
        // 可用性是缓存的快照：盘刚插回来时不能因为旧快照一直拒绝。
        // 强制重探一次（只在「看起来不可用」这条路径上发生，不轮询）。
        await useDropTargetsStore.getState().load({ force: true });
        const fresh = useDropTargetsStore.getState().targets.find((t) => t.id === targetId);
        if (!fresh || !fresh.available) {
          if (alive.current) {
            flash(
              t("capsule.inboxDrop.targetUnavailable", { name: target.name }),
            );
          }
          return;
        }
      }
      try {
        const report = await drop(targetId, paths);
        if (!report || !alive.current) return; // 被去重/在途守卫拦下，或面板已关闭
        // 投递源可能是「最近暂存」里的文件：move 模式目标会把源文件搬走，
        // 引用条目随即失效；复制也顺带刷新存在性。一次小切片查询，不轮询。
        void useShelfStore.getState().loadRecent({ force: true });
        setReportOpen(report.failed > 0 || report.partial > 0);
        if (report.failed > 0 && report.partial > 0) {
          flash(
            t("capsule.inboxDrop.flashFailedPartial", {
              name: target.name,
              failed: report.failed,
              partial: report.partial,
            }),
          );
        } else if (report.failed > 0) {
          flash(
            t("capsule.inboxDrop.flashFailed", {
              name: target.name,
              count: report.failed,
            }),
          );
        } else if (report.partial > 0) {
          flash(
            t("capsule.inboxDrop.flashPartial", {
              name: target.name,
              count: report.partial,
            }),
          );
        }
      } catch (e) {
        if (alive.current) {
          flash(t("capsule.inboxDrop.dropFailed", { error: errorMessage(e) }));
        }
      }
    },
    [drop, flash, t],
  );

  /**
   * 拖入「最近暂存」：默认引用模式，只登记原文件路径，绝不移动/删除源文件。
   * 结果必须区分成功、失败与部分失败：部分失败只能说「部分」，不能冒充成功。
   */
  const addToShelf = useCallback(
    async (paths: string[]) => {
      try {
        const result = await useShelfStore
          .getState()
          .addPaths(paths, "reference", "drag");
        if (!alive.current) return;
        const failed = result.failed.length;
        if (failed > 0) {
          const reason = result.failed[0]?.reason ?? "";
          flash(
            result.added > 0
              ? t("capsule.inboxDrop.shelfPartial", {
                  added: result.added,
                  failed,
                  reason,
                })
              : t("capsule.inboxDrop.shelfFailed", { failed, reason }),
          );
        } else if (result.added > 0) {
          flash(t("capsule.inboxDrop.shelfAdded", { added: result.added }));
        } else {
          // added=0 且 failed=0（空批次/全部被过滤）：与完整暂存架 reportAdd
          // 同口径提示，不得静默结束，也不能显示「已暂存」。
          flash(t("capsule.inboxDrop.shelfNothingToAdd"));
        }
      } catch (e) {
        if (alive.current) {
          flash(t("capsule.inboxDrop.shelfAddError", { error: errorMessage(e) }));
        }
      } finally {
        // 与文件选择器同一口径：以最近切片为准刷新（新增条目立即可见）。
        if (alive.current) {
          void useShelfStore.getState().loadRecent({ force: true });
        }
      }
    },
    [flash, t],
  );

  /**
   * 结果条「查看诊断」：进入完整窗口诊断中心并定位到本批次操作链。
   * 意图只在导航成功后下发（`after`），取消草稿确认或保存中拒绝时不会残留；
   * 硬拒绝（saving）才额外提示，`pending` 由全局离开确认条接管。
   */
  const showDiagnostics = useCallback(
    (operationId: string) => {
      const result = openFullApp("diagnostics", () =>
        useUiStore.getState().requestDiagnosticsOperation(operationId),
      );
      if (result === "blocked") flash(t("capsule.inboxDrop.diagnosticsBlocked"));
    },
    [flash, t],
  );

  // ── 拖入订阅（面板在即订阅，卸载即释放；全应用只有一条 Webview 监听）──
  //
  // 本面板是胶囊拖拽会话的**唯一消费者**：目录卡片与「最近暂存」都在它的
  // 落点范围内，因此不能在两者各注册一个消费者（会出现一次拖入被处理两次，
  // 或在 enter 时按优先级抢走整个会话）。由这里按松手坐标路由：
  //   可见卡片 → 目录投递；最近暂存 → 引用暂存；空白/其它 → 不执行。
  useEffect(() => {
    return registerFileDropConsumer({
      id: "capsule-inbox-drop",
      priority: 20,
      // 面板在即接管：即使没有可见目录卡片，「最近暂存」仍是有效接收区。
      // 是否真的执行由 over/drop 的实时命中决定，未命中一律不碰文件。
      claim: () => true,
      onEnter: (point) => {
        dropSession.current = { active: true, handled: false };
        setDragging(true);
        // 进入那一瞬间就按坐标命中一次：OLE 只在鼠标移动时发 over，
        // 用户「拖进来后停在卡片上」不会有第二次机会；命中不到就保持无高亮。
        applyOver(point);
      },
      onOver: (point) => {
        const session = dropSession.current;
        if (!session.active) {
          // enter 时未认领（例如目标列表刚加载完）允许在 over 阶段补开一次；
          // 已经 drop 过的会话不再接迟到 over，避免重复高亮。
          if (session.handled) return;
          dropSession.current = { active: true, handled: false };
        }
        // 收到 over 本身就是「拖拽正在进行」的证据：enter 被错过时也要进入可投递形态。
        setDragging(true);
        applyOver(point);
      },
      onLeave: () => {
        dropSession.current = { active: false, handled: false };
        lastPoint.current = null;
        setOver(null);
        setShelfOver(false);
        setDragging(false);
        endLocalDrag();
      },
      onDrop: (paths, point) => {
        const session = dropSession.current;
        lastPoint.current = null;
        setOver(null);
        setShelfOver(false);
        setDragging(false);
        endLocalDrag();
        // 一次会话只执行一次：重复 drop 与 leave 后的迟到 drop 都不得再操作文件。
        if (!session.active || session.handled) return;
        session.handled = true;
        session.active = false;
        // 用**松手瞬间**的坐标重新命中：`over` 缓存可能已经过期（悬停 A 后快速移到
        // B 直接松手，不会再收到 over），拿缓存会让文件落进上一张卡片/上一区域。
        // 没有坐标、空 paths、空白/未命中时一律不执行文件操作。
        if (!point || paths.length === 0) return;
        const targetId = hitVisible(point);
        if (targetId) {
          void submit(targetId, paths);
          return;
        }
        if (hitShelfZone(point)) void addToShelf(paths);
      },
    });
  }, [addToShelf, applyOver, endLocalDrag, hitShelfZone, hitVisible, submit]);

  const lastReport = lastTargetId ? reports[lastTargetId] ?? null : null;
  const lastTarget = lastTargetId ? targets.find((t) => t.id === lastTargetId) ?? null : null;
  // 目标被移除后仍要能说明「这是哪次投递」：用投递时记录的名称兜底。
  const lastTargetName = lastTarget?.name ?? (lastTargetId ? reportNames[lastTargetId] ?? "" : "");
  /** 目标配置已不存在：不能再调 openDir（后端按 id 查不到），改为展示目标路径。 */
  const targetGone = lastTargetId !== null && lastTarget === null;
  // 跳过不是成功，部分完成也不是失败：三类都列出来，由用户判断是否需要处理。
  const pendingEntries = (lastReport?.entries ?? []).filter((e) => e.status !== "ok");
  const reportSummary = lastReport
    ? lastReport.partial > 0
      ? lastTargetName
        ? t("capsule.inboxDrop.resultSummaryNamedPartial", {
            name: lastTargetName,
            success: lastReport.success,
            skipped: lastReport.skipped,
            partial: lastReport.partial,
            failed: lastReport.failed,
          })
        : t("capsule.inboxDrop.resultSummaryPartial", {
            success: lastReport.success,
            skipped: lastReport.skipped,
            partial: lastReport.partial,
            failed: lastReport.failed,
          })
      : lastTargetName
        ? t("capsule.inboxDrop.resultSummaryNamed", {
            name: lastTargetName,
            success: lastReport.success,
            skipped: lastReport.skipped,
            failed: lastReport.failed,
          })
        : t("capsule.inboxDrop.resultSummary", {
            success: lastReport.success,
            skipped: lastReport.skipped,
            failed: lastReport.failed,
          })
    : "";

  /**
   * 重试失败项：把失败/跳过/部分完成条目的源路径**原样重投**到同一目标
   * （entries[].source 是投递时的源路径，move 目标的残留已由 residual_source 提示）。
   * 无 entries 或全部成功时不显示入口；重投复用 submit 的可用性探测与结果条。
   */
  const retryPending = useCallback(async () => {
    if (!lastReport || retryBusy) return;
    const paths = pendingEntries.map((e) => e.source).filter((p) => typeof p === "string" && p.length > 0);
    if (paths.length === 0) return;
    setRetryBusy(true);
    try {
      await submit(lastReport.target_id, paths);
    } finally {
      setRetryBusy(false);
    }
  }, [lastReport, pendingEntries, retryBusy, submit]);

  const empty = visible.length === 0;
  /**
   * 读屏播报用的落点名：只在实际可投递时给出。
   * 指向「目录不可用 / 正在投递」的卡片却播报「会投递到这里」是在骗读屏用户。
   */
  const overTarget = overId
    ? visible.find((target) => target.id === overId)
    : undefined;
  const liveDropName =
    overTarget && overTarget.available && !ops[overTarget.id]
      ? overTarget.name
      : "";

  return (
    <>
      {error && (
        <div className="cap-drop-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="cap-mini"
            onClick={() => void load({ force: true })}
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      <div className="cap-drop" ref={scrollRef}>
      {editing !== null ? (
        <DropTargetForm
          target={editing === "new" ? null : targets.find((t) => t.id === editing) ?? null}
          variant="capsule"
          formId={FORM_ID}
          hideActions
          onBusyChange={setFormBusy}
          onDone={(msg) => {
            setEditing(null);
            setFormBusy(false);
            if (msg) flash(msg);
          }}
          onError={(msg) => flash(msg)}
        />
      ) : (
        <>
          {/* 空态只在「确实没有目标」或「首次读取中」出现：
              读取失败由上方错误条负责（不冒充正在读取）；目标全部未勾选
              「在工具面板显示」时由下方提示负责（不误报还没有目标、不诱导重复添加）。 */}
          {empty && !loading && !error && targets.length === 0 && (
            <EmptyState
              icon={<FolderInput size={22} strokeWidth={1.6} aria-hidden="true" />}
              text={
                loaded
                  ? t("capsule.inboxDrop.emptyNone")
                  : t("capsule.inboxDrop.emptyLoading")
              }
              actionLabel={
                loaded ? t("capsule.inboxDrop.addTargetFolder") : undefined
              }
              onAction={loaded ? () => setEditing("new") : undefined}
            />
          )}

          {visible.length > 0 && (
            <div
              className={`cap-drop-grid${dragActive ? " is-dragging" : ""}`}
              role="list"
              aria-label={t("capsule.inboxDrop.listAria")}
            >
              {visible.map((target, index) => (
                <DropCard
                  key={target.id}
                  target={target}
                  over={overId === target.id}
                  op={ops[target.id]}
                  dragActive={dragActive}
                  first={index === 0}
                  last={index === visible.length - 1}
                  confirming={confirmRemove === target.id}
                  onOpen={() => {
                    void openDir(target.id).catch((e) => flash(errorMessage(e)));
                  }}
                  onEdit={() => setEditing(target.id)}
                  onMove={(dir) => {
                    void move(target.id, dir).catch((e) => flash(errorMessage(e)));
                  }}
                  onAskRemove={() => setConfirmRemove(target.id)}
                  onCancelRemove={() => setConfirmRemove(null)}
                  onConfirmRemove={() => {
                    setConfirmRemove(null);
                    void remove(target.id)
                      .then(() =>
                        flash(
                          t("capsule.inboxDrop.removed", {
                            name: target.name,
                          }),
                        ),
                      )
                      .catch((e) => flash(errorMessage(e)));
                  }}
                />
              ))}
            </div>
          )}

          {/* 拖拽过程中的动态文案只放在目标自身（卡片 meta 行 / 接收区标题行标签）：
              顶部已说明「拖文件到卡片即可投递 · N 个目标」，再插一条面板级提示
              既与顶部重复，又会作为普通文档流元素改变下方接收区几何。
              这也是 2026-11-10「提示条把卡片下移 32.7px 导致 drop 命中失败」
              的同类风险点，因此不再渲染任何面板级拖入提示。 */}

          {/* 拖入时唯一的读屏播报源：视觉文案分散在各卡片上，这里只播报「当前落点」
              一次，避免多张卡的 live 区域重复播报。视觉隐藏、不占布局也不参与命中；
              不悬停任何目标时内容为空（不播报与顶部重复的冗余信息）。 */}
          <span className="sr-only cap-drop-live" role="status">
            {dragActive && liveDropName
              ? t("capsule.inboxDrop.releaseTo", { name: liveDropName })
              : ""}
          </span>

          {visible.length === 0 && targets.length > 0 && (
            <p className="cap-drop-hint">
              {t("capsule.inboxDrop.hiddenTargets", { count: targets.length })}
            </p>
          )}

          {lastReport && (
            <div className={`cap-drop-result${lastReport.failed > 0 || lastReport.partial > 0 ? " is-warn" : ""}`}>
              <button
                type="button"
                className="cap-drop-result-head"
                aria-expanded={reportOpen}
                aria-controls="cap-drop-result-detail"
                onClick={() => setReportOpen((v) => !v)}
              >
                {lastReport.failed === 0 && lastReport.partial === 0 ? (
                  <Check size={13} strokeWidth={2.4} aria-hidden="true" />
                ) : (
                  <AlertTriangle size={13} strokeWidth={2.2} aria-hidden="true" />
                )}
                <span className="cap-drop-result-text">{reportSummary}</span>
                <ChevronDown
                  size={12}
                  strokeWidth={2.2}
                  aria-hidden="true"
                  className={reportOpen ? "is-open" : undefined}
                />
              </button>
              {reportOpen && (
                <ul className="cap-drop-result-list" id="cap-drop-result-detail">
                  {pendingEntries.map((e, i) => (
                    <li key={`${e.source}-${i}`}>
                      <span className="cap-drop-result-name" title={e.source}>
                        <span className={`cap-drop-result-tag is-${e.status}`}>
                          {statusLabel[e.status] ?? e.status}
                        </span>
                        {e.display_name}
                      </span>
                      <span className="cap-drop-result-reason">
                        {e.reason ?? statusLabel[e.status]}
                      </span>
                      {e.residual_source && (
                        <span className="cap-drop-result-residual" title={e.residual_source}>
                          {t("capsule.inboxDrop.residual", {
                            path: e.residual_source,
                          })}
                        </span>
                      )}
                      {e.recovery && (
                        <span className="cap-drop-result-recovery">{e.recovery}</span>
                      )}
                    </li>
                  ))}
                  {pendingEntries.length === 0 && (
                    <li>
                      <span className="cap-drop-result-reason">
                        {t("capsule.inboxDrop.allWritten")}
                      </span>
                    </li>
                  )}
                </ul>
              )}
              {targetGone && (
                <p className="cap-drop-result-reason">
                  {t("capsule.inboxDrop.targetGone", {
                    path: lastReport.target_path,
                  })}
                </p>
              )}
              <div className="cap-drop-result-actions">
                {pendingEntries.length > 0 && (
                  <button
                    type="button"
                    className="cap-link"
                    aria-label={t("capsule.inboxDrop.retryFailedAria", { count: pendingEntries.length })}
                    disabled={retryBusy || Boolean(lastTargetId && ops[lastTargetId])}
                    onClick={() => void retryPending()}
                  >
                    {retryBusy ? (
                      <Loader2 size={11} className="spin" aria-hidden="true" />
                    ) : null}
                    {t("capsule.inboxDrop.retryFailed", { count: pendingEntries.length })}
                  </button>
                )}
                {(lastReport.failed > 0 || lastReport.partial > 0) && (
                  <button
                    type="button"
                    className="cap-link"
                    onClick={() => showDiagnostics(lastReport.batch_id)}
                  >
                    {t("capsule.inboxDrop.viewDiagnostics")}
                  </button>
                )}
                {lastTarget ? (
                  <button
                    type="button"
                    className="cap-link"
                    onClick={() => {
                      void openDir(lastReport.target_id).catch((e) => flash(errorMessage(e)));
                    }}
                  >
                    {t("capsule.inboxDrop.openTargetFolder")}
                  </button>
                ) : (
                  <span className="cap-drop-result-reason" title={lastReport.target_path}>
                    {lastReport.target_path}
                  </span>
                )}
                <button type="button" className="cap-link" onClick={() => clearReport(lastReport.target_id)}>
                  {t("capsule.inboxDrop.collapse")}
                </button>
              </div>
            </div>
          )}

          {notice && (
            <p className="cap-drop-notice" role="status">
              {notice}
            </p>
          )}

          {/* 与投递互补：不用打开完整面板就能看到最近暂存并直接打开/复制。
              它同时是本面板拖入会话的第二个落点（引用暂存），由上面的消费者统一路由。 */}
          <InboxRecentShelf
            onNotice={flash}
            dropZone
            dropActive={dragActive}
            dropOver={shelfOver}
            onDragOutStart={beginLocalDrag}
            onDragOutEnd={endLocalDrag}
          />
        </>
      )}
      </div>

      {/* 底栏固定在面板底部：列表状态给「添加目标 / 管理」；表单状态只给
          「保存 / 取消」，避免出现两套主操作或一个禁用的重复按钮。 */}
      <div className={`cap-drop-foot${editing !== null ? " is-form" : ""}`}>
        {editing !== null ? (
          <>
            <button
              type="submit"
              form={FORM_ID}
              className="cap-mini is-primary"
              disabled={formBusy}
            >
              {formBusy ? <Loader2 size={11} className="spin" aria-hidden="true" /> : null}
              {editing === "new"
                ? t("capsule.inboxDrop.addTarget")
                : t("capsule.inboxDrop.save")}
            </button>
            <button
              type="button"
              className="cap-mini"
              disabled={formBusy}
              onClick={() => {
                setEditing(null);
                setFormBusy(false);
              }}
            >
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="cap-mini" onClick={() => setEditing("new")}>
              <Plus size={12} strokeWidth={2.4} aria-hidden="true" />{" "}
              {t("capsule.inboxDrop.addTarget")}
            </button>
            <button
              type="button"
              className="cap-link"
              onClick={() => {
                // 一次性意图必须绑定在导航事务上：切页被未保存草稿拦截/保存中
                // 拒绝时不能提前置位，否则之后进入暂存架会突然展开管理面板。
                openFullApp("shelf", () => requestManage());
              }}
            >
              {t("capsule.inboxDrop.manage")}
              <Folder size={12} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </>
  );
}

function DropCard({
  target,
  over,
  op,
  dragActive,
  first,
  last,
  confirming,
  onOpen,
  onEdit,
  onMove,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  target: ShelfDropTarget;
  over: boolean;
  op?: { total: number };
  dragActive: boolean;
  first: boolean;
  last: boolean;
  confirming: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onMove: (dir: "up" | "down") => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  const { t } = useLocale();
  const modeLabel =
    target.op_mode === "move"
      ? t("capsule.inboxDrop.modeMove")
      : t("capsule.inboxDrop.modeCopy");
  /** 投递中（正在复制/移动）与目录不可用的卡片不参与「可投递」形态。 */
  const droppable = target.available && !op;
  /**
   * 拖拽期间的三态，只用这一处判定，避免「可投递」与「当前落点」互相矛盾：
   * ready=可以接收但光标不在其上；over=松开就投递到这张卡；blocked=不可投递。
   */
  const dropState = !dragActive
    ? "idle"
    : !droppable
      ? "blocked"
      : over
        ? "over"
        : "ready";
  // 图标换成语义更明确的「文件夹 + 向内箭头」：不靠透明度也能看出这是接收区。
  const Icon = dragActive && target.available ? FolderInput : Folder;
  /**
   * 悬停时 meta 行只回答「松手会发生什么」；未悬停时保留完整模式说明
   * （含「删除源文件」警告）。两者都是单行、同一字号，不改变卡片高度。
   */
  const releaseLabel =
    dropState === "over"
      ? target.op_mode === "move"
        ? t("capsule.inboxDrop.releaseMove")
        : t("capsule.inboxDrop.releaseCopy")
      : null;
  /** 指向一张放不进去的卡片：用警示描边说明「这里不能投」，而不是复用它 is-over 的强调样式。 */
  const blockedOver = dragActive && over && !target.available;
  return (
    <div
      className={[
        "cap-drop-card",
        dropState === "over" ? "is-over" : "",
        op ? "is-busy" : "",
        target.available ? "" : "is-off",
        dropState === "ready" ? "is-idle" : "",
        // 强调描边只加在**拖拽中且当前可投递**的卡片上；静止态/正在投递/不可用都不加
        dragActive && droppable ? "is-dragging" : "",
        blockedOver ? "is-over-blocked" : "",
        confirming ? "is-confirming" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-drop-target={target.id}
      data-drop-state={dropState}
      role="listitem"
    >
      <button
        type="button"
        className="cap-drop-main"
        aria-label={t("capsule.inboxDrop.openTargetAria", { name: target.name })}
        data-tip={target.path}
        onClick={onOpen}
      >
        <span className="cap-drop-icon" aria-hidden="true">
          <Icon size={15} strokeWidth={1.8} />
        </span>
        <span className="cap-drop-name" title={target.name}>
          {target.name}
        </span>
        <span className="cap-drop-path" title={target.path}>
          {shortPath(target.path)}
        </span>
      </button>

      <span className="cap-drop-meta">
        {op ? (
          <span className="cap-drop-busy" role="status">
            <Loader2 size={11} className="spin" aria-hidden="true" />
            {target.op_mode === "move"
              ? t("capsule.inboxDrop.busyMove", { count: op.total })
              : t("capsule.inboxDrop.busyCopy", { count: op.total })}
          </span>
        ) : !target.available ? (
          <span className="cap-drop-status is-bad">
            {t("capsule.inboxDrop.unavailable")}
          </span>
        ) : releaseLabel ? (
          <span
            className="cap-drop-status is-release"
            data-tip={
              target.op_mode === "move"
                ? t("capsule.inboxDrop.moveTip")
                : t("capsule.inboxDrop.copyTip")
            }
          >
            {releaseLabel}
          </span>
        ) : (
          <span
            className={`cap-drop-status is-mode ${target.op_mode === "move" ? "is-warn" : ""}`}
            data-tip={
              target.op_mode === "move"
                ? t("capsule.inboxDrop.moveTip")
                : t("capsule.inboxDrop.copyTip")
            }
          >
            {modeLabel}
          </span>
        )}
      </span>

      {/* 菜单在拖入开始时重置：展开的弹层不能挡住落点命中 */}
      {!confirming && (
        <DropdownMenu
          key={dragActive ? "drag" : "idle"}
          menuLabel={t("capsule.inboxDrop.cardMenuAria", { name: target.name })}
          placement="bottom-end"
          menuMinWidth={132}
          trigger={({ ref, onClick, onKeyDown, expanded }) => (
            <button
              ref={ref}
              type="button"
              className="cap-drop-more"
              aria-label={t("capsule.inboxDrop.cardMoreAria", {
                name: target.name,
              })}
              aria-expanded={expanded}
              data-tip={t("capsule.inboxDrop.moreTip")}
              onClick={onClick}
              onKeyDown={onKeyDown}
            >
              <MoreVertical size={13} strokeWidth={2.2} aria-hidden="true" />
            </button>
          )}
          items={[
            {
              key: "edit",
              label: t("capsule.inboxDrop.edit"),
              icon: <Pencil size={12} strokeWidth={2.2} aria-hidden="true" />,
              onSelect: onEdit,
            },
            {
              key: "up",
              label: t("capsule.inboxDrop.moveUp"),
              icon: <ArrowUp size={12} strokeWidth={2.2} aria-hidden="true" />,
              disabled: first,
              onSelect: () => onMove("up"),
            },
            {
              key: "down",
              label: t("capsule.inboxDrop.moveDown"),
              icon: <ArrowDown size={12} strokeWidth={2.2} aria-hidden="true" />,
              disabled: last,
              onSelect: () => onMove("down"),
            },
            {
              key: "remove",
              label: t("capsule.inboxDrop.remove"),
              icon: <Trash2 size={12} strokeWidth={2.2} aria-hidden="true" />,
              danger: true,
              onSelect: onAskRemove,
            },
          ]}
        />
      )}

      {confirming && (
        <span
          className="cap-drop-confirm"
          role="group"
          aria-label={t("capsule.inboxDrop.removeAria", { name: target.name })}
        >
          <span className="cap-drop-confirm-text">
            {t("capsule.inboxDrop.removeConfirm")}
          </span>
          <span className="cap-drop-confirm-actions">
            <button type="button" className="cap-mini is-primary" onClick={onConfirmRemove}>
              {t("capsule.inboxDrop.removeBtn")}
            </button>
            <button type="button" className="cap-mini" onClick={onCancelRemove}>
              {t("common.cancel")}
            </button>
          </span>
        </span>
      )}
    </div>
  );
}
