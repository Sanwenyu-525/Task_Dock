//! 分组卡片：类型预览（截图封面/类型图标）、摘要、整组操作、详情与删除。
//!
//! 2026-11-19 精修：
//! - 删除与条目卡片一致，收回「更多操作」菜单（危险动作 + 说明），动作行只保留
//!   整组复制、逐项粘贴与更多；不再有独立的「查看详情」重复入口。
//! - 标题区改为真实按钮：鼠标点卡片空白仍打开详情，键盘用户有一个可见、可聚焦
//!   的入口；内部按钮的 Enter/Space 不会串到根节点。
//! - 卡片的顶部/正文/元数据/动作四段式与条目卡片同源，行内元数据贴底。

import { useLayoutEffect, useRef } from "react";
import {
  CheckSquare, Copy, Files, Image as ImageIcon, Layers, Link2, MoreHorizontal,
  Pin, Play, Square, Star, Trash2, Type,
} from "lucide-react";
import type { ClipboardGroup, ClipboardItem } from "../../lib/bridge";
import {
  clipboardTime, groupComposition, groupCoverSize, groupExcerpt, groupFamily,
  groupKindCounts, groupModeLabel, groupStatusLabel, linkSummary, urlDomain,
} from "../../lib/clipboardUi";
import type { ClipboardDensity } from "../../lib/clipboardDensity";
import DropdownMenu, { type DropdownMenuItem } from "../ui/DropdownMenu";
import { ClipboardThumb, useCompactViewport, useInViewport } from "./Media";

const COVER_LIMIT = 3;

export default function ClipboardGroupCard({
  group,
  selected,
  linkMode,
  removing,
  pending,
  density,
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
  /** 页面态密度；不传为抽屉/工具面板行布局。分组只在舒适态放大封面。 */
  density?: ClipboardDensity;
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
    { key: "sep", separator: true, disabled: true } as DropdownMenuItem,
    {
      key: "delete",
      label: "删除分组",
      description: "条目仍保留在历史中",
      icon: <Trash2 size={12} aria-hidden="true" />,
      danger: true,
      disabled: locked,
      onSelect: onDelete,
    },
  ];

  return (
    <article
      ref={cardRef}
      data-clip-id={group.id}
      className={`clip-group-card density-${density ?? "row"} ${selected ? "selected" : ""} ${removing ? "removing" : ""} ${pending ? "pending" : ""}`}
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

      <button
        type="button"
        className="clip-item-main clip-group-main"
        aria-label={`打开分组详情：${group.name}`}
        disabled={locked}
        onClick={(e) => {
          stop(e);
          onDetail();
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <span className="clip-item-top">
          {group.status === "collecting" && (
            <span className="clip-badge live">{groupStatusLabel(group.status)}</span>
          )}
          {group.pinned && <Pin size={10} className="clip-flag" aria-label="已置顶" />}
          {group.favorite && <Star size={10} className="clip-flag favorite" aria-label="已收藏" />}
          <span className="clip-time">{clipboardTime(group.updated_at)}</span>
        </span>
        <span className="clip-group-name" data-tip={`分组名：${group.name}`}>
          {group.name}
        </span>
        {hasSummary && <span className="clip-preview clip-group-summary">{summary}</span>}
        {/* 类型数量与模式属于次要信息，统一贴底展示，避免顶部堆满标签 */}
        <span className="clip-meta">
          <span>
            {composition.join(" · ") || `${group.item_count} 项`}
            {/* 尺寸只属于单图组；多图组的首图尺寸不能冒充整组尺寸 */}
            {family === "image" && group.image_count === 1 && coverSize && ` · ${coverSize}`}
            {/* 自动/手动分组都显式标出：自动分组是后端行为，用户需要能分辨。 */}
            {` · ${groupModeLabel(group.mode)}分组`}
          </span>
        </span>
      </button>

      <div className="clip-actions" onClick={stop}>
        {linkMode && (
          <button className="btn sm primary" onClick={onLink} disabled={locked} data-tip="关联到当前任务">
            <Link2 size={11} /> 关联
          </button>
        )}
        <button
          className="btn sm clip-copy-btn"
          data-tip="复制整组（富文本）"
          aria-label="复制整组内容"
          onClick={onCopyRich}
          disabled={locked}
        >
          <Copy size={12} aria-hidden="true" /> 复制整组
        </button>
        {/* 逐项粘贴在复制右侧：与工具面板截图组行的操作顺序一致。 */}
        <button
          className="icon-btn sm"
          data-tip="逐项粘贴到当前窗口"
          aria-label="逐项粘贴"
          onClick={onPaste}
          disabled={locked}
        >
          <Play size={12} />
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
          menuMinWidth={208}
          placement="bottom-end"
          className="clip-group-menu"
        />
      </div>
    </article>
  );
}
