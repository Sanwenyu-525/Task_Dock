//! 暂存架条目卡：缩略图/类型图标、名称截断、大小、来源、时间、失效徽标、
//! 多选复选与条目菜单（打开/定位/复制/收藏/置顶/分组/删除）。
//!
//! 交互分工（与框选/拖出手势的仲裁）：
//! - 缩略图：图片直接打开灯箱，其他类型打开详情；
//! - 名称：打开详情；
//! - 勾选：切换选择；
//! - 卡片空白/元信息：普通点击单选，Ctrl 切换，Shift 连选；
//! - 卡片主体按住拖动：Windows OLE 拖出；Alt+拖动：应用内拖入垃圾桶（不进入 OLE）。

import { useEffect, useState, type MouseEvent, type PointerEvent } from "react";
import { Clock, FileQuestion, MoreHorizontal, Pin, Star } from "lucide-react";
import {
  shelfReadImage,
  type ShelfDragOutResult,
  type ShelfItem,
} from "../../lib/bridge";
import { clipboardTime, formatBytes } from "../../lib/clipboardUi";
import { shelfFileTypeUi } from "../../lib/fileTypeUi";
import { useShelfDragOut } from "../../hooks/useShelfDragOut";
import { DropdownMenu } from "../ui";
import type { DropdownMenuItem } from "../ui/DropdownMenu";

function sourceLabel(item: ShelfItem): string {
  switch (item.source_kind) {
    case "drag":
      return "拖入";
    case "picker":
      return "选择器";
    case "clipboard":
      return "剪贴板";
    case "url":
      return "链接";
    default:
      return "手动";
  }
}

/** 托管 / 引用模式徽标：让「是否已保存副本」一目了然（避免误以为只有失效路径）。 */
function modeLabel(item: ShelfItem): string {
  if (item.kind === "link") return "链接";
  if (item.kind === "text") return "文本";
  return item.storage_mode === "managed" ? "托管副本" : "引用";
}

export default function ShelfItemCard({
  item,
  selected,
  focused = false,
  layout = "list",
  thumbUrl,
  menuItems,
  onOpen,
  onToggleSelect,
  onPreview,
  onPreviewImage,
  onSelectOnly,
  onSelectToggle,
  onSelectRange,
  onContextMenu,
  onInternalDragStart,
  dragEnabled = false,
  resolveDragIds,
  onDragSettled,
  onDragError,
}: {
  item: ShelfItem;
  selected: boolean;
  /** 键盘焦点位置（与选中态分离，焦点必须有可见指示）。 */
  focused?: boolean;
  layout?: "list" | "grid";
  thumbUrl: string | null;
  menuItems: DropdownMenuItem[];
  onOpen: () => void;
  onToggleSelect: () => void;
  onPreview: () => void;
  /** 图片缩略图单击：直接打开灯箱（不再先进入详情）。 */
  onPreviewImage?: () => void;
  onSelectOnly?: () => void;
  onSelectToggle?: () => void;
  onSelectRange?: () => void;
  /** 右键：按当前选择集合打开上下文菜单（未选中条目会先改为单选）。 */
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  /** Alt+左键按下：应用内拖动到垃圾桶（父级负责手势与命中）。 */
  onInternalDragStart?: (event: PointerEvent<HTMLElement>) => void;
  /** 只有 file/image/folder 且文件存在时为 true。 */
  dragEnabled?: boolean;
  /** 由父级决定拖单条还是整个多选集。 */
  resolveDragIds?: () => string[];
  onDragSettled?: (result: ShelfDragOutResult, ids: string[]) => void;
  onDragError?: (message: string) => void;
}) {
  const type = shelfFileTypeUi(item);
  const Icon = type.icon;
  const missing = item.exists_state === "missing";
  const [fallbackThumb, setFallbackThumb] = useState<string | null>(null);
  const drag = useShelfDragOut({
    enabled: dragEnabled,
    resolveIds: resolveDragIds ?? (() => []),
    onSettled: onDragSettled,
    onError: onDragError,
  });
  /** 名称/缩略图上的修饰键点击：优先执行多选语义，不打开内容。 */
  const modifierSelect = (event: MouseEvent): boolean => {
    if (event.shiftKey && onSelectRange) {
      event.preventDefault();
      onSelectRange();
      return true;
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      onSelectToggle?.();
      return true;
    }
    return false;
  };
  // 列表传入的 thumbUrl 为空时（如翻页合并后），图片条目自行懒加载一次
  useEffect(() => {
    if (thumbUrl || fallbackThumb || item.kind !== "image") return;
    let alive = true;
    shelfReadImage(item.id, false)
      .then((u) => alive && u && setFallbackThumb(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [thumbUrl, fallbackThumb, item.kind, item.id]);

  const thumb = thumbUrl ?? fallbackThumb;

  return (
    <div
      className={`shelf-item surface-card ${selected ? "selected surface-card--selected" : ""} ${missing ? "missing" : ""} ${dragEnabled ? "is-draggable" : ""} ${focused ? "is-focused" : ""} shelf-item--${layout}`}
      role="listitem"
      aria-selected={selected}
      aria-current={focused ? "true" : undefined}
      data-kind={item.kind}
      data-shelf-id={item.id}
      tabIndex={-1}
      onContextMenu={onContextMenu}
      onClick={(event) => {
        if (drag.shouldSuppressClick()) return;
        // 卡片内按钮各自处理点击；这里只处理空白/元信息区域的“单选”。
        if ((event.target as Element | null)?.closest?.("button, a, input")) return;
        if (modifierSelect(event)) return;
        onSelectOnly?.();
      }}
      onPointerDown={(event) => {
        const target = event.target as Element | null;
        if (
          event.altKey &&
          event.button === 0 &&
          onInternalDragStart &&
          !target?.closest?.("[data-no-drag]")
        ) {
          event.preventDefault();
          onInternalDragStart(event);
          return;
        }
        drag.onPointerDown(event);
      }}
    >
      <button
        type="button"
        className={`shelf-check ${selected ? "on" : ""}`}
        aria-label={selected ? `取消选择 ${item.display_name}` : `选择 ${item.display_name}`}
        aria-pressed={selected}
        data-no-drag
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
      >
        {selected && "✓"}
      </button>
      <button
        type="button"
        className={`shelf-thumb file-tone-${type.tone}`}
        aria-label={`预览 ${item.display_name}`}
        data-tip={dragEnabled ? "点击预览 · 拖到其他窗口 · Alt+拖动可拖入垃圾桶" : undefined}
        onClick={(event) => {
          if (drag.shouldSuppressClick()) {
            event.preventDefault();
            return;
          }
          if (modifierSelect(event)) return;
          if (item.kind === "image" && onPreviewImage) onPreviewImage();
          else onPreview();
        }}
      >
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" draggable={false} />
        ) : (
          <Icon size={layout === "grid" ? 30 : 22} strokeWidth={1.6} aria-hidden="true" />
        )}
        {missing && (
          <span className="shelf-thumb-badge missing" data-tip="原文件/副本已失效">
            <FileQuestion size={13} aria-hidden="true" />
          </span>
        )}
      </button>
      <div className="shelf-item-body">
        <button
          type="button"
          className="shelf-item-name"
          data-tip={`${item.display_name} · ${type.label} · ${modeLabel(item)}`}
          onClick={(event) => {
            if (drag.shouldSuppressClick()) {
              event.preventDefault();
              return;
            }
            if (modifierSelect(event)) return;
            onOpen();
          }}
        >
          {item.display_name}
        </button>
        <div className="shelf-item-meta">
          <span className="shelf-tag mode">{modeLabel(item)}</span>
          <span>{formatBytes(item.byte_size)}</span>
          <span className="shelf-item-meta-sep" aria-hidden="true">·</span>
          <span className="shelf-item-src">{sourceLabel(item)}</span>
          <span className="shelf-item-meta-sep" aria-hidden="true">·</span>
          <span className="shelf-item-time">
            <Clock size={11} aria-hidden="true" />
            {clipboardTime(item.created_at)}
          </span>
        </div>
      </div>
      <div className="shelf-item-flags">
        {item.favorite && <Star size={12} aria-hidden="true" className="flag-fav" />}
        {item.pinned && <Pin size={12} aria-hidden="true" className="flag-pin" />}
      </div>
      <DropdownMenu
        trigger={(props) => (
          <button
            {...props}
            type="button"
            className="icon-btn sm shelf-more"
            aria-label={`更多操作：${item.display_name}`}
            data-no-drag
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        )}
        items={menuItems}
        menuLabel={`条目操作：${item.display_name}`}
        placement="bottom-end"
      />
    </div>
  );
}
