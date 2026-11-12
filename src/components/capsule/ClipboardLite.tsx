//! 剪贴板面板（胶囊内，对照 `docs/design-refs/v07/停靠效果图/03-clipboard.png`）。
//!
//! 数据：**不再自持列表**。视图来自 `useClipboardStore.lite`（挂载时按当前
//! 分段/搜索读取一次真实查询，每类上限 30；切换分段复用 store 内的每类缓存），
//! 实时更新复用 store 里全局唯一的 clipboard-changed 监听（引用计数，不会重复
//! 注册，事件按当前筛选刷新）；缩略图走既有 `ClipboardThumb`（进程内缓存、上限 240）。
//! 敏感内容只在展开面板内出现，轨道上永远不显示正文。
//!
//! 安全约束（与完整剪贴板工作区一致）：
//! - Dock 内复制由后端标记为内部复制，**不会**再次写回历史；
//! - 复制后不刷新列表（历史顺序不因复制而跳动）；
//! - 参考图里的勾选框代表多选，但 Lite 面板没有批量接口 —— 这里**不画**
//!   不可操作的勾选框，改为「类型色块 + 单项复制 + 进入完整页面做批量操作」。
//!
//! 分段筛选（全部/文字/链接/富文本/图片/文件）与完整页 KIND_CHIPS 同一套
//! 后端 kind 原值，**由后端查询表达**（不再「先取 20 条再本地过滤」）；
//! 搜索走后端 search 参数，250ms 防抖。
//!
//! 暂停/恢复监听：走 `useLifecycleStore.setPaused("clipboard")`（写既有
//! clipboard_paused 设置键，与完整页/设置页同一意图源），写库后回读
//! clipboard_status 呈现真实状态；监听关闭/配置异常 ≠ 已暂停，由监听状态行
//! 六态区分。截图组（groups）只在全部/图片分段展示。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Clipboard,
  Copy,
  FileText,
  Images,
  Layers,
  Loader2,
  Pause,
  Play,
} from "lucide-react";
import {
  clipboardCopyGroupRich,
  clipboardCopyItem,
  type ClipboardGroup,
  type ClipboardItem,
  type CopyReport,
} from "../../lib/bridge";
import { normalizeError } from "../../lib/errors";
import { useClipboardStore, CLIPBOARD_LITE_LIMIT, type ClipboardLiteKind } from "../../store/useClipboardStore";
import { useLifecycleStore } from "../../store/useLifecycleStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useLocale, type UseLocaleResult } from "../../hooks/useLocale";
import { ClipboardThumb } from "../clipboard/Media";
import { SearchField } from "../ui";
import { openFullApp } from "./actions";
import ClipboardTargetView from "./ClipboardTargetView";
import {
  ClipboardLiteFilesView,
  ClipboardLiteGroupView,
  ClipboardLiteImageView,
  ClipboardLiteTextView,
  clearGroupPageCache,
  liteMeta,
  liteTitle,
  loadGroupPage,
  type ClipboardLiteView,
} from "./ClipboardLiteViews";
import { EmptyState, PanelHead, Segmented, type SegOption } from "./PanelKit";

/** 监听状态的展示文案键与状态点色调（与列表数据状态分开显示；六态口径与完整页一致）。 */
const MONITOR_TEXT: Record<string, { key: "monitor.checking" | "monitor.ok" | "monitor.paused" | "monitor.disabled" | "monitor.configError" | "monitor.notRunning" | "monitor.unknown"; tone: "none" | "ok" | "warn" | "bad" }> = {
  checking: { key: "monitor.checking", tone: "none" },
  ok: { key: "monitor.ok", tone: "ok" },
  paused: { key: "monitor.paused", tone: "warn" },
  disabled: { key: "monitor.disabled", tone: "warn" },
  configError: { key: "monitor.configError", tone: "bad" },
  notRunning: { key: "monitor.notRunning", tone: "warn" },
  unknown: { key: "monitor.unknown", tone: "warn" },
};

type Filter = ClipboardLiteKind;

/** 分段标签取自 i18n：与完整页 KIND_CHIPS 同一套语义（全部/文字/链接/富文本/图片/文件）。 */
function filterOptions(t: UseLocaleResult["t"]): readonly SegOption<Filter>[] {
  return [
    { value: "all", label: t("capsule.clipboard.filter.all") },
    { value: "text", label: t("capsule.clipboard.filter.text") },
    { value: "url", label: t("capsule.clipboard.filter.url") },
    { value: "html", label: t("capsule.clipboard.filter.html") },
    { value: "image", label: t("capsule.clipboard.filter.image") },
    { value: "files", label: t("capsule.clipboard.filter.files") },
  ];
}

/** 搜索防抖：输入停顿 250ms 才发起查询（后端 search 参数）。 */
const SEARCH_DEBOUNCE_MS = 250;

/** 行 → 二级视图：图片优先（原图预览），其次文件列表，最后文本查看。 */
function viewOfItem(item: ClipboardItem): ClipboardLiteView {
  if (item.has_image) return { kind: "image", item };
  if (item.file_paths.length > 0) return { kind: "files", item };
  return { kind: "text", item };
}

function toneOf(item: ClipboardItem): { cls: string; icon: typeof FileText } {
  if (item.has_image) return { cls: "tone-image", icon: Images };
  if (item.file_paths.length > 0) return { cls: "tone-files", icon: FileText };
  return { cls: "tone-text", icon: FileText };
}

export default function ClipboardLite() {
  const { t } = useLocale();
  const lite = useClipboardStore((s) => s.lite);
  const liteStatus = useClipboardStore((s) => s.liteStatus);
  const liteFilter = useClipboardStore((s) => s.liteFilter);
  const liteTotal = useClipboardStore((s) => s.liteTotal);
  const monitor = useClipboardStore((s) => s.monitor);
  const loadLite = useClipboardStore((s) => s.loadLite);
  const loadMonitor = useClipboardStore((s) => s.loadMonitor);
  const releaseLite = useClipboardStore((s) => s.releaseLite);
  const setLiteLive = useClipboardStore((s) => s.setLiteLive);
  const showToast = useUiStore((s) => s.showToast);
  const requestPaste = useUiStore((s) => s.requestClipboardPaste);
  // 暂停/恢复：意图从既有设置派生（与完整页同口径），运行状态由 store 的六态呈现
  const clipboardPaused = useSettingsStore((s) => s.settings?.clipboard_paused ?? false);
  const clipboardEnabled = useSettingsStore((s) => s.settings?.clipboard_enabled ?? true);
  const pausePending = useLifecycleStore((s) => s.pending.clipboard ?? false);

  const [filter, setFilter] = useState<Filter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const items = lite?.items ?? null;
  // 所有有图分组都列出来，列表由固定高度内容区滚动承载；
  // 每个分组最多展示 3 张真实封面（后端列表接口已填充 cover_items）。
  // 分段查询仍会返回分组（后端分组不按 kind 过滤）：只在全部/图片分段展示。
  const groups = useMemo(
    () => (lite?.groups ?? []).filter((g) => g.image_count > 0),
    [lite],
  );
  /** 旧数据/旧后端没有 cover_items 时，按需补读第 1 张作为降级封面 */
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  /** 二级视图栈：图片 / 文本 / 文件 / 截图组；分组里再点图会压入原图预览。 */
  const [views, setViews] = useState<ClipboardLiteView[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const prevViewCount = useRef(0);

  // 搜索 250ms 防抖：输入停顿后才更新生效的搜索词（查询键包含它）。
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // 面板打开 → 按当前分段取一次轻量视图 + 监听状态，并接入全局唯一的
  // clipboard-changed 监听（store 内部引用计数：完整页面与胶囊面板共用同一个
  // 监听，不会重复注册）。卸载释放视图与每类缓存。
  useEffect(() => {
    setLiteLive(true);
    void loadMonitor();
    return () => {
      setLiteLive(false);
      releaseLite();
    };
  }, [loadMonitor, releaseLite, setLiteLive]);

  // 分段/搜索变化 → 按该范围查询（同键最近结果在面板会话内缓存，不重发 IPC）。
  useEffect(() => {
    void loadLite({ kind: filter, search });
  }, [loadLite, filter, search]);

  // 列表快照变化 = 组内容可能变化（新增/删除/移动/分组修改）→ 封面与预览缓存整体失效。
  useEffect(() => {
    clearGroupPageCache();
  }, [lite]);

  // 封面：优先用列表接口已带的 cover_items（最多 3 张，无需额外 IPC）；
  // 旧数据缺失时才按需补读每个分组第 1 张（limit 1 / imagesOnly）作为降级。
  // 同一快照内复用缓存，不重复请求；失败静默，不影响文案与复制。
  useEffect(() => {
    const missing = groups.filter((g) => (g.cover_items?.length ?? 0) === 0);
    if (missing.length === 0) return;
    let alive = true;
    void (async () => {
      for (const g of missing) {
        try {
          const page = await loadGroupPage(g, 1, 0, true);
          if (!alive) return;
          const cover = page.items[0];
          // 组内图片被删空时同时移除旧封面 id，避免继续请求已不存在的缩略图。
          setCovers((prev) => {
            if (cover) {
              return prev[g.id] === cover.id ? prev : { ...prev, [g.id]: cover.id };
            }
            if (!(g.id in prev)) return prev;
            const next = { ...prev };
            delete next[g.id];
            return next;
          });
        } catch {
          // 缩略图失败不影响文案与复制
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [groups]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // 退出二级视图后恢复列表滚动位置（列表在详情期间不渲染，滚动值由 ref 记住）。
  useLayoutEffect(() => {
    if (prevViewCount.current > 0 && views.length === 0) {
      const el = listRef.current;
      if (el) {
        el.scrollTop = listScroll.current;
        el.focus({ preventScroll: true });
      }
    }
    prevViewCount.current = views.length;
  }, [views.length]);

  /** 当前分段+搜索的查询（重试/刷新共用；无参 = 重复最近一次目标查询并跳过缓存）。 */
  const refreshCurrent = useCallback(
    () => loadLite({ kind: filter, search }, { force: true }),
    [loadLite, filter, search],
  );

  /** 复制失败按原因提示：条目不存在（列表需刷新）/ 剪贴板被占用 / 写入失败。 */
  const reportCopyFailure = (e: unknown, what: string) => {
    const err = normalizeError(e);
    if (err.code === "NOT_FOUND") {
      showToast(t("capsule.clipboard.notFoundRefresh", { what }), { kind: "error", code: err.code });
      void loadLite(undefined, { force: true });
      return;
    }
    if (/占用/.test(err.message)) {
      showToast(t("capsule.clipboard.clipboardBusy"), { kind: "error", code: err.code });
      return;
    }
    showToast(t("capsule.clipboard.copyFailed", { what, message: err.message }), {
      kind: "error",
      code: err.code,
    });
  };

  /**
   * 剪贴板写入成功但统计/降级项未完成时给出「部分成功」提示。
   * 写入本身已成功，因此绝不能回退成「复制失败」。
   */
  const copyPartialText = (r: CopyReport): string | null => {
    const partial = r.warnings.length > 0 || r.stats_recorded === false;
    if (!partial) return null;
    const detail = [
      ...(r.stats_recorded === false ? [t("capsule.clipboard.statsMiss")] : []),
      ...r.warnings,
    ].join("；");
    return detail
      ? t("capsule.clipboard.copyPartialDetail", { detail })
      : t("capsule.clipboard.copyPartial");
  };

  const copyItem = async (id: string) => {
    try {
      const r = await clipboardCopyItem(id);
      setCopied(id); // 写入成功才显示勾选反馈；统计失败不影响勾选
      const partial = copyPartialText(r);
      if (partial) showToast(partial, { kind: "info" });
    } catch (e) {
      reportCopyFailure(e, t("capsule.clipboard.whatItem"));
    }
  };

  const copyGroup = async (id: string) => {
    try {
      const r = await clipboardCopyGroupRich(id);
      setCopied(id);
      const partial = copyPartialText(r);
      if (partial) showToast(partial, { kind: "info" });
    } catch (e) {
      reportCopyFailure(e, t("capsule.clipboard.whatGroup"));
    }
  };

  /** 二级视图里的复制：不复用列表勾选态，改为一次性 toast 反馈。 */
  const copyDetailItem = async (id: string, what: string) => {
    try {
      const r = await clipboardCopyItem(id);
      const partial = copyPartialText(r);
      showToast(partial ?? t("capsule.clipboard.copiedWhat", { what }), {
        kind: partial ? "info" : "success",
      });
      return true;
    } catch (e) {
      reportCopyFailure(e, t("capsule.clipboard.whatItem"));
      return false;
    }
  };

  const copyDetailGroup = async (id: string) => {
    try {
      const r = await clipboardCopyGroupRich(id);
      const partial = copyPartialText(r);
      showToast(partial ?? t("capsule.clipboard.copiedWhat", { what: t("capsule.clipboard.whatGroup") }), {
        kind: partial ? "info" : "success",
      });
      return true;
    } catch (e) {
      reportCopyFailure(e, t("capsule.clipboard.whatGroup"));
      return false;
    }
  };

  /**
   * 工具面板的逐项粘贴入口：把一次性意图绑定到本次导航事务，
   * 只有切页成功（含用户确认放弃未保存草稿）后才写入 Store。
   * 取消/保存中拦截时不留下请求，之后进入剪贴板页也不会突然弹层。
   */
  const openPaste = (group: ClipboardGroup) => {
    openFullApp("clipboard", () => {
      requestPaste(group.id, group.name || t("capsule.clipboard.groupName"));
    });
  };

  /** 打开二级视图：记住列表滚动位置，返回时恢复。 */
  const openView = (view: ClipboardLiteView) => {
    listScroll.current = listRef.current?.scrollTop ?? 0;
    setViews([view]);
  };
  const pushView = (view: ClipboardLiteView) => setViews((s) => [...s, view]);
  const closeTop = () => setViews((s) => s.slice(0, -1));

  /**
   * 从列表行打开「复制并切换到…」：入口只在列表里，因此与 openView 一样先记住
   * 列表滚动位置；返回列表时由上面的 useLayoutEffect 恢复（不改变行高与面板几何）。
   */
  const openCopySwitch = (it: ClipboardItem) => {
    listScroll.current = listRef.current?.scrollTop ?? 0;
    pushView({ kind: "copy-switch", item: it });
  };

  /** 暂停/恢复监听：写既有设置键（同一意图源），写库成功后回读真实状态呈现。 */
  const togglePause = async () => {
    if (pausePending) return;
    const next = !clipboardPaused;
    const result = await useLifecycleStore.getState().setPaused("clipboard", next);
    if (result === "failed") {
      const reason = useLifecycleStore.getState().errors.clipboard;
      showToast(t("capsule.clipboard.pauseFailed", { reason: reason ?? t("common.unknown") }), {
        kind: "error",
      });
      return;
    }
    // 写库成功 ≠ 监听线程已收尾/重建：回读 clipboard_status 刷新六态；
    // 回读失败时 monitor 为 unknown，状态行提供「重查」，不伪装成功。
    await loadMonitor();
    if (result === "unconfirmed") {
      showToast(t("capsule.clipboard.pauseUnconfirmed"), { kind: "warning" });
    }
  };

  // 数据范围一致性：当前分段+搜索与已取回数据的筛选键一致才展示列表，
  // 不拿其他分段/旧搜索的结果冒充当前筛选（同任务面板 liteScope 口径）。
  const dataReady = liteFilter === `${filter}|${search.trim()}`;
  const list = dataReady && items !== null ? items : [];
  const showGroups =
    dataReady && groups.length > 0 && (filter === "all" || filter === "image");
  // 副标题口径 = 实际渲染的行数（当前分段真实查询结果 + 当前可见的截图组），
  // 不报载入快照总数；后端 total 更大时补充「共 N 条」的范围说明。
  const shownRows = list.length + (showGroups ? groups.length : 0);
  const totalKnown = dataReady && liteTotal !== null && liteTotal > shownRows;
  // 数据错误与监听状态分开：error 时有旧数据 → 旧列表 + 错误条；无数据 → 错误空态
  const dataError = liteStatus === "error";
  const loadingData = liteStatus === "loading" && lite === null;
  // 成功且整表确无记录（items 与 groups 都空）才是真空态；否则按筛选显示局部空态
  const trulyEmpty = liteStatus === "empty";
  const empty = !dataError && dataReady && list.length === 0 && !showGroups;
  const monitorInfo = MONITOR_TEXT[monitor] ?? MONITOR_TEXT.unknown;
  const pauseUnavailable = !clipboardEnabled || monitor === "configError";
  const filters = useMemo(() => filterOptions(t), [t]);
  const headSub = loadingData
    ? t("common.loading")
    : dataError && items === null
      ? t("capsule.clipboard.loadFailed")
      : !dataReady
        ? t("common.loading")
        : [
            t("capsule.clipboard.subRows", { rows: shownRows }),
            ...(totalKnown ? [t("capsule.clipboard.subTotal", { total: liteTotal ?? 0 })] : []),
            ...(showGroups ? [t("capsule.clipboard.subGroups", { groups: groups.length })] : []),
          ].join(" · ");

  // 二级视图：只替换面板内容（不新开窗口、不改面板尺寸），下层视图保持挂载，
  // 因此截图组 → 原图 → 返回组时无需重新请求；每层各自接入 overlayStack。
  if (views.length > 0) {
    return (
      <>
        {views.map((view, index) => (
          <div
            className="cap-clip-view"
            key={view.kind === "group" ? `group:${view.group.id}` : `${view.kind}:${view.item.id}:${index}`}
            hidden={index !== views.length - 1}
          >
            {view.kind === "image" ? (
              <ClipboardLiteImageView
                item={view.item}
                sequence={view.sequence}
                liveGroup={
                  view.sequence
                    ? lite?.groups.find((g) => g.id === view.sequence!.group.id)
                    : undefined
                }
                active={index === views.length - 1}
                onBack={closeTop}
                onOpenFull={() => openFullApp("clipboard")}
                onCopyItem={copyDetailItem}
              />
            ) : view.kind === "text" ? (
              <ClipboardLiteTextView
                item={view.item}
                onBack={closeTop}
                onOpenFull={() => openFullApp("clipboard")}
                onCopyItem={copyDetailItem}
              />
            ) : view.kind === "files" ? (
              <ClipboardLiteFilesView
                item={view.item}
                onBack={closeTop}
                onOpenFull={() => openFullApp("clipboard")}
                onCopyItem={copyDetailItem}
              />
            ) : view.kind === "copy-switch" ? (
              <ClipboardTargetView
                item={view.item}
                active={index === views.length - 1}
                onBack={closeTop}
              />
            ) : (
              <ClipboardLiteGroupView
                group={lite?.groups.find((g) => g.id === view.group.id) ?? view.group}
                onBack={closeTop}
                onOpenFull={() => openFullApp("clipboard")}
                onCopyGroup={copyDetailGroup}
                onPasteGroup={openPaste}
                onOpenImage={(_item, _index, sequence) =>
                  pushView({ kind: "image", item: _item, sequence })
                }
              />
            )}
          </div>
        ))}
      </>
    );
  }

  const groupName = (g: ClipboardGroup) => g.name || t("capsule.clipboard.groupName");

  return (
    <>
      <PanelHead
        title={t("capsule.clipboard.title")}
        sub={headSub}
        actions={
          <button
            type="button"
            className="cap-iconbtn"
            aria-label={
              clipboardPaused ? t("capsule.clipboard.resumeAria") : t("capsule.clipboard.pauseAria")
            }
            aria-pressed={clipboardPaused}
            data-tip={
              pauseUnavailable
                ? t("capsule.clipboard.pauseUnavailableTip")
                : clipboardPaused
                  ? t("capsule.clipboard.resumeAria")
                  : t("capsule.clipboard.pauseAria")
            }
            data-tip-placement="bottom"
            aria-disabled={pausePending || pauseUnavailable}
            disabled={pauseUnavailable}
            onClick={() => void togglePause()}
          >
            {pausePending ? (
              <Loader2 size={15} strokeWidth={2} className="spin" aria-hidden="true" />
            ) : clipboardPaused ? (
              <Play size={15} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Pause size={15} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
        }
      />

      {/* 监听运行状态（clipboardStatus 派生，独立于列表错误；unknown 可重查。
          模块关闭/配置异常 ≠ 已暂停：六态各自成文，不合并。） */}
      <div className="cap-summary" role="status">
        <span
          className={`cap-state-dot${monitorInfo.tone === "none" ? "" : ` tone-${monitorInfo.tone}`}`}
          aria-hidden="true"
        />
        <span>{t("capsule.clipboard.monitorLine", { state: t(`capsule.clipboard.${monitorInfo.key}`) })}</span>
        {monitor === "unknown" && (
          <button
            type="button"
            className="cap-link"
            aria-label={t("capsule.clipboard.monitorRecheckAria")}
            onClick={() => void loadMonitor()}
          >
            {t("capsule.clipboard.monitorRecheck")}
          </button>
        )}
      </div>

      <Segmented
        label={t("capsule.clipboard.filterAria")}
        options={filters}
        value={filter}
        onChange={setFilter}
      />

      <SearchField
        value={searchInput}
        onChange={setSearchInput}
        placeholder={t("capsule.clipboard.searchPlaceholder")}
        ariaLabel={t("capsule.clipboard.searchAria")}
        clearLabel={t("capsule.clipboard.searchClear")}
        size="compact"
        className="cap-search ui-search--capsule"
      />

      <div className="cap-list" ref={listRef} tabIndex={-1}>
        {/* 错误优先于空态：有旧数据 → 旧列表 + 可重试错误条；无数据 → 错误空态 */}
        {dataError && items !== null && dataReady && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">{t("capsule.panel.staleText")}</span>
            <button
              type="button"
              className="cap-mini"
              aria-label={t("capsule.clipboard.retryRowAria")}
              onClick={() => void refreshCurrent()}
            >
              {t("common.retry")}
            </button>
          </div>
        )}

        {dataError && (items === null || !dataReady) && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={t("capsule.clipboard.emptyError")}
            actionLabel={t("common.retry")}
            onAction={() => void refreshCurrent()}
          />
        )}

        {!dataError && !dataReady && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={t("common.loading")}
          />
        )}

        {empty && trulyEmpty && !search.trim() && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={t("capsule.clipboard.emptyAll")}
            actionLabel={t("capsule.clipboard.openFull")}
            onAction={() => openFullApp("clipboard")}
          />
        )}

        {empty && trulyEmpty && Boolean(search.trim()) && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={t("capsule.clipboard.emptySearch")}
          />
        )}

        {empty && !trulyEmpty && !search.trim() && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={t("capsule.clipboard.emptyFiltered")}
          />
        )}

        {showGroups &&
          groups.map((g) => {
            const coverItems = (g.cover_items ?? []).slice(0, 3);
            const legacyCover = coverItems.length === 0 ? covers[g.id] : undefined;
            return (
            <div className="cap-item cap-clip-row" key={g.id}>
              <button
                type="button"
                className="cap-clip-hit"
                aria-label={t("capsule.clipboard.groupPreviewAria", { name: groupName(g) })}
                onClick={() => openView({ kind: "group", group: g })}
              >
                <span
                  className={`cap-stack${coverItems.length > 0 ? " is-multi" : ""}`}
                  aria-hidden="true"
                >
                  {coverItems.length > 0 ? (
                    coverItems.map((cover) => (
                      <i key={cover.id}>
                        <ClipboardThumb
                          itemId={cover.id}
                          hasThumb={cover.has_thumb}
                          size={26}
                        />
                      </i>
                    ))
                  ) : (
                    <>
                      <i>
                        <Layers size={13} strokeWidth={1.8} />
                      </i>
                      <i />
                      <i>
                        {legacyCover ? (
                          <ClipboardThumb itemId={legacyCover} hasThumb size={46} />
                        ) : null}
                      </i>
                    </>
                  )}
                </span>
              </button>
              <button
                type="button"
                className="cap-main cap-clip-main"
                aria-label={t("capsule.clipboard.groupOpenAria", { name: groupName(g) })}
                onClick={() => openView({ kind: "group", group: g })}
              >
                <span className="cap-item-title" title={groupName(g)}>
                  {groupName(g)}
                </span>
                <span className="cap-item-sub">
                  {g.item_count > g.image_count
                    ? t("capsule.clipboard.groupMetaTotal", {
                        images: g.image_count,
                        count: g.item_count,
                      })
                    : t("capsule.clipboard.groupMeta", { images: g.image_count })}
                </span>
              </button>
              {/* 逐项粘贴在复制左侧：与完整面板分组卡的操作顺序一致。 */}
              <button
                type="button"
                className="cap-mini is-icon"
                aria-label={t("capsule.clipboard.pasteGroupAria", { name: groupName(g) })}
                data-tip={t("capsule.clipboard.pasteGroupTip")}
                onClick={() => openPaste(g)}
              >
                <Play size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`cap-mini is-icon${copied === g.id ? " is-ok" : ""}`}
                aria-label={t("capsule.clipboard.copyGroupAria", { name: groupName(g) })}
                onClick={() => void copyGroup(g.id)}
              >
                {copied === g.id ? (
                  <Check size={13} strokeWidth={2.6} aria-hidden="true" />
                ) : (
                  <Copy size={13} strokeWidth={2} aria-hidden="true" />
                )}
              </button>
            </div>
            );
          })}

        {dataReady &&
          list.map((it) => {
          const tone = toneOf(it);
          const Icon = tone.icon;
          return (
            <div className="cap-item cap-clip-row" key={it.id}>
              {it.has_image && it.has_thumb ? (
                <span className="cap-clip-thumb">
                  <ClipboardThumb
                    itemId={it.id}
                    hasThumb
                    size={46}
                    onOpen={() => openView({ kind: "image", item: it })}
                  />
                </span>
              ) : (
                <span className={`cap-tile ${tone.cls}`} aria-hidden="true">
                  <Icon size={17} strokeWidth={1.8} />
                </span>
              )}
              <button
                type="button"
                className="cap-main cap-clip-main"
                aria-label={t("capsule.clipboard.viewItemAria", { title: liteTitle(it) })}
                onClick={() => openView(viewOfItem(it))}
              >
                <span className="cap-item-title clip-2" title={liteTitle(it)}>
                  {liteTitle(it)}
                </span>
                <span className="cap-item-sub">{liteMeta(it)}</span>
              </button>
              <button
                type="button"
                className={`cap-mini is-icon${copied === it.id ? " is-ok" : ""}`}
                aria-label={t("capsule.clipboard.copyItemAria", { title: liteTitle(it) })}
                onClick={() => void copyItem(it.id)}
              >
                {copied === it.id ? (
                  <Check size={13} strokeWidth={2.6} aria-hidden="true" />
                ) : (
                  <Copy size={13} strokeWidth={2} aria-hidden="true" />
                )}
              </button>
              {/* 分体入口：复制按钮行为不变，右侧箭头直接打开「复制或粘贴到…」。
                  箭头表示「跳转到其他窗口」，不是折叠/展开；行高由既有行样式决定。 */}
              <button
                type="button"
                className="cap-mini is-icon"
                aria-label={t("capsule.clipboard.copySwitchAria")}
                data-tip={t("capsule.clipboard.copySwitchAria")}
                onClick={() => openCopySwitch(it)}
              >
                <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">
          {t("capsule.clipboard.footNote", { limit: CLIPBOARD_LITE_LIMIT })}
        </span>
        <button type="button" className="cap-link" onClick={() => openFullApp("clipboard")}>
          {t("capsule.clipboard.openFullShort")}
        </button>
      </div>
    </>
  );
}
