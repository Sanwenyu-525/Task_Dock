//! 收集箱（CaptureInboxPanel，v0.7）
//!
//! 快速捕获的落地页：默认展示未处理条目，可切换全部；每条支持复制、转为任务、
//! 标记已处理、删除（沿用仓库内的就地二次确认，不使用原生 confirm）。
//! 只消费语义 Token 与既有面板基类（filter-bar / seg-group / btn / icon-btn / empty-state），
//! 样式补充见 src/styles.css 末尾 `.inbox-*`（追加式，避免动到其他任务的改动）。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  FileText,
  FolderPlus,
  Inbox,
  Lightbulb,
  Link2,
  ListPlus,
  ListTodo,
  Plus,
  RefreshCw,
  SquareCheck,
  StickyNote,
  Trash2,
} from "lucide-react";
import { useCaptureStore } from "../../store/useCaptureStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useNotesStore } from "../../store/useNotesStore";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";
import { errorMessage } from "../../lib/errors";
import { locateElement } from "../global-search/locate";
import { copyText } from "../../lib/clipboard";
import { formatRelative } from "../../lib/format";
import type { CaptureItem, CaptureKind } from "../../lib/bridge";
import { quickCaptureShow } from "../../lib/bridge";
import { EmptyState, StatusBadge } from "../ui";
import type { IconComponent } from "../ui/AgentIcon";
import WorkspaceSplit from "../../workbench/WorkspaceSplit";
import {
  WorkbenchDetailFacts,
  WorkbenchPageDetail,
  useWorkbenchDetailHost,
} from "../../workbench/pageDetail";
import "./inbox-workspace.css";
import CaptureAttachmentStrip from "./CaptureAttachmentStrip";

const KIND_LABELS: Record<CaptureKind, string> = {
  task: "任务",
  idea: "想法",
  text: "文字",
  todo: "待办",
  link: "链接",
};

const KIND_ICONS: Record<CaptureKind, IconComponent> = {
  task: ListTodo,
  idea: Lightbulb,
  text: FileText,
  todo: SquareCheck,
  link: Link2,
};

const STATUS_LABELS: Record<CaptureItem["status"], string> = {
  inbox: "未处理",
  handled: "已处理",
  converted: "已转任务",
};

const DELETE_CONFIRM_MS = 3000;

/** 列表项的可访问名：类型 + 内容摘要，保证读屏能区分同类条目 */
function itemLabel(item: CaptureItem): string {
  const summary = item.content.replace(/\s+/g, " ").trim().slice(0, 24);
  const images = item.attachments.length > 0 ? `，${item.attachments.length} 张图片` : "";
  return `${KIND_LABELS[item.kind]}：${summary}${item.content.length > 24 ? "…" : ""}${images}`;
}

export default function CaptureInboxPanel() {
  const items = useCaptureStore((s) => s.items);
  const filter = useCaptureStore((s) => s.filter);
  const loading = useCaptureStore((s) => s.loading);
  const error = useCaptureStore((s) => s.error);
  const setFilter = useCaptureStore((s) => s.setFilter);
  const load = useCaptureStore((s) => s.load);
  const markHandled = useCaptureStore((s) => s.markHandled);
  const convertToTask = useCaptureStore((s) => s.convertToTask);
  const remove = useCaptureStore((s) => s.remove);
  const showToast = useUiStore((s) => s.showToast);
  const setTab = useUiStore((s) => s.setTab);
  const setCollectionSub = useUiStore((s) => s.setCollectionSub);

  /**
   * 页内「+ 快速记录」：打开既有快速捕获窗口（草稿 / 类型 / 幂等提交全部复用），
   * 不在这里维护第二套输入与保存逻辑；窗口已打开时只聚焦，不会把窗口收起。
   */
  const openQuickRecord = useCallback(async () => {
    try {
      const result = await quickCaptureShow();
      // 旧后端可能返回 undefined（无结果契约）：按成功处理，不误报。
      if (result && result.visible && !result.focused) {
        showToast(
          result.focusError
            ? `快速捕获已打开，但系统未允许自动聚焦：${result.focusError}`
            : "快速捕获已打开，但系统未允许自动聚焦；请点击窗口继续",
          { kind: "info" },
        );
      } else if (result && !result.visible) {
        showToast("快速捕获窗口未能显示，请稍后重试", { kind: "error" });
      }
    } catch (e) {
      showToast(`无法打开快速捕获：${errorMessage(e)}`, { kind: "error" });
    }
  }, [showToast]);
  const addTextToShelf = useShelfStore((s) => s.addText);
  const addLinkToShelf = useShelfStore((s) => s.addLink);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<CaptureKind | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailHost = useWorkbenchDetailHost();
  const detailInRail = detailHost !== null;

  // 进入收集箱即拉取；筛选切换由 store 内部重新 load，避免两条刷新路径。
  useEffect(() => {
    void load();
  }, [load]);

  // 全局搜索定位：切到「全部」确保已处理/已转任务条目可见，数据渲染后滚动高亮。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  const [locateId, setLocateId] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "capture") return;
    const intent = pendingLocate;
    consumeLocate();
    if (filter !== "all") setFilter("all");
    setLocateId(intent.id);
    void load();
    locateElement({
      find: () => document.querySelector<HTMLElement>(`[data-capture-id="${CSS.escape(intent.id)}"]`),
    });
    // 仅响应定位意图变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLocate]);

  // 二次确认超时自动收起，避免一直停留在危险态
  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = window.setTimeout(() => setConfirmDeleteId(null), DELETE_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteId]);

  const onCopy = useCallback(
    async (item: CaptureItem) => {
      const text = item.kind === "link" && item.url ? item.url : item.content;
      const ok = await copyText(text);
      showToast(ok ? "已复制到剪贴板" : "复制失败", { kind: ok ? "success" : "error" });
    },
    [showToast],
  );

  const onConvert = useCallback(
    async (item: CaptureItem) => {
      setBusyId(item.id);
      try {
        await convertToTask(item.id);
        showToast("已转为任务", { kind: "success" });
      } catch (e) {
        showToast(`转为任务失败：${errorMessage(e)}`, { kind: "error" });
      } finally {
        setBusyId(null);
      }
    },
    [convertToTask, showToast],
  );

  const onMarkHandled = useCallback(
    async (item: CaptureItem) => {
      setBusyId(item.id);
      try {
        await markHandled(item.id);
        showToast("已标记为已处理", { kind: "success" });
      } catch (e) {
        showToast(`标记已处理失败：${errorMessage(e)}`, { kind: "error" });
      } finally {
        setBusyId(null);
      }
    },
    [markHandled, showToast],
  );

  /**
   * 添加到暂存架（v0.8 跨模块转存）：text/idea → 暂存文本，link → 暂存链接。
   * 走 useShelfStore 既有动作（引用其本地合并与统计刷新）；原收集条目**保留**，
   * 失败不改变任何状态；busyId 复用逐条在途守卫，连点不会重复创建。
   */
  const onSendToShelf = useCallback(
    async (item: CaptureItem) => {
      setBusyId(item.id);
      try {
        if (item.kind === "link" && item.url) {
          await addLinkToShelf(item.url);
        } else {
          await addTextToShelf(item.content);
        }
        showToast("已添加到文件暂存", {
          kind: "success",
          action: { label: "查看", run: () => setTab("shelf") },
        });
      } catch (e) {
        showToast(`发送到暂存架失败：${errorMessage(e)}`, { kind: "error" });
      } finally {
        setBusyId(null);
      }
    },
    [addLinkToShelf, addTextToShelf, setTab, showToast],
  );

  /**
   * 转为笔记：后端在事务内查重（source_capture_id 唯一索引）并只读原条目，
   * 重复点击幂等返回同一条笔记；失败不改变收集箱内容。
   * 不自动切换子页把用户拽离收集箱，只给可选的「查看」。
   */
  const onConvertToNote = useCallback(
    async (item: CaptureItem) => {
      setBusyId(item.id);
      try {
        const result = await useNotesStore.getState().convertCapture(item.id);
        showToast(result.duplicate ? "已存在对应笔记，已定位" : "已转为笔记", {
          kind: "success",
          action: {
            label: "查看",
            run: () => {
              setTab("inbox");
              setCollectionSub("notes");
            },
          },
        });
      } catch (e) {
        showToast(`转为笔记失败：${errorMessage(e)}`, { kind: "error" });
      } finally {
        setBusyId(null);
      }
    },
    [setCollectionSub, setTab, showToast],
  );

  const onDelete = useCallback(
    async (item: CaptureItem) => {
      setBusyId(item.id);
      setConfirmDeleteId(null);
      try {
        await remove(item.id);
        showToast("已删除捕获记录", { kind: "success" });
      } catch (e) {
        showToast(`删除捕获记录失败：${errorMessage(e)}`, { kind: "error" });
      } finally {
        setBusyId(null);
      }
    },
    [remove, showToast],
  );

  const emptyCopy = useMemo(() => {
    if (filter === "inbox") {
      return {
        title: "收集箱是空的",
        hint: "打开快速捕获窗口，随手记下想法、待办与链接；提交后会留在这里等待处理。",
      };
    }
    return {
      title: "还没有捕获记录",
      hint: "快速捕获的内容都会留在这里，处理后可转为任务或删除。",
    };
  }, [filter]);

  const showLoading = loading && items.length === 0;
  const showEmpty = !showLoading && !error && items.length === 0;

  const kindCounts = useMemo(() => {
    const counts: Record<CaptureKind | "all", number> = {
      all: items.length,
      task: 0,
      idea: 0,
      text: 0,
      todo: 0,
      link: 0,
    };
    for (const item of items) counts[item.kind] += 1;
    return counts;
  }, [items]);

  const visibleItems = useMemo(
    () => (kindFilter === "all" ? items : items.filter((item) => item.kind === kindFilter)),
    [items, kindFilter],
  );
  const selectedItem =
    visibleItems.find((item) => item.id === selectedId) ??
    (selectedId ? items.find((item) => item.id === selectedId) ?? null : null);
  const selectedBusy = selectedItem ? busyId === selectedItem.id : false;
  const selectedCanProcess = selectedItem?.status === "inbox";

  function selectKind(next: CaptureKind | "all") {
    setKindFilter(next);
    setSelectedId(null);
  }

  return (
    <div className={`inbox-panel page-fill${detailInRail ? " has-detail" : ""}`}>
      <div className="inbox-commandbar">
        <span className="inbox-count-hint">
          {visibleItems.length} 条{filter === "inbox" ? "未处理" : ""}
          {kindFilter !== "all" ? ` · ${KIND_LABELS[kindFilter]}` : ""}
        </span>
        <span className="flex-spacer" />
        <button
          type="button"
          className="btn primary sm"
          aria-label="快速记录到收集箱"
          data-tip="打开快速捕获窗口"
          onClick={() => void openQuickRecord()}
        >
          <Plus size={12} aria-hidden="true" /> 快速记录
        </button>
        <button
          type="button"
          className="btn sm"
          aria-label="刷新收集箱"
          data-tip="刷新收集箱"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={12} aria-hidden="true" /> 刷新
        </button>
      </div>

      <WorkspaceSplit
        id="capture-inbox"
        sidebarLabel="收集箱筛选"
        defaultWidth={224}
        minWidth={200}
        maxWidth={300}
        sidebar={
          <aside className="inbox-rail">
            <div className="workspace-rail-head">
              <span className="workspace-rail-eyebrow">CAPTURE</span>
              <h2>收集箱</h2>
            </div>

            <section className="inbox-rail-section" aria-label="处理状态">
              <p className="inbox-rail-label">处理状态</p>
              <div className="inbox-rail-nav">
                <button
                  type="button"
                  className={`inbox-rail-item${filter === "inbox" ? " is-active" : ""}`}
                  aria-label="未处理"
                  aria-pressed={filter === "inbox"}
                  onClick={() => {
                    setFilter("inbox");
                    setSelectedId(null);
                  }}
                >
                  <span>未处理</span>
                  <em>{items.filter((item) => item.status === "inbox").length}</em>
                </button>
                <button
                  type="button"
                  className={`inbox-rail-item${filter === "all" ? " is-active" : ""}`}
                  aria-label="全部"
                  aria-pressed={filter === "all"}
                  onClick={() => {
                    setFilter("all");
                    setSelectedId(null);
                  }}
                >
                  <span>全部</span>
                  <em>{items.length}</em>
                </button>
              </div>
            </section>

            <section className="inbox-rail-section" aria-label="内容类型">
              <p className="inbox-rail-label">内容类型</p>
              <div className="inbox-rail-nav">
                {(["all", "text", "idea", "todo", "link", "task"] as const).map((kind) => {
                  const Icon = kind === "all" ? Inbox : KIND_ICONS[kind];
                  return (
                    <button
                      key={kind}
                      type="button"
                      className={`inbox-rail-item${kindFilter === kind ? " is-active" : ""}`}
                      aria-label={kind === "all" ? "全部类型" : KIND_LABELS[kind]}
                      aria-pressed={kindFilter === kind}
                      onClick={() => selectKind(kind)}
                    >
                      <span>
                        <Icon size={12} aria-hidden="true" />
                        {kind === "all" ? "全部类型" : KIND_LABELS[kind]}
                      </span>
                      <em>{kindCounts[kind]}</em>
                    </button>
                  );
                })}
              </div>
            </section>

            <p className="inbox-rail-note">
              快速捕获只负责收集；转任务、转笔记和投递目标都在条目上执行，不自动改写原内容。
            </p>
          </aside>
        }
      >
        <div className="page-scroll inbox-body">
          {error && (
            <div className="inbox-error" role="alert">
              <span className="inbox-error-text">加载失败：{error}</span>
              <button type="button" className="btn sm" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}

          {showLoading && <div className="empty-hint">加载中…</div>}

          {showEmpty && (
            <div className="inbox-empty-wrap">
              <EmptyState
                icon={<Inbox size={22} aria-hidden="true" />}
                title={emptyCopy.title}
                hint={
                  <span className="inbox-empty-copy">
                    {emptyCopy.hint}
                    <span className="inbox-empty-shortcut">
                      <kbd>Ctrl</kbd>
                      <span aria-hidden="true">+</span>
                      <kbd>Shift</kbd>
                      <span aria-hidden="true">+</span>
                      <kbd>Space</kbd>
                    </span>
                  </span>
                }
                action={
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void openQuickRecord()}
                  >
                    <Plus size={13} aria-hidden="true" /> 快速记录
                  </button>
                }
              />
              <ul className="inbox-empty-kinds" aria-label="可收集的内容类型">
                {(["idea", "todo", "text", "link", "task"] as const).map((kind) => {
                  const Icon = KIND_ICONS[kind];
                  return (
                    <li key={kind}>
                      <Icon size={12} aria-hidden="true" />
                      {KIND_LABELS[kind]}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {!showLoading && !showEmpty && visibleItems.length === 0 && (
            <EmptyState
              icon={<Inbox size={22} aria-hidden="true" />}
              title="当前类型没有记录"
              hint="切换左侧内容类型，或使用「快速记录」新增一条。"
            />
          )}

          {visibleItems.length > 0 && (
            <ul className="inbox-list" aria-busy={loading} aria-label="捕获记录">
              {visibleItems.map((item) => {
                const KindIcon = KIND_ICONS[item.kind];
                const confirming = confirmDeleteId === item.id;
                const busy = busyId === item.id;
                const canProcess = item.status === "inbox";
                const active = selectedId === item.id;
                return (
                  <li
                    key={item.id}
                    data-capture-id={item.id}
                    className={`inbox-item surface-card${item.status === "inbox" ? "" : " is-done"}${active ? " is-selected" : ""}${locateId === item.id ? " gs-locate-flash" : ""}`}
                    aria-label={itemLabel(item)}
                  >
                    <button
                      type="button"
                      className="inbox-select"
                      aria-pressed={active}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <div className="inbox-head">
                        <span className={`inbox-kind inbox-kind-${item.kind}`}>
                          <KindIcon size={11} strokeWidth={1.9} aria-hidden="true" />
                          {KIND_LABELS[item.kind]}
                        </span>
                        {filter === "all" && (
                          <StatusBadge
                            tone={item.status === "converted" ? "info" : item.status === "handled" ? "success" : "neutral"}
                            size="md"
                          >
                            {STATUS_LABELS[item.status]}
                          </StatusBadge>
                        )}
                        <span className="flex-spacer" />
                        <span className="inbox-time" title={item.created_at}>
                          {formatRelative(item.created_at)}
                        </span>
                      </div>
                      <p className="inbox-content">{item.content}</p>
                      {item.kind === "link" && item.note && <p className="inbox-note">{item.note}</p>}
                    </button>
                    <CaptureAttachmentStrip attachments={item.attachments} />
                    <div className="inbox-actions">
                      <button
                        type="button"
                        className="icon-btn sm"
                        aria-label={`复制${KIND_LABELS[item.kind]}`}
                        data-tip="复制内容"
                        disabled={busy}
                        onClick={() => void onCopy(item)}
                      >
                        <Copy size={12} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn sm"
                        aria-label="转为任务"
                        data-tip="转为任务"
                        disabled={busy || !canProcess}
                        onClick={() => void onConvert(item)}
                      >
                        <ListPlus size={12} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn sm"
                        aria-label="转为笔记"
                        data-tip="转为笔记（保留本条）"
                        disabled={busy}
                        onClick={() => void onConvertToNote(item)}
                      >
                        <StickyNote size={12} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn sm"
                        aria-label="标记已处理"
                        data-tip="标记已处理"
                        disabled={busy || !canProcess}
                        onClick={() => void onMarkHandled(item)}
                      >
                        <Check size={12} aria-hidden="true" />
                      </button>
                      {(item.kind === "text" || item.kind === "idea" || item.kind === "link") && (
                        <button
                          type="button"
                          className="icon-btn sm"
                          aria-label={`添加到暂存架：${KIND_LABELS[item.kind]}`}
                          data-tip="添加到暂存架（保留本条）"
                          disabled={busy}
                          onClick={() => void onSendToShelf(item)}
                        >
                          <FolderPlus size={12} aria-hidden="true" />
                        </button>
                      )}
                      {confirming ? (
                        <>
                          <button
                            type="button"
                            className="btn sm danger"
                            aria-label="确认删除"
                            disabled={busy}
                            onClick={() => void onDelete(item)}
                          >
                            确认删除
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            aria-label="取消删除"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="icon-btn sm danger"
                          aria-label="删除"
                          data-tip="删除"
                          disabled={busy}
                          onClick={() => setConfirmDeleteId(item.id)}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </WorkspaceSplit>

      {selectedItem && (
        <WorkbenchPageDetail
          title="捕获详情"
          actions={
            <>
              <button
                type="button"
                className="icon-btn sm"
                aria-label={`复制${KIND_LABELS[selectedItem.kind]}`}
                data-tip="复制内容"
                disabled={selectedBusy}
                onClick={() => void onCopy(selectedItem)}
              >
                <Copy size={12} aria-hidden="true" />
              </button>
            </>
          }
        >
          <WorkbenchDetailFacts
            rows={[
              { label: "类型", value: KIND_LABELS[selectedItem.kind] },
              { label: "状态", value: STATUS_LABELS[selectedItem.status] },
              { label: "创建时间", value: formatRelative(selectedItem.created_at) },
              selectedItem.url ? { label: "链接", value: selectedItem.url } : null,
            ]}
          />
          <p className="inbox-detail-content">{selectedItem.content}</p>
          {selectedItem.note && <p className="inbox-detail-note">{selectedItem.note}</p>}
          <CaptureAttachmentStrip attachments={selectedItem.attachments} variant="detail" />
          <div className="inbox-detail-actions">
            <button
              type="button"
              className="btn sm primary"
              aria-label="转为任务（详情栏）"
              disabled={selectedBusy || !selectedCanProcess}
              onClick={() => void onConvert(selectedItem)}
            >
              <ListPlus size={12} aria-hidden="true" /> 转为任务
            </button>
            <button
              type="button"
              className="btn sm"
              aria-label="转为笔记（详情栏）"
              disabled={selectedBusy}
              onClick={() => void onConvertToNote(selectedItem)}
            >
              <StickyNote size={12} aria-hidden="true" /> 转为笔记
            </button>
            <button
              type="button"
              className="btn sm"
              aria-label="标记已处理（详情栏）"
              disabled={selectedBusy || !selectedCanProcess}
              onClick={() => void onMarkHandled(selectedItem)}
            >
              <Check size={12} aria-hidden="true" /> 标记已处理
            </button>
          </div>
          <p className="inbox-detail-hint">
            行内操作保持可用；右栏用于在长列表中确认内容与状态。
          </p>
        </WorkbenchPageDetail>
      )}
    </div>
  );
}
