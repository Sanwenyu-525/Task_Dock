//! 收集箱「文件」子页的最近暂存：把文件暂存架里最近几条搬进胶囊。
//!
//! 复用 `useShelfStore` 的轻量切片（`loadRecent` 只取 4 条）与既有后端命令，
//! 不建第二套最近文件缓存、不做目录扫描；隐藏/卸载后没有订阅或轮询。
//!
//! 定位条目复用全局搜索的 `pendingLocate` 通道：完整暂存架挂载后消费意图、
//! 清空筛选并打开详情，不另造一套「指定条目」参数。

import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlignLeft,
  File as FileIcon,
  Folder,
  Image as ImageIcon,
  Link2,
  Loader2,
  MoreVertical,
  Plus,
} from "lucide-react";
import {
  SHELF_KIND_LABELS,
  shelfCopyFiles,
  shelfCopyPaths,
  shelfOpenItem,
  type ShelfItem,
  type ShelfKind,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useShelfStore } from "../../store/useShelfStore";
import { openFullApp } from "./actions";
import { DropdownMenu } from "../ui";

const KIND_ICONS: Record<ShelfKind, typeof FileIcon> = {
  file: FileIcon,
  image: ImageIcon,
  folder: Folder,
  link: Link2,
  text: AlignLeft,
};

function storageLabel(item: ShelfItem): string {
  if (item.kind === "link") return "链接";
  if (item.kind === "text") return "文本";
  return item.storage_mode === "managed" ? "托管副本" : "引用原文件";
}

export default function InboxRecentShelf({ onNotice }: { onNotice: (msg: string) => void }) {
  const recent = useShelfStore((s) => s.recent);
  const recentLoading = useShelfStore((s) => s.recentLoading);
  const recentLoaded = useShelfStore((s) => s.recentLoaded);
  const recentError = useShelfStore((s) => s.recentError);
  const loadRecent = useShelfStore((s) => s.loadRecent);
  const addPaths = useShelfStore((s) => s.addPaths);
  const requestShelfLocate = useGlobalSearchStore((s) => s.requestShelfLocate);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const openItem = useCallback(
    (item: ShelfItem) => {
      // 文本没有系统级打开目标：直接去完整暂存架看详情。
      if (item.kind === "text") {
        openFullApp("shelf", () => requestShelfLocate(item.id, item.kind));
        return;
      }
      void shelfOpenItem(item.id).catch((e) => onNotice(`打开暂存项失败：${errorMessage(e)}`));
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
      void shelfCopyFiles([item.id])
        .then(() => onNotice("文件已复制，可在资源管理器粘贴"))
        .catch((e) => onNotice(`复制文件失败：${errorMessage(e)}`));
    },
    [onNotice],
  );

  const copyPath = useCallback(
    (item: ShelfItem) => {
      void shelfCopyPaths([item.id])
        .then(() => onNotice("路径已复制"))
        .catch((e) => onNotice(`复制路径失败：${errorMessage(e)}`));
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
      if (r.added > 0) onNotice(`已暂存 ${r.added} 项`);
      if (r.failed.length > 0) {
        const first = r.failed[0];
        onNotice(`有 ${r.failed.length} 项未能暂存：${first.reason}`);
      }
      // addPaths 只刷新完整列表；这里让最近切片立刻反映新增条目。
      await loadRecent({ force: true });
    } catch (e) {
      onNotice(`暂存文件失败：${errorMessage(e)}`);
    } finally {
      setAdding(false);
    }
  };

  const showEmpty = recentLoaded && recent.length === 0 && !recentError;

  return (
    <section className="cap-recent" aria-label="最近暂存">
      <div className="cap-recent-head">
        <span className="cap-recent-title">最近暂存</span>
        {recent.length > 0 && <span className="cap-recent-count">{recent.length}</span>}
        <span className="cap-recent-gap" />
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

      {recentError && recent.length === 0 ? (
        <p className="cap-recent-hint is-error" role="alert">
          暂存架读取失败
          <button type="button" className="cap-mini" onClick={() => void loadRecent({ force: true })}>
            重试
          </button>
        </p>
      ) : recentLoading && recent.length === 0 ? (
        <p className="cap-recent-hint" role="status">
          正在读取最近暂存…
        </p>
      ) : showEmpty ? (
        <p className="cap-recent-hint">
          暂存架还是空的；用「+」添加文件，默认只保存引用、不复制原文件。
        </p>
      ) : (
        <ul className="cap-recent-list">
          {recent.map((item) => {
            const Icon = KIND_ICONS[item.kind] ?? FileIcon;
            const missing = item.exists_state === "missing";
            const kindLabel = SHELF_KIND_LABELS[item.kind] ?? item.kind;
            return (
              <li key={item.id} className={`cap-recent-item${missing ? " is-missing" : ""}`}>
                <button
                  type="button"
                  className="cap-recent-main"
                  aria-label={`打开「${item.display_name}」`}
                  title={item.original_path ?? item.display_name}
                  onClick={() => openItem(item)}
                >
                  <span className="cap-recent-icon" aria-hidden="true">
                    <Icon size={13} strokeWidth={1.9} />
                  </span>
                  <span className="cap-recent-text">
                    <span className="cap-recent-name">{item.display_name}</span>
                    <span className="cap-recent-sub">
                      {kindLabel} · {storageLabel(item)}
                      {missing ? " · 原文件不可用" : ""}
                    </span>
                  </span>
                </button>
                <DropdownMenu
                  menuLabel={`「${item.display_name}」操作`}
                  placement="bottom-end"
                  trigger={({ ref, onClick, onKeyDown, expanded }) => (
                    <button
                      ref={ref}
                      type="button"
                      className="cap-mini is-icon cap-recent-more"
                      aria-label={`「${item.display_name}」更多操作`}
                      aria-expanded={expanded}
                      data-tip="更多"
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
                            label: "打开",
                            onSelect: () => openItem(item),
                          },
                        ]),
                    {
                      key: "locate",
                      label: "在暂存架中查看",
                      onSelect: () => locate(item),
                    },
                    ...(item.kind === "file" || item.kind === "image"
                      ? [
                          {
                            key: "copy-file",
                            label: "复制文件",
                            onSelect: () => copyFile(item),
                          },
                        ]
                      : []),
                    {
                      key: "copy-path",
                      label: "复制路径",
                      onSelect: () => copyPath(item),
                    },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
