//! 收集箱「文件」子页的最近暂存：把文件暂存架里最近几条搬进胶囊。
//!
//! 复用 `useShelfStore` 的轻量切片（`loadRecent` 只取 4 条）与既有后端命令，
//! 不建第二套最近文件缓存、不做目录扫描；隐藏/卸载后没有订阅或轮询。
//!
//! 定位条目复用全局搜索的 `pendingLocate` 通道：完整暂存架挂载后消费意图、
//! 清空筛选并打开详情，不另造一套「指定条目」参数。

import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Loader2, MoreVertical, Plus, Trash2 } from "lucide-react";
import {
  clipboardCopyText,
  shelfCopyFiles,
  shelfCopyPaths,
  shelfGetItem,
  shelfOpenItem,
  shelfReadText,
  shelfRevealItem,
  type ShelfDragOutResult,
  type ShelfItem,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { shelfFileTypeUi } from "../../lib/fileTypeUi";
import { useLocale } from "../../hooks/useLocale";
import { useShelfDragOut } from "../../hooks/useShelfDragOut";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useShelfStore } from "../../store/useShelfStore";
import { shelfDeleteFeedback } from "../shelf/shelfDeleteFeedback";
import { openFullApp } from "./actions";
import { DropdownMenu } from "../ui";
import "../shelf/shelf-ui.css";

function storageLabel(item: ShelfItem): string {
  if (item.kind === "link") return "链接";
  if (item.kind === "text") return "文本";
  return item.storage_mode === "managed" ? "托管副本" : "引用原文件";
}

function isPhysical(item: ShelfItem): boolean {
  return item.kind === "file" || item.kind === "image" || item.kind === "folder";
}

/**
 * 最近暂存接收区的稳定标记。
 * 只有接入了 `lib/fileDrop` 仲裁器的容器（胶囊「文件」子页）才暴露它；
 * 命中由仲裁者用 `dropTargetAt(point, "data-drop-zone")` 完成。
 */
export const SHELF_RECENT_DROP_ZONE = "shelf-recent";

interface InboxRecentShelfProps {
  onNotice: (msg: string) => void;
  /** 拖拽会话进行中：显示「可暂存」轻提示（绝对定位，不挤占列表空间）。 */
  dropActive?: boolean;
  /** 当前落点就在本接收区：强调高亮。 */
  dropOver?: boolean;
  /** 是否暴露原生文件拖放标记；未接仲裁器时不暴露，避免命中一个没人处理的目标。 */
  dropZone?: boolean;
}

export default function InboxRecentShelf({
  onNotice,
  dropActive = false,
  dropOver = false,
  dropZone = false,
}: InboxRecentShelfProps) {
  const { t } = useLocale();
  const recent = useShelfStore((s) => s.recent);
  const recentLoading = useShelfStore((s) => s.recentLoading);
  const recentLoaded = useShelfStore((s) => s.recentLoaded);
  const recentError = useShelfStore((s) => s.recentError);
  const mutationSyncError = useShelfStore((s) => s.mutationSyncError);
  const loadRecent = useShelfStore((s) => s.loadRecent);
  const retryShelfSync = useShelfStore((s) => s.retryShelfSync);
  const addPaths = useShelfStore((s) => s.addPaths);
  const updateItem = useShelfStore((s) => s.updateItem);
  const deleteItems = useShelfStore((s) => s.deleteItems);
  const requestShelfLocate = useGlobalSearchStore((s) => s.requestShelfLocate);
  const [adding, setAdding] = useState(false);
  const [favoriteBusyId, setFavoriteBusyId] = useState<string | null>(null);
  /** 待确认删除的条目：确认面板直接替换该行内容，保证点击处可见。 */
  const [confirmDelete, setConfirmDelete] = useState<ShelfItem | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const dragItemRef = useRef<ShelfItem | null>(null);
  /** 确认展开后把焦点移到「取消」：键盘用户不会因为原按钮卸载而丢失焦点。 */
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  useEffect(() => {
    if (confirmDelete) confirmCancelRef.current?.focus();
  }, [confirmDelete]);

  const drag = useShelfDragOut({
    enabled: true,
    resolveIds: () => {
      const item = dragItemRef.current;
      if (!item || !isPhysical(item) || item.exists_state === "missing") {
        return [];
      }
      return [item.id];
    },
    onSettled: (result: ShelfDragOutResult) => {
      if (result.effect !== "move") return;
      void loadRecent({ force: true });
      onNotice("文件已移动；最近暂存已刷新，原路径可能已失效");
    },
    onError: onNotice,
  });

  const openItem = useCallback(
    (item: ShelfItem) => {
      // 文本没有系统级打开目标：直接去完整暂存架看详情。
      if (item.kind === "text") {
        openFullApp("shelf", () => requestShelfLocate(item.id, item.kind));
        return;
      }
      if (item.kind !== "link" && item.exists_state === "missing") {
        onNotice("文件不存在，无法打开");
        return;
      }
      void shelfOpenItem(item.id).catch((e) => onNotice(`打开失败：${errorMessage(e)}`));
    },
    [onNotice, requestShelfLocate],
  );

  const locate = useCallback(
    (item: ShelfItem) => {
      openFullApp("shelf", () => requestShelfLocate(item.id, item.kind));
    },
    [requestShelfLocate],
  );

  const copyFile = useCallback(
    (item: ShelfItem) => {
      if (item.exists_state === "missing") {
        onNotice("文件不存在，无法复制");
        return;
      }
      void shelfCopyFiles([item.id])
        .then(() => onNotice("文件已复制，可在资源管理器粘贴"))
        .catch((e) => onNotice(`复制文件失败：${errorMessage(e)}`));
    },
    [onNotice],
  );

  const copyPath = useCallback(
    (item: ShelfItem) => {
      if (item.kind !== "link" && item.kind !== "text" && item.exists_state === "missing") {
        onNotice("文件不存在，无法复制路径");
        return;
      }
      void shelfCopyPaths([item.id])
        .then(() => onNotice("路径已复制"))
        .catch((e) => onNotice(`复制路径失败：${errorMessage(e)}`));
    },
    [onNotice],
  );

  const copyLink = useCallback(
    (item: ShelfItem) => {
      void (async () => {
        let url = "";
        try {
          // 列表载荷不含正文：只在用户点击复制时读一条权威行。
          const full = await shelfGetItem(item.id);
          url = (full.content ?? "").trim();
        } catch (e) {
          onNotice(`链接内容读取失败：${errorMessage(e)}`);
          return;
        }
        if (!url) {
          onNotice("链接内容读取失败：链接为空");
          return;
        }
        try {
          await clipboardCopyText(url);
          onNotice("链接已复制");
        } catch (e) {
          onNotice(`剪贴板写入失败：${errorMessage(e)}`);
        }
      })();
    },
    [onNotice],
  );

  const copyText = useCallback(
    (item: ShelfItem) => {
      void (async () => {
        let content = "";
        let truncated = false;
        try {
          const payload = await shelfReadText(item.id);
          content = payload.content;
          truncated = payload.truncated;
        } catch (e) {
          onNotice(`内容读取失败：${errorMessage(e)}`);
          return;
        }
        if (truncated) {
          // 宁可明确拒绝，也不把截断正文当完整内容复制给用户。
          onNotice("内容过大，未能完整复制");
          return;
        }
        if (!content) {
          onNotice("内容为空，没有可复制的内容");
          return;
        }
        try {
          await clipboardCopyText(content);
          onNotice("内容已复制");
        } catch (e) {
          onNotice(`剪贴板写入失败：${errorMessage(e)}`);
        }
      })();
    },
    [onNotice],
  );

  const toggleFavorite = useCallback(
    (item: ShelfItem) => {
      if (favoriteBusyId) return;
      setFavoriteBusyId(item.id);
      void updateItem(item.id, { favorite: !item.favorite })
        .then(() => onNotice(item.favorite ? "已取消收藏" : "已收藏"))
        .catch((e) => onNotice(`更新收藏失败：${errorMessage(e)}`))
        .finally(() => setFavoriteBusyId(null));
    },
    [favoriteBusyId, onNotice, updateItem],
  );

  /**
   * 删除单条暂存记录。
   *
   * 收藏/置顶/被场景引用的条目在完整暂存架里默认受保护；胶囊里同样先确认，
   * 确认后才传 `includeProtected=true`。删除只影响暂存记录：托管副本会被删，
   * 引用模式的原文件不动（与完整面板口径一致）。
   */
  const removeItem = useCallback(
    async (item: ShelfItem) => {
      if (deleteBusyId) return;
      setDeleteBusyId(item.id);
      try {
        const includeProtected =
          item.favorite || item.pinned || item.scene_id != null;
        const result = await deleteItems([item.id], includeProtected);
        onNotice(shelfDeleteFeedback(result, "delete").message);
        setConfirmDelete(null);
      } catch (e) {
        onNotice(`删除暂存项失败：${errorMessage(e)}`);
      } finally {
        setDeleteBusyId(null);
      }
    },
    [deleteBusyId, deleteItems, onNotice],
  );

  const revealItem = useCallback(
    (item: ShelfItem) => {
      void shelfRevealItem(item.id)
        .then(() => onNotice("已在文件夹中显示"))
        .catch((e) => onNotice(`打开所在文件夹失败：${errorMessage(e)}`));
    },
    [onNotice],
  );

  const addFiles = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const picked = await openDialog({
        multiple: true,
        directory: false,
        title: "选择要暂存的文件",
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      const r = await addPaths(paths, "reference", "picker");
      // 与拖入路径（InboxDropPane.addToShelf）同一套文案与分支：部分失败合并为
      // 一条汇总（两条 onNotice 会互相覆盖），0/0 不静默、不冒充成功。
      const failed = r.failed.length;
      const reason = r.failed[0]?.reason ?? "";
      if (r.added > 0 && failed > 0) {
        onNotice(t("capsule.inboxDrop.shelfPartial", { added: r.added, failed, reason }));
      } else if (r.added > 0) {
        onNotice(t("capsule.inboxDrop.shelfAdded", { added: r.added }));
      } else if (failed > 0) {
        onNotice(t("capsule.inboxDrop.shelfFailed", { failed, reason }));
      } else {
        onNotice(t("capsule.inboxDrop.shelfNothingToAdd"));
      }
      // addPaths 只刷新完整列表；这里让最近切片立刻反映新增条目。
      await loadRecent({ force: true });
    } catch (e) {
      onNotice(`暂存文件失败：${errorMessage(e)}`);
    } finally {
      setAdding(false);
    }
  };

  const showEmpty = recentLoaded && recent.length === 0 && !recentError && !mutationSyncError;
  const retryRecent = () =>
    void (mutationSyncError ? retryShelfSync() : loadRecent({ force: true }));

  return (
    <section
      className={[
        "cap-shelf-recent",
        dropZone && dropActive ? "is-drop-active" : "",
        dropZone && dropOver ? "is-drop-over" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="最近暂存"
      data-drop-zone={dropZone ? SHELF_RECENT_DROP_ZONE : undefined}
    >
      <div className="cap-shelf-recent-head">
        <span className="cap-shelf-recent-title">最近暂存</span>
        {recent.length > 0 && <span className="cap-shelf-recent-count">{recent.length}</span>}
        <span className="cap-shelf-recent-gap" />
        <button
          type="button"
          className="cap-mini is-icon"
          aria-label="添加文件到暂存架"
          data-tip="添加文件到暂存架"
          disabled={adding}
          onClick={() => void addFiles()}
        >
          {adding ? (
            <Loader2 size={11} className="spin" aria-hidden="true" />
          ) : (
            <Plus size={12} strokeWidth={2.4} aria-hidden="true" />
          )}
        </button>
        <button type="button" className="cap-link" onClick={() => openFullApp("shelf")}>
          查看全部
        </button>
      </div>

      {(recentError || mutationSyncError) && recent.length === 0 ? (
        <p className="cap-shelf-recent-hint is-error" role="alert">
          暂存架状态刷新失败
          <button type="button" className="cap-mini" onClick={retryRecent}>
            重试同步
          </button>
        </p>
      ) : recentLoading && recent.length === 0 ? (
        <p className="cap-shelf-recent-hint" role="status">
          正在读取最近暂存…
        </p>
      ) : showEmpty ? (
        <p className="cap-shelf-recent-hint">
          暂存架还是空的；用「+」添加文件，默认只保存引用、不复制原文件。
        </p>
      ) : (
        <>
        {(recentError || mutationSyncError) && (
          <p className="cap-shelf-recent-hint is-error" role="alert">
            暂存架状态刷新失败，当前列表可能未同步。
            <button type="button" className="cap-mini" onClick={retryRecent}>
              重试同步
            </button>
          </p>
        )}
        <ul className="cap-shelf-recent-list">
          {recent.map((item) => {
            const type = shelfFileTypeUi(item);
            const Icon = type.icon;
            const missing = item.exists_state === "missing";
            const draggable = isPhysical(item) && !missing;
            const confirming = confirmDelete?.id === item.id;
            const deleteBusy = deleteBusyId === item.id;
            // link/text 的存储方式与类型同名：只写一次类型，不显示「文本 · 文本」。
            const showStorage = item.kind !== "link" && item.kind !== "text";
            const protectedItem = item.favorite || item.pinned || item.scene_id != null;
            return (
              <li
                key={item.id}
                className={`cap-shelf-recent-item${missing ? " is-missing" : ""}${draggable && !confirming ? " is-draggable" : ""}${confirming ? " is-confirming" : ""}`}
                onPointerDown={(event) => {
                  // 确认删除期间该行只响应确认按钮，不发起拖出。
                  if (confirming) return;
                  dragItemRef.current = item;
                  drag.onPointerDown(event);
                }}
              >
                {confirming ? (
                  <div
                    className="cap-shelf-recent-confirm"
                    role="group"
                    aria-label={`删除「${item.display_name}」`}
                  >
                    <span className="cap-shelf-recent-confirm-text">
                      删除「{item.display_name}」？
                      {protectedItem
                        ? "已收藏/置顶/被场景引用，确认后一并删除。"
                        : "只删暂存记录，引用的原文件不受影响。"}
                    </span>
                    <span className="cap-shelf-recent-confirm-actions">
                      <button
                        ref={confirmCancelRef}
                        type="button"
                        className="cap-mini"
                        disabled={deleteBusy}
                        onClick={() => setConfirmDelete(null)}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="cap-mini cap-confirm-danger"
                        disabled={deleteBusy}
                        onClick={() => void removeItem(item)}
                      >
                        {deleteBusy ? (
                          <Loader2 size={11} className="spin" aria-hidden="true" />
                        ) : null}
                        删除
                      </button>
                    </span>
                  </div>
                ) : (
                  <>
                  <button
                    type="button"
                    className="cap-shelf-recent-main"
                    aria-label={`${item.kind === "text" ? "查看" : "打开"}「${item.display_name}」`}
                    data-tip={
                      draggable
                        ? `${item.original_path ?? item.display_name} · 按住可拖出`
                        : (item.original_path ?? item.display_name)
                    }
                    onClick={() => {
                      if (drag.shouldSuppressClick()) return;
                      openItem(item);
                    }}
                  >
                    <span
                      className={`cap-shelf-recent-icon file-tone-${type.tone}`}
                      aria-hidden="true"
                    >
                      <Icon size={13} strokeWidth={1.9} />
                    </span>
                    <span className="cap-shelf-recent-text">
                      <span className="cap-shelf-recent-name">{item.display_name}</span>
                      <span className="cap-shelf-recent-sub">
                        {type.label}
                        {showStorage ? ` · ${storageLabel(item)}` : ""}
                        {missing ? " · 原文件不可用" : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="cap-mini is-icon cap-shelf-recent-del"
                    aria-label={`删除「${item.display_name}」`}
                    data-tip="删除"
                    data-no-drag
                    disabled={deleteBusy}
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirmDelete(item);
                    }}
                  >
                    <Trash2 size={12} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                  <DropdownMenu
                    menuLabel={`「${item.display_name}」操作`}
                    placement="bottom-end"
                    trigger={({ ref, onClick, onKeyDown, expanded }) => (
                      <button
                        ref={ref}
                        type="button"
                        className="cap-mini is-icon cap-shelf-recent-more"
                        aria-label={`「${item.display_name}」更多操作`}
                        aria-expanded={expanded}
                        data-tip="更多"
                        data-no-drag
                        onClick={onClick}
                        onKeyDown={onKeyDown}
                      >
                        <MoreVertical size={12} strokeWidth={2.2} aria-hidden="true" />
                      </button>
                    )}
                    items={[
                      ...(item.kind === "text"
                        ? []
                        : [
                            {
                              key: "open",
                              label:
                                item.kind === "link"
                                  ? "打开链接"
                                  : item.kind === "folder"
                                    ? "打开目录"
                                    : "打开",
                              onSelect: () => openItem(item),
                            },
                          ]),
                      ...(isPhysical(item) && !missing
                        ? [
                            {
                              key: "reveal",
                              label: "在文件夹中显示",
                              onSelect: () => revealItem(item),
                            },
                          ]
                        : []),
                      ...(item.kind === "file" || item.kind === "image"
                        ? [
                            {
                              key: "copy-file",
                              label: "复制文件",
                              onSelect: () => copyFile(item),
                            },
                            {
                              key: "copy-path",
                              label: "复制路径",
                              onSelect: () => copyPath(item),
                            },
                          ]
                        : []),
                      ...(item.kind === "folder"
                        ? [
                            {
                              key: "copy-path",
                              label: "复制路径",
                              onSelect: () => copyPath(item),
                            },
                          ]
                        : []),
                      ...(item.kind === "link"
                        ? [
                            {
                              key: "copy-link",
                              label: "复制链接",
                              onSelect: () => copyLink(item),
                            },
                          ]
                        : []),
                      ...(item.kind === "text"
                        ? [
                            {
                              key: "view",
                              label: "查看内容",
                              onSelect: () => openItem(item),
                            },
                            {
                              key: "copy-text",
                              label: "复制内容",
                              onSelect: () => copyText(item),
                            },
                          ]
                        : []),
                      {
                        key: "favorite",
                        label: item.favorite ? "取消收藏" : "收藏",
                        disabled: favoriteBusyId === item.id,
                        onSelect: () => toggleFavorite(item),
                      },
                      {
                        key: "locate",
                        label: "在暂存架中查看",
                        onSelect: () => locate(item),
                      },
                      {
                        key: "delete",
                        label: "删除",
                        danger: true,
                        disabled: deleteBusyId === item.id,
                        onSelect: () => setConfirmDelete(item),
                      },
                    ]}
                  />
                  </>
                )}
              </li>
            );
          })}
        </ul>
        </>
      )}
      {/* 绝对定位的拖入提示：只在拖拽期间出现，不推挤列表，也不参与落点命中。
          整个会话期间接收区有轻高亮，光标真正落在其上时再加强。 */}
      {dropZone && dropActive && (
        <p className="cap-shelf-recent-drop-hint" role="status">
          {t("capsule.inboxDrop.shelfDropHint")}
        </p>
      )}
    </section>
  );
}
