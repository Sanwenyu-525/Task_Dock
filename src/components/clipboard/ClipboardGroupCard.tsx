//! 分组卡片：类型预览（截图封面/类型图标）、摘要、整组操作、详情与删除。
//!
//! 键盘边界：卡片根节点不是按钮，鼠标点空白区打开详情；键盘用户走卡片内
//! 「详情」按钮，内部真实按钮的 Enter/Space 因此不会串到根节点触发详情。

import { useLayoutEffect, useRef } from "react";
import {
  CheckSquare, Copy, Files, Image as ImageIcon, Layers, Link2, Maximize2, MoreHorizontal,
  Pin, Play, Square, Star, Trash2, Type,
} from "lucide-react";
import type { ClipboardGroup, ClipboardItem } from "../../lib/bridge";
import {
  clipboardTime, groupComposition, groupCoverSize, groupExcerpt, groupFamily,
  groupKindCounts, groupModeLabel, groupStatusLabel, linkSummary, urlDomain,
} from "../../lib/clipboardUi";
import DropdownMenu from "../ui/DropdownMenu";
import { ClipboardThumb, useCompactViewport, useInViewport } from "./Media";

const COVER_LIMIT = 3;

export default function ClipboardGroupCard({
  group,
  selected,
  linkMode,
  removing,
  pending,
  onSelect,
  onToggle,
  onCopyRich,
  onCopyFiles,
  onPaste,
  onDetail,
  onDelete,
  onLink,
  onOpenImage,
}: {
  group: ClipboardGroup;
  selected: boolean;
  linkMode: boolean;
  /** 已删除、正在播放退出动画 */
  removing: boolean;
  /** 删除请求在途（后端尚未确认）：显示执行中并挡住重复操作 */
  pending: boolean;
  onSelect: () => void;
  onToggle: (flag: "favorite" | "pinned") => void;
  onCopyRich: () => void;
  onCopyFiles: () => void;
  onPaste: () => void;
  onDetail: () => void;
  onDelete: () => void;
  onLink: () => void;
  /** 点封面缩略图：进入现有大图预览，不打开分组详情 */
  onOpenImage: (item: ClipboardItem) => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  // 在途或正在离场：整卡冻结，避免对同一个分组连发第二次删除
  const locked = removing || pending;
  const cardRef = useRef<HTMLElement>(null);
  // 封面缩略图进入可视区才发起 IPC；长列表不会一次性读取所有组图。
  const [previewRef, previewVisible] = useInViewport<HTMLDivElement>();

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (removing && el) el.style.setProperty("--clip-exit-h", `${el.offsetHeight}px`);
  }, [removing]);

  const counts = groupKindCounts(group);
  const family = groupFamily(group);
  const composition = groupComposition(group);
  const compact = useCompactViewport(cardRef);
  const covers = (group.cover_items ?? []).slice(0, compact ? 1 : COVER_LIMIT);
  const excerpt = groupExcerpt(group);
  const link = excerpt && urlDomain(excerpt) ? linkSummary(excerpt) : null;
  const coverSize = groupCoverSize(covers);
  const hasCover = family === "image" || family === "mixed"
    ? covers.length > 0 || counts.image > 0
    : false;

  const summary = (() => {
    if (family === "link") {
      return link ? (
        <span className="clip-link-summary">
          <span className="clip-link-domain">{link.domain}</span>
          {link.rest && <span className="clip-link-rest">{link.rest}</span>}
        </span>
      ) : (
        <span>{excerpt || "链接分组"}</span>
      );
    }
    if (family === "files") return <span>{excerpt || "文件分组"}</span>;
    if (family === "text") return <span>{excerpt || "（暂无文本预览）"}</span>;
    // 图片组由封面承担识别；混合组优先展示首条文本/链接摘要。
    if (family === "mixed" && excerpt) return <span>{excerpt}</span>;
    return null;
  })();
  const hasSummary = Boolean(summary);

  const typeTile = (() => {
    if (hasCover) return null;
    const Icon = family === "link" ? Link2 : family === "files" ? Files : family === "mixed" ? Layers : Type;
    return (
      <span className={`clip-type-tile ${family}`} aria-hidden="true">
        <Icon size={18} />
      </span>
    );
  })();

  const moreItems = [
    {
      key: "copy-files",
      label: "复制文件路径（整组）",
      icon: <Files size={12} aria-hidden="true" />,
      disabled: locked,
      onSelect: onCopyFiles,
    },
    {
      key: "pinned",
      label: group.pinned ? "取消置顶" : "置顶分组",
      icon: <Pin size={12} aria-hidden="true" />,
      trailing: group.pinned ? <span className="clip-menu-state">已置顶</span> : undefined,
      disabled: locked,
      onSelect: () => onToggle("pinned"),
    },
    {
      key: "favorite",
      label: group.favorite ? "取消收藏" : "收藏分组",
      icon: <Star size={12} aria-hidden="true" />,
      trailing: group.favorite ? <span className="clip-menu-state">已收藏</span> : undefined,
      disabled: locked,
      onSelect: () => onToggle("favorite"),
    },
  ];

  return (
    <article
      ref={cardRef}
      data-clip-id={group.id}
      className={`clip-group-card ${selected ? "selected" : ""} ${removing ? "removing" : ""} ${pending ? "pending" : ""}`}
      onClick={locked ? undefined : onDetail}
      aria-label={`分组 ${group.name}，${composition.join("、") || `${group.item_count} 项`}`}
      aria-hidden={removing || undefined}
      // 离场期间整棵子树不可交互：inert 补上 pointer-events 挡不住的键盘焦点
      inert={removing || undefined}
      aria-busy={pending || undefined}
    >
      <button
        className="clip-check"
        aria-label={selected ? "取消选择分组" : "选择分组"}
        aria-pressed={selected}
        disabled={locked}
        onClick={(e) => {
          stop(e);
          onSelect();
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {selected ? <CheckSquare size={14} /> : <Square size={14} />}
      </button>

      <div
        ref={previewRef}
        className={`clip-group-preview ${family} ${hasCover ? "has-cover" : ""}`}
      >
        {hasCover ? (
          covers.length > 0 ? (
            <div className="clip-cover-stack">
              {covers.map((item, i) => (
                <ClipboardThumb
                  key={item.id}
                  itemId={item.id}
                  hasThumb={item.has_thumb}
                  size={44}
                  enabled={previewVisible}
                  openLabel={`查看分组第 ${i + 1} 张截图`}
                  onOpen={() => onOpenImage(item)}
                />
              ))}
            </div>
          ) : (
            <span className={`clip-type-tile ${family}`} aria-hidden="true">
              <ImageIcon size={18} />
            </span>
          )
        ) : (
          typeTile
        )}
        {/* 数量徽标移到缩略图旁：不压住封面内容；单图不重复显示数量。 */}
        {hasCover && group.image_count > covers.length && (
          <span className="clip-cover-total" aria-hidden="true">
            {group.image_count}
          </span>
        )}
      </div>

      <div className="clip-item-main">
        <div className="clip-item-top">
          {group.status === "collecting" && (
            <span className="clip-badge live">{groupStatusLabel(group.status)}</span>
          )}
          {group.pinned && <Pin size={10} className="clip-flag" aria-label="已置顶" />}
          {group.favorite && <Star size={10} className="clip-flag favorite" aria-label="已收藏" />}
          <span className="clip-time">{clipboardTime(group.updated_at)}</span>
        </div>
        <div className="clip-group-name" data-tip={`分组名：${group.name}`}>
          {group.name}
        </div>
        {hasSummary && <div className="clip-preview clip-group-summary">{summary}</div>}
        {/* 类型数量与模式属于次要信息，合并到一行弱化展示，避免顶部堆满标签 */}
        <div className="clip-meta">
          <span>
            {composition.join(" · ") || `${group.item_count} 项`}
            {/* 尺寸只属于单图组；多图组的首图尺寸不能冒充整组尺寸 */}
            {family === "image" && group.image_count === 1 && coverSize && ` · ${coverSize}`}
            {group.mode !== "auto" && ` · ${groupModeLabel(group.mode)}`}
          </span>
        </div>
      </div>

      <div className="clip-actions" onClick={stop}>
        {linkMode && (
          <button className="btn sm primary" onClick={onLink} disabled={locked} data-tip="关联到当前任务">
            <Link2 size={11} /> 关联
          </button>
        )}
        {/* 逐项粘贴在复制左侧：与工具面板截图组行的操作顺序一致。 */}
        <button
          className="icon-btn sm"
          data-tip="逐项粘贴到当前窗口"
          aria-label="逐项粘贴"
          onClick={onPaste}
          disabled={locked}
        >
          <Play size={12} />
        </button>
        <button
          className="icon-btn sm"
          data-tip="复制整组（富文本）"
          aria-label="复制整组内容"
          onClick={onCopyRich}
          disabled={locked}
        >
          <Copy size={12} />
        </button>
        <button
          className="icon-btn sm"
          data-tip="查看分组详情"
          aria-label="查看分组详情"
          onClick={onDetail}
          disabled={locked}
        >
          <Maximize2 size={12} />
        </button>
        <DropdownMenu
          trigger={({ ref, expanded, onClick, onKeyDown }) => (
            <button
              ref={ref}
              type="button"
              className="icon-btn sm"
              data-tip="更多操作"
              aria-label="更多操作"
              aria-expanded={expanded}
              disabled={locked}
              onClick={onClick}
              onKeyDown={onKeyDown}
            >
              <MoreHorizontal size={12} />
            </button>
          )}
          items={moreItems}
          menuLabel={`分组更多操作：${group.name}`}
          menuMinWidth={190}
          placement="bottom-end"
          className="clip-group-menu"
        />
        {/* 删除与普通操作分离：中间隔一段空白，避免误点 */}
        <span className="clip-actions-sep" aria-hidden="true" />
        <button
          className="icon-btn sm danger-ghost"
          data-tip="删除分组（保留条目）"
          aria-label="删除分组"
          onClick={onDelete}
          disabled={locked}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </article>
  );
}
