//! 收集箱面板（胶囊内）。取代原先轨道上的 Agent 重复入口：
//! Agent 已由顶部状态球直达，轨道第四类改为收集箱（任务 → 收集箱 → 剪贴板 → 应用）。
//!
//! 两个子页（v35）：
//! - **快速收集**：未处理记录，复用 `useCaptureStore` 的轻量切片
//!   （quickCaptureList("inbox", 8, 0) + quickCaptureState()），与完整收集箱页
//!   （`CaptureInboxPanel`）同一个 store、同一份后端命令；不建第二套快速捕获后端。
//! - **文件**：上方把资源管理器里的文件/文件夹直接落到用户配置的真实目录
//!   （`InboxDropPane`），下方是最近暂存（`InboxRecentShelf`）；与完整面板
//!   共享同一份目标配置与暂存数据，投递本身不写库、不进暂存架。
//!
//! 上次使用的子页记在 localStorage（纯 UI 偏好，不进设置表）：胶囊是高频入口，
//! 每次展开都要重新选子页会明显打断「拖文件就走」的节奏。
//!
//! 实时刷新**不自建监听**：全应用只有 App.tsx 挂了一条 quick-capture-created，
//! 它调用 `useCaptureStore.load()`；面板开着时 load() 顺带刷新 lite 切片
//! （见 store 内注释），不产生第二条订阅，也没有轮询。
//!
//! 真实性约束：
//! - 只列未处理记录，内容预览截断换行，不在轨道/面板外泄露正文；
//! - 读取失败显示错误态 + 重试，绝不伪装成「没有未处理记录」；
//! - 进入完整收集箱复用 `openFullApp("inbox")`（既有 Tab，不发明新导航）。

import { useEffect, useRef, useState } from "react";
import {
  AlignLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  FolderPlus,
  Inbox,
  Lightbulb,
  Link2,
  ListPlus,
  ListTodo,
  Loader2,
  MoreVertical,
  Plus,
  SquareCheckBig,
  StickyNote,
  Trash2,
} from "lucide-react";
import type { CaptureItem, CaptureKind } from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import { useQuickRecord } from "../../hooks/useQuickRecord";
import { useCaptureStore } from "../../store/useCaptureStore";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";
import { useNotesStore } from "../../store/useNotesStore";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";
import { DropdownMenu } from "../ui";
import { openFullApp } from "./actions";
import InboxDropPane from "./InboxDropPane";
import { EmptyState, PanelHead, Segmented, type SegOption } from "./PanelKit";

/** 上次使用的子页：纯前端偏好，损坏/不可读写时回落到快速收集。 */
const SUB_STORAGE_KEY = "taskdock.capsule.inbox.sub.v1";

type InboxSub = "capture" | "drop";

function readSub(): InboxSub {
  try {
    return window.localStorage.getItem(SUB_STORAGE_KEY) === "drop" ? "drop" : "capture";
  } catch {
    return "capture";
  }
}

function writeSub(sub: InboxSub): void {
  try {
    window.localStorage.setItem(SUB_STORAGE_KEY, sub);
  } catch {
    // 隐私模式/配额满：只影响「记住上次子页」，不影响功能本身
  }
}

/** 捕获类型 → 图标（lucide 既有图标，与完整页视觉一致）。 */
const KIND_ICONS: Record<CaptureKind, typeof ListTodo> = {
  task: ListTodo,
  idea: Lightbulb,
  text: AlignLeft,
  todo: SquareCheckBig,
  link: Link2,
};

function previewOf(item: CaptureItem, emptyLabel: string): string {
  const raw = (item.content || "").replace(/\s+/g, " ").trim();
  if (raw) return raw;
  if (item.url) return item.url;
  return emptyLabel;
}

/** 动作按钮的可访问名称要短：正文可能很长，不能整段塞进 aria-label。 */
function shortLabel(item: CaptureItem, emptyLabel: string): string {
  return previewOf(item, emptyLabel).slice(0, 24);
}

export default function InboxLite() {
  const { t } = useLocale();
  const lite = useCaptureStore((s) => s.lite);
  const liteLoading = useCaptureStore((s) => s.liteLoading);
  const liteError = useCaptureStore((s) => s.liteError);
  const inboxCount = useCaptureStore((s) => s.inboxCount);
  const loadInboxLite = useCaptureStore((s) => s.loadInboxLite);
  const releaseLite = useCaptureStore((s) => s.releaseLite);
  const markHandled = useCaptureStore((s) => s.markHandled);
  const convertToTask = useCaptureStore((s) => s.convertToTask);
  const remove = useCaptureStore((s) => s.remove);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CaptureItem | null>(null);
  const [sub, setSub] = useState<InboxSub>(readSub);
  const targetCount = useDropTargetsStore((s) => s.targets.filter((t) => t.show_in_capsule).length);
  // 回调触发后从 Set 删除：连续处理多条记录时不会把已结束的计时器 ID 累积下来。
  const timers = useRef(new Set<number>());

  // 面板打开 → 取一次未处理切片 + 真实计数；关闭 → 释放并作废在途响应。
  useEffect(() => {
    void loadInboxLite();
    return () => releaseLite();
  }, [loadInboxLite, releaseLite]);

  // 所有提示/隐藏延时都可回收，避免对已卸载组件 setState。
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => window.clearTimeout(t));
      pending.clear();
    };
  }, []);

  const flash = (msg: string) => {
    setNotice(msg);
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      setNotice((n) => (n === msg ? null : n));
    }, 2400);
    timers.current.add(t);
  };

  const { openQuickRecord, opening } = useQuickRecord(flash);

  // 删除确认 3s 自动收起，避免一直停留在危险态。
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(null), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const loading = liteLoading && lite === null;
  const hasError = liteError !== null;
  // 面板口径以切片为准：lite 为 null（未加载）时不拿全局计数冒充面板状态
  const items = (lite ?? []).filter((it) => !handled.has(it.id));

  const retry = () => {
    void loadInboxLite();
  };

  /**
   * 快捷处理走既有 store 命令；成功后立即从列表移除并刷新切片/计数，
   * 失败则保留记录、给出提示，并以真实列表为准重新拉取。
   */
  const runAction = async (
    item: CaptureItem,
    kind: "convert" | "handled" | "delete",
  ) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      if (kind === "convert") {
        await convertToTask(item.id);
      } else if (kind === "handled") {
        await markHandled(item.id);
      } else {
        await remove(item.id);
        setConfirmDelete(null);
      }
      setHandled((prev) => new Set(prev).add(item.id));
      setExpandedId((cur) => (cur === item.id ? null : cur));
      flash(
        kind === "convert"
          ? t("capsule.inbox.converted")
          : kind === "handled"
            ? t("capsule.inbox.handled")
            : t("capsule.inbox.deleted"),
      );
      await loadInboxLite();
    } catch {
      flash(
        kind === "convert"
          ? t("capsule.inbox.convertFailed")
          : kind === "handled"
            ? t("capsule.inbox.handleFailed")
            : t("capsule.inbox.deleteFailed"),
      );
      void loadInboxLite();
    } finally {
      setBusyId(null);
    }
  };

  /** 更多菜单：复制 / 转笔记 / 发送到暂存架。均不强行把用户拽离当前面板。 */
  const runMenuAction = async (
    item: CaptureItem,
    kind: "copy" | "note" | "shelf",
  ) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      if (kind === "copy") {
        const text = item.kind === "link" && item.url ? item.url : item.content;
        const ok = await copyText(text);
        flash(ok ? t("capsule.inbox.copied") : t("capsule.inbox.copyFailed"));
      } else if (kind === "note") {
        await useNotesStore.getState().convertCapture(item.id);
        flash(t("capsule.inbox.convertedToNote"));
      } else {
        const shelf = useShelfStore.getState();
        if (item.kind === "link" && item.url) {
          await shelf.addLink(item.url);
        } else {
          await shelf.addText(item.content);
        }
        flash(t("capsule.inbox.sentToShelf"));
      }
    } catch (e) {
      flash(t("capsule.inbox.actionFailed", { error: errorMessage(e) }));
    } finally {
      setBusyId(null);
    }
  };

  const subOptions: readonly SegOption<InboxSub>[] = [
    { value: "capture", label: t("capsule.inbox.sub.capture") },
    { value: "drop", label: t("capsule.inbox.sub.drop") },
  ];
  const emptyContent = t("capsule.inbox.emptyContent");

  return (
    <>
      <PanelHead
        title={t("capsule.inbox.title")}
        sub={
          sub === "drop"
            ? targetCount > 0
              ? t("capsule.inbox.dropSubTargets", { count: targetCount })
              : t("capsule.inbox.dropSub")
            : loading
              ? t("capsule.inbox.loading")
              : hasError
                ? t("capsule.inbox.loadFailed")
                : t("capsule.inbox.subCounts", {
                    pending: inboxCount,
                    recent: items.length,
                  })
        }
        actions={
          <>
            {sub === "capture" && (
              <button
                type="button"
                className="cap-iconbtn"
                aria-label={t("capsule.inbox.quickRecord")}
                data-tip={t("capsule.inbox.quickRecord")}
                data-tip-placement="bottom"
                disabled={opening}
                onClick={() => void openQuickRecord()}
              >
                {opening ? (
                  <Loader2 size={14} className="spin" aria-hidden="true" />
                ) : (
                  <Plus size={15} strokeWidth={2.2} aria-hidden="true" />
                )}
              </button>
            )}
            <button
              type="button"
              className="cap-iconbtn"
              aria-label={
                sub === "drop"
                  ? t("capsule.inbox.openFullShelf")
                  : t("capsule.inbox.openFullInbox")
              }
              data-tip-placement="bottom"
              onClick={() => openFullApp(sub === "drop" ? "shelf" : "inbox")}
            >
              <ArrowUpRight size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </>
        }
      />

      <Segmented
        label={t("capsule.inbox.subAria")}
        options={subOptions}
        value={sub}
        onChange={(next) => {
          setSub(next);
          writeSub(next);
        }}
      />

      {sub === "drop" ? (
        <InboxDropPane />
      ) : (
        <>
          <div className="cap-list">
            {/* 错误优先于空态：有旧数据时叠加错误提示条（可重试），没有则错误空态 */}
            {hasError && items.length > 0 && (
              <div className="cap-item cap-error-row" role="alert">
                <span className="cap-error-text">{t("capsule.inbox.staleText")}</span>
                <button
                  type="button"
                  className="cap-mini"
                  aria-label={t("capsule.inbox.retryAria")}
                  onClick={retry}
                >
                  {t("common.retry")}
                </button>
              </div>
            )}

            {hasError && items.length === 0 && (
              <EmptyState
                icon={<Inbox size={22} strokeWidth={1.6} aria-hidden="true" />}
                text={t("capsule.inbox.emptyError")}
                actionLabel={t("common.retry")}
                onAction={retry}
              />
            )}

            {!hasError && !loading && items.length === 0 && (
              <EmptyState
                icon={<Inbox size={22} strokeWidth={1.6} aria-hidden="true" />}
                text={t("capsule.inbox.empty")}
                actionLabel={t("capsule.inbox.openFullInbox")}
                onAction={() => openFullApp("inbox")}
              />
            )}

            {items.map((it) => {
              const Icon = KIND_ICONS[it.kind] ?? AlignLeft;
              const open = expandedId === it.id;
              const busy = busyId === it.id;
              const label = shortLabel(it, emptyContent);
              const full = (it.content || "").trim() || it.url || emptyContent;
              return (
                <div className="cap-inbox-group" key={it.id}>
                  <div className="cap-item cap-clip-row" aria-busy={busy}>
                    <span className="cap-tile" aria-hidden="true">
                      <Icon size={17} strokeWidth={1.8} />
                    </span>
                    <button
                      type="button"
                      className="cap-main cap-row-open"
                      aria-label={
                        open
                          ? t("capsule.inbox.rowAriaCollapse", { label })
                          : t("capsule.inbox.rowAriaOpen", { label })
                      }
                      aria-expanded={open}
                      aria-controls={`capture-detail-${it.id}`}
                      onClick={() => setExpandedId(open ? null : it.id)}
                    >
                      <span className="cap-item-title clip-2">{previewOf(it, emptyContent)}</span>
                      <span className="cap-item-sub">
                        {it.note ? `${it.note} · ` : ""}
                        {it.kind === "link" && it.url
                          ? t("capsule.inbox.kindLink")
                          : t("capsule.inbox.kindCapture")}
                      </span>
                    </button>
                    <span className="cap-inbox-actions">
                      <button
                        type="button"
                        className="cap-mini is-icon"
                        aria-label={t("capsule.inbox.convertAria", { label })}
                        data-tip={t("capsule.inbox.convertTip")}
                        disabled={busy}
                        onClick={() => void runAction(it, "convert")}
                      >
                        <ListPlus size={12} strokeWidth={2.2} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="cap-mini is-icon"
                        aria-label={t("capsule.inbox.handleAria", { label })}
                        data-tip={t("capsule.inbox.handleTip")}
                        disabled={busy}
                        onClick={() => void runAction(it, "handled")}
                      >
                        <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                      </button>
                      <DropdownMenu
                        menuLabel={t("capsule.inbox.moreAria", { label })}
                        placement="bottom-end"
                        menuMinWidth={132}
                        trigger={(props) => (
                          <button
                            {...props}
                            type="button"
                            className="cap-mini is-icon"
                            aria-label={t("capsule.inbox.moreAria", { label })}
                            data-tip={t("capsule.inbox.moreTip")}
                            disabled={busy}
                          >
                            <MoreVertical
                              size={12}
                              strokeWidth={2.2}
                              aria-hidden="true"
                            />
                          </button>
                        )}
                        items={[
                          {
                            key: "copy",
                            label: t("capsule.inbox.copyContent"),
                            icon: <Copy size={12} aria-hidden="true" />,
                            onSelect: () => void runMenuAction(it, "copy"),
                          },
                          {
                            key: "note",
                            label: t("capsule.inbox.convertNote"),
                            icon: <StickyNote size={12} aria-hidden="true" />,
                            onSelect: () => void runMenuAction(it, "note"),
                          },
                          ...(it.kind === "text" ||
                          it.kind === "idea" ||
                          it.kind === "link"
                            ? [
                                {
                                  key: "shelf",
                                  label: t("capsule.inbox.sendShelf"),
                                  icon: (
                                    <FolderPlus size={12} aria-hidden="true" />
                                  ),
                                  onSelect: () =>
                                    void runMenuAction(it, "shelf"),
                                },
                              ]
                            : []),
                          {
                            key: "delete",
                            label: t("capsule.inbox.delete"),
                            icon: <Trash2 size={12} aria-hidden="true" />,
                            danger: true,
                            onSelect: () => setConfirmDelete(it),
                          },
                        ]}
                      />
                    </span>
                  </div>
                  {open && (
                    <div className="cap-capture-detail" id={`capture-detail-${it.id}`}>
                      <p className="cap-detail-desc">{full}</p>
                      {it.url && it.kind === "link" ? (
                        <div className="cap-detail-row">
                          <span className="cap-detail-label">{t("capsule.inbox.linkLabel")}</span>
                          <span className="cap-detail-value">{it.url}</span>
                        </div>
                      ) : null}
                      {it.note ? (
                        <div className="cap-detail-row">
                          <span className="cap-detail-label">{t("capsule.inbox.noteLabel")}</span>
                          <span className="cap-detail-value">{it.note}</span>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {confirmDelete && (
            <div
              className="cap-confirm"
              role="alertdialog"
              aria-label={t("capsule.inbox.deleteConfirmAria")}
            >
              <p className="cap-confirm-text">
                {t("capsule.inbox.deleteConfirmTitle", {
                  label: shortLabel(confirmDelete, emptyContent),
                })}
                <span>{t("capsule.inbox.deleteConfirmDetail")}</span>
              </p>
              <div className="cap-confirm-actions">
                <button
                  type="button"
                  className="cap-mini"
                  disabled={busyId === confirmDelete.id}
                  onClick={() => setConfirmDelete(null)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="cap-mini cap-confirm-danger"
                  disabled={busyId === confirmDelete.id}
                  onClick={() => void runAction(confirmDelete, "delete")}
                >
                  {t("capsule.inbox.delete")}
                </button>
              </div>
            </div>
          )}

          <div className="cap-foot">
            <span className="cap-foot-note">
              {notice ?? t("capsule.inbox.footNote")}
            </span>
            <div className="cap-actions">
              {/* 快速笔记复用完整面板的第三个子页（NotesPanel），胶囊不新建编辑器；
                  子页切换绑定在导航事务的 after 上：被草稿拦截/保存中拒绝时不提前改状态。 */}
              <button
                type="button"
                className="cap-link"
                onClick={() =>
                  openFullApp("inbox", () => useUiStore.getState().setCollectionSub("notes"))
                }
              >
                {t("capsule.inbox.quickNotes")}
                <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
              </button>
              <button type="button" className="cap-link" onClick={() => openFullApp("inbox")}>
                {t("capsule.inbox.toFullInbox")}
                <ArrowUpRight size={12} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
