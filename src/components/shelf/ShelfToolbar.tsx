//! 暂存架单行工具条：添加、粘贴当前剪贴板、搜索、筛选、更多。
//!
//! 原「文件暂存架」标题行与四个头部图标收进本工具条：类型/分组/收藏进筛选
//! 浮层，投递目标/空间清理/帮助/清空进「⋯」菜单；搜索框始终常驻，保证键盘
//! 与既有测试的稳定入口。窄容器下添加/筛选收敛为图标按钮，不换行。

import { useRef, useState } from "react";
import {
  ChevronDown, ClipboardPaste, FolderInput, HardDrive, HelpCircle, Loader2,
  MoreHorizontal, Plus, Send, SlidersHorizontal, Trash2,
} from "lucide-react";
import { DropdownMenu, SearchField } from "../ui";
import type { DropdownMenuItem } from "../ui/DropdownMenu";
import { useUiStore } from "../../store/useUiStore";
import type { ShelfGroup, ShelfKind } from "../../lib/bridge";
import ShelfFilters, { KIND_FILTERS } from "./ShelfFilters";
import "./shelf-ui.css";

export interface ShelfToolbarProps {
  searchDraft: string;
  onSearchChange: (value: string) => void;
  copyOnAdd: boolean;
  onCopyOnAddChange: (value: boolean) => void;
  kind: ShelfKind | "all";
  onKindChange: (kind: ShelfKind | "all") => void;
  groupId: string;
  groups: ShelfGroup[];
  onGroupChange: (groupId: string) => void;
  favoriteOnly: boolean;
  onFavoriteOnlyChange: (value: boolean) => void;
  hasFilters: boolean;
  filterCount: number;
  onClearFilters: () => void;
  onPickFiles: () => void;
  onPickFolder: () => void;
  /** 粘贴当前系统剪贴板（与 onAddFromClipboard 的历史选择明确不同）。 */
  onPasteCurrent: () => void;
  pasteBusy?: boolean;
  onAddLink: () => void;
  onAddText: () => void;
  onAddFromClipboard: () => void;
  onOpenTargets: () => void;
  onOpenCleanup: () => void;
  onClearShelf: () => void;
  /** 资源管理器右键「发送到 Task Dock」开关（HKCU 动词）。 */
  sendToEnabled: boolean;
  onToggleSendTo: () => void;
  helpArticleId: string;
}

export default function ShelfToolbar({
  searchDraft,
  onSearchChange,
  copyOnAdd,
  onCopyOnAddChange,
  kind,
  onKindChange,
  groupId,
  groups,
  onGroupChange,
  favoriteOnly,
  onFavoriteOnlyChange,
  hasFilters,
  filterCount,
  onClearFilters,
  onPickFiles,
  onPickFolder,
  onPasteCurrent,
  pasteBusy = false,
  onAddLink,
  onAddText,
  onAddFromClipboard,
  onOpenTargets,
  onOpenCleanup,
  onClearShelf,
  sendToEnabled,
  onToggleSendTo,
  helpArticleId,
}: ShelfToolbarProps) {
  const filterAnchor = useRef<HTMLButtonElement | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const setTab = useUiStore((s) => s.setTab);
  const requestHelpArticle = useUiStore((s) => s.requestHelpArticle);
  const setHelpReturnTab = useUiStore((s) => s.setHelpReturnTab);

  const openGuide = () => {
    const returnTab = useUiStore.getState().tab;
    setTab("help", {
      after: () => {
        setHelpReturnTab(returnTab);
        requestHelpArticle(helpArticleId);
      },
    });
  };

  const addItems: DropdownMenuItem[] = [
    { key: "file", label: "添加文件…", onSelect: onPickFiles },
    { key: "folder", label: "添加文件夹…", onSelect: onPickFolder },
    { key: "link", label: "添加网页链接…", onSelect: onAddLink },
    { key: "text", label: "添加文本片段…", onSelect: onAddText },
    { key: "clip", label: "从剪贴板添加…", onSelect: onAddFromClipboard },
    {
      key: "mode-label",
      label: "添加方式",
      disabled: true,
      description: "拖入与剪贴板添加同样遵循",
    },
    {
      key: "reference",
      label: "引用原文件（不复制）",
      radio: true,
      checked: !copyOnAdd,
      onSelect: () => onCopyOnAddChange(false),
    },
    {
      key: "managed",
      label: "保存副本到托管目录",
      radio: true,
      checked: copyOnAdd,
      onSelect: () => onCopyOnAddChange(true),
    },
  ];

  const overflowItems: DropdownMenuItem[] = [
    {
      key: "targets",
      label: "投递目标管理",
      icon: <FolderInput size={13} aria-hidden="true" />,
      onSelect: onOpenTargets,
    },
    {
      key: "cleanup",
      label: "空间与清理",
      icon: <HardDrive size={13} aria-hidden="true" />,
      onSelect: onOpenCleanup,
    },
    {
      key: "sendto",
      label: sendToEnabled
        ? "停用资源管理器右键发送"
        : "启用资源管理器右键发送",
      icon: <Send size={13} aria-hidden="true" />,
      onSelect: onToggleSendTo,
    },
    {
      key: "help",
      label: "查看帮助",
      icon: <HelpCircle size={13} aria-hidden="true" />,
      onSelect: openGuide,
    },
    {
      key: "clear",
      label: "清空暂存架",
      icon: <Trash2 size={13} aria-hidden="true" />,
      danger: true,
      onSelect: onClearShelf,
    },
  ];

  const kindLabel =
    KIND_FILTERS.find((option) => option.value === kind)?.label ?? "全部";
  const groupLabel =
    groupId === "all"
      ? ""
      : groupId === "none"
        ? "未分组"
        : (groups.find((group) => group.id === groupId)?.name ?? "分组");

  return (
    <div className="shelf-toolbar-wrap">
      <div className="shelf-toolbar">
        <div className="shelf-add-split">
          <button
            type="button"
            className="btn sm primary shelf-add-main"
            aria-label="添加文件到暂存架"
            data-tip="选择文件加入暂存架"
            onClick={onPickFiles}
          >
            <Plus size={14} aria-hidden="true" />
            <span className="shelf-add-label">添加</span>
          </button>
          <DropdownMenu
            trigger={(props) => (
              <button
                {...props}
                type="button"
                className="icon-btn sm shelf-add-more"
                aria-label="更多添加方式"
                data-tip="更多添加方式"
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            )}
            items={addItems}
            menuLabel="添加到暂存架"
            placement="bottom-start"
            menuMinWidth={190}
          />
        </div>

        <button
          type="button"
          className="icon-btn sm shelf-paste-btn"
          aria-label="粘贴当前剪贴板"
          data-tip="粘贴当前内容 (Ctrl+V)"
          disabled={pasteBusy}
          onClick={onPasteCurrent}
        >
          {pasteBusy ? (
            <Loader2 size={14} className="spin" aria-hidden="true" />
          ) : (
            <ClipboardPaste size={14} aria-hidden="true" />
          )}
        </button>

        <SearchField
          className="shelf-search"
          size="compact"
          value={searchDraft}
          placeholder="搜索名称 / 内容 / 备注"
          ariaLabel="搜索暂存条目"
          onChange={onSearchChange}
        />

        <button
          ref={filterAnchor}
          type="button"
          className={`btn sm shelf-filter-btn${filterOpen ? " is-open" : ""}`}
          aria-label="筛选暂存条目"
          aria-expanded={filterOpen}
          data-tip="类型 / 分组 / 收藏"
          onClick={() => setFilterOpen((open) => !open)}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          <span className="shelf-filter-btn-label">筛选</span>
          {filterCount > 0 && (
            <span className="shelf-filter-badge" aria-hidden="true">
              {filterCount}
            </span>
          )}
        </button>

        <DropdownMenu
          trigger={(props) => (
            <button
              {...props}
              type="button"
              className="icon-btn sm shelf-overflow"
              aria-label="更多暂存架操作"
              data-tip="更多"
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
          )}
          items={overflowItems}
          menuLabel="暂存架更多操作"
          placement="bottom-end"
          menuMinWidth={164}
        />
      </div>

      <ShelfFilters
        open={filterOpen}
        onOpenChange={setFilterOpen}
        anchorRef={filterAnchor}
        kind={kind}
        onKindChange={onKindChange}
        groupId={groupId}
        groups={groups}
        onGroupChange={onGroupChange}
        favoriteOnly={favoriteOnly}
        onFavoriteOnlyChange={onFavoriteOnlyChange}
        hasFilters={hasFilters}
        onClear={onClearFilters}
      />

      {filterCount > 0 && (
        <div className="shelf-active-filters" aria-label="当前筛选">
          {kind !== "all" && (
            <button
              type="button"
              className="shelf-active-filter"
              aria-label={`移除类型筛选：${kindLabel}`}
              onClick={() => onKindChange("all")}
            >
              {kindLabel}
              <span aria-hidden="true">×</span>
            </button>
          )}
          {groupId !== "all" && (
            <button
              type="button"
              className="shelf-active-filter"
              aria-label={`移除分组筛选：${groupLabel}`}
              onClick={() => onGroupChange("all")}
            >
              {groupLabel}
              <span aria-hidden="true">×</span>
            </button>
          )}
          {favoriteOnly && (
            <button
              type="button"
              className="shelf-active-filter"
              aria-label="取消只看收藏"
              onClick={() => onFavoriteOnlyChange(false)}
            >
              只看收藏
              <span aria-hidden="true">×</span>
            </button>
          )}
          <button
            type="button"
            className="shelf-active-filter-clear"
            onClick={onClearFilters}
          >
            清除
          </button>
        </div>
      )}
    </div>
  );
}
