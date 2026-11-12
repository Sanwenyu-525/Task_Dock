//! 剪贴板面板（胶囊内，对照 `docs/design-refs/v07/停靠效果图/03-clipboard.png`）。
//!
//! 数据：**不再自持列表**。视图来自 `useClipboardStore.lite`（挂载时
//! loadLite() 取一次 clipboard_view(limit 20)），实时更新复用 store 里
//! 全局唯一的 clipboard-changed 监听（引用计数，不会重复注册）；
//! 缩略图走既有 `ClipboardThumb`（进程内缓存、上限 240）。
//! 敏感内容只在展开面板内出现，轨道上永远不显示正文。
//!
//! 安全约束（与完整剪贴板工作区一致）：
//! - Dock 内复制由后端标记为内部复制，**不会**再次写回历史；
//! - 复制后不刷新列表（历史顺序不因复制而跳动）；
//! - 参考图里的勾选框代表多选，但 Lite 面板没有批量接口 —— 这里**不画**
//!   不可操作的勾选框，改为「类型色块 + 单项复制 + 进入完整页面做批量操作」。
//!
//! 分段筛选（全部 / 文本 / 图片 / 文件）是对同一份真实列表的本地过滤。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Clipboard,
  Copy,
  FileText,
  Images,
  Layers,
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
import { useClipboardStore } from "../../store/useClipboardStore";
import { useUiStore } from "../../store/useUiStore";
import { ClipboardThumb } from "../clipboard/Media";
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

/** 监听状态的展示文案与状态点色调（与列表数据状态分开显示）。 */
const MONITOR_TEXT: Record<string, { text: string; tone: "none" | "ok" | "warn" | "bad" }> = {
  checking: { text: "检查中…", tone: "none" },
  ok: { text: "监听中", tone: "ok" },
  paused: { text: "已暂停", tone: "warn" },
  disabled: { text: "剪贴板模块已关闭", tone: "warn" },
  configError: { text: "配置异常，采集被拒绝", tone: "bad" },
  notRunning: { text: "监听线程未运行", tone: "warn" },
  unknown: { text: "状态未知", tone: "warn" },
};

type Filter = "all" | "text" | "image" | "file";

const FILTERS: readonly SegOption<Filter>[] = [
  { value: "all", label: "全部" },
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "file", label: "文件" },
];

const TEXT_KINDS = new Set(["text", "html", "link", "code"]);

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
  const lite = useClipboardStore((s) => s.lite);
  const liteStatus = useClipboardStore((s) => s.liteStatus);
  const monitor = useClipboardStore((s) => s.monitor);
  const loadLite = useClipboardStore((s) => s.loadLite);
  const loadMonitor = useClipboardStore((s) => s.loadMonitor);
  const releaseLite = useClipboardStore((s) => s.releaseLite);
  const setLiteLive = useClipboardStore((s) => s.setLiteLive);
  const showToast = useUiStore((s) => s.showToast);
  const requestPaste = useUiStore((s) => s.requestClipboardPaste);
  const items = lite?.items ?? null;
  // 所有有图分组都列出来（不再截断前两组），列表由固定高度内容区滚动承载；
  // 每个分组最多展示 3 张真实封面（后端列表接口已填充 cover_items）。
  const groups = useMemo(
    () => (lite?.groups ?? []).filter((g) => g.image_count > 0),
    [lite],
  );
  const [filter, setFilter] = useState<Filter>("all");
  /** 旧数据/旧后端没有 cover_items 时，按需补读第 1 张作为降级封面 */
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  /** 二级视图栈：图片 / 文本 / 文件 / 截图组；分组里再点图会压入原图预览。 */
  const [views, setViews] = useState<ClipboardLiteView[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const prevViewCount = useRef(0);

  // 面板打开 → 取一次轻量视图 + 监听状态，并接入全局唯一的 clipboard-changed
  // 监听（store 内部引用计数：完整页面与胶囊面板共用同一个监听，不会重复注册）。
  useEffect(() => {
    void loadLite();
    void loadMonitor();
    setLiteLive(true);
    return () => {
      setLiteLive(false);
      releaseLite();
    };
  }, [loadLite, loadMonitor, releaseLite, setLiteLive]);

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
    const t = window.setTimeout(() => setCopied(null), 1200);
    return () => window.clearTimeout(t);
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

  /** 复制失败按原因提示：条目不存在（列表需刷新）/ 剪贴板被占用 / 写入失败。 */
  const reportCopyFailure = (e: unknown, what: string) => {
    const err = normalizeError(e);
    if (err.code === "NOT_FOUND") {
      showToast(`${what}已不存在，正在刷新列表`, { kind: "error", code: err.code });
      void loadLite();
      return;
    }
    if (/占用/.test(err.message)) {
      showToast("剪贴板被其他程序占用，请稍后重试", { kind: "error", code: err.code });
      return;
    }
    showToast(`复制${what}失败：${err.message}`, { kind: "error", code: err.code });
  };

  /**
   * 剪贴板写入成功但统计/降级项未完成时给出「部分成功」提示。
   * 写入本身已成功，因此绝不能回退成「复制失败」。
   */
  const copyPartialText = (r: CopyReport): string | null => {
    const partial = r.warnings.length > 0 || r.stats_recorded === false;
    if (!partial) return null;
    const detail = [
      ...(r.stats_recorded === false ? ["使用次数未记录"] : []),
      ...r.warnings,
    ].join("；");
    return detail ? `已复制（部分成功：${detail}）` : "已复制（部分成功）";
  };

  const copyItem = async (id: string) => {
    try {
      const r = await clipboardCopyItem(id);
      setCopied(id); // 写入成功才显示勾选反馈；统计失败不影响勾选
      const partial = copyPartialText(r);
      if (partial) showToast(partial, { kind: "info" });
    } catch (e) {
      reportCopyFailure(e, "条目");
    }
  };

  const copyGroup = async (id: string) => {
    try {
      const r = await clipboardCopyGroupRich(id);
      setCopied(id);
      const partial = copyPartialText(r);
      if (partial) showToast(partial, { kind: "info" });
    } catch (e) {
      reportCopyFailure(e, "截图组");
    }
  };

  /** 二级视图里的复制：不复用列表勾选态，改为一次性 toast 反馈。 */
  const copyDetailItem = async (id: string, what: string) => {
    try {
      const r = await clipboardCopyItem(id);
      const partial = copyPartialText(r);
      showToast(partial ?? `已复制${what}`, { kind: partial ? "info" : "success" });
      return true;
    } catch (e) {
      reportCopyFailure(e, "条目");
      return false;
    }
  };

  const copyDetailGroup = async (id: string) => {
    try {
      const r = await clipboardCopyGroupRich(id);
      const partial = copyPartialText(r);
      showToast(partial ?? "已复制截图组", { kind: partial ? "info" : "success" });
      return true;
    } catch (e) {
      reportCopyFailure(e, "截图组");
      return false;
    }
  };

  const openFull = () => openFullApp("clipboard");

  /**
   * 工具面板的逐项粘贴入口：把一次性意图绑定到本次导航事务，
   * 只有切页成功（含用户确认放弃未保存草稿）后才写入 Store。
   * 取消/保存中拦截时不留下请求，之后进入剪贴板页也不会突然弹层。
   */
  const openPaste = (group: ClipboardGroup) => {
    openFullApp("clipboard", () => {
      requestPaste(group.id, group.name || "截图组");
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

  const list = useMemo(() => {
    if (!items) return null;
    return items
      .filter((i) => {
        if (filter === "text") return TEXT_KINDS.has(i.kind) && !i.has_image;
        if (filter === "image") return i.has_image;
        if (filter === "file") return i.file_paths.length > 0;
        return TEXT_KINDS.has(i.kind) || i.has_image || i.file_paths.length > 0;
      })
      .slice(0, 8);
  }, [items, filter]);

  const showGroups = groups.length > 0 && (filter === "all" || filter === "image");
  // 副标题口径 = 实际渲染的行数（列表最多 8 条 + 当前可见的截图组），
  // 不报载入快照总数：否则「最近 20 条」与屏幕上的 8 行对不上。
  const shownRows = (list?.length ?? 0) + (showGroups ? groups.length : 0);
  // 数据错误与监听状态分开：error 时有旧数据 → 旧列表 + 错误条；无数据 → 错误空态
  const dataError = liteStatus === "error";
  const loadingData = liteStatus === "loading" && lite === null;
  // 成功且整表确无记录（items 与 groups 都空）才是真空态；否则按筛选显示局部空态
  const trulyEmpty = liteStatus === "empty";
  const empty = !dataError && list !== null && list.length === 0 && !showGroups;
  const monitorInfo = MONITOR_TEXT[monitor] ?? MONITOR_TEXT.unknown;

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
                onOpenFull={openFull}
                onCopyItem={copyDetailItem}
              />
            ) : view.kind === "text" ? (
              <ClipboardLiteTextView
                item={view.item}
                onBack={closeTop}
                onOpenFull={openFull}
                onCopyItem={copyDetailItem}
              />
            ) : view.kind === "files" ? (
              <ClipboardLiteFilesView
                item={view.item}
                onBack={closeTop}
                onOpenFull={openFull}
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
                onOpenFull={openFull}
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

  return (
    <>
      <PanelHead
        title="剪贴板"
        sub={
          loadingData
            ? "读取中"
            : dataError && items === null
              ? "读取失败"
              : `最近 ${shownRows} 条${
                  showGroups && groups.length > 0 ? ` · 含 ${groups.length} 个截图组` : ""
                }`
        }
        actions={
          <button
            type="button"
            className="cap-iconbtn"
            aria-label="打开剪贴板页"
            data-tip-placement="bottom"
            onClick={() => openFullApp("clipboard")}
          >
            <ArrowUpRight size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        }
      />

      {/* 监听运行状态（clipboardStatus 派生，独立于列表错误；unknown 可重查） */}
      <div className="cap-summary" role="status">
        <span
          className={`cap-state-dot${monitorInfo.tone === "none" ? "" : ` tone-${monitorInfo.tone}`}`}
          aria-hidden="true"
        />
        <span>监听状态：{monitorInfo.text}</span>
        {monitor === "unknown" && (
          <button type="button" className="cap-link" aria-label="重新检查监听状态" onClick={() => void loadMonitor()}>
            重查
          </button>
        )}
      </div>

      <Segmented label="剪贴板类型筛选" options={FILTERS} value={filter} onChange={setFilter} />

      <div className="cap-list" ref={listRef} tabIndex={-1}>
        {/* 错误优先于空态：有旧数据 → 旧列表 + 可重试错误条；无数据 → 错误空态 */}
        {dataError && items !== null && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">刷新失败，显示的是上次结果</span>
            <button type="button" className="cap-mini" aria-label="重试读取剪贴板记录" onClick={() => void loadLite()}>
              重试
            </button>
          </div>
        )}

        {dataError && items === null && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="剪贴板记录读取失败"
            actionLabel="重试"
            onAction={() => void loadLite()}
          />
        )}

        {empty && trulyEmpty && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="剪贴板暂无记录"
            actionLabel="打开剪贴板页"
            onAction={() => openFullApp("clipboard")}
          />
        )}

        {empty && !trulyEmpty && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="该筛选下没有记录"
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
                aria-label={`预览截图组「${g.name || "截图组"}」`}
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
                aria-label={`查看截图组「${g.name || "截图组"}」`}
                onClick={() => openView({ kind: "group", group: g })}
              >
                <span className="cap-item-title" title={g.name || "截图组"}>
                  {g.name || "截图组"}
                </span>
                <span className="cap-item-sub">
                  截图组 · {g.image_count} 张{g.item_count > g.image_count ? ` · 共 ${g.item_count} 项` : ""}
                </span>
              </button>
              {/* 逐项粘贴在复制左侧：与完整面板分组卡的操作顺序一致。 */}
              <button
                type="button"
                className="cap-mini is-icon"
                aria-label={`逐项粘贴截图组「${g.name || "截图组"}」`}
                data-tip="逐项粘贴（选择目标窗口）"
                onClick={() => openPaste(g)}
              >
                <Play size={13} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`cap-mini is-icon${copied === g.id ? " is-ok" : ""}`}
                aria-label={`复制截图组「${g.name || "截图组"}」`}
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

        {list?.map((it) => {
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
                aria-label={`查看「${liteTitle(it)}」`}
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
                aria-label={`复制「${liteTitle(it)}」`}
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
                aria-label="复制或粘贴到目标窗口"
                data-tip="复制或粘贴到目标窗口"
                onClick={() => openCopySwitch(it)}
              >
                <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">仅显示最近记录，复制不会写回历史</span>
        <button type="button" className="cap-link" onClick={() => openFullApp("clipboard")}>
          剪贴板页
        </button>
      </div>
    </>
  );
}
