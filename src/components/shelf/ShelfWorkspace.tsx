//! 文件暂存架工作区：顶部添加入口（文件/文件夹/链接/文本/从剪贴板）、
//! 搜索与类型/分组筛选、条目列表、多选操作栏、空间占用与清理设置。
//!
//! 拖入：监听 Tauri Webview 级 onDragDropEvent（真实 OS 文件拖入，非 HTML5 模拟），
//! 仅在暂存架页签激活时处理；拖入默认走引用模式（不复制、不占磁盘），
//! 「添加方式」菜单可切换为托管复制。
//! 拖入路由：目标管理视图（targetsOpen）下按松手坐标命中目标卡片 → 真实文件
//! 投递（useDropTargetsStore.drop）；未命中卡片仍按上述方式暂存。两个动作互斥，
//! 一次原生拖放只被其中一个消费（lib/fileDrop 仲裁保证单消费者，会话内再兜一层）。
//! 拖出：卡片按住拖动走 Windows OLE 原生文件拖出（复制/移动由目标应用决定），
//! 复制路径/复制文件（CF_HDROP）继续作为键盘可达与失败回退。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Clipboard, Copy, CopyCheck, FilterX, FolderInput, HardDrive, Info, Link2, Loader2, Plus, Star,
  Tag, Trash2, Upload, X,
} from "lucide-react";
import {
  clipboardCopyText,
  clipboardView,
  getSettings,
  quickCaptureSubmit,
  shelfGetItem,
  shelfCopyFiles,
  shelfCopyPaths,
  shelfOpenItem,
  shelfRecycleExecute,
  shelfRecyclePreview,
  shelfRevealItem,
  shelfSendToDisable,
  shelfSendToEnable,
  shelfSendToStatus,
  shelfDropTargetOpen,
  updateSettings,
  SHELF_KIND_LABELS,
  type ShelfDragOutResult,
  type ShelfFailedEntry,
  type ShelfItem,
  type ShelfKind,
  type ShelfPasteReport,
  type ShelfCollectedEvent,
  type ShelfRecyclePreview,
} from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { errorMessage } from "../../lib/errors";
import { isCapsuleMode } from "../../lib/edgeSnap";
import { shouldHandleShelfPaste } from "../../lib/pasteShortcut";
import { dropTargetAt, discardOperation, registerFileDropConsumer, type DropPayloadMeta, type DropPoint } from "../../lib/fileDrop";
import {
  canDropToDirectory,
  payloadCount,
  type DragPayloadView,
  type DragProbe,
} from "../../lib/dragPayload";
import { useFullViewVisible } from "../../hooks/useMainUiVisible";
import { useShelfCollected } from "../../hooks/useShelfCollected";
import { useShelfInternalDrag } from "../../hooks/useShelfInternalDrag";
import { useShelfMarquee } from "../../hooks/useShelfMarquee";
import { useShelfStore, type ShelfMutationResult } from "../../store/useShelfStore";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useGlobalSearchStore, type GlobalSearchLocateIntent } from "../../store/useGlobalSearchStore";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog } from "../ui/Dialog";
import { DropdownMenu } from "../ui";
import type { DropdownMenuItem } from "../ui/DropdownMenu";
import ShelfItemCard from "./ShelfItemCard";
import ShelfToolbar from "./ShelfToolbar";
import ShelfDetail from "./ShelfDetail";
import ShelfImageLightbox from "./ShelfImageLightbox";
import ShelfRecycleDialog from "./ShelfRecycleDialog";
import ShelfContextMenu from "./ShelfContextMenu";
import ShelfBatchLinkDialog from "./ShelfBatchLinkDialog";
import ShelfTagDialog from "./ShelfTagDialog";
import ShelfDuplicateDialog from "./ShelfDuplicateDialog";
import ShelfRulesDialog from "./ShelfRulesDialog";
import ShelfFileOpPanel, { type ShelfFileOpRequest } from "./ShelfFileOpPanel";
import DropTargetManager from "./DropTargetManager";
import { deliverToTarget, deliverOperationToTarget } from "./shelfDeliver";
import { shelfDeleteFeedback } from "./shelfDeleteFeedback";
import { shelfCleanupFeedback } from "./shelfCleanupFeedback";

/** 有真实文件/文件夹语义的条目（link/text 不参与移动与复制）。 */
function isPhysicalItem(item: ShelfItem): boolean {
  return item.kind === "file" || item.kind === "image" || item.kind === "folder";
}

/** 移动仅限 reference 且文件存在；managed 必须走导出副本。 */
export function canMoveItem(item: ShelfItem): boolean {
  return isPhysicalItem(item) && item.storage_mode === "reference" && item.exists_state !== "missing";
}

/** 复制/导出要求当前文件可读（托管副本存在或引用原文件存在）。 */
export function canCopyItem(item: ShelfItem): boolean {
  return isPhysicalItem(item) && item.exists_state !== "missing";
}

/** 批量复制入口的文案：托管副本只能「导出副本」，混合选择时两者都发生。 */
export function copyActionLabel(items: ShelfItem[]): string {
  const managed = items.filter((i) => i.storage_mode === "managed").length;
  if (managed === 0) return "复制到…";
  if (managed === items.length) return "导出副本到…";
  return "复制 / 导出到…";
}

/** 失败码（后端为大写 `AppError::code`，预检码为小写）→ 用户可读原因；未知 code 原样展示。 */
const ADD_FAILURE_CODE_LABELS: Record<string, string> = {
  empty_path: "路径为空",
  relative_path: "只接受绝对路径",
  not_found: "文件不存在",
  unsupported: "不支持的文件类型",
  permission_denied: "没有访问权限",
  permission_required: "需要额外权限",
  duplicate: "已在暂存架中",
  conflict: "存在冲突",
  quota_exceeded: "托管空间不足",
  copy_failed: "复制失败",
  io_error: "读写失败",
  database_error: "数据库错误",
  database_busy: "数据库忙，请稍后重试",
  data_integrity_error: "数据完整性错误",
  timeout: "操作超时",
  service_unavailable: "服务不可用",
  service_overloaded: "服务繁忙",
  clipboard_no_valid_items: "没有可保存的有效路径",
};

function addFailureReason(f: ShelfFailedEntry): string {
  const code = f.code?.trim();
  if (code) {
    const key = code.toLowerCase();
    // VALIDATION_ERROR 覆盖“文件夹不能托管/配额不足/路径非法”等多种原因，
    // 统一显示“参数无效”会丢掉可操作信息，因此保留后端具体 reason。
    if (key === "validation_error") return f.reason?.trim() || "参数无效";
    return ADD_FAILURE_CODE_LABELS[key] ?? code;
  }
  return f.reason?.trim() || "未知原因";
}

/** toast 只展示文件名，不把完整路径带进提示（保持既有隐私口径）。 */
function dropPathName(path: string): string {
  const parts = path
    .split(/[\\/]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) ?? "（空路径）";
}

interface PendingDelete {
  ids: string[];
  includeProtected: boolean;
  hasFlags: boolean;
  hasScene: boolean;
}

/** dry-run 预览：确认框只展示这三项，执行结果以后端报告为准。 */
interface CleanupPreview {
  candidates: number;
  skipped_protected: number;
  freed_bytes: number;
}

/** 受保护原因必须说清，不能用「受保护内容」糊过去：场景引用的后果与收藏/置顶不同。 */
function protectedReason(hasFlags: boolean, hasScene: boolean): string {
  if (hasFlags && hasScene) return "包含收藏/置顶项，且被场景引用";
  if (hasScene) return "被场景引用";
  return "包含收藏/置顶项";
}

type ShelfViewMode = "list" | "grid";
type ShelfGridSize = "s" | "m" | "l";

const SHELF_VIEW_KEY = "taskdock.shelf.view";
const SHELF_GRID_SIZE_KEY = "taskdock.shelf.gridSize";
/** 与后端 shelf::trash::MAX_TRASH_ITEMS 一致：确认框展示的数量必须是真正会处理的。 */
const MAX_TRASH_BATCH = 500;

/** 视图偏好只影响本机呈现：读失败（隐私模式/测试环境）时回退列表。 */
function readViewPref(): ShelfViewMode {
  try {
    return localStorage.getItem(SHELF_VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function readGridSizePref(): ShelfGridSize {
  try {
    const value = localStorage.getItem(SHELF_GRID_SIZE_KEY);
    return value === "s" || value === "l" ? value : "m";
  } catch {
    return "m";
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存储不可用不影响本次会话内的视图切换。
  }
}

/** 灯箱序列：当前筛选/排序下的可读图片（失效条目不参与，避免必然失败的空转）。 */
function imageItemsOf(items: ShelfItem[]): ShelfItem[] {
  return items.filter((item) => item.kind === "image" && item.exists_state !== "missing");
}

export default function ShelfWorkspace({ active }: { active: boolean }) {
  const showToast = useUiStore((s) => s.showToast);
  const setTab = useUiStore((s) => s.setTab);
  // 胶囊模式下本页被整体隐藏（dock-app inert）：拖入事件必须让给胶囊面板
  const capsuleMode = useEdgeSnapStore((s) => isCapsuleMode(s.phase));
  // 完整面板在极简/紧凑模式下只是 CSS 隐藏、组件仍挂载（DeferredView 保活）：
  // 此时注册拖入消费者会让隐藏的暂存架抢走可见界面的文件拖入。
  const fullViewVisible = useFullViewVisible();
  const items = useShelfStore((s) => s.items);
  const total = useShelfStore((s) => s.total);
  const groups = useShelfStore((s) => s.groups);
  const stats = useShelfStore((s) => s.stats);
  const filter = useShelfStore((s) => s.filter);
  const loading = useShelfStore((s) => s.loading);
  const error = useShelfStore((s) => s.error);
  const mutationSyncError = useShelfStore((s) => s.mutationSyncError);
  const deletionBusy = useShelfStore((s) => s.deletionBusy);
  const cleanupBusy = useShelfStore((s) => s.cleanupBusy);
  const selectedIds = useShelfStore((s) => s.selectedIds);
  const detailId = useShelfStore((s) => s.detailId);
  const load = useShelfStore((s) => s.load);
  const loadMore = useShelfStore((s) => s.loadMore);
  const setFilter = useShelfStore((s) => s.setFilter);
  const refreshMeta = useShelfStore((s) => s.refreshMeta);
  const addPaths = useShelfStore((s) => s.addPaths);
  const addLink = useShelfStore((s) => s.addLink);
  const addText = useShelfStore((s) => s.addText);
  const addFromClipboard = useShelfStore((s) => s.addFromClipboard);
  const pasteCurrent = useShelfStore((s) => s.pasteCurrent);
  const pasteScreenshotAction = useShelfStore((s) => s.pasteScreenshot);
  const updateItem = useShelfStore((s) => s.updateItem);
  const trashItems = useShelfStore((s) => s.trashItems);
  const restoreTrash = useShelfStore((s) => s.restoreTrash);
  const retryShelfSync = useShelfStore((s) => s.retryShelfSync);
  const runCleanup = useShelfStore((s) => s.runCleanup);
  const moveToGroup = useShelfStore((s) => s.moveToGroup);
  const toggleSelect = useShelfStore((s) => s.toggleSelect);
  const setSelection = useShelfStore((s) => s.setSelection);
  const selectAll = useShelfStore((s) => s.selectAll);
  const clearSelection = useShelfStore((s) => s.clearSelection);
  const setDetail = useShelfStore((s) => s.setDetail);
  const verifyExists = useShelfStore((s) => s.verifyExists);
  const relocateItem = useShelfStore((s) => s.relocateItem);

  const notifyShelfMutation = (
    result: ShelfMutationResult,
    action: "delete" | "clear",
  ) => {
    const feedback = shelfDeleteFeedback(result, action);
    showToast(feedback.message, {
      kind: feedback.kind,
      ...(!result.synced
        ? { action: { label: "重试同步", run: () => void retryShelfSync() } }
        : {}),
    });
  };

  const [dragOver, setDragOver] = useState(false);
  /** 拖入/剪贴板添加的默认策略：引用优先（不偷偷复制占用磁盘），用户可显式切换。 */
  const [copyOnAdd, setCopyOnAdd] = useState(false);
  /** 主动粘贴当前剪贴板的在途闸：按钮与 Ctrl+V 共用，避免重复入队。 */
  const [pasteBusy, setPasteBusy] = useState(false);
  const pasteBusyRef = useRef(false);
  /** 资源管理器右键发送状态（HKCU 动词，仅展示与开关，不参与文件操作）。 */
  const [sendToEnabled, setSendToEnabled] = useState(false);
  const sendToBusyRef = useRef(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [textDraft, setTextDraft] = useState(false);
  const [textValue, setTextValue] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  /** 投递目标管理（工具面板「文件投递」共用同一份配置） */
  const [targetsOpen, setTargetsOpen] = useState(false);
  /** 目标管理里是否有未保存表单：外部定位请求必须先确认才能离开。 */
  const [targetsDirty, setTargetsDirty] = useState(false);
  /** 等待未保存确认的定位意图（已从全局 store 消费，取消后不会延迟执行）。 */
  const [locatePending, setLocatePending] = useState<GlobalSearchLocateIntent | null>(null);
  const [locateConfirm, setLocateConfirm] = useState(false);
  /** 目标不在当前一页时，用单条读取兜底显示详情。 */
  const [detailFallback, setDetailFallback] = useState<ShelfItem | null>(null);
  const locateRunSeq = useRef(0);
  const [clipboardEntries, setClipboardEntries] = useState<
    { id: string; kind: string; preview: string }[]
  >([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [batchLinkOpen, setBatchLinkOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [dedupOpen, setDedupOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  /** dry-run 在途（与真实执行分开：预览按钮用它禁用，不误报「正在清理」）。 */
  const [cleanupPreviewBusy, setCleanupPreviewBusy] = useState(false);
  /** 同步闸：state 更新前的连点也不能重复发 dry-run。 */
  const cleanupPreviewInFlight = useRef(false);
  /** 预览代际：关闭面板/卸载后，迟到的 dry-run 结果不得弹确认框。 */
  const cleanupSeq = useRef(0);
  /** 反向转存（暂存架→收集箱）在途守卫：菜单项 disabled，防连点重复创建 */
  const [toInboxBusy, setToInboxBusy] = useState(false);
  /** 内嵌文件操作面板（移动/复制共享同一套面板，不做大模态） */
  const [fileOpRequest, setFileOpRequest] = useState<ShelfFileOpRequest | null>(null);
  const searchTimer = useRef<number | null>(null);
  /** 视图切换时保留暂存列表滚动位置（目标管理视图不渲染列表）。 */
  const listRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);

  // ── 选择 / 视图 / 垃圾桶（本轮效率升级）──
  const [view, setView] = useState<ShelfViewMode>(readViewPref);
  const [gridSize, setGridSize] = useState<ShelfGridSize>(readGridSizePref);
  /** 框选中的临时选择：不写入 store，松手后才提交，避免 pointermove 写持久状态。 */
  const [marqueePreview, setMarqueePreview] = useState<string[] | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  /** Shift 连选的锚点（普通点击/Ctrl 点击都会更新）。 */
  const anchorRef = useRef<string | null>(null);
  /** 灯箱：当前图片 id + 是否正在为「下一张」分页加载。 */
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [lightboxLoading, setLightboxLoading] = useState(false);
  /** 外部文件拖到垃圾桶后的确认（preview 为 null 表示尚未检查完）。 */
  const [pendingRecycle, setPendingRecycle] = useState<{
    paths: string[];
    preview: ShelfRecyclePreview | null;
  } | null>(null);
  const [recycleBusy, setRecycleBusy] = useState(false);
  const [recyclePreviewBusy, setRecyclePreviewBusy] = useState(false);
  /** 外部拖拽经过垃圾桶：只在命中时高亮，不影响工具栏布局。 */
  const [externalTrashOver, setExternalTrashOver] = useState(false);
  const trashHitRef = useRef<HTMLDivElement | null>(null);
  /** 右键菜单：位置 + 本次作用的条目 ID（右键未选中条目时先改为单选）。 */
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    ids: string[];
  } | null>(null);
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    writePref(SHELF_VIEW_KEY, view);
  }, [view]);
  useEffect(() => {
    writePref(SHELF_GRID_SIZE_KEY, gridSize);
  }, [gridSize]);

  // 筛选/视图变化后，框选预览与焦点可能指向已不可见的条目：只清理失效引用。
  useEffect(() => {
    setMarqueePreview(null);
    setContextMenu(null);
    setFocusId((current) =>
      current && items.some((item) => item.id === current) ? current : null,
    );
  }, [filter.search, filter.kind, filter.group_id, filter.favorite_only, view, items]);

  /** 关闭清理面板：作废在途 dry-run，迟到的预览不得再弹确认框。 */
  const closeCleanupPanel = useCallback(() => {
    cleanupSeq.current += 1;
    setCleanupOpen(false);
    setCleanupPreview(null);
    setConfirmCleanup(false);
  }, []);

  // 兜底：其他路径关闭面板或组件卸载时，同样作废在途预览。
  useEffect(() => {
    if (!cleanupOpen) cleanupSeq.current += 1;
  }, [cleanupOpen]);
  useEffect(
    () => () => {
      cleanupSeq.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (targetsOpen) {
      savedScroll.current = listRef.current?.scrollTop ?? savedScroll.current;
      // 进入目标管理立刻退出拖入态：此视图不接收文件。
      setDragOver(false);
    } else {
      const top = savedScroll.current;
      const raf = requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = top;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [targetsOpen]);

  // 初次进入：加载列表 + 分组/统计；随后批量核对引用存在性（当前一页）
  useEffect(() => {
    if (!active) return;
    void (async () => {
      await Promise.all([load(), refreshMeta()]);
      const ids = useShelfStore
        .getState()
        .items.filter((i) => i.kind !== "link" && i.kind !== "text")
        .map((i) => i.id)
        .slice(0, 200);
      void verifyExists(ids);
    })();
  }, [active, load, refreshMeta, verifyExists]);

  // 全局搜索 / 胶囊最近暂存定位：必须先回到文件暂存架视图，再打开详情。
  // 目标管理有未保存表单时不能静默丢弃：弹确认，取消后意图已消费，不会延迟误执行。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);

  const runLocate = useCallback(
    async (intent: GlobalSearchLocateIntent) => {
      const seq = ++locateRunSeq.current;
      // 复位全部筛选（不只搜索词）：目标条目可能被类型/分组/收藏筛选挡住。
      // 同时等列表按新筛选加载完成：load 会用服务端结果收敛 detailId，
      // 若提前 setDetail，旧筛选结果会把刚设置的详情清掉。
      const f = useShelfStore.getState().filter;
      const needReset = f.search || f.kind !== "all" || f.group_id !== "all" || f.favorite_only;
      if (needReset) {
        await setFilter({ search: "", kind: "all", group_id: "all", favorite_only: false });
      } else {
        // 无条件拉一次权威列表：可能在途的旧 load 会清掉不在当前页的 detailId。
        await load();
      }
      if (seq !== locateRunSeq.current) return; // 只执行最新一次合法定位
      setDetail(intent.id);
    },
    [load, setFilter, setDetail],
  );

  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "shelf") return;
    const intent = pendingLocate;
    consumeLocate();
    if (targetsOpen && targetsDirty) {
      // 先不切视图：等用户确认；意图放在本地，取消即丢弃。
      setLocatePending(intent);
      setLocateConfirm(true);
      return;
    }
    if (targetsOpen) {
      setTargetsOpen(false);
      setTargetsDirty(false);
    }
    void runLocate(intent);
  }, [pendingLocate, targetsOpen, targetsDirty, consumeLocate, runLocate]);

  // 目标不在当前一页（或列表加载失败）时，用单条读取兜底显示详情；
  // 只读一条，不为了定位加载全部历史。
  useEffect(() => {
    if (!detailId) {
      setDetailFallback(null);
      return;
    }
    if (items.some((i) => i.id === detailId)) {
      setDetailFallback(null);
      return;
    }
    if (loading) return;
    let alive = true;
    void shelfGetItem(detailId)
      .then((item) => {
        if (alive) setDetailFallback(item);
      })
      .catch((e) => {
        if (!alive) return;
        setDetailFallback(null);
        showToast(`无法打开暂存条目：${errorMessage(e)}`, { kind: "error" });
        setDetail(null);
      });
    return () => {
      alive = false;
    };
  }, [detailId, items, loading, showToast, setDetail]);

  // 胶囊「文件投递 → 管理」的一次性意图：进入本页后展开投递目标面板。
  // 意图由 store 持有，页面还没挂载时也不会丢（下次挂载即消费）。
  const manageRequest = useDropTargetsStore((s) => s.manageRequest);
  const consumeManage = useDropTargetsStore((s) => s.consumeManage);
  useEffect(() => {
    if (manageRequest === 0) return;
    consumeManage();
    setTargetsOpen(true);
    closeCleanupPanel();
  }, [manageRequest, consumeManage, closeCleanupPanel]);

  // 最近投递目标：批量栏打开「文件操作」时才读取，避免每个暂存架视图都多一次 IPC。
  const dropTargets = useDropTargetsStore((s) => s.targets);
  const loadDropTargets = useDropTargetsStore((s) => s.load);

  // 搜索输入去抖：输入框保留即时草稿，避免受控值与 250ms 去抖互相拉扯。
  const [searchDraft, setSearchDraft] = useState(filter.search ?? "");
  useEffect(() => {
    setSearchDraft(filter.search ?? "");
  }, [filter.search]);

  const onSearchInput = useCallback(
    (v: string) => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
      searchTimer.current = window.setTimeout(() => {
        searchTimer.current = null;
        void setFilter({ search: v });
      }, 250);
    },
    [setFilter],
  );

  // 卸载时回收待执行的去抖：面板切走后不再写 store 筛选（旧输入不会迟到落地）
  useEffect(
    () => () => {
      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
        searchTimer.current = null;
      }
    },
    [],
  );

  /** addPaths 返回的合并结果（预检失败 + 后端失败已在 store 内汇总完毕）。 */
  const reportAdd = useCallback(
    (r: { added: number; failed: ShelfFailedEntry[] }, verb: string) => {
      const failed = r.failed ?? [];
      // 成功与失败并存：只发一条汇总，避免一次拖入刷 N 条错误 toast。
      if (r.added > 0 && failed.length > 0) {
        const first = failed[0];
        showToast(
          `${verb} ${r.added} 项，${failed.length} 项失败：${dropPathName(first.path)} — ${addFailureReason(first)}`,
          { kind: "warning" },
        );
        return;
      }
      if (r.added > 0) {
        showToast(`${verb} ${r.added} 项`, { kind: "success" });
        return;
      }
      if (failed.length > 0) {
        const first = failed[0];
        const more = failed.length > 1 ? `（共 ${failed.length} 项失败）` : "";
        showToast(`无法添加「${dropPathName(first.path)}」：${addFailureReason(first)}${more}`, {
          kind: "error",
        });
        return;
      }
      // 后端既没有成功也没有失败（空批次/全部被过滤）：不得静默当作成功。
      showToast("没有可添加的文件", { kind: "warning" });
    },
    [showToast],
  );

  /** 主动粘贴当前剪贴板的完整反馈：成功/部分失败/空/占用/不支持分别说明。 */
  const reportPaste = useCallback(
    (report: ShelfPasteReport) => {
      if (report.success) {
        const skipped = report.skipped > 0 ? `，跳过 ${report.skipped} 项重复或空路径` : "";
        const duplicates =
          report.duplicates > 0
            ? `，其中 ${report.duplicates} 项与已有条目重复`
            : "";
        if (report.failed.length > 0) {
          const first = report.failed[0];
          const detail = report.failed
            .slice(0, 3)
            .map((f) => `${dropPathName(f.path)}：${addFailureReason(f)}`)
            .join("；");
          showToast(
            `已粘贴 ${report.added.length} 项，${report.failed.length} 项失败：${dropPathName(first.path)} — ${addFailureReason(first)}${skipped}${duplicates}`,
            {
              kind: "warning",
              code: report.failed[0]?.code ?? undefined,
              detail,
            },
          );
        } else if (report.skipped > 0 || report.duplicates > 0) {
          showToast(`已粘贴 ${report.added.length} 项${skipped}${duplicates}`, {
            kind: "info",
          });
        } else {
          showToast(`已粘贴 ${report.added.length} 项到暂存架`, { kind: "success" });
        }
        return;
      }
      const code = report.code ?? "";
      if (code === "CLIPBOARD_BUSY") {
        showToast("剪贴板正被其他程序占用，请稍后重试", {
          kind: "warning",
          code,
        });
      } else if (code === "CLIPBOARD_EMPTY") {
        showToast("剪贴板没有可暂存的内容", { kind: "warning", code });
      } else if (code === "CLIPBOARD_CONTENT_TOO_LARGE") {
        showToast("剪贴板内容超过大小上限，请改用拖入或先保存为文件", {
          kind: "error",
          code,
        });
      } else if (code === "CLIPBOARD_UNSUPPORTED" || code === "CLIPBOARD_UNREADABLE") {
        showToast("当前剪贴板内容暂不支持暂存", { kind: "warning", code });
      } else if (code === "CLIPBOARD_NO_IMAGE") {
        showToast("当前剪贴板没有截图图片，请先截图再暂存", { kind: "warning", code });
      } else {
        const first = report.failed[0];
        showToast(
          first
            ? `粘贴失败：${addFailureReason(first)}`
            : "粘贴失败：未能读取或保存当前剪贴板",
          { kind: "error", code: code || undefined },
        );
      }
    },
    [showToast],
  );

  const pasteCurrentClipboard = useCallback(async () => {
    if (pasteBusyRef.current) return;
    pasteBusyRef.current = true;
    setPasteBusy(true);
    try {
      const { report } = await pasteCurrent(copyOnAdd ? "managed" : "reference", null);
      reportPaste(report);
    } catch (e) {
      showToast(`粘贴失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      pasteBusyRef.current = false;
      setPasteBusy(false);
    }
  }, [copyOnAdd, pasteCurrent, reportPaste, showToast]);

  /** 截图/剪贴板图片专用入口：只保存图片字节，不偷存文本或文件。 */
  const pasteScreenshot = useCallback(async () => {
    if (pasteBusyRef.current) return;
    pasteBusyRef.current = true;
    setPasteBusy(true);
    try {
      const { report } = await pasteScreenshotAction();
      reportPaste(report);
    } catch (e) {
      showToast(`暂存截图失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      pasteBusyRef.current = false;
      setPasteBusy(false);
    }
  }, [pasteScreenshotAction, reportPaste, showToast]);

  useEffect(() => {
    let alive = true;
    void shelfSendToStatus()
      .then((status) => {
        if (alive) setSendToEnabled(status.enabled);
      })
      .catch(() => {
        // 非 Windows / 注册表不可读：保持关闭展示，不冒充已启用。
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleSendTo = useCallback(async () => {
    if (sendToBusyRef.current) return;
    sendToBusyRef.current = true;
    try {
      const status = await shelfSendToStatus();
      if (status.enabled) {
        await shelfSendToDisable();
        setSendToEnabled(false);
        showToast("已停用资源管理器右键发送", { kind: "success" });
      } else {
        const next = await shelfSendToEnable();
        setSendToEnabled(next.enabled);
        showToast(
          next.enabled
            ? "已启用：在资源管理器右键文件/文件夹即可发送到 Task Dock"
            : "右键菜单已写入，但状态校验未通过，请重启资源管理器后重试",
          { kind: next.enabled ? "success" : "warning" },
        );
      }
    } catch (e) {
      showToast(`更新右键发送失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      sendToBusyRef.current = false;
    }
  }, [showToast]);

  // 全局热键 / 资源管理器发送到：后台入库完成后刷新并给出计数反馈。
  useShelfCollected(
    useCallback(
      (event: ShelfCollectedEvent) => {
        // 后台收集不经过本页命令；刷新完整列表与统计，避免只在下次手动刷新时出现。
        void useShelfStore.getState().load({ silent: true }).catch(() => {});
        void useShelfStore.getState().refreshMeta().catch(() => {});
        const prefix =
          event.source === "sendto" ? "已从资源管理器暂存" : "已收集当前剪贴板";
        const skipped = event.skipped > 0 ? `，跳过 ${event.skipped} 项` : "";
        const duplicates =
          (event.duplicates ?? 0) > 0
            ? `，其中 ${event.duplicates} 项与已有条目重复`
            : "";
        if (event.success && event.failed === 0) {
          showToast(`${prefix} ${event.added} 项${skipped}${duplicates}`, {
            kind: event.skipped > 0 || (event.duplicates ?? 0) > 0 ? "info" : "success",
          });
          return;
        }
        if (event.success) {
          showToast(
            `${prefix} ${event.added} 项，${event.failed} 项失败${skipped}`,
            { kind: "warning", code: event.code ?? undefined },
          );
          return;
        }
        if (event.code === "CLIPBOARD_BUSY") {
          showToast("剪贴板正被其他程序占用，请稍后重试", {
            kind: "warning",
            code: event.code,
          });
        } else if (event.code === "CLIPBOARD_EMPTY") {
          showToast("剪贴板没有可暂存的内容", {
            kind: "warning",
            code: event.code,
          });
        } else {
          showToast("收集失败：未能读取或保存内容", {
            kind: "error",
            code: event.code ?? undefined,
          });
        }
      },
      [showToast],
    ),
  );

  // Ctrl+V 只在暂存架真实可见、无弹出表单/确认框时生效；编辑控件由守卫放行。
  useEffect(() => {
    if (!active || !fullViewVisible || capsuleMode || targetsOpen) return;
    if (
      linkOpen ||
      textDraft ||
      clipOpen ||
      cleanupOpen ||
      confirmClear ||
      confirmDelete ||
      confirmCleanup ||
      locateConfirm
    ) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShelfPaste(event, { busy: pasteBusyRef.current })) return;
      event.preventDefault();
      void pasteCurrentClipboard();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    active,
    fullViewVisible,
    capsuleMode,
    targetsOpen,
    linkOpen,
    textDraft,
    clipOpen,
    cleanupOpen,
    confirmClear,
    confirmDelete,
    confirmCleanup,
    locateConfirm,
    pasteCurrentClipboard,
  ]);

  // ── OS 文件拖入（统一拖放分发，仅本页签真实可见时认领；随卸载释放）──
  // 不用 `onDragDropEvent` 直接订阅：胶囊「文件投递」也在争用同一条 Webview 事件，
  // 由 `lib/fileDrop` 统一仲裁，一次拖入只会有一个面板处理。
  // `copyOnAdd` / `targetsOpen` 用 ref 读取而不是 effect 依赖：拖拽会话中途切换
  // 添加方式或进出目标管理视图都不应重新注册消费者（重注册会清空 owner，
  // 正在进行的拖入随即丢失）。
  const copyOnAddRef = useRef(copyOnAdd);
  useEffect(() => {
    copyOnAddRef.current = copyOnAdd;
  }, [copyOnAdd]);
  const targetsOpenRef = useRef(targetsOpen);
  useEffect(() => {
    targetsOpenRef.current = targetsOpen;
  }, [targetsOpen]);

  /** 目标管理视图里的卡片悬停高亮（投递落点），与整页暂存高亮互斥。 */
  const [overTargetId, setOverTargetId] = useState<string | null>(null);
  const overTargetRef = useRef<string | null>(null);
  const setOverTarget = useCallback((id: string | null) => {
    // over 是高频事件：只在实际换卡时触发渲染
    if (overTargetRef.current === id) return;
    overTargetRef.current = id;
    setOverTargetId(id);
  }, []);
  /** 目标管理视图内是否正有拖入会话：驱动「松手即投递/暂存」提示条。 */
  const [targetsDragging, setTargetsDragging] = useState(false);

  /**
   * 一次原生拖入会话只允许执行一个动作（投递或暂存）。
   * fileDrop 在 drop 后已结束会话，这里再兜一层：重复/迟到的 drop 不得
   * 重复投递或重复暂存；新会话必须由 enter（或 enter 未认领时的 over）开启。
   */
  const dropSession = useRef({ active: false, handled: false });

  /** 只命中「当前配置仍存在的目标卡片」；刚被删除的入口不接收投递。 */
  const hitTarget = useCallback((point: DropPoint): string | null => {
    const id = dropTargetAt(point);
    if (!id) return null;
    return useDropTargetsStore.getState().targets.some((t) => t.id === id) ? id : null;
  }, []);

  /** 悬停高亮的唯一入口：每次都用当前坐标重新命中，卡片与整页遮罩互斥。 */
  const applyTargetOver = useCallback(
    (point: DropPoint | null) => {
      if (!point || !targetsOpenRef.current) {
        setOverTarget(null);
        return;
      }
      setOverTarget(hitTarget(point));
    },
    [hitTarget, setOverTarget],
  );

  /** 暂存动作：原始路径直接交给 addPaths，与工具条/选择器同一口径。 */
  const stageDropped = useCallback(
    (paths: string[]) => {
      addPaths(paths, copyOnAddRef.current ? "managed" : "reference", "drag")
        .then((r) => reportAdd(r, "已暂存"))
        .catch((e) => showToast(`暂存拖入文件失败：${errorMessage(e)}`, { kind: "error" }));
    },
    [addPaths, reportAdd, showToast],
  );

  /** 投递动作：可用性兜底在 deliverToTarget 内统一处理；结果条由 store 驱动。 */
  const deliverDropped = useCallback(
    async (targetId: string, paths: string[]) => {
      const result = await deliverToTarget(targetId, paths);
      if (result.kind === "blocked") {
        showToast(result.reason, { kind: "error" });
        return;
      }
      if (result.kind === "error") {
        showToast(`投递失败：${result.message}`, { kind: "error" });
        return;
      }
      // 失败/部分完成必须显式提示（结果条在目标卡片下方，首次可能收起）。
      const { report, targetName } = result;
      if (report.failed > 0 || report.partial > 0) {
        const parts: string[] = [];
        if (report.failed > 0) parts.push(`${report.failed} 项失败`);
        if (report.partial > 0) parts.push(`${report.partial} 项部分完成`);
        showToast(`投递到「${targetName}」：${parts.join("、")}，详情见目标卡片下方结果`, {
          kind: "warning",
        });
      }
    },
    [showToast],
  );

  /**
   * 拖入内容的类型探测（原生桥）：只驱动提示与「能否投递到文件夹」，
   * 松手落点仍由坐标命中决定。桥未给出探测时为 null，交互保持原样。
   */
  const [dropProbe, setDropProbe] = useState<DragProbe | null>(null);
  /** 当前拖入内容不能变成真实文件（链接/文本/未识别）：目标卡片不给投递承诺。 */
  const dropBlocked = Boolean(targetsDragging && dropProbe && !dropProbe.canDirectory);

  /** 暂存一次拖入会话：内容已在后端暂存区，前端只传 operationId。 */
  const stageOperation = useCallback(
    (operationId: string) => {
      useShelfStore
        .getState()
        .commitDragPayload(operationId, copyOnAddRef.current ? "managed" : "reference", null)
        .then((r) => reportAdd(r, "已暂存"))
        .catch((e) => showToast(`暂存拖入内容失败：${errorMessage(e)}`, { kind: "error" }));
    },
    [reportAdd, showToast],
  );

  /** 投递一次拖入会话到目标目录（虚拟文件/图片字节）：兜底与 deliverToTarget 一致。 */
  const deliverOperation = useCallback(
    async (targetId: string, operationId: string, count: number) => {
      const result = await deliverOperationToTarget(targetId, operationId, count);
      if (result.kind === "blocked") {
        showToast(result.reason, { kind: "error" });
        void discardOperation(operationId, "directory-blocked");
        return;
      }
      if (result.kind === "error") {
        showToast(`投递失败：${result.message}`, { kind: "error" });
        void discardOperation(operationId, "directory-error");
        return;
      }
      const { report, targetName } = result;
      if (report.failed > 0 || report.partial > 0) {
        const parts: string[] = [];
        if (report.failed > 0) parts.push(`${report.failed} 项失败`);
        if (report.partial > 0) parts.push(`${report.partial} 项部分完成`);
        showToast(`投递到「${targetName}」：${parts.join("、")}，详情见目标卡片下方结果`, {
          kind: "warning",
        });
      }
    },
    [showToast],
  );

  /**
   * 通用拖入载荷路由（原生桥通道）。与路径通道同一套命中：
   * 垃圾桶 → 外部文件回收站；目标管理视图命中卡片 → 目录投递（仅文件类）；
   * 其余情况 → 暂存架。
   */
  const pointInTrash = useCallback((point: DropPoint | null) => {
    if (!point) return false;
    const rect = trashHitRef.current?.getBoundingClientRect();
    // 未布局/隐藏（宽高为 0）时不能把左上角 (0,0) 当成垃圾桶命中。
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    // 命中区比图标外扩 10px（只影响命中与高亮，不改变工具栏布局）。
    const pad = 10;
    return (
      point.x >= rect.left - pad &&
      point.x <= rect.right + pad &&
      point.y >= rect.top - pad &&
      point.y <= rect.bottom + pad
    );
  }, []);

  /** 垃圾桶外扩容差后的矩形（Alt 内部拖动共用同一命中口径）。 */
  const trashHitRect = useCallback((): DOMRect | null => {
    const rect = trashHitRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const pad = 10;
    return new DOMRect(
      rect.left - pad,
      rect.top - pad,
      rect.width + pad * 2,
      rect.height + pad * 2,
    );
  }, []);

  /** 外部真实文件 → 回收站：先只读预览，确认前不删除任何文件。 */
  const requestRecycle = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setRecyclePreviewBusy(true);
      try {
        const preview = await shelfRecyclePreview(paths);
        if (preview.ready === 0) {
          const first = preview.entries.find((entry) => entry.status === "blocked");
          showToast(`无法移到回收站：${first?.reason ?? "没有可删除的本地文件"}`, {
            kind: "error",
          });
          return;
        }
        setPendingRecycle({ paths, preview });
      } catch (e) {
        showToast(`检查待删除文件失败：${errorMessage(e)}`, { kind: "error" });
      } finally {
        setRecyclePreviewBusy(false);
      }
    },
    [showToast],
  );

  const routeDropPayload = useCallback(
    (payload: DragPayloadView, point: DropPoint | null, meta: DropPayloadMeta) => {
      // 垃圾桶优先于投递目标与暂存：一次拖入只执行删除，绝不「删完又暂存」。
      if (point && pointInTrash(point)) {
        if (payload.kind === "local-files") {
          void discardOperation(meta.operationId, "trash-delegated");
          void requestRecycle(payload.paths);
          return;
        }
        // 链接/文本/虚拟内容没有可安全删除的本地原文件：明确拒绝，不留孤立副本。
        showToast(
          "垃圾桶只接受真实本地文件；链接、文本与虚拟内容不会删除任何文件",
          { kind: "warning" },
        );
        void discardOperation(meta.operationId, "trash-unsupported-kind");
        return;
      }
      if (targetsOpenRef.current) {
        const targetId = point ? hitTarget(point) : null;
        if (targetId) {
          if (!canDropToDirectory(payload)) {
            // 链接/文本绝不隐式写成文件，也不留下无主暂存副本。
            showToast("此内容不能直接投递到文件夹；松手不会写入任何目录", { kind: "warning" });
            void discardOperation(meta.operationId, "directory-kind-rejected");
            return;
          }
          if (payload.kind === "local-files") {
            void discardOperation(meta.operationId, "local-files-delegated");
            void deliverDropped(targetId, payload.paths);
            return;
          }
          void deliverOperation(targetId, meta.operationId, payloadCount(payload));
          return;
        }
      }
      if (payload.kind === "unsupported") {
        // 后端原因是已脱敏的人读说明（只有格式名/计数）；有就展示具体原因。
        showToast(
          payload.reason.trim() || "无法识别拖入内容，未暂存任何东西",
          { kind: "error" },
        );
        void discardOperation(meta.operationId, "unsupported");
        return;
      }
      if (payload.kind === "local-files") {
        void discardOperation(meta.operationId, "local-files-delegated");
        stageDropped(payload.paths);
        return;
      }
      stageOperation(meta.operationId);
    },
    [deliverDropped, deliverOperation, hitTarget, pointInTrash, requestRecycle, showToast, stageDropped, stageOperation],
  );

  const dropEnabled = active && fullViewVisible && !capsuleMode;
  useEffect(() => {
    // 胶囊模式下本页被整体隐藏（dock-app inert），极简/紧凑模式下完整面板
    // 同样只是 CSS 隐藏；两种隐藏态都绝不能抢拖入事件——否则拖到可见界面上的
    // 文件会被悄悄塞进隐藏的暂存架。
    // 目标管理视图也是本消费者的落点范围：按松手坐标路由——命中目标卡片
    // 投递到真实目录，未命中仍按暂存处理（一次拖入只执行其中一个动作）。
    if (!dropEnabled) return;
    return registerFileDropConsumer({
      id: "shelf-workspace",
      // 低于胶囊投递卡片：胶囊展开时投递优先，其余情况由暂存架接收
      priority: 10,
      claim: () => true,
      onEnter: () => {
        dropSession.current = { active: true, handled: false };
        setOverTarget(null);
        setExternalTrashOver(false);
        // 目标管理视图不给整页遮罩：落点提示由视图内的提示条与卡片高亮承担。
        if (!targetsOpenRef.current) setDragOver(true);
        else setTargetsDragging(true);
      },
      onOver: (point) => {
        const session = dropSession.current;
        if (!session.active) {
          // enter 时未认领（例如目标列表刚加载完）允许在 over 阶段补开一次；
          // 已经 drop 过的会话不再接迟到 over，避免重复高亮。
          if (session.handled) return;
          dropSession.current = { active: true, handled: false };
        }
        // 垃圾桶是独立落点：命中时只高亮垃圾桶，不再显示整页/目标卡片提示。
        const inTrash = pointInTrash(point);
        setExternalTrashOver(inTrash);
        if (inTrash) {
          setDragOver(false);
          setTargetsDragging(false);
          setOverTarget(null);
          return;
        }
        if (targetsOpenRef.current) {
          setTargetsDragging(true);
          applyTargetOver(point);
        } else {
          setDragOver(true);
        }
      },
      onLeave: () => {
        dropSession.current = { active: false, handled: false };
        setDragOver(false);
        setTargetsDragging(false);
        setOverTarget(null);
        setDropProbe(null);
        setExternalTrashOver(false);
      },
      onDrop: (paths, point) => {
        const session = dropSession.current;
        // 先清高亮：无论后续是否执行，松手后都不能留下遮罩或卡片高亮。
        setDragOver(false);
        setTargetsDragging(false);
        setOverTarget(null);
        setDropProbe(null);
        setExternalTrashOver(false);
        // 一次会话只执行一个动作：重复 drop 与 leave 后的迟到 drop 不得再操作文件。
        if (!session.active || session.handled) return;
        session.handled = true;
        session.active = false;
        // 系统未给出路径：静默复位，不调用 addPaths，也不报「已暂存」。
        // （用户拖入的空/相对路径由 store 预检拦截并计入失败，走 reportAdd 明确提示。）
        if (paths.length === 0) return;
        // 垃圾桶优先：命中即删除，绝不再暂存同一批文件。
        if (point && pointInTrash(point)) {
          void requestRecycle(paths);
          return;
        }
        if (targetsOpenRef.current) {
          // 用松手瞬间的坐标重新命中：over 缓存可能已经过期（悬停 A 后快速移到
          // B 直接松手，不会再收到 over）。无坐标无法命中卡片，退回暂存动作。
          const targetId = point ? hitTarget(point) : null;
          if (targetId) {
            void deliverDropped(targetId, paths);
            return;
          }
        }
        stageDropped(paths);
      },
      // 类型探测只更新提示与卡片可用形态，不参与命中。
      onProbe: (next) => {
        setDropProbe(next);
      },
      // 松手已受理、内容仍在后端读取：先复位高亮，等载荷到达再决定动作。
      onAccepted: () => {
        dropSession.current = { active: false, handled: true };
        setDragOver(false);
        setTargetsDragging(false);
        setOverTarget(null);
        setExternalTrashOver(false);
      },
      onPayload: (payload, point, meta) => {
        setDropProbe(null);
        setExternalTrashOver(false);
        routeDropPayload(payload, point, meta);
      },
    });
  }, [
    dropEnabled,
    applyTargetOver,
    deliverDropped,
    hitTarget,
    pointInTrash,
    requestRecycle,
    routeDropPayload,
    setOverTarget,
    stageDropped,
  ]);

  // ── 添加动作 ──
  const pickAndAdd = async (dirs: boolean) => {
    try {
      const picked = await openDialog({
        multiple: true,
        directory: dirs,
        title: dirs ? "选择要暂存的文件夹" : "选择要暂存的文件",
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      const r = await addPaths(paths, copyOnAdd ? "managed" : "reference", "picker");
      reportAdd(r, "已暂存");
    } catch (e) {
      showToast(`暂存文件失败：${errorMessage(e)}`, { kind: "error" });
    }
  };

  const submitLink = async () => {
    if (!linkDraft.trim()) return;
    try {
      await addLink(linkDraft.trim());
      setLinkDraft("");
      setLinkOpen(false);
      showToast("链接已暂存", { kind: "success" });
    } catch (e) {
      showToast(`暂存链接失败：${errorMessage(e)}`, { kind: "error" });
    }
  };

  const submitText = async () => {
    if (!textValue.trim()) return;
    try {
      await addText(textValue);
      setTextValue("");
      setTextDraft(false);
      showToast("文本已暂存", { kind: "success" });
    } catch (e) {
      showToast(`暂存文本失败：${errorMessage(e)}`, { kind: "error" });
    }
  };

  const toggleClipboardPicker = async () => {
    const next = !clipOpen;
    setClipOpen(next);
    if (next) {
      try {
        const view = await clipboardView();
        setClipboardEntries(
          view.items.slice(0, 20).map((i) => ({
            id: i.id,
            kind: String(i.kind),
            preview:
              i.preview ||
              String(i.text || "").slice(0, 60) ||
              (i.file_paths && i.file_paths.length > 0
                ? i.file_paths.join("、").slice(0, 60)
                : "") ||
              (i.kind === "image" ? "图片" : "（无预览）"),
          })),
        );
      } catch (e) {
        showToast(`读取剪贴板列表失败：${errorMessage(e)}`, { kind: "error" });
      }
    }
  };

  const addFromClip = async (entryId: string) => {
    try {
      const r = await addFromClipboard([entryId], copyOnAdd ? "managed" : "reference");
      reportAdd(r, "已从剪贴板添加");
      if (r.added > 0) setClipOpen(false);
    } catch (e) {
      showToast(`从剪贴板添加失败：${errorMessage(e)}`, { kind: "error" });
    }
  };

  // ── 文件操作：移动 / 复制 / 重定位 ──
  const openFileOp = useCallback(
    (op: "move" | "copy", chosen: ShelfItem[]) => {
      const eligible = chosen.filter(op === "move" ? canMoveItem : canCopyItem);
      if (eligible.length === 0) {
        showToast(
          op === "move"
            ? "所选条目没有可移动的原文件（仅引用模式且文件存在时可移动；托管副本请用「导出副本到…」）"
            : "所选条目没有可复制的文件（原文件或托管副本已失效）",
          { kind: "error" },
        );
        return;
      }
      setFileOpRequest({
        op,
        ids: eligible.map((i) => i.id),
        items: eligible,
        excluded: chosen.length - eligible.length,
      });
    },
    [showToast],
  );

  const relocateItemFlow = useCallback(
    async (item: ShelfItem) => {
      try {
        const picked = await openDialog({
          directory: item.kind === "folder",
          multiple: false,
          title: item.kind === "folder" ? "重新选择文件夹" : "重新选择文件",
        });
        if (typeof picked !== "string") return;
        await relocateItem(item.id, picked);
        showToast("已重新定位，路径与存在状态已刷新", { kind: "success" });
      } catch (e) {
        showToast(`重新定位失败：${errorMessage(e)}`, { kind: "error" });
      }
    },
    [relocateItem, showToast],
  );

  // ── 条目菜单 ──
  const itemMenuFor = useCallback(
    (item: ShelfItem): DropdownMenuItem[] => [
      {
        key: "open",
        label: item.kind === "link" ? "在浏览器打开" : "打开",
        onSelect: () => {
          shelfOpenItem(item.id).catch((e) => showToast(`打开暂存项失败：${errorMessage(e)}`, { kind: "error" }));
        },
      },
      ...(item.kind === "file" || item.kind === "image" || item.kind === "folder"
        ? [
            {
              key: "reveal",
              label: "所在文件夹",
              onSelect: () => {
                shelfRevealItem(item.id).catch((e) =>
                  showToast(`打开所在文件夹失败：${errorMessage(e)}`, { kind: "error" }),
                );
              },
            },
          ]
        : []),
      ...(canMoveItem(item)
        ? [
            {
              key: "move-to",
              label: "移动原文件到…",
              onSelect: () => openFileOp("move", [item]),
            },
          ]
        : []),
      ...(canCopyItem(item)
        ? [
            {
              key: "copy-to",
              label: item.storage_mode === "managed" ? "导出副本到…" : "复制到…",
              onSelect: () => openFileOp("copy", [item]),
            },
          ]
        : []),
      ...(isPhysicalItem(item) &&
      item.storage_mode === "reference" &&
      item.exists_state === "missing"
        ? [
            {
              key: "relocate",
              label: "重新定位…",
              onSelect: () => void relocateItemFlow(item),
            },
          ]
        : []),
      {
        key: "copy-path",
        label: "复制路径",
        onSelect: () => {
          shelfCopyPaths([item.id])
            .then(() => showToast("路径已复制", { kind: "success" }))
            .catch((e) => showToast(`复制路径失败：${errorMessage(e)}`, { kind: "error" }));
        },
      },
      ...(item.kind === "file" || item.kind === "image"
        ? [
            {
              key: "copy-file",
              label: "复制文件（资源管理器可粘贴）",
              onSelect: () => {
                shelfCopyFiles([item.id])
                  .then(() => showToast("文件已复制到剪贴板", { kind: "success" }))
                  .catch((e) => showToast(`复制文件失败：${errorMessage(e)}`, { kind: "error" }));
              },
            },
          ]
        : []),
      ...(item.kind === "text" || item.kind === "link"
        ? [
            {
              key: "to-inbox",
              label: "添加到收集箱",
              disabled: toInboxBusy,
              onSelect: () => {
                if (toInboxBusy) return;
                setToInboxBusy(true);
                // 列表载荷不含 content（大文本不进前端内存）：先取全量权威行再转存。
                // 复用快速捕获既有提交通道（client_id 幂等去重）；原暂存条目保留，
                // 失败不改动任何状态。
                shelfGetItem(item.id)
                  .then((full) => {
                    const content = (full.content ?? "").trim();
                    if (!content) {
                      showToast("该条目缺少可转存的内容", { kind: "error" });
                      return;
                    }
                    const input =
                      full.kind === "link"
                        ? { client_id: crypto.randomUUID(), kind: "link" as const, content, url: content }
                        : { client_id: crypto.randomUUID(), kind: "text" as const, content };
                    return quickCaptureSubmit(input).then(() =>
                      showToast("已添加到收集箱", {
                        kind: "success",
                        action: { label: "查看", run: () => setTab("inbox") },
                      }),
                    );
                  })
                  .catch((e) => showToast(`添加到收集箱失败：${errorMessage(e)}`, { kind: "error" }))
                  .finally(() => setToInboxBusy(false));
              },
            },
          ]
        : []),
      {
        key: "favorite",
        label: item.favorite ? "取消收藏" : "收藏",
        onSelect: () => {
          updateItem(item.id, { favorite: !item.favorite }).catch((e) =>
            showToast(`更新收藏失败：${errorMessage(e)}`, { kind: "error" }),
          );
        },
      },
      {
        key: "pin",
        label: item.pinned ? "取消置顶" : "置顶",
        onSelect: () => {
          updateItem(item.id, { pinned: !item.pinned }).catch((e) =>
            showToast(`更新置顶失败：${errorMessage(e)}`, { kind: "error" }),
          );
        },
      },
      ...groups.map((g) => ({
        key: `group-${g.id}`,
        label: `${item.group_id === g.id ? "✓ " : ""}移动到分组：${g.name}`,
        onSelect: () => {
          moveToGroup([item.id], g.id).catch((e) => showToast(`移动分组失败：${errorMessage(e)}`, { kind: "error" }));
        },
      })),
      {
        key: "delete",
        label: "删除",
        danger: true,
        onSelect: () => {
          setPendingDelete({
            ids: [item.id],
            includeProtected: item.favorite || item.pinned || item.scene_id != null,
            hasFlags: item.favorite || item.pinned,
            hasScene: item.scene_id != null,
          });
          setConfirmDelete(true);
        },
      },
    ],
    [
      groups,
      showToast,
      updateItem,
      moveToGroup,
      toInboxBusy,
      setTab,
      openFileOp,
      relocateItemFlow,
    ],
  );

  const detailItem =
    items.find((i) => i.id === detailId) ??
    (detailFallback && detailFallback.id === detailId ? detailFallback : null);
  const selectedItems = items.filter((i) => selectedIds.includes(i.id));
  const movableSelected = selectedItems.filter(canMoveItem);
  const copyableSelected = selectedItems.filter(canCopyItem);
  const copyLabel = copyActionLabel(copyableSelected);
  const copyHasManaged = copyableSelected.some((i) => i.storage_mode === "managed");
  /** 快速投递只接受「引用模式且有真实原路径」的条目；托管副本走「导出副本到…」。 */
  const deliverableSelected = selectedItems.filter(
    (item) =>
      item.storage_mode === "reference" &&
      item.kind !== "text" &&
      item.kind !== "link" &&
      item.exists_state !== "missing" &&
      Boolean(item.original_path),
  );

  // ── 选择语义（框选 / Ctrl / Shift / 键盘共用）──
  const imageItems = useMemo(() => imageItemsOf(items), [items]);
  const lightboxItem = lightboxId
    ? items.find((item) => item.id === lightboxId) ?? null
    : null;

  const focusCard = useCallback((id: string) => {
    const container = listRef.current;
    if (!container) return;
    const node = Array.from(
      container.querySelectorAll<HTMLElement>("[data-shelf-id]"),
    ).find((el) => el.dataset.shelfId === id);
    node?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const selectOnly = useCallback(
    (id: string) => {
      setSelection([id]);
      anchorRef.current = id;
      setFocusId(id);
    },
    [setSelection],
  );

  const selectToggle = useCallback(
    (id: string) => {
      toggleSelect(id);
      anchorRef.current = id;
      setFocusId(id);
    },
    [toggleSelect],
  );

  /** Shift 连选：按当前加载顺序取锚点到目标的闭区间（替换选择）。 */
  const selectRange = useCallback(
    (id: string) => {
      const list = itemsRef.current;
      const to = list.findIndex((item) => item.id === id);
      if (to < 0) return;
      const anchor = anchorRef.current;
      let from = anchor ? list.findIndex((item) => item.id === anchor) : -1;
      if (from < 0) from = to;
      const [start, end] = from <= to ? [from, to] : [to, from];
      setSelection(list.slice(start, end + 1).map((item) => item.id));
      setFocusId(id);
    },
    [setSelection],
  );

  const openDeleteConfirm = useCallback((ids: string[], includeProtected = false) => {
    let unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    if (unique.length > MAX_TRASH_BATCH) {
      unique = unique.slice(0, MAX_TRASH_BATCH);
      showToast(`一次最多移除 ${MAX_TRASH_BATCH} 项，已取前 ${MAX_TRASH_BATCH} 项`, {
        kind: "warning",
      });
    }
    const chosen = itemsRef.current.filter((item) => unique.includes(item.id));
    setPendingDelete({
      ids: unique,
      includeProtected,
      hasFlags: chosen.some((item) => item.favorite || item.pinned),
      hasScene: chosen.some((item) => item.scene_id != null),
    });
    setConfirmDelete(true);
  }, [showToast]);

  /** 单条受保护条目：与卡片「⋯」菜单一致，显式确认后可删；多选仍保守跳过。 */
  const openDeleteConfirmForEntry = useCallback(
    (ids: string[]) => {
      const single =
        ids.length === 1 ? itemsRef.current.find((item) => item.id === ids[0]) : undefined;
      const includeProtected = Boolean(
        single && (single.favorite || single.pinned || single.scene_id != null),
      );
      openDeleteConfirm(ids, includeProtected);
    },
    [openDeleteConfirm],
  );

  /** 右键：已选条目上右键作用于整个选择集；未选中条目先改为单选。 */
  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, item: ShelfItem) => {
      event.preventDefault();
      const selected = selectedIdsRef.current;
      const ids =
        selected.includes(item.id) && selected.length > 1 ? selected : [item.id];
      if (!selected.includes(item.id)) selectOnly(item.id);
      setFocusId(item.id);
      setContextMenu({ x: event.clientX, y: event.clientY, ids });
    },
    [selectOnly],
  );

  const onTrashClick = () => {
    if (selectedIdsRef.current.length > 0) {
      openDeleteConfirm(selectedIdsRef.current, false);
      return;
    }
    showToast(
      "先选中条目再点垃圾桶；也可以按住 Alt 把条目拖到这里，或把资源管理器文件直接拖进来",
      { kind: "info" },
    );
  };

  const confirmRecycle = async () => {
    const pending = pendingRecycle;
    if (!pending?.preview || recycleBusy) return;
    const expected = pending.preview.entries
      .filter((entry) => entry.status === "ready")
      .map((entry) => ({
        path: entry.path,
        is_dir: entry.is_dir,
        byte_size: entry.byte_size,
        modified_ms: entry.modified_ms,
      }));
    setRecycleBusy(true);
    try {
      const report = await shelfRecycleExecute(pending.paths, expected);
      const parts = [`已移入回收站 ${report.deleted} 项`];
      if (report.skipped > 0) parts.push(`${report.skipped} 项跳过`);
      if (report.failed > 0) parts.push(`${report.failed} 项失败`);
      const problem = report.entries.find((entry) => entry.status !== "ok");
      showToast(
        `${parts.join("，")}${
          problem ? `：${problem.name} — ${problem.reason ?? "未知原因"}` : "，可在 Windows 回收站恢复"
        }`,
        { kind: report.failed > 0 || report.skipped > 0 ? "warning" : "success" },
      );
      setPendingRecycle(null);
    } catch (e) {
      showToast(`移到回收站失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setRecycleBusy(false);
    }
  };

  /** 撤销软删除：按批次恢复条目、标签与项目/任务关联，再走权威列表同步。 */
  const undoTrash = async (batchId: string) => {
    if (!batchId) return;
    try {
      const { report, synced } = await restoreTrash(batchId);
      if (report.restored > 0) {
        showToast(
          `已恢复 ${report.restored} 项${
            report.conflicts > 0 ? `，${report.conflicts} 项因已存在跳过` : ""
          }`,
          { kind: report.conflicts > 0 ? "warning" : "success" },
        );
      } else {
        showToast("撤销失败：回收站中已找不到这些条目", { kind: "error" });
      }
      if (!synced) {
        showToast("恢复已执行，但列表同步失败；可稍后重试同步", {
          kind: "warning",
          action: { label: "重试同步", run: () => void retryShelfSync() },
        });
      }
    } catch (e) {
      showToast(`撤销失败：${errorMessage(e)}`, { kind: "error" });
    }
  };

  // ── 灯箱序列：按当前筛选/排序；到尾部时按需加载下一页 ──
  const navigateLightbox = useCallback(
    async (direction: -1 | 1) => {
      const currentId = lightboxId;
      if (!currentId) return;
      const images = imageItemsOf(itemsRef.current);
      const index = images.findIndex((item) => item.id === currentId);
      const next = index + direction;
      if (next >= 0 && next < images.length) {
        setLightboxId(images[next].id);
        return;
      }
      if (direction > 0 && itemsRef.current.length < total) {
        setLightboxLoading(true);
        try {
          // 尾部可能连续多页没有图片：最多继续加载 3 页，避免把「下一页没图」
          // 误报成「已经是最后一张」。
          let advanced = false;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const before = useShelfStore.getState();
            if (before.items.length >= before.total) break;
            await loadMore();
            const latest = useShelfStore.getState();
            const after = imageItemsOf(latest.items);
            const at = after.findIndex((item) => item.id === currentId);
            const candidate = at >= 0 ? after[at + 1] : after[after.length - 1];
            if (candidate && candidate.id !== currentId) {
              setLightboxId(candidate.id);
              advanced = true;
              break;
            }
            if (latest.items.length <= before.items.length) break;
          }
          if (!advanced) showToast("已经是最后一张图片", { kind: "info" });
        } catch (e) {
          showToast(`加载更多图片失败：${errorMessage(e)}`, { kind: "error" });
        } finally {
          setLightboxLoading(false);
        }
        return;
      }
      showToast(direction < 0 ? "已经是第一张图片" : "已经是最后一张图片", { kind: "info" });
    },
    [lightboxId, loadMore, showToast, total],
  );

  const copyLightboxImage = (target: ShelfItem) => {
    shelfCopyFiles([target.id])
      .then(() => showToast("图片文件已复制，可在资源管理器粘贴", { kind: "success" }))
      .catch((e) => showToast(`复制图片失败：${errorMessage(e)}`, { kind: "error" }));
  };

  // ── 矩形框选：预览只写本地 state，松手才提交 selection ──
  const marquee = useShelfMarquee({
    containerRef: listRef,
    enabled:
      active &&
      fullViewVisible &&
      !capsuleMode &&
      !targetsOpen &&
      !fileOpRequest &&
      !pendingRecycle,
    onChange: (ids, _mode, phase) => {
      if (phase === "end") {
        setSelection(ids);
        setMarqueePreview(null);
        anchorRef.current = ids[0] ?? null;
        setFocusId(ids[0] ?? null);
        return;
      }
      setMarqueePreview(ids);
    },
    onCancel: () => setMarqueePreview(null),
    getBaseSelection: () => useShelfStore.getState().selectedIds,
  });

  // ── Alt+拖动到垃圾桶：应用内手势，不进入 OLE 拖出 ──
  const internalDrag = useShelfInternalDrag({
    enabled: active && fullViewVisible && !capsuleMode && !targetsOpen,
    getTrashRect: trashHitRect,
    onDrop: (ids) => openDeleteConfirmForEntry(ids),
  });

  /** 框选预览期间卡片也显示临时选中态（不写 store）。 */
  const effectiveSelected = useMemo(
    () => new Set(marqueePreview ?? selectedIds),
    [marqueePreview, selectedIds],
  );

  /** 弹层/详情打开时，Esc 先交给它们；列表只处理“无弹层”的取消选择。 */
  const overlayOpen = Boolean(
    linkOpen ||
      textDraft ||
      clipOpen ||
      cleanupOpen ||
      targetsOpen ||
      confirmClear ||
      confirmDelete ||
      confirmCleanup ||
      locateConfirm ||
      batchLinkOpen ||
      tagOpen ||
      dedupOpen ||
      rulesOpen ||
      fileOpRequest ||
      pendingRecycle ||
      lightboxId,
  );

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target as Element | null;
    if (
      target?.closest?.(
        "input,textarea,select,[contenteditable='true'],button,a,[role='button']",
      )
    ) {
      return;
    }
    const list = itemsRef.current;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(list.map((item) => item.id));
      anchorRef.current = list[0]?.id ?? null;
      return;
    }
    if (event.key === "Escape") {
      // 框选中按 Esc：交给 useShelfMarquee 取消，保留取消前的选择（不能先清空）。
      if (marquee.active) return;
      if (overlayOpen) return;
      if (detailId) {
        event.preventDefault();
        setDetail(null);
        return;
      }
      if (selectedIdsRef.current.length > 0) {
        event.preventDefault();
        clearSelection();
        anchorRef.current = null;
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (list.length === 0) return;
      event.preventDefault();
      const current = focusId
        ? list.findIndex((item) => item.id === focusId)
        : -1;
      const next =
        event.key === "ArrowDown"
          ? Math.min(list.length - 1, current + 1)
          : Math.max(0, current - 1);
      const id = list[next].id;
      if (event.shiftKey) selectRange(id);
      else selectOnly(id);
      setFocusId(id);
      focusCard(id);
      return;
    }
    if (event.key === " " || event.key === "Spacebar") {
      if (!focusId) return;
      event.preventDefault();
      selectToggle(focusId);
      return;
    }
    if (event.key === "Enter") {
      if (!focusId) return;
      event.preventDefault();
      setDetail(focusId);
      return;
    }
    if (event.key === "Delete") {
      const targetIds =
        selectedIdsRef.current.length > 0
          ? selectedIdsRef.current
          : focusId
            ? [focusId]
            : [];
      if (targetIds.length === 0) return;
      event.preventDefault();
      if (targetIds.length === 1) openDeleteConfirmForEntry(targetIds);
      else openDeleteConfirm(targetIds, false);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      const ids = selectedIdsRef.current;
      if (ids.length === 0) return;
      event.preventDefault();
      const chosen = itemsRef.current.filter((item) => ids.includes(item.id));
      if (chosen.length > 0 && chosen.every((item) => item.kind === "text" || item.kind === "link")) {
        void (async () => {
          try {
            const contents = await Promise.all(
              chosen.map((item) => shelfGetItem(item.id).then((full) => full.content ?? "")),
            );
            await clipboardCopyText(contents.join("\n\n"));
            showToast("内容已复制", { kind: "success" });
          } catch (e) {
            showToast(`复制内容失败：${errorMessage(e)}`, { kind: "error" });
          }
        })();
        return;
      }
      copySelectedFiles();
    }
  };

  // 空态必须区分「暂存架真空」与「当前筛选无结果」：stats.total 是未筛选总数。
  const hasFilters =
    filter.search.trim() !== "" ||
    filter.kind !== "all" ||
    filter.group_id !== "all" ||
    filter.favorite_only;
  const filterCount =
    (filter.kind !== "all" ? 1 : 0) +
    (filter.group_id !== "all" ? 1 : 0) +
    (filter.favorite_only ? 1 : 0);
  const shelfHasItems = (stats?.total ?? 0) > 0;
  const filteredEmpty = shelfHasItems && total === 0 && items.length === 0;
  const clearFilters = () => {
    setSearchDraft("");
    void setFilter({ search: "", kind: "all", group_id: "all", favorite_only: false });
  };

  const copyFilesOf = (ids: string[]) => {
    shelfCopyFiles(ids)
      .then(() => showToast("文件已复制，可在资源管理器粘贴", { kind: "success" }))
      .catch((e) => showToast(`复制所选文件失败：${errorMessage(e)}`, { kind: "error" }));
  };

  const copySelectedFiles = () => copyFilesOf(selectedIds);

  /** 批量收藏（或取消收藏）：逐项收集结果，部分失败明确报告。 */
  const favoriteItems = (chosen: ShelfItem[], favorite = true) => {
    const ids = chosen.map((item) => item.id);
    void (async () => {
      // 逐项结果单独收集：批量部分失败不能整体丢弃或一律报成功。
      const results = await Promise.all(
        ids.map((id) =>
          updateItem(id, { favorite }).then(
            () => true,
            () => false,
          ),
        ),
      );
      const failed = results.filter((ok) => !ok).length;
      const done = ids.length - failed;
      if (failed === 0) showToast(favorite ? "已收藏所选" : "已取消收藏", { kind: "success" });
      else if (done === 0) showToast("更新收藏失败，请稍后重试", { kind: "error" });
      else showToast(`已更新 ${done} 项，${failed} 项失败`, { kind: "warning" });
    })();
  };

  const favoriteSelected = () => favoriteItems(selectedItems, true);

  const moveSelectedToGroup = (groupId: string) => {
    moveToGroup(selectedIds, groupId)
      .then(() => showToast("已移动", { kind: "success" }))
      .catch((e) => showToast(`移动分组失败：${errorMessage(e)}`, { kind: "error" }));
  };

  /** 右键菜单项：只列与当前集合相关的动作；不适用项禁用并说明。 */
  const contextActionsFor = (ids: string[]) => {
    const chosen = itemsRef.current.filter((item) => ids.includes(item.id));
    const multi = chosen.length > 1;
    const copyable = chosen.filter(canCopyItem);
    const movable = chosen.filter(canMoveItem);
    const allFavorite = chosen.length > 0 && chosen.every((item) => item.favorite);
    return [
      {
        key: "open",
        label: "打开",
        disabled: multi || chosen.length === 0,
        onSelect: () => {
          const first = chosen[0];
          if (!first) return;
          shelfOpenItem(first.id).catch((e) =>
            showToast(`打开暂存项失败：${errorMessage(e)}`, { kind: "error" }),
          );
        },
      },
      {
        key: "detail",
        label: "查看详情",
        icon: <Info size={13} aria-hidden="true" />,
        disabled: multi || chosen.length === 0,
        onSelect: () => chosen[0] && setDetail(chosen[0].id),
      },
      {
        key: "copy-files",
        label: multi ? `复制文件（${copyable.length} 项）` : "复制文件",
        icon: <Copy size={13} aria-hidden="true" />,
        disabled: copyable.length === 0,
        onSelect: () => copyFilesOf(copyable.map((item) => item.id)),
      },
      {
        key: "copy-paths",
        label: "复制路径",
        disabled: chosen.length === 0,
        onSelect: () => {
          shelfCopyPaths(ids)
            .then(() => showToast("路径已复制", { kind: "success" }))
            .catch((e) => showToast(`复制路径失败：${errorMessage(e)}`, { kind: "error" }));
        },
      },
      {
        key: "move",
        label: "移动原文件到…",
        disabled: movable.length === 0,
        onSelect: () => openFileOp("move", chosen),
      },
      {
        key: "copy-to",
        label: "复制 / 导出到…",
        disabled: copyable.length === 0,
        onSelect: () => openFileOp("copy", chosen),
      },
      {
        key: "favorite",
        label: allFavorite ? "取消收藏" : "收藏",
        icon: <Star size={13} aria-hidden="true" />,
        disabled: chosen.length === 0,
        onSelect: () => favoriteItems(chosen, !allFavorite),
      },
      {
        key: "tag",
        label: "添加标签…",
        icon: <Tag size={13} aria-hidden="true" />,
        disabled: chosen.length === 0,
        onSelect: () => setTagOpen(true),
      },
      {
        key: "link",
        label: "关联项目或任务…",
        icon: <Link2 size={13} aria-hidden="true" />,
        disabled: chosen.length === 0,
        onSelect: () => setBatchLinkOpen(true),
      },
      {
        key: "delete",
        label: multi ? `删除 ${chosen.length} 项…` : "删除…",
        icon: <Trash2 size={13} aria-hidden="true" />,
        danger: true,
        disabled: chosen.length === 0,
        onSelect: () => openDeleteConfirmForEntry(ids),
      },
    ];
  };

  /**
   * 批量投递到最近目标：只投递引用模式的真实原文件；托管副本与文本/链接不参与，
   * 并显式说明跳过数量，绝不把「没投递」说成成功。
   */
  const deliverSelectedTo = async (targetId: string) => {
    const chosen = deliverableSelected;
    if (chosen.length === 0) {
      showToast(
        "所选条目没有可投递的原文件（托管副本请用「导出副本到…」，文本/链接不能当文件复制）",
        { kind: "error" },
      );
      return;
    }
    const result = await deliverToTarget(
      targetId,
      chosen.map((item) => item.original_path as string),
    );
    if (result.kind === "blocked") {
      showToast(result.reason, { kind: "error" });
      return;
    }
    if (result.kind === "error") {
      showToast(`投递失败：${result.message}`, { kind: "error" });
      return;
    }
    const { report, targetName } = result;
    const excluded = selectedItems.length - chosen.length;
    const parts = [`已投递 ${report.success} 项到「${targetName}」`];
    if (report.failed > 0) parts.push(`${report.failed} 项失败`);
    if (report.partial > 0) parts.push(`${report.partial} 项部分完成`);
    if (excluded > 0) parts.push(`${excluded} 项不适用（托管副本/文本/缺失）`);
    showToast(parts.join("，"), {
      kind: report.failed > 0 || report.partial > 0 || excluded > 0 ? "warning" : "success",
      action: {
        label: "打开目标",
        run: () => {
          shelfDropTargetOpen(targetId).catch(() => {});
        },
      },
    });
    // 目标配置为 move 时源文件已被搬走：立即复核存在状态，不留下伪「可用」。
    if (report.op === "move") {
      void verifyExists(chosen.map((item) => item.id));
    }
  };

  /** 选中多选时拖整个选择集；否则只拖当前卡片。 */
  const dragIdsFor = useCallback(
    (item: ShelfItem) =>
      selectedIds.includes(item.id) && selectedIds.length > 1
        ? selectedIds
        : [item.id],
    [selectedIds],
  );

  const onDragSettled = useCallback(
    (result: ShelfDragOutResult, ids: string[]) => {
      if (result.effect !== "move") return;
      // 目标应用按 Windows 默认把源文件搬走；条目保留，但原路径可能已失效。
      void verifyExists(ids);
      showToast(
        "文件已移动；暂存条目保留，原路径可能已失效，可重新定位或删除",
        { kind: "warning" },
      );
    },
    [showToast, verifyExists],
  );

  const onDragError = useCallback(
    (message: string) => showToast(message, { kind: "error" }),
    [showToast],
  );

  /** dry-run 预览：只读，不触发真实清理；关闭面板后迟到的结果直接丢弃。 */
  const previewCleanup = useCallback(async (): Promise<CleanupPreview | null> => {
    if (cleanupPreviewInFlight.current || cleanupBusy) return null;
    cleanupPreviewInFlight.current = true;
    const seq = ++cleanupSeq.current;
    setCleanupPreviewBusy(true);
    try {
      const { report } = await runCleanup(true, false);
      if (seq !== cleanupSeq.current) return null;
      const preview: CleanupPreview = {
        candidates: report.candidates,
        skipped_protected: report.skipped_protected,
        freed_bytes: report.freed_bytes,
      };
      setCleanupPreview(preview);
      return preview;
    } catch (e) {
      if (seq === cleanupSeq.current) {
        showToast(`清理预览失败：${errorMessage(e)}`, { kind: "error" });
      }
      return null;
    } finally {
      cleanupPreviewInFlight.current = false;
      setCleanupPreviewBusy(false);
    }
  }, [cleanupBusy, runCleanup, showToast]);

  const runCleanupPreview = () => {
    void previewCleanup();
  };

  /** 「立即清理过期」：先自动 dry-run 预览，再弹确认；确认前绝不执行真实清理。 */
  const askCleanupNow = async () => {
    const preview = await previewCleanup();
    if (!preview) return;
    if (preview.candidates === 0) {
      // 0 候选不是成功清理：不弹「确认清理」，也不发真实请求。
      showToast("没有需要清理的过期条目。", { kind: "info" });
      return;
    }
    setConfirmCleanup(true);
  };

  /** 二次确认后才执行真实清理；结果反馈与权威同步都由 Store 负责。 */
  const confirmCleanupNow = async () => {
    try {
      const result = await runCleanup(false, false);
      const feedback = shelfCleanupFeedback(result);
      showToast(feedback.message, {
        kind: feedback.kind,
        ...(!result.synced
          ? { action: { label: "重试同步", run: () => void retryShelfSync() } }
          : {}),
      });
      setCleanupPreview(null);
      // 有托管文件残留或列表未同步时保留面板，便于再次预览或重试同步。
      if (result.synced && result.report.failed_files === 0) closeCleanupPanel();
    } catch (e) {
      showToast(`清理失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setConfirmCleanup(false);
    }
  };

  return (
    <div className={`shelf-workspace ${dragOver ? "drag-over" : ""}`}>
      {targetsOpen ? (
        /* 目标管理是独立内容视图：暂存架工具栏/筛选/列表/空态都不再挂载。
           拖入由 ShelfWorkspace 的消费者统一路由：命中目标卡片即投递，
           未命中仍暂存；这里只透传拖放高亮状态。 */
        <DropTargetManager
          onClose={() => {
            setTargetsOpen(false);
            setTargetsDirty(false);
          }}
          onDirtyChange={setTargetsDirty}
          dragActive={targetsDragging}
          overTargetId={overTargetId}
          dropBlocked={dropBlocked}
        />
      ) : (
        <>
      <ShelfToolbar
        searchDraft={searchDraft}
        onSearchChange={(value) => {
          setSearchDraft(value);
          onSearchInput(value);
        }}
        copyOnAdd={copyOnAdd}
        onCopyOnAddChange={setCopyOnAdd}
        kind={filter.kind}
        onKindChange={(kind) => void setFilter({ kind })}
        groupId={filter.group_id}
        groups={groups}
        onGroupChange={(groupId) => void setFilter({ group_id: groupId })}
        favoriteOnly={filter.favorite_only}
        onFavoriteOnlyChange={(favoriteOnly) =>
          void setFilter({ favorite_only: favoriteOnly })
        }
        hasFilters={hasFilters}
        filterCount={filterCount}
        onClearFilters={clearFilters}
        onPickFiles={() => void pickAndAdd(false)}
        onPickFolder={() => void pickAndAdd(true)}
        onPasteCurrent={() => void pasteCurrentClipboard()}
        onPasteScreenshot={() => void pasteScreenshot()}
        pasteBusy={pasteBusy}
        onAddLink={() => setLinkOpen((value) => !value)}
        onAddText={() => setTextDraft((value) => !value)}
        onAddFromClipboard={() => void toggleClipboardPicker()}
        onOpenTargets={() => {
          setTargetsOpen(true);
          closeCleanupPanel();
        }}
        onOpenCleanup={() => {
          if (cleanupOpen) {
            closeCleanupPanel();
          } else {
            cleanupSeq.current += 1;
            setCleanupPreview(null);
            setCleanupOpen(true);
          }
        }}
        onClearShelf={() => setConfirmClear(true)}
        onOpenDedup={() => setDedupOpen(true)}
        onOpenRules={() => setRulesOpen(true)}
        sendToEnabled={sendToEnabled}
        onToggleSendTo={() => void toggleSendTo()}
        helpArticleId="help.capture.shelf"
        view={view}
        onViewChange={setView}
        gridSize={gridSize}
        onGridSizeChange={setGridSize}
        trashRef={trashHitRef}
        trashActive={dragOver || internalDrag.active}
        trashOver={externalTrashOver || internalDrag.overTrash}
        onTrashClick={onTrashClick}
      />

      {/* 投递目标管理已改为独立视图（见顶部 targetsOpen 分支），此处不再内联。 */}

      {/* 清理设置面板 */}
      {cleanupOpen && (
        <CleanupPanel
          stats={stats}
          preview={cleanupPreview}
          busy={cleanupBusy || cleanupPreviewBusy}
          onPreview={runCleanupPreview}
          onRun={() => void askCleanupNow()}
          onClose={closeCleanupPanel}
        />
      )}

      {/* 添加链接行 */}
      {linkOpen && (
        <div className="shelf-inline-form" role="form" aria-label="添加网页链接">
          <input
            type="url"
            className="input-embedded"
            placeholder="https://…"
            aria-label="链接地址"
            value={linkDraft}
            autoFocus
            onChange={(e) => setLinkDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submitLink()}
          />
          <button type="button" className="btn sm primary" onClick={() => void submitLink()}>
            添加
          </button>
          <button type="button" className="btn sm" onClick={() => setLinkOpen(false)}>
            取消
          </button>
        </div>
      )}

      {/* 添加文本行 */}
      {textDraft && (
        <div className="shelf-inline-form column" role="form" aria-label="添加文本片段">
          <textarea
            className="shelf-text-input"
            rows={4}
            placeholder="粘贴或输入要暂存的文本（≤512KB）"
            aria-label="文本内容"
            value={textValue}
            autoFocus
            onChange={(e) => setTextValue(e.target.value)}
          />
          <div className="shelf-inline-actions">
            <button type="button" className="btn sm primary" onClick={() => void submitText()}>
              添加
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setTextDraft(false);
                setTextValue("");
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 从剪贴板添加 */}
      {clipOpen && (
        <div className="shelf-clip-picker" role="dialog" aria-label="从剪贴板选择条目">
          <div className="shelf-clip-head">
            <Clipboard size={14} aria-hidden="true" /> 最近的剪贴板条目
            <button
              type="button"
              className="icon-btn sm"
              aria-label="关闭剪贴板选择"
              onClick={() => setClipOpen(false)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
          {clipboardEntries.length === 0 ? (
            <p className="shelf-clip-empty">剪贴板历史为空或未启用剪贴板模块</p>
          ) : (
            <ul className="shelf-clip-list">
              {clipboardEntries.map((c) => (
                <li key={c.id}>
                  <span className="shelf-clip-kind">
                    {SHELF_KIND_LABELS[c.kind as ShelfKind] ?? c.kind}
                  </span>
                  <span className="shelf-clip-preview" title={c.preview}>
                    {c.preview}
                  </span>
                  <button type="button" className="btn sm" onClick={() => void addFromClip(c.id)}>
                    添加
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(mutationSyncError || error) && items.length > 0 && (
        <div className="shelf-error" role="alert">
          {mutationSyncError ?? error}
          <button type="button" className="btn sm" onClick={() => void retryShelfSync()}>
            重试同步
          </button>
        </div>
      )}

      {/* 文件操作内嵌面板（移动 / 复制共享） */}
      {fileOpRequest && (
        <ShelfFileOpPanel request={fileOpRequest} onClose={() => setFileOpRequest(null)} />
      )}

      {/* 列表 / 网格：同一个滚动容器与同一批条目，只切换布局。
          框选从容器空白处起拖；卡片主体仍由 useShelfDragOut 负责拖出。 */}
      <div
        className={`shelf-list shelf-list--${view} shelf-grid-${gridSize}`}
        role="list"
        aria-label="暂存条目"
        ref={listRef}
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        onPointerDown={(event) => {
          const target = event.target as Element | null;
          if (
            !target?.closest?.(
              "[data-shelf-id],button,input,textarea,select,a,[data-marquee-ignore]",
            )
          ) {
            listRef.current?.focus({ preventScroll: true });
          }
          marquee.onPointerDown(event);
        }}
        onClickCapture={(event) => {
          // 框选收尾的 click 不得清空刚提交的选择。
          if (marquee.shouldSuppressClick()) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {items.map((item) => (
          <ShelfItemCard
            key={item.id}
            item={item}
            layout={view}
            selected={effectiveSelected.has(item.id)}
            focused={focusId === item.id}
            thumbUrl={null}
            menuItems={itemMenuFor(item)}
            onOpen={() => setDetail(item.id)}
            onToggleSelect={() => selectToggle(item.id)}
            onSelectOnly={() => selectOnly(item.id)}
            onSelectToggle={() => selectToggle(item.id)}
            onSelectRange={() => selectRange(item.id)}
            onContextMenu={(event) => openContextMenu(event, item)}
            onInternalDragStart={(event) => internalDrag.start(event, dragIdsFor(item))}
            isClickSuppressed={internalDrag.shouldSuppressClick}
            onPreview={() => setDetail(item.id)}
            onPreviewImage={
              item.kind === "image" ? () => setLightboxId(item.id) : undefined
            }
            dragEnabled={canCopyItem(item)}
            resolveDragIds={() => dragIdsFor(item)}
            onDragSettled={onDragSettled}
            onDragError={onDragError}
          />
        ))}
        {items.length === 0 && !loading && (mutationSyncError || error) && (
          <div className="shelf-empty is-error" role="alert">
            <p>暂存架读取失败</p>
            <p className="shelf-empty-sub">{mutationSyncError ?? error}</p>
            <button type="button" className="btn sm" onClick={() => void retryShelfSync()}>
              重试同步
            </button>
          </div>
        )}
        {items.length === 0 && !loading && !error && !mutationSyncError && filteredEmpty && (
          <div className="shelf-empty">
            <FilterX size={22} strokeWidth={1.5} aria-hidden="true" />
            <p>没有匹配的文件</p>
            <p className="shelf-empty-sub">
              {hasFilters
                ? `当前筛选条件下没有结果；暂存架里仍有 ${stats?.total ?? 0} 项。`
                : `暂存架里仍有 ${stats?.total ?? 0} 项，可重新加载查看。`}
            </p>
            <button type="button" className="btn sm" onClick={clearFilters}>
              清除筛选
            </button>
          </div>
        )}
        {items.length === 0 && !loading && !error && !mutationSyncError && !filteredEmpty && (
          <div className="shelf-empty">
            <Upload size={22} strokeWidth={1.5} aria-hidden="true" />
            <p>把文件、图片拖进窗口，或用上方「添加」收纳链接与文本。</p>
            <p className="shelf-empty-sub">
              暂存架与剪贴板互相独立：这里只保存你主动放入的内容，删除剪贴板历史不影响暂存架。
              加入后按住卡片可拖到资源管理器或其他窗口。
            </p>
            <div className="shelf-empty-actions">
              <button type="button" className="btn sm primary" onClick={() => void pickAndAdd(false)}>
                <Plus size={13} aria-hidden="true" /> 添加文件
              </button>
              <button type="button" className="btn sm" onClick={() => void pickAndAdd(true)}>
                添加文件夹
              </button>
            </div>
          </div>
        )}
        {loading && (
          <div className="shelf-loading" aria-live="polite">
            <Loader2 size={16} className="spin" aria-hidden="true" /> 加载中…
          </div>
        )}
        {/* 框选矩形：内容坐标系，随列表滚动；纯视觉层不接收指针事件。 */}
        {marquee.rect && (
          <div
            className="shelf-marquee"
            aria-hidden="true"
            style={{
              left: marquee.rect.left,
              top: marquee.rect.top,
              width: marquee.rect.width,
              height: marquee.rect.height,
            }}
          />
        )}
      </div>

      {items.length < total && (
        <button type="button" className="btn sm shelf-more-btn" onClick={() => void loadMore()}>
          加载更多（{items.length}/{total}）
        </button>
      )}

      {/* 多选操作栏 */}
      {selectedIds.length > 0 && marqueePreview === null && (
        <div className="shelf-selectbar" role="toolbar" aria-label="批量操作">
          <span className="shelf-selectbar-count">已选 {selectedIds.length} 项</span>
          <button
            type="button"
            className="btn sm"
            data-tip="全选本页"
            onClick={selectAll}
          >
            全选
          </button>
          <span className="flex-spacer" />
          <button
            type="button"
            className="icon-btn sm"
            aria-label="收藏所选"
            data-tip="收藏所选"
            onClick={favoriteSelected}
          >
            <Star size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            aria-label="批量关联项目或任务"
            data-tip="批量关联项目/任务"
            onClick={() => setBatchLinkOpen(true)}
          >
            <Link2 size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            aria-label="批量标签"
            data-tip="批量添加/移除标签"
            onClick={() => setTagOpen(true)}
          >
            <Tag size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            aria-label="检测所选重复内容"
            data-tip="检测重复内容（只提示）"
            onClick={() => setDedupOpen(true)}
          >
            <CopyCheck size={14} aria-hidden="true" />
          </button>
          <DropdownMenu
            trigger={(props) => (
              <button
                {...props}
                type="button"
                className="icon-btn sm"
                aria-label="批量文件操作"
                data-tip="移动到分组 / 文件操作"
                onClick={() => {
                  props.onClick?.();
                  // 打开菜单时才读取最近投递目标（不在挂载时增加 IPC）。
                  void loadDropTargets();
                }}
              >
                <FolderInput size={14} aria-hidden="true" />
              </button>
            )}
            items={[
              ...(dropTargets.length > 0
                ? [
                    { key: "deliver-label", label: "投递到目标目录", disabled: true },
                    ...dropTargets.slice(0, 4).map((target) => ({
                      key: `deliver-${target.id}`,
                      label: target.name,
                      disabled: !target.available || deliverableSelected.length === 0,
                      description: target.available
                        ? target.op_mode === "move"
                          ? "移动原文件（投递后原路径失效）"
                          : "复制原文件（保留暂存记录）"
                        : "目录当前不可用",
                      onSelect: () => void deliverSelectedTo(target.id),
                    })),
                  ]
                : []),
              ...(groups.length > 0
                ? [{ key: "group-label", label: "移动到分组", disabled: true }]
                : []),
              ...groups.map((group) => ({
                key: group.id,
                label: group.name,
                onSelect: () => moveSelectedToGroup(group.id),
              })),
              {
                key: "none",
                label: "未分组",
                onSelect: () => moveSelectedToGroup("none"),
              },
              {
                key: "copy-files",
                label: "复制文件",
                onSelect: copySelectedFiles,
              },
              {
                key: "move-to",
                label: "移动原文件到…",
                disabled: movableSelected.length === 0,
                description: "仅引用模式且文件存在时可移动",
                onSelect: () => openFileOp("move", selectedItems),
              },
              {
                key: "copy-to",
                label: copyLabel,
                disabled: copyableSelected.length === 0,
                description: copyHasManaged
                  ? "托管副本导出为副本，引用文件复制到目标目录"
                  : "复制到目标目录，原文件与暂存记录保持不变",
                onSelect: () => openFileOp("copy", selectedItems),
              },
            ]}
            menuLabel="批量文件操作"
            placement="top-end"
            menuMinWidth={190}
          />
          <button
            type="button"
            className="icon-btn sm danger"
            aria-label="删除所选"
            data-tip="删除所选（受保护条目跳过）"
            onClick={() => {
              const selected = items.filter((it) => selectedIds.includes(it.id));
              setPendingDelete({
                ids: selectedIds,
                // 批量删除保持保守：受保护条目跳过并保留，不隐式删除。
                includeProtected: false,
                hasFlags: selected.some((it) => it.favorite || it.pinned),
                hasScene: selected.some((it) => it.scene_id != null),
              });
              setConfirmDelete(true);
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            aria-label="取消选择"
            data-tip="取消选择"
            onClick={clearSelection}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* 详情 */}
      {detailItem && (
        <ShelfDetail
          item={detailItem}
          onClose={() => setDetail(null)}
          onFileOp={(op) => openFileOp(op, [detailItem])}
          onRelocate={() => void relocateItemFlow(detailItem)}
        />
      )}

      {/* 拖入高亮遮罩 */}
      {dragOver && (
        <div className="shelf-dropzone" aria-hidden="true">
          <div className="shelf-dropzone-inner">
            <Upload size={28} strokeWidth={1.5} />
            <p>{copyOnAdd ? "松开以复制副本到暂存架" : "松开以引用方式暂存（不复制文件）"}</p>
          </div>
        </div>
      )}

      {/* 批量关联项目/任务（复用关系表，不复制内容） */}
      <ShelfBatchLinkDialog
        open={batchLinkOpen}
        ids={selectedIds}
        onClose={() => setBatchLinkOpen(false)}
      />
      <ShelfTagDialog open={tagOpen} ids={selectedIds} onClose={() => setTagOpen(false)} />
      <ShelfDuplicateDialog
        open={dedupOpen}
        ids={selectedIds.length > 0 ? selectedIds : undefined}
        onClose={() => setDedupOpen(false)}
      />
      <ShelfRulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />

      {/* 右键菜单：作用于当前选择集；未选中条目会先改为单选。 */}
      {contextMenu && (
        <ShelfContextMenu
          open
          x={contextMenu.x}
          y={contextMenu.y}
          label={`条目操作（${contextMenu.ids.length} 项）`}
          items={contextActionsFor(contextMenu.ids)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 图片灯箱：缩略图单击直达；左右键按当前筛选/排序连续浏览。 */}
      {lightboxItem && (
        <ShelfImageLightbox
          item={lightboxItem}
          images={imageItems}
          loadingMore={lightboxLoading}
          onClose={() => setLightboxId(null)}
          onNavigate={(direction) => void navigateLightbox(direction)}
          onRequestDetail={(id) => {
            setLightboxId(null);
            setDetail(id);
          }}
          onFavorite={(item) => {
            updateItem(item.id, { favorite: !item.favorite }).catch((e) =>
              showToast(`更新收藏失败：${errorMessage(e)}`, { kind: "error" }),
            );
          }}
          onCopyImage={copyLightboxImage}
          onReveal={(item) => {
            shelfRevealItem(item.id).catch((e) =>
              showToast(`打开所在文件夹失败：${errorMessage(e)}`, { kind: "error" }),
            );
          }}
          onRequestDelete={(item) => {
            setLightboxId(null);
            openDeleteConfirmForEntry([item.id]);
          }}
        />
      )}

      {/* 外部文件拖入垃圾桶：先显示真实数量与保护原因，确认后才调用回收站。 */}
      <ShelfRecycleDialog
        open={Boolean(pendingRecycle)}
        preview={pendingRecycle?.preview ?? null}
        busy={recycleBusy || recyclePreviewBusy}
        onConfirm={() => void confirmRecycle()}
        onCancel={() => {
          if (!recycleBusy) setPendingRecycle(null);
        }}
      />

      {/* Alt+拖动时的轻量跟随提示（不改变列表布局）。 */}
      {internalDrag.active && internalDrag.point && (
        <div
          className="shelf-trash-ghost"
          aria-hidden="true"
          style={{ left: internalDrag.point.x + 14, top: internalDrag.point.y + 14 }}
        >
          <Trash2 size={13} strokeWidth={1.8} />
          松开移入垃圾桶
        </div>
      )}

      {/* 删除确认（含受保护条目提示） */}
      <ConfirmDialog
        open={confirmDelete}
        title={
          pendingDelete?.includeProtected
            ? "删除受保护的条目？"
            : `删除 ${pendingDelete?.ids.length ?? 0} 个条目？`
        }
        detail={
          pendingDelete?.includeProtected
            ? `所选条目${protectedReason(
                pendingDelete.hasFlags,
                pendingDelete.hasScene,
              )}，需要你确认后才会一并删除。${
                pendingDelete.hasScene ? "删除后对应场景会失去这些文件引用。" : ""
              }删除会移入暂存回收站，可立即撤销；引用的原文件不受影响。`
            : `收藏、置顶与被场景引用的条目会被跳过并保留。${
                pendingDelete && (pendingDelete.hasFlags || pendingDelete.hasScene)
                  ? `（本次所选${protectedReason(pendingDelete.hasFlags, pendingDelete.hasScene)}）`
                  : ""
              }删除会移入暂存回收站，7 天内可撤销；引用模式的原文件不受影响。`
        }
        confirmLabel="删除"
        danger
        busy={deletionBusy}
        onConfirm={() => {
          const target = pendingDelete;
          if (!target) return;
          void (async () => {
            try {
              const result = await trashItems(target.ids, target.includeProtected);
              const { report } = result;
              if (report.removed > 0) {
                showToast(
                  `已移除 ${report.removed} 项${
                    report.skipped_protected > 0
                      ? `，${report.skipped_protected} 项受保护已保留`
                      : ""
                  } · 可撤销`,
                  {
                    kind: report.skipped_protected > 0 ? "warning" : "success",
                    action: {
                      label: "撤销",
                      run: () => void undoTrash(report.batch_id),
                    },
                  },
                );
              } else if (report.skipped_protected > 0) {
                showToast(`${report.skipped_protected} 项受保护，未删除`, {
                  kind: "warning",
                });
              } else {
                showToast("没有可删除的条目", { kind: "info" });
              }
              if (!result.synced) {
                showToast("删除已执行，但列表同步失败；可稍后重试同步", {
                  kind: "warning",
                  action: { label: "重试同步", run: () => void retryShelfSync() },
                });
              }
            } catch (e) {
              showToast(`删除暂存项失败：${errorMessage(e)}`, { kind: "error" });
            } finally {
              setConfirmDelete(false);
              setPendingDelete(null);
            }
          })();
        }}
        onCancel={() => {
          setConfirmDelete(false);
          setPendingDelete(null);
        }}
      />

      {/* 清空确认 */}
      <ConfirmDialog
        open={confirmClear}
        title="清空暂存架？"
        detail="删除全部未收藏、未置顶、未被场景引用的条目（收藏、置顶与场景引用条目保留）。清空不会进入暂存回收站，无法撤销；托管副本会立即删除，引用的原文件不受影响。如需可撤销，请改用选择后「删除」。"
        confirmLabel="清空"
        danger
        busy={deletionBusy}
        onConfirm={() => {
          void (async () => {
            try {
              const result = await useShelfStore.getState().clearShelf(false);
              notifyShelfMutation(result, "clear");
            } catch (e) {
              showToast(`清空暂存架失败：${errorMessage(e)}`, { kind: "error" });
            } finally {
              setConfirmClear(false);
            }
          })();
        }}
        onCancel={() => setConfirmClear(false)}
      />

      {/* 过期清理确认：dry-run 只做预览；确认后才执行真实清理。
          预览与执行之间可能有时间差，最终以后端执行报告为准。 */}
      <ConfirmDialog
        open={confirmCleanup}
        title="清理过期条目？"
        detail={
          cleanupPreview
            ? `预计清理 ${cleanupPreview.candidates} 项，释放约 ${formatBytes(cleanupPreview.freed_bytes)} 托管空间。${
                cleanupPreview.skipped_protected > 0
                  ? `另有 ${cleanupPreview.skipped_protected} 项因收藏、置顶或场景引用而保留。`
                  : ""
              }只会删除 Task Dock 托管的副本与暂存记录，不会删除你的原始文件；收藏、置顶及被场景引用的条目默认保留。实际结果以执行后报告为准。`
            : undefined
        }
        confirmLabel="确认清理"
        danger
        busy={cleanupBusy}
        onConfirm={() => void confirmCleanupNow()}
        onCancel={() => {
          if (cleanupBusy) return;
          setConfirmCleanup(false);
        }}
      />
        </>
      )}

      {/* 外部定位（胶囊最近暂存/全局搜索）遇到目标管理未保存表单：
          确认后才离开；取消只丢定位意图，保留编辑内容。 */}
      <ConfirmDialog
        open={locateConfirm}
        title="放弃未保存的目标修改并查看文件？"
        detail="投递目标管理中还有未保存的修改。继续会放弃这些输入，返回文件暂存架并定位到该条目。"
        confirmLabel="放弃并定位"
        danger
        onConfirm={() => {
          const intent = locatePending;
          setLocateConfirm(false);
          setLocatePending(null);
          setTargetsOpen(false);
          setTargetsDirty(false);
          if (intent) void runLocate(intent);
        }}
        onCancel={() => {
          setLocateConfirm(false);
          setLocatePending(null);
        }}
      />
    </div>
  );
}

/** 空间占用与过期清理面板（自动清理默认关闭；设置走统一 settings 通道）。 */
function CleanupPanel({
  stats,
  preview,
  busy,
  onPreview,
  onRun,
  onClose,
}: {
  stats: ReturnType<typeof useShelfStore.getState>["stats"];
  preview: CleanupPreview | null;
  busy: boolean;
  onPreview: () => void;
  onRun: () => void;
  onClose: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [days, setDays] = useState<number>(30);

  useEffect(() => {
    let alive = true;
    getSettings()
      .then((s) => {
        if (!alive) return;
        setAuto(s.shelf_auto_cleanup_enabled ?? false);
        setDays(s.shelf_retention_days ?? 30);
      })
      .catch(() => alive && setAuto(false));
    return () => {
      alive = false;
    };
  }, []);

  const setAutoCleanup = async (enabled: boolean) => {
    setAuto(enabled);
    try {
      await updateSettings({ shelf_auto_cleanup_enabled: enabled });
    } catch (e) {
      setAuto(!enabled);
      showToast(`保存自动清理设置失败：${errorMessage(e)}`, { kind: "error" });
    }
  };

  const setRetention = async (d: number) => {
    const prev = days;
    setDays(d);
    try {
      await updateSettings({ shelf_retention_days: d });
    } catch (e) {
      setDays(prev);
      showToast(`保存保留天数失败：${errorMessage(e)}`, { kind: "error" });
    }
  };

  return (
    <div className="shelf-cleanup-panel" role="dialog" aria-label="空间占用与清理设置">
      <div className="shelf-cleanup-head">
        <HardDrive size={14} aria-hidden="true" /> 空间与清理
        <button type="button" className="icon-btn sm" aria-label="关闭清理设置" onClick={onClose}>
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      {stats && (
        <ul className="shelf-cleanup-stats">
          <li>
            条目 {stats.total}（文件 {stats.file_count} · 图片 {stats.image_count} · 文件夹{" "}
            {stats.folder_count} · 链接 {stats.link_count} · 文本 {stats.text_count}）
          </li>
          <li>
            托管占用 {formatBytes(stats.managed_bytes)}（配额 {stats.quota_mb} MB）
          </li>
          <li>磁盘实际占用 {formatBytes(stats.disk_bytes)}</li>
        </ul>
      )}
      <label className="shelf-cleanup-row">
        <input
          type="checkbox"
          checked={auto ?? false}
          onChange={(e) => void setAutoCleanup(e.target.checked)}
        />
        启用自动过期清理（默认关闭；启用后每 1 小时检查一次）
      </label>
      <label className="shelf-cleanup-row">
        过期天数
        <input
          type="number"
          min={1}
          max={3650}
          className="input-embedded shelf-days-input"
          aria-label="过期天数"
          value={days}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 1 && v <= 3650) void setRetention(v);
          }}
        />
        （收藏、置顶、场景引用条目不自动清理）
      </label>
      <p className="shelf-cleanup-hint">
        「立即清理过期」会先预览并二次确认；只删除 Task Dock 托管的副本与暂存记录，不会删除你的原始文件。
      </p>
      <div className="shelf-cleanup-actions">
        <button type="button" className="btn sm" disabled={busy} onClick={onPreview}>
          预览可清理
        </button>
        <button type="button" className="btn sm danger" disabled={busy} onClick={onRun}>
          {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
          立即清理过期
        </button>
      </div>
      {preview && (
        <p className="shelf-cleanup-preview" role="status">
          可清理 {preview.candidates} 项，预计释放 {formatBytes(preview.freed_bytes)}
          {preview.skipped_protected > 0 &&
            `；${preview.skipped_protected} 项因收藏、置顶或场景引用被跳过`}
        </p>
      )}
    </div>
  );
}
