//! 文件暂存架工作区：顶部添加入口（文件/文件夹/链接/文本/从剪贴板）、
//! 搜索与类型/分组筛选、条目列表、多选操作栏、空间占用与清理设置。
//!
//! 拖入：监听 Tauri Webview 级 onDragDropEvent（真实 OS 文件拖入，非 HTML5 模拟），
//! 仅在暂存架页签激活时处理；拖入默认走引用模式（不复制、不占磁盘），
//! 「保存副本」开关可切换为托管复制。
//! 拖出：WebView2 无可靠的系统级文件拖出通道，第一版提供复制路径/复制文件
//! （CF_HDROP，资源管理器可直接粘贴）/打开所在文件夹作为替代，并在验收报告中如实标记。

import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ChevronDown, Clipboard, HardDrive, Loader2, Plus, Settings2, Star, Trash2, Upload, X,
} from "lucide-react";
import {
  clipboardView,
  getSettings,
  quickCaptureSubmit,
  shelfCleanup,
  shelfGetItem,
  shelfCopyFiles,
  shelfCopyPaths,
  shelfOpenItem,
  shelfRevealItem,
  updateSettings,
  SHELF_KIND_LABELS,
  type ShelfItem,
  type ShelfKind,
} from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { errorMessage } from "../../lib/errors";
import { useShelfStore } from "../../store/useShelfStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useUiStore } from "../../store/useUiStore";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { ConfirmDialog } from "../ui/Dialog";
import { DropdownMenu, SearchField } from "../ui";
import type { DropdownMenuItem } from "../ui/DropdownMenu";
import ShelfItemCard from "./ShelfItemCard";
import ShelfDetail from "./ShelfDetail";

const KIND_FILTERS: { value: ShelfKind | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "file", label: "文件" },
  { value: "folder", label: "文件夹" },
  { value: "link", label: "链接" },
  { value: "text", label: "文本" },
];

interface PendingDelete {
  ids: string[];
  includeProtected: boolean;
}

export default function ShelfWorkspace({ active }: { active: boolean }) {
  const showToast = useUiStore((s) => s.showToast);
  const setTab = useUiStore((s) => s.setTab);
  const items = useShelfStore((s) => s.items);
  const total = useShelfStore((s) => s.total);
  const groups = useShelfStore((s) => s.groups);
  const stats = useShelfStore((s) => s.stats);
  const filter = useShelfStore((s) => s.filter);
  const loading = useShelfStore((s) => s.loading);
  const error = useShelfStore((s) => s.error);
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
  const updateItem = useShelfStore((s) => s.updateItem);
  const deleteItems = useShelfStore((s) => s.deleteItems);
  const moveToGroup = useShelfStore((s) => s.moveToGroup);
  const toggleSelect = useShelfStore((s) => s.toggleSelect);
  const selectAll = useShelfStore((s) => s.selectAll);
  const clearSelection = useShelfStore((s) => s.clearSelection);
  const setDetail = useShelfStore((s) => s.setDetail);
  const verifyExists = useShelfStore((s) => s.verifyExists);

  const [dragOver, setDragOver] = useState(false);
  /** 拖入/剪贴板添加的默认策略：引用优先（不偷偷复制占用磁盘），用户可显式切换。 */
  const [copyOnAdd, setCopyOnAdd] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [textDraft, setTextDraft] = useState(false);
  const [textValue, setTextValue] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [clipboardEntries, setClipboardEntries] = useState<
    { id: string; kind: string; preview: string }[]
  >([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<{
    candidates: number;
    skipped_protected: number;
    freed_bytes: number;
  } | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  /** 反向转存（暂存架→收集箱）在途守卫：菜单项 disabled，防连点重复创建 */
  const [toInboxBusy, setToInboxBusy] = useState(false);
  const searchTimer = useRef<number | null>(null);

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

  // 全局搜索定位：清过滤确保目标条目在列表中（详情数据源是当前 items），
  // 然后按 id 打开详情；详情在 items 重新加载完成前不渲染，加载后自动出现。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "shelf") return;
    const intent = pendingLocate;
    consumeLocate();
    if (useShelfStore.getState().filter.search) setFilter({ search: "" });
    setDetail(intent.id);
    // 仅响应定位意图变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLocate]);

  // 搜索输入去抖：输入框保留即时草稿，避免受控值与 250ms 去抖互相拉扯。
  const [searchDraft, setSearchDraft] = useState(filter.search ?? "");
  useEffect(() => {
    setSearchDraft(filter.search ?? "");
  }, [filter.search]);

  const onSearchInput = useCallback(
    (v: string) => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
      searchTimer.current = window.setTimeout(() => {
        void setFilter({ search: v });
      }, 250);
    },
    [setFilter],
  );

  const reportAdd = useCallback(
    (r: { added: number; failed: { path: string; reason: string }[] }, verb: string) => {
      if (r.added > 0) showToast(`${verb} ${r.added} 项`, { kind: "success" });
      for (const f of r.failed) {
        showToast(`无法添加「${f.path.split(/[\\/]/).pop()}」：${f.reason}`, { kind: "error" });
      }
    },
    [showToast],
  );

  // ── OS 文件拖入（Tauri drag-drop 事件，仅本页签激活时；随卸载释放）──
  useEffect(() => {
    if (!active) return;
    const scope = createSubscriptionScope();
    scope.add(
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragOver(true);
          } else if (event.payload.type === "drop") {
            setDragOver(false);
            const paths = event.payload.paths;
            if (paths.length === 0) return;
            addPaths(paths, copyOnAdd ? "managed" : "reference", "drag")
              .then((r) => reportAdd(r, "已暂存"))
              .catch((e) => showToast(`暂存拖入文件失败：${errorMessage(e)}`, { kind: "error" }));
          } else {
            setDragOver(false);
          }
        })
        .then((unlisten) => unlisten ?? (() => {}))
        .catch(() => () => {}),
    );
    return () => scope.dispose();
  }, [active, copyOnAdd, addPaths, showToast, reportAdd]);

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
        label: `${item.group_id === g.id ? "✓ " : ""}移动到：${g.name}`,
        onSelect: () => {
          moveToGroup([item.id], g.id).catch((e) => showToast(`移动分组失败：${errorMessage(e)}`, { kind: "error" }));
        },
      })),
      {
        key: "delete",
        label: "删除",
        danger: true,
        onSelect: () => {
          setPendingDelete({ ids: [item.id], includeProtected: item.favorite || item.pinned });
          setConfirmDelete(true);
        },
      },
    ],
    [groups, showToast, updateItem, moveToGroup, toInboxBusy, setTab],
  );

  const detailItem = items.find((i) => i.id === detailId) ?? null;

  const quotaUsedPct =
    stats && stats.quota_mb > 0
      ? Math.min(100, Math.round((stats.managed_bytes / (stats.quota_mb * 1024 * 1024)) * 100))
      : 0;

  const copySelectedFiles = () => {
    shelfCopyFiles(selectedIds)
      .then(() => showToast("文件已复制，可在资源管理器粘贴", { kind: "success" }))
      .catch((e) => showToast(`复制所选文件失败：${errorMessage(e)}`, { kind: "error" }));
  };

  const runCleanupPreview = async () => {
    setCleanupBusy(true);
    try {
      const r = await shelfCleanup(true, false);
      setCleanupPreview({
        candidates: r.candidates,
        skipped_protected: r.skipped_protected,
        freed_bytes: r.freed_bytes,
      });
    } catch (e) {
      showToast(`清理预览失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setCleanupBusy(false);
    }
  };

  const runCleanupNow = async () => {
    setCleanupBusy(true);
    try {
      const r = await shelfCleanup(false, false);
      showToast(`已清理 ${r.candidates} 项，释放 ${formatBytes(r.freed_bytes)}`, {
        kind: "success",
      });
      setCleanupPreview(null);
      setCleanupOpen(false);
    } catch (e) {
      showToast(`清理失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      setCleanupBusy(false);
    }
  };

  return (
    <div className={`shelf-workspace ${dragOver ? "drag-over" : ""}`}>
      {/* 面板标题行（对齐剪贴板 clip-head 结构） */}
      <div className="shelf-head">
        <span className="shelf-head-title">文件暂存架</span>
        {total > 0 && <span className="shelf-head-count">{total} 项</span>}
        <button
          type="button"
          className="icon-btn sm"
          aria-label="空间占用与清理设置"
          data-tip="空间占用与清理"
          onClick={() => {
            setCleanupOpen((v) => !v);
            setCleanupPreview(null);
          }}
        >
          <Settings2 size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label="清空暂存架"
          data-tip="清空（保留收藏/置顶）"
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>

      {/* 工具栏 */}
      <div className="shelf-toolbar">
        <button
          type="button"
          className="btn sm primary"
          onClick={() => void pickAndAdd(false)}
          data-tip="选择文件加入暂存架"
        >
          <Plus size={14} aria-hidden="true" /> 添加
        </button>
        <DropdownMenu
          trigger={(props) => (
            <button {...props} type="button" className="icon-btn sm" aria-label="更多添加方式">
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
          items={[
            { key: "file", label: "添加文件…", onSelect: () => void pickAndAdd(false) },
            { key: "folder", label: "添加文件夹…", onSelect: () => void pickAndAdd(true) },
            { key: "link", label: "添加网页链接…", onSelect: () => setLinkOpen((v) => !v) },
            { key: "text", label: "添加文本片段…", onSelect: () => setTextDraft((v) => !v) },
            { key: "clip", label: "从剪贴板添加…", onSelect: () => void toggleClipboardPicker() },
          ]}
          menuLabel="添加到暂存架"
          placement="bottom-start"
        />

        <SearchField
          className="shelf-search"
          size="compact"
          value={searchDraft}
          placeholder="搜索名称 / 内容 / 备注"
          ariaLabel="搜索暂存条目"
          onChange={(v) => {
            setSearchDraft(v);
            onSearchInput(v);
          }}
        />

        <div className="seg-group" role="tablist" aria-label="类型筛选">
          {KIND_FILTERS.map((k) => (
            <button
              key={k.value}
              type="button"
              role="tab"
              aria-selected={filter.kind === k.value}
              className={`seg-btn ${filter.kind === k.value ? "active" : ""}`}
              onClick={() => void setFilter({ kind: k.value })}
            >
              {k.label}
            </button>
          ))}
        </div>

        <DropdownMenu
          trigger={(props) => (
            <button {...props} type="button" className="btn sm" aria-label="分组筛选">
              {filter.group_id === "all"
                ? "全部分组"
                : filter.group_id === "none"
                  ? "未分组"
                  : groups.find((g) => g.id === filter.group_id)?.name ?? "分组"}
            </button>
          )}
          items={[
            {
              key: "all",
              label: "全部分组",
              radio: true,
              checked: filter.group_id === "all",
              onSelect: () => void setFilter({ group_id: "all" }),
            },
            {
              key: "none",
              label: "未分组",
              radio: true,
              checked: filter.group_id === "none",
              onSelect: () => void setFilter({ group_id: "none" }),
            },
            ...groups.map((g) => ({
              key: g.id,
              label: g.name,
              radio: true,
              checked: filter.group_id === g.id,
              onSelect: () => void setFilter({ group_id: g.id }),
            })),
          ]}
          menuLabel="分组筛选"
          placement="bottom-end"
        />

        <button
          type="button"
          className={`icon-btn sm ${filter.favorite_only ? "active" : ""}`}
          aria-label="只看收藏"
          aria-pressed={filter.favorite_only}
          data-tip="只看收藏"
          onClick={() => void setFilter({ favorite_only: !filter.favorite_only })}
        >
          <Star size={14} aria-hidden="true" />
        </button>

        <label
          className="shelf-copy-toggle"
          data-tip="拖入/剪贴板添加时复制副本到托管目录（默认仅引用，不占磁盘）"
        >
          <input
            type="checkbox"
            checked={copyOnAdd}
            onChange={(e) => setCopyOnAdd(e.target.checked)}
          />
          保存副本
        </label>
      </div>

      {/* 清理设置面板 */}
      {cleanupOpen && (
        <CleanupPanel
          stats={stats}
          preview={cleanupPreview}
          busy={cleanupBusy}
          onPreview={() => void runCleanupPreview()}
          onRun={() => void runCleanupNow()}
          onClose={() => setCleanupOpen(false)}
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

      {/* 空间占用条 */}
      {stats && stats.total > 0 && (
        <div
          className="shelf-spacebar"
          aria-label={`空间占用：托管已用 ${formatBytes(stats.managed_bytes)}，配额 ${stats.quota_mb} MB`}
        >
          <HardDrive size={12} aria-hidden="true" />
          <span>
            {stats.total} 项 · 托管 {formatBytes(stats.managed_bytes)} / {stats.quota_mb} MB
          </span>
          <div className="shelf-spacebar-track" aria-hidden="true">
            <div
              className={`shelf-spacebar-fill ${quotaUsedPct > 90 ? "hot" : ""}`}
              style={{ width: `${quotaUsedPct}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="shelf-error" role="alert">
          {error}
        </div>
      )}

      {/* 列表 */}
      <div className="shelf-list" role="list" aria-label="暂存条目">
        {items.map((item) => (
          <ShelfItemCard
            key={item.id}
            item={item}
            selected={selectedIds.includes(item.id)}
            thumbUrl={null}
            menuItems={itemMenuFor(item)}
            onOpen={() => setDetail(item.id)}
            onToggleSelect={() => toggleSelect(item.id)}
            onPreview={() => setDetail(item.id)}
          />
        ))}
        {items.length === 0 && !loading && (
          <div className="shelf-empty">
            <Upload size={22} strokeWidth={1.5} aria-hidden="true" />
            <p>把文件、图片拖进窗口，或用上方「添加」收纳链接与文本。</p>
            <p className="shelf-empty-sub">
              暂存架与剪贴板互相独立：这里只保存你主动放入的内容，删除剪贴板历史不影响暂存架。
            </p>
          </div>
        )}
        {loading && (
          <div className="shelf-loading" aria-live="polite">
            <Loader2 size={16} className="spin" aria-hidden="true" /> 加载中…
          </div>
        )}
      </div>

      {items.length < total && (
        <button type="button" className="btn sm shelf-more-btn" onClick={() => void loadMore()}>
          加载更多（{items.length}/{total}）
        </button>
      )}

      {/* 多选操作栏 */}
      {selectedIds.length > 0 && (
        <div className="shelf-selectbar" role="toolbar" aria-label="批量操作">
          <span className="shelf-selectbar-count">已选 {selectedIds.length} 项</span>
          <button type="button" className="btn sm" onClick={selectAll}>
            全选本页
          </button>
          <DropdownMenu
            trigger={(props) => (
              <button {...props} type="button" className="btn sm">
                移动到分组
              </button>
            )}
            items={[
              ...groups.map((g) => ({
                key: g.id,
                label: g.name,
                onSelect: () => {
                  moveToGroup(selectedIds, g.id)
                    .then(() => showToast("已移动", { kind: "success" }))
                    .catch((e) => showToast(`移动分组失败：${errorMessage(e)}`, { kind: "error" }));
                },
              })),
              {
                key: "none",
                label: "未分组",
                onSelect: () => {
                  moveToGroup(selectedIds, "none")
                    .then(() => showToast("已移动", { kind: "success" }))
                    .catch((e) => showToast(`移动分组失败：${errorMessage(e)}`, { kind: "error" }));
                },
              },
            ]}
            menuLabel="移动到分组"
            placement="top-start"
          />
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              const ids = selectedIds;
              void (async () => {
                // 逐项结果单独收集：批量部分失败不能整体丢弃或一律报成功。
                const results = await Promise.all(
                  ids.map((id) =>
                    updateItem(id, { favorite: true }).then(
                      () => true,
                      () => false,
                    ),
                  ),
                );
                const failed = results.filter((ok) => !ok).length;
                const done = ids.length - failed;
                if (failed === 0) showToast("已收藏所选", { kind: "success" });
                else if (done === 0) showToast("收藏所选失败，请稍后重试", { kind: "error" });
                else showToast(`已收藏 ${done} 项，${failed} 项失败`, { kind: "warning" });
              })();
            }}
          >
            <Star size={13} aria-hidden="true" /> 收藏
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setPendingDelete({ ids: selectedIds, includeProtected: false });
              setConfirmDelete(true);
            }}
          >
            <Trash2 size={13} aria-hidden="true" /> 删除
          </button>
          <button type="button" className="btn sm" onClick={copySelectedFiles}>
            复制文件
          </button>
          <button type="button" className="btn sm" onClick={clearSelection}>
            取消选择
          </button>
        </div>
      )}

      {/* 详情 */}
      {detailItem && <ShelfDetail item={detailItem} onClose={() => setDetail(null)} />}

      {/* 拖入高亮遮罩 */}
      {dragOver && (
        <div className="shelf-dropzone" aria-hidden="true">
          <div className="shelf-dropzone-inner">
            <Upload size={28} strokeWidth={1.5} />
            <p>{copyOnAdd ? "松开以复制副本到暂存架" : "松开以引用方式暂存（不复制文件）"}</p>
          </div>
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
            ? "所选条目包含收藏/置顶项，需要你确认后才会一并删除。托管副本会被删除，用户原文件不受影响。"
            : "托管副本将被删除；引用模式的原文件不受影响。"
        }
        confirmLabel="删除"
        danger
        onConfirm={() => {
          const target = pendingDelete;
          setConfirmDelete(false);
          setPendingDelete(null);
          if (!target) return;
          deleteItems(target.ids, target.includeProtected)
            .then(() => showToast("已删除", { kind: "success" }))
            .catch((e) => showToast(`删除暂存项失败：${errorMessage(e)}`, { kind: "error" }));
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
        detail="删除全部未收藏、未置顶的条目（收藏/置顶保留）。托管副本会被删除，引用的原文件不受影响。"
        confirmLabel="清空"
        danger
        onConfirm={() => {
          setConfirmClear(false);
          useShelfStore
            .getState()
            .clearShelf(false)
            .then(() => showToast("已清空", { kind: "success" }))
            .catch((e) => showToast(`清空暂存架失败：${errorMessage(e)}`, { kind: "error" }));
        }}
        onCancel={() => setConfirmClear(false)}
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
  preview: { candidates: number; skipped_protected: number; freed_bytes: number } | null;
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
        （收藏/置顶永不过期）
      </label>
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
            `；${preview.skipped_protected} 项因收藏/置顶被跳过`}
        </p>
      )}
    </div>
  );
}
