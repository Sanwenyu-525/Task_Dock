//! 智能剪贴板工作区：**页面与抽屉共用同一份业务逻辑**。
//!
//! - `variant="page"`：完整模式左侧导航「剪贴板」页，直接占据右侧内容区；
//! - `variant="drawer"`：任务关联 / 紧凑模式下的临时抽屉，遮罩 + 侧滑面板。
//!
//! 两种形态共用同一套状态、订阅与操作逻辑（不复制第二份）：
//! - 数据加载、筛选、分页、多选由 useClipboardStore 统一持有；
//! - 后端变更监听由 store 内部**引用计数**保证全局只有一个 Tauri 监听，
//!   因此页面与抽屉同时存在时不会重复处理同一次采集事件；
//! - Escape 走全局弹层栈：确认框(dialog) → 顶层模态(modalTop，图片灯箱) →
//!   子弹层(sublayer) → 抽屉(drawer) → 主窗口。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle, Clipboard, Copy, FolderPlus, Info, Link2, Merge, Pause, Play, RefreshCw, Search,
  Settings as SettingsIcon, Star, Trash2, X,
} from "lucide-react";
import {
  clipboardClearHistory,
  clipboardCopyGroupFiles,
  clipboardCopyGroupRich,
  clipboardCopyItem,
  clipboardCopyItemsFiles,
  clipboardCopyItemsRich,
  clipboardCreateGroup,
  clipboardDeleteGroup,
  clipboardDeleteItems,
  clipboardLinkTask,
  clipboardMergeGroups,
  clipboardStatus,
  clipboardToggleGroup,
  clipboardToggleItem,
  type ClipboardGroup,
  type ClipboardItem,
  type ClipboardStatus,
  type CopyReport,
  type DeleteReport,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { formatBytes, objectHint } from "../../lib/clipboardUi";
import { EXIT_MS, REORDER_MS, prefersReducedMotion } from "../../lib/motion";
import { useClipboardStore } from "../../store/useClipboardStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useFocusTrap, useOverlayLayer } from "../ui/overlay";
import { ConfirmDialog } from "../ui/Dialog";
import ClipboardGroupCard from "./ClipboardGroupCard";
import ClipboardGroupDetail from "./ClipboardGroupDetail";
import ClipboardItemCard from "./ClipboardItemCard";
import ClipboardItemDetail from "./ClipboardItemDetail";
import ImageLightbox from "./ImageLightbox";
import PastePanel from "./PastePanel";
import type { AskConfirm, ClipboardDetail } from "./types";

const KIND_CHIPS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "text", label: "文字" },
  { id: "url", label: "链接" },
  { id: "html", label: "富文本" },
  { id: "image", label: "图片" },
  { id: "files", label: "文件" },
];

export interface ClipboardWorkspaceProps {
  variant: "page" | "drawer";
  /** 活跃态：false 时不加载、不订阅（面板页离开时避免后台空转） */
  active: boolean;
  /** 抽屉形态的关闭回调 */
  onClose?: () => void;
}

export default function ClipboardWorkspace({ variant, active, onClose }: ClipboardWorkspaceProps) {
  const isDrawer = variant === "drawer";
  const linkTask = useUiStore((s) => s.clipboardLinkTask);
  const closeDrawer = useUiStore((s) => s.closeClipboard);
  const bumpLink = useUiStore((s) => s.bumpClipboardLink);
  const setTab = useUiStore((s) => s.setTab);
  const showToast = useUiStore((s) => s.showToast);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);

  const view = useClipboardStore((s) => s.view);
  const filters = useClipboardStore((s) => s.filters);
  const section = useClipboardStore((s) => s.section);
  const searchText = useClipboardStore((s) => s.searchText);
  const loading = useClipboardStore((s) => s.loading);
  const loadingMore = useClipboardStore((s) => s.loadingMore);
  const error = useClipboardStore((s) => s.error);
  const selectedItems = useClipboardStore((s) => s.selectedItems);
  const selectedGroups = useClipboardStore((s) => s.selectedGroups);
  const setFilters = useClipboardStore((s) => s.setFilters);
  const setSection = useClipboardStore((s) => s.setSection);
  const setSearchText = useClipboardStore((s) => s.setSearchText);
  const load = useClipboardStore((s) => s.load);
  const setFullLive = useClipboardStore((s) => s.setFullLive);
  const toggleItemSelection = useClipboardStore((s) => s.toggleItemSelection);
  const toggleGroupSelection = useClipboardStore((s) => s.toggleGroupSelection);
  const clearSelection = useClipboardStore((s) => s.clearSelection);

  const [detail, setDetail] = useState<ClipboardDetail | null>(null);
  /** 列表里点缩略图直接打开的原图灯箱（详情视图内的灯箱由 ClipboardItemDetail 自己托管） */
  const [previewImage, setPreviewImage] = useState<ClipboardItem | null>(null);
  const [status, setStatus] = useState<ClipboardStatus | null>(null);
  /** 状态读取失败：保留旧状态并标记过期，避免把「监听异常」显示成未知/正常 */
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [mergeName, setMergeName] = useState("");
  const [confirm, setConfirm] = useState<{
    title: string;
    detail?: string;
    confirmLabel: string;
    danger?: boolean;
    run: () => void | Promise<void>;
  } | null>(null);
  const drawerRef = useRef<HTMLElement>(null);

  // 删除反馈链：执行中（等后端确认）→ 目标卡片离场 → 离场结束再静默补位。
  // 离场中的行由 store 钉在原位，后台采集事件与静默刷新都不能把它提前卸载；
  // 快照的收尾定时器归 store 所有，动画中途关闭抽屉（卸载）也能正常收尾，
  // 不会把已删除的行以快照形式带回列表。这里的组件定时器只负责收尾后的
  // 静默刷新与焦点交接，卸载时统一回收；不做常驻轮询或高频刷新。
  const exiting = useClipboardStore((s) => s.exiting);
  const beginExit = useClipboardStore((s) => s.beginExit);
  const endExit = useClipboardStore((s) => s.endExit);
  const patchItem = useClipboardStore((s) => s.patchItem);
  const patchGroup = useClipboardStore((s) => s.patchGroup);
  /** 后端尚未确认：目标卡片显示执行中并挡住重复提交 */
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 发起操作时用户所在的卡片：确认框会抢走焦点，等到确认后再取就拿不到了 */
  const confirmAnchor = useRef<string | null>(null);
  const exitTimers = useRef<number[]>([]);
  useEffect(
    () => () => {
      exitTimers.current.forEach((t) => window.clearTimeout(t));
      exitTimers.current = [];
    },
    [],
  );

  // 主列表轻量重排（FLIP）：置顶/取消置顶、静默刷新带来的顺序变化用一次
  // 位移补偿过渡。不引动画库、不常驻 rAF；只读一次 offsetTop，播完即走。
  // 与删除离场互斥：离场行的高度收拢已经在表达位移，再叠 FLIP 会来回打架。
  const listTopsRef = useRef<Map<string, number>>(new Map());
  const prevExitCountRef = useRef(0);
  const exitCount = Object.keys(exiting).length;
  useEffect(() => {
    prevExitCountRef.current = exitCount;
  }, [exitCount]);
  const flipSig =
    section +
    "|" +
    (view?.items.map((i) => i.id).join("|") ?? "") +
    "|" +
    (view?.groups.map((g) => g.id).join("|") ?? "");
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-clip-id]"));
    const tops = new Map(rows.map((r) => [r.dataset.clipId ?? "", r.offsetTop]));
    const prev = listTopsRef.current;
    const prevExiting = prevExitCountRef.current;
    listTopsRef.current = tops;
    // 首次渲染没有参照位置；离场开始/结束的渲染不做重排（收拢动画已表达位移）
    if (prev.size === 0 || exitCount > 0 || prevExiting > 0) return;
    if (prefersReducedMotion() || rows.length > 60) return;
    for (const r of rows) {
      const id = r.dataset.clipId ?? "";
      const before = prev.get(id);
      if (before === undefined) continue;
      const delta = before - (tops.get(id) ?? before);
      if (delta === 0 || typeof r.animate !== "function") continue;
      r.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: REORDER_MS, easing: "ease" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipSig]);

  /** 焦点在被删卡片上时，先记下相邻行的 id，供离场结束后接管焦点。 */
  function captureFocusAnchor(ids: string[]): string | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const card = active.closest<HTMLElement>("[data-clip-id]");
    if (!card) return null;
    const gone = new Set(ids);
    const rows = Array.from(
      card.parentElement?.querySelectorAll<HTMLElement>("[data-clip-id]") ?? [],
    );
    const self = rows.indexOf(card);
    const alive = (el: HTMLElement) => !gone.has(el.dataset.clipId ?? "");
    const next = rows.slice(self + 1).find(alive);
    const prev = rows.slice(0, Math.max(self, 0)).reverse().find(alive);
    return (next ?? prev)?.dataset.clipId ?? null;
  }
  /** 离场结束：放手让列表补位、静默刷新，并把焦点交还给相邻卡片或搜索框。 */
  function scheduleExitEnd(ids: string[], anchorId: string | null, after?: () => void) {
    const timer = window.setTimeout(
      () => {
        exitTimers.current = exitTimers.current.filter((t) => t !== timer);
        endExit(ids);
        void load({ silent: true });
        if (anchorId) {
          const selector = `[data-clip-id="${CSS.escape(anchorId)}"]`;
          const el = listRef.current?.querySelector<HTMLElement>(selector);
          (el ?? searchRef.current)?.focus();
        }
        after?.();
      },
      prefersReducedMotion() ? 0 : EXIT_MS,
    );
    exitTimers.current.push(timer);
  }

  /**
   * 删除的统一反馈链。`countOf` 决定「后端到底删掉了几个目标对象」：
   * 条目看 `deleted`，分组看命令是否成功（`deleted` 只统计连带删除的条目）。
   * 数量为 0 时如实提示并刷新，绝不演一场成功。
   */
  async function runDelete(
    ids: string[],
    kind: "item" | "group",
    invokeDelete: () => Promise<DeleteReport>,
    countOf: (r: DeleteReport) => number,
    report: (deleted: number) => void,
    after?: () => void,
  ) {
    setPendingIds((prev) => [...prev, ...ids]);
    // 优先用发起操作时记下的相邻行；没有（例如批量操作在工具栏发起）就不接管焦点
    const anchorId = confirmAnchor.current ?? captureFocusAnchor(ids);
    confirmAnchor.current = null;
    try {
      const r = await invokeDelete();
      const deleted = countOf(r);
      if (deleted <= 0) {
        showToast("这些内容已经不存在，列表已刷新", { kind: "warning" });
        void load({ silent: true });
        return;
      }
      if (deleted < ids.length) {
        // 后端只删掉一部分，而且报告里说不清是哪几条：整批演离场等于把没删掉的
        // 也伪装成已删除。如实报数并按服务端结果重新同步，剩下由刷新来定性。
        showToast(`选中 ${ids.length} 条，实际删除 ${deleted} 条，其余仍在列表中`, { kind: "warning" });
        void load({ silent: true });
        return;
      }
      beginExit(ids, kind);
      report(deleted);
      scheduleExitEnd(ids, anchorId, after);
    } catch (e) {
      showToast(String(e), { kind: "error" });
    } finally {
      setPendingIds((prev) => prev.filter((x) => !ids.includes(x)));
    }
  }

  const askConfirm: AskConfirm = (opts) => {
    // 确认框打开后会夺走焦点，此刻还没删任何东西，先记下相邻卡片
    confirmAnchor.current = captureFocusAnchor([]);
    setConfirm({
      title: opts.title,
      detail: opts.detail,
      confirmLabel: opts.confirmLabel ?? "确认",
      danger: opts.danger,
      run: opts.run,
    });
  };

  // 打开或筛选变化时拉取
  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, filters.kind, filters.favorite, filters.search, load]);

  // 搜索防抖：输入框即时回显，筛选条件延迟落库
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => {
      if (searchText !== filters.search) setFilters({ search: searchText });
    }, 260);
    return () => window.clearTimeout(t);
  }, [searchText, active, filters.search, setFilters]);

  // 全局搜索定位：消费一次性意图，直接按 id 打开条目详情
  // （ClipboardItemDetail 以 itemId 独立取数，不依赖当前过滤列表）。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "clipboard") return;
    const intent = pendingLocate;
    consumeLocate();
    setDetail({ kind: "item", id: intent.id });
    // 仅响应定位意图变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLocate]);

  // 关联模式固定回到「历史」：上次浏览停在「分组」时直接复用会让用户看不到任何可选条目
  useEffect(() => {
    if (!linkTask) return;
    setSection("items");
    clearSelection();
  }, [linkTask, clearSelection, setSection]);

  // 实时监听：交给 store 统一管理（全局只建一个 Tauri 监听）
  useEffect(() => {
    if (!active) return;
    setFullLive(true);
    return () => setFullLive(false);
  }, [active, setFullLive]);

  // 监听状态（区分「已暂停」与「监听线程未启动」）
  useEffect(() => {
    if (!active) return;
    let alive = true;
    clipboardStatus()
      .then((s) => {
        if (alive) {
          setStatus(s);
          setStatusError(null);
        }
      })
      .catch((e) => {
        if (alive) setStatusError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [active]);

  // 关闭时重置子视图与确认框
  useEffect(() => {
    if (active) return;
    setDetail(null);
    setConfirm(null);
  }, [active]);

  // 弹层栈：详情子视图 → 抽屉。确认框由 ConfirmDialog 自己注册（dialog，优先级最高）。
  useOverlayLayer("sublayer", active && !!detail, () => setDetail(null));
  // 关联模式（从任务编辑器发起）时，抽屉是**盖在编辑器之上**的模态选择面，
  // Escape 必须先关抽屉而不是编辑器——弹层层级要和视觉层级一致。
  // 因此关联模式按 dialog 注册，并让任务编辑器在抽屉打开期间让出弹层栈。
  useOverlayLayer(linkTask ? "dialog" : "drawer", active && isDrawer, () => (onClose ?? closeDrawer)(), drawerRef);
  // 焦点陷阱：抽屉内 Tab 循环；确认框打开时交由确认框自己接管
  useFocusTrap(active && isDrawer && !confirm, drawerRef);

  // 配置异常优先于 enabled/paused：损坏的配置绝不能显示为“监听中”。
  const configError = status?.configError ?? null;
  const configOrigin = status?.configOrigin ?? null;
  const legacyPaused = !configError && configOrigin === "legacy_upgrade_paused";
  const paused = configError ? true : settings?.clipboard_paused ?? false;
  const enabled = configError ? false : settings?.clipboard_enabled ?? true;
  const monitoringDown = status?.monitoring === false;
  const statusLabel = configError
    ? "配置异常，自动记录已暂停"
    : !enabled
      ? "已停用"
      : paused
        ? "已暂停"
        : monitoringDown
          ? "监听未启动"
          : "监听中";
  const statusTone = configError ? "bad" : !enabled ? "off" : paused ? "paused" : monitoringDown ? "bad" : "ok";
  const stats = view?.stats;

  function reportCopy(r: CopyReport) {
    const warn = r.warnings.length > 0 ? `；${r.warnings.join("；")}` : "";
    showToast(`已复制 ${r.item_count} 项（${r.mode.toUpperCase()}，${formatBytes(r.bytes)}）${warn}`, {
      kind: r.warnings.length > 0 ? "info" : "success",
    });
  }

  async function onCopyItem(item: ClipboardItem) {
    try {
      reportCopy(await clipboardCopyItem(item.id));
      // 复制不改变排序：只就地更新使用次数，避免整表刷新导致分页丢失或滚动跳顶。
      useClipboardStore.getState().bumpItemCopy(item.id);
    } catch (e) {
      showToast(`复制失败：${String(e)}`, { kind: "error" });
    }
  }

  async function onToggleItem(item: ClipboardItem, flag: "favorite" | "pinned") {
    try {
      const updated = await clipboardToggleItem(item.id, flag);
      // 后端返回最新实体：图标就地翻转，不必等整表刷新才确认操作生效
      patchItem(updated);
      const hint = objectHint(item);
      if (flag === "favorite") {
        showToast(
          updated.favorite
            ? `已收藏「${hint}」`
            : filters.favorite
              // 只看收藏下取消收藏会让它离开当前列表：说清是退出筛选，不是删除
              ? `已取消收藏「${hint}」，退出「只看收藏」列表，内容仍保留在历史中`
              : `已取消收藏「${hint}」，内容仍保留在历史中`,
          { kind: "success" },
        );
      } else {
        showToast(
          updated.pinned
            ? `已置顶「${hint}」，将排到列表前面`
            : `已取消置顶「${hint}」，按时间回到原位`,
          { kind: "success" },
        );
      }
      // 置顶会改变排序，仍需静默刷新拿到新的顺序
      void load({ silent: true });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  function onDeleteItem(item: ClipboardItem) {
    askConfirm({
      title: "删除这条剪贴板历史？",
      detail: item.file_paths.length > 0
        ? "将同时从所属分组和任务关联中移除；文件条目只删除历史记录，不会删除磁盘上的文件。"
        : "将同时从所属分组和任务关联中移除。",
      confirmLabel: "删除",
      danger: true,
      run: () =>
        runDelete(
          [item.id],
          "item",
          () => clipboardDeleteItems([item.id]),
          (r) => r.deleted,
          // 带上对象信息：相似内容连排时，只有一句「删除成功」认不出动的是哪条
          () => showToast(`已删除「${objectHint(item)}」`, { kind: "success" }),
        ),
    });
  }

  async function onCopyGroup(group: ClipboardGroup, mode: "rich" | "files") {
    setBusy(`${mode}-${group.id}`);
    try {
      const r = mode === "rich"
        ? await clipboardCopyGroupRich(group.id)
        : await clipboardCopyGroupFiles(group.id);
      reportCopy(r);
    } catch (e) {
      showToast(`复制失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onToggleGroup(group: ClipboardGroup, flag: "favorite" | "pinned") {
    try {
      const updated = await clipboardToggleGroup(group.id, flag);
      patchGroup(updated);
      const action = flag === "favorite"
        ? updated.favorite ? "已收藏" : "已取消收藏"
        : updated.pinned ? "已置顶" : "已取消置顶";
      showToast(`${action}分组「${group.name}」`, { kind: "success" });
      void load({ silent: true });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  function onDeleteGroup(group: ClipboardGroup) {
    askConfirm({
      title: `删除分组「${group.name}」？`,
      detail: "只删除分组本身，分组内的历史条目仍保留。若要连同内容删除，请在分组详情中操作。",
      confirmLabel: "删除分组",
      danger: true,
      // 保留条目时报告的 deleted 只统计条目（恒为 0），分组本身删没删看 groups_deleted：
      // 分组不存在时（groups_deleted = 0）如实提示并刷新，绝不演一场成功
      run: () =>
        runDelete(
          [group.id],
          "group",
          () => clipboardDeleteGroup(group.id, false),
          (r) => r.groups_deleted,
          () => showToast(`分组「${group.name}」已删除，历史条目仍保留`, { kind: "success" }),
        ),
    });
  }

  function onClearHistory() {
    if (historyCount === 0) return;
    askConfirm({
      title: "确定清空全部剪贴板历史？",
      detail:
        "将删除 Dock 保存的全部历史条目、分组和相关内部图片缓存，包括收藏和置顶内容。此操作不可撤销。" +
        "不会清除系统当前剪贴板，也不会删除电脑中的原始文件。",
      confirmLabel: "确认清空",
      danger: true,
      run: async () => {
        setBusy("clear-history");
        try {
          const r = await clipboardClearHistory();
          clearSelection();
          setDetail(null);
          const warn = r.failed_files > 0
            ? `；${r.failed_files} 个缓存文件删除失败，将在下次清理时重试`
            : "";
          showToast(
            `已清空 ${r.items} 条历史、${r.groups} 个分组${warn}`,
            { kind: r.failed_files > 0 ? "info" : "success" },
          );
          await load();
        } catch (e) {
          showToast(`清空失败：${String(e)}`, { kind: "error" });
        } finally {
          setBusy(null);
        }
      },
    });
  }

  async function onCreateGroup() {
    if (selectedItems.length === 0) return;
    setBusy("create-group");
    try {
      const g = await clipboardCreateGroup(groupName.trim() || "手动分组", selectedItems);
      setGroupName("");
      clearSelection();
      setSection("groups");
      showToast(`已创建分组「${g.name}」，共 ${g.item_count} 项`, { kind: "success" });
      void load({ silent: true });
    } catch (e) {
      showToast(`创建分组失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  /** 任意多选批量复制：rich=富文本整合；files=文件/图片本地路径。 */
  async function onCopySelectedItems(mode: "rich" | "files") {
    if (selectedItems.length === 0) return;
    setBusy(`copy-selected-${mode}`);
    try {
      const r = mode === "rich"
        ? await clipboardCopyItemsRich(selectedItems)
        : await clipboardCopyItemsFiles(selectedItems);
      reportCopy(r);
    } catch (e) {
      showToast(`批量复制失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onMergeGroups() {
    if (selectedGroups.length < 2) return;
    const ids = [...selectedGroups];
    setBusy("merge");
    try {
      const g = await clipboardMergeGroups(ids, mergeName.trim() || "合并分组");
      setMergeName("");
      // 原分组用与删除一致的离场语言退场，新分组随刷新出现
      beginExit(ids, "group");
      clearSelection();
      setSection("groups");
      showToast(`已合并为「${g.name}」，共 ${g.item_count} 项；原 ${ids.length} 个分组不再单独显示`, { kind: "success" });
      // 离场结束时 scheduleExitEnd 已带一次静默刷新，这里不再重复请求
      scheduleExitEnd(ids, null);
    } catch (e) {
      showToast(`合并失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  function onDeleteSelectedItems() {
    const ids = [...selectedItems];
    if (ids.length === 0) return;
    askConfirm({
      title: `删除选中的 ${ids.length} 条历史？`,
      detail: "将同时从所属分组和任务关联中移除；文件条目只删除记录，不会删除磁盘文件。",
      confirmLabel: "删除所选",
      danger: true,
      run: () =>
        runDelete(
          ids,
          "item",
          () => clipboardDeleteItems(ids),
          (r) => r.deleted,
          // 走到这里说明选中项已全部删除；数量仍以后端为准
          (deleted) => showToast(`已删除 ${deleted} 条`, { kind: "success" }),
          clearSelection,
        ),
    });
  }

  async function onLink(targetType: "item" | "group", targetId: string) {
    if (!linkTask) return;
    try {
      await clipboardLinkTask(linkTask.id, targetType, targetId);
      bumpLink();
      showToast(`已关联到任务「${linkTask.title}」`, { kind: "success" });
      closeDrawer();
    } catch (e) {
      showToast(`关联失败：${String(e)}`, { kind: "error" });
    }
  }

  async function togglePause() {
    try {
      await updateSettings({ clipboard_paused: !paused });
      showToast(!paused ? "已暂停记录新的剪贴板内容" : "已恢复监听", { kind: "success" });
    } catch (e) {
      showToast(`切换失败：${String(e)}`, { kind: "error" });
    }
  }

  function goSettings() {
    setTab("settings");
    if (isDrawer) closeDrawer();
  }

  const filterActive = filters.kind !== "all" || filters.favorite || filters.search.trim() !== "";
  /** 清空入口的可用性：条目与分组都为空时没有可清空的内容。 */
  const historyCount = (stats?.items ?? 0) + (stats?.groups ?? 0);
  /** 所选里是否至少有一条文件/图片；纯文字选区不能「复制为文件」。 */
  const selectedHasFiles = (view?.items ?? []).some(
    (i) => selectedItems.includes(i.id) && (i.kind === "image" || i.kind === "files"),
  );

  function renderList() {
    if (section === "groups") {
      const groups = view?.groups ?? [];
      if (loading && !view) return <div className="clip-loading">正在加载分组…</div>;
      if (error) {
        return (
          <div className="clip-empty">
            <span>{error}</span>
            <button className="btn sm" onClick={() => void load()}>重试</button>
          </div>
        );
      }
      if (groups.length === 0) {
        return (
          <div className="clip-empty">
            <Clipboard size={22} className="clip-empty-icon" />
            <strong>暂无分组</strong>
            <span>连续截图会自动成组；也可以在历史中勾选条目后手动创建分组。</span>
          </div>
        );
      }
      return (
        <div className="clip-list" ref={listRef}>
          {groups.map((g) => (
            <ClipboardGroupCard
              key={g.id}
              group={g}
              selected={selectedGroups.includes(g.id)}
              removing={!!exiting[g.id]}
              pending={pendingIds.includes(g.id)}
              linkMode={!!linkTask}
              onSelect={() => toggleGroupSelection(g.id)}
              onToggle={(flag) => void onToggleGroup(g, flag)}
              onCopyRich={() => void onCopyGroup(g, "rich")}
              onCopyFiles={() => void onCopyGroup(g, "files")}
              onPaste={() => setDetail({ kind: "paste", id: g.id, name: g.name })}
              onDetail={() => setDetail({ kind: "group", id: g.id })}
              onDelete={() => onDeleteGroup(g)}
              onLink={() => void onLink("group", g.id)}
            />
          ))}
        </div>
      );
    }

    const items = view?.items ?? [];
    if (loading && !view) return <div className="clip-loading">正在加载剪贴板历史…</div>;
    if (error) {
      return (
        <div className="clip-empty">
          <span>{error}</span>
          <button className="btn sm" onClick={() => void load()}>重试</button>
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div className="clip-empty">
          <Clipboard size={22} className="clip-empty-icon" />
          <strong>{filterActive ? "没有符合条件的记录" : "还没有剪贴板记录"}</strong>
          <span>
            {configError
              ? "剪贴板配置异常，自动记录已暂停；请在设置 → 智能剪贴板中修复。"
              : !enabled
                ? "剪贴板记录已停用，可在设置中开启。"
                : paused
                  ? "监听已暂停，恢复后新的复制才会被记录。"
                  : filterActive
                    ? "试试清除搜索或切换类型筛选。"
                    : "复制文字、图片或文件后会自动出现在这里。"}
          </span>
        </div>
      );
    }
    return (
      <>
        <div className="clip-list" ref={listRef}>
          {items.map((item) => (
            <ClipboardItemCard
              key={item.id}
              item={item}
              selected={selectedItems.includes(item.id)}
              removing={!!exiting[item.id]}
              pending={pendingIds.includes(item.id)}
              linkMode={!!linkTask}
              onSelect={() => toggleItemSelection(item.id)}
              onCopy={() => void onCopyItem(item)}
              onToggle={(flag) => void onToggleItem(item, flag)}
              onDetail={() => setDetail({ kind: "item", id: item.id })}
              onDelete={() => onDeleteItem(item)}
              onLink={() => void onLink("item", item.id)}
              onOpenImage={() => setPreviewImage(item)}
            />
          ))}
        </div>
        {view && view.items.length < view.total_items && (
          <button className="btn sm clip-more" onClick={() => void load({ append: true })} disabled={loadingMore}>
            {loadingMore ? <RefreshCw size={12} className="spin" /> : null}
            加载更多（{view.items.length}/{view.total_items}）
          </button>
        )}
      </>
    );
  }

  const body = (
    <>
      <header className="clip-head">
        <div className="clip-head-title">
          <Clipboard size={15} />
          <span>智能剪贴板</span>
          <span className={`clip-status tone-${statusTone}`}>
            <i /> {statusLabel}
          </span>
        </div>
        <div className="clip-head-actions">
          <button
            className={`icon-btn sm ${paused ? "active" : ""}`}
            data-tip={
              !enabled
                ? "剪贴板记录已停用，请在设置中开启"
                : paused
                  ? "恢复监听"
                  : "暂停记录新的剪贴板内容（仍可查看历史）"
            }
            aria-label={paused ? "恢复监听" : "暂停监听"}
            aria-pressed={paused}
            disabled={!enabled}
            onClick={togglePause}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
          <button className="icon-btn sm" data-tip="剪贴板设置" aria-label="剪贴板设置" onClick={goSettings}>
            <SettingsIcon size={13} />
          </button>
          {isDrawer && (
            <button className="icon-btn sm" data-tip="关闭 (Esc)" aria-label="关闭剪贴板" onClick={onClose ?? closeDrawer}>
              <X size={14} />
            </button>
          )}
        </div>
      </header>
      {statusError && (
        <div className="empty-hint error-text" role="status">
          剪贴板状态读取失败：{statusError}（下方状态可能不是最新）
          <button
            className="btn sm"
            onClick={() => {
              clipboardStatus()
                .then((s) => {
                  setStatus(s);
                  setStatusError(null);
                })
                .catch((e) => setStatusError(errorMessage(e)));
            }}
          >
            重试
          </button>
        </div>
      )}

      {configError && (
        <div className="clip-link-banner clip-config-banner" role="alert">
          <AlertTriangle size={12} />
          <span>
            {configError.message}
            {configError.keys.length > 0 ? `（键：${configError.keys.join("、")}）` : ""}
            。监听线程仍在运行，但不会记录任何新内容；损坏的原始值已保留，可在设置中修复。
          </span>
          <button className="link-btn" onClick={goSettings}>去修复</button>
        </div>
      )}

      {legacyPaused && (
        <div className="clip-link-banner" role="status">
          <Info size={12} />
          <span>从旧版本升级：为避免未经确认的记录，剪贴板自动采集默认保持暂停，Task Dock 不会自行开始记录。</span>
          <button className="link-btn" onClick={goSettings}>去设置</button>
        </div>
      )}

      {linkTask && (
        <div className="clip-link-banner">
          <Link2 size={12} />
          <span>为任务「{linkTask.title}」选择要关联的条目或分组；关联后抽屉会自动关闭。</span>
          <button className="link-btn" onClick={onClose ?? closeDrawer}>取消</button>
        </div>
      )}

      {!detail && (
        <>
          <div className="clip-toolbar">
            <div className="clip-search">
              <Search size={12} />
              <input
                className="input-embedded"
                ref={searchRef}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="搜索文字、来源应用、文件名…"
                aria-label="搜索剪贴板历史"
              />
              {searchText && (
                <button className="icon-btn sm" data-tip="清除搜索" aria-label="清除搜索" onClick={() => setSearchText("")}>
                  <X size={11} />
                </button>
              )}
            </div>
            <button
              className={`icon-btn sm ${filters.favorite ? "active" : ""}`}
              data-tip={filters.favorite ? "显示全部" : "只看收藏"}
              aria-label={filters.favorite ? "显示全部条目" : "只看收藏"}
              aria-pressed={filters.favorite}
              onClick={() => setFilters({ favorite: !filters.favorite })}
            >
              <Star size={13} />
            </button>
          </div>
          <div className="seg-group subtle clip-chips" role="group" aria-label="类型筛选">
            {KIND_CHIPS.map((k) => (
              <button
                key={k.id}
                className={`seg-btn ${filters.kind === k.id ? "active" : ""}`}
                aria-pressed={filters.kind === k.id}
                onClick={() => setFilters({ kind: k.id })}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="clip-tabs" role="tablist" aria-label="剪贴板视图">
            <button
              role="tab"
              aria-selected={section === "items"}
              className={section === "items" ? "active" : ""}
              onClick={() => {
                setSection("items");
                clearSelection();
              }}
            >
              历史 <em>{view?.total_items ?? 0}</em>
            </button>
            <button
              role="tab"
              aria-selected={section === "groups"}
              className={section === "groups" ? "active" : ""}
              onClick={() => {
                setSection("groups");
                clearSelection();
              }}
            >
              分组 <em>{view?.groups.length ?? 0}</em>
            </button>
          </div>
        </>
      )}

      <div className="clip-body">
        {detail?.kind === "item" ? (
          <ClipboardItemDetail
            itemId={detail.id}
            linkTask={linkTask}
            askConfirm={askConfirm}
            onBack={() => setDetail(null)}
            onChanged={() => void load({ silent: true })}
          />
        ) : detail?.kind === "group" ? (
          <ClipboardGroupDetail
            groupId={detail.id}
            linkTask={linkTask}
            askConfirm={askConfirm}
            onBack={() => setDetail(null)}
            onChanged={() => void load({ silent: true })}
          />
        ) : detail?.kind === "paste" ? (
          <PastePanel groupId={detail.id} groupName={detail.name} onBack={() => setDetail(null)} />
        ) : detail?.kind === "paste-items" ? (
          <PastePanel itemIds={detail.ids} onBack={() => setDetail(null)} />
        ) : (
          renderList()
        )}
      </div>

      {!detail && section === "items" && selectedItems.length > 0 && (
        <div className="clip-selectbar">
          <span>{selectedItems.length} 项已选</span>
          <button
            className="btn sm primary"
            onClick={() => void onCopySelectedItems("rich")}
            disabled={busy !== null}
            data-tip="按选择顺序整合文字与图片，写入富文本"
          >
            {busy === "copy-selected-rich" ? <RefreshCw size={11} className="spin" /> : <Copy size={11} />} 复制所选
          </button>
          <button
            className="btn sm"
            onClick={() => void onCopySelectedItems("files")}
            disabled={busy !== null || !selectedHasFiles}
            data-tip={
              !selectedHasFiles
                ? "所选内容没有图片或文件；请使用「复制所选」复制文字"
                : "把所选文件/图片作为文件列表复制；普通文字不包含在内"
            }
          >
            {busy === "copy-selected-files" ? <RefreshCw size={11} className="spin" /> : <Copy size={11} />} 复制为文件
          </button>
          <button
            className="btn sm"
            onClick={() => setDetail({ kind: "paste-items", ids: selectedItems })}
            disabled={busy !== null}
            data-tip="选择目标窗口后按顺序逐条粘贴"
          >
            <Play size={11} /> 逐项粘贴
          </button>
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="新分组名称"
            aria-label="新分组名称"
            maxLength={80}
          />
          <button className="btn sm primary" onClick={onCreateGroup} disabled={busy !== null}>
            {busy === "create-group" ? <RefreshCw size={11} className="spin" /> : <FolderPlus size={11} />} 创建分组
          </button>
          <button className="btn sm danger" onClick={onDeleteSelectedItems} disabled={busy !== null}>
            <Trash2 size={11} /> 删除所选
          </button>
          <button className="icon-btn sm" onClick={clearSelection} data-tip="取消选择" aria-label="取消选择">
            <X size={12} />
          </button>
        </div>
      )}

      {!detail && section === "groups" && selectedGroups.length > 0 && (
        <div className="clip-selectbar">
          <span>{selectedGroups.length} 个分组已选</span>
          <input
            value={mergeName}
            onChange={(e) => setMergeName(e.target.value)}
            placeholder="合并后的分组名称"
            aria-label="合并后的分组名称"
            maxLength={80}
          />
          <button
            className="btn sm primary"
            onClick={onMergeGroups}
            disabled={selectedGroups.length < 2 || busy !== null}
            data-tip={selectedGroups.length < 2 ? "至少选择两个分组" : "按选择顺序合并"}
          >
            {busy === "merge" ? <RefreshCw size={11} className="spin" /> : <Merge size={11} />} 合并
          </button>
          <button className="icon-btn sm" onClick={clearSelection} data-tip="取消选择" aria-label="取消选择">
            <X size={12} />
          </button>
        </div>
      )}

      <footer className="clip-foot">
        <span className={`clip-status tone-${statusTone}`}><i />{statusLabel}</span>
        <span>{stats?.items ?? 0} 条 · {stats?.groups ?? 0} 组</span>
        <span>图片缓存 {formatBytes(stats?.asset_bytes ?? 0)}</span>
        <div className="clip-foot-actions">
          <button
            className="link-btn clip-clear-btn"
            onClick={onClearHistory}
            disabled={historyCount === 0 || busy === "clear-history" || loading}
            data-tip={historyCount === 0 ? "没有可清空的剪贴板历史" : "删除全部历史、分组与内部图片缓存"}
            aria-label="清空剪贴板历史"
          >
            {busy === "clear-history"
              ? <RefreshCw size={11} className="spin" />
              : <Trash2 size={11} />} 清空历史
          </button>
          <button className="link-btn" onClick={goSettings}>
            <SettingsIcon size={11} /> 剪贴板设置
          </button>
        </div>
      </footer>
    </>
  );

  return (
    <>
      {isDrawer ? (
        <div className={`clipboard-layer${linkTask ? " link-mode" : ""}`}>
          <div className="clipboard-scrim" aria-hidden onMouseDown={onClose ?? closeDrawer} />
          <section
            className="clipboard-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="智能剪贴板"
            ref={drawerRef}
            tabIndex={-1}
          >
            {body}
          </section>
        </div>
      ) : (
        <div className="clipboard-page" role="region" aria-label="智能剪贴板">
          {body}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ""}
        detail={confirm?.detail}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        onCancel={() => {
          confirmAnchor.current = null;
          setConfirm(null);
        }}
        onConfirm={() => {
          const run = confirm?.run;
          setConfirm(null);
          if (run) Promise.resolve(run()).catch((e) => showToast(String(e), { kind: "error" }));
        }}
      />

      {previewImage && (
        <ImageLightbox
              item={previewImage}
              askConfirm={askConfirm}
              onClose={() => setPreviewImage(null)}
            />
      )}
    </>
  );
}
