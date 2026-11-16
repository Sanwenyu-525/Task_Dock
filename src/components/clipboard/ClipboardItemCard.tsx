//! 历史条目卡片：类型/预览/来源/时间 + 复制、收藏、置顶、详情、删除、关联。
//!
//! 2026-11-16 结构重排（工作台大卡片）：
//! - 卡片根节点**不再**是 `role="button"`：它同时包含选择框、主预览按钮、复制与
//!   更多菜单等真实按钮，嵌套按钮既违反 ARIA，也会让 Enter 同时触发「打开详情」
//!   与「激活内部按钮」两个动作。
//! - 主预览入口是一个真实 `<button class="clip-item-main">`，Enter/Space 只触发它
//!   自己的 click，且键盘焦点永远落在可见控件上。
//! - 图片改为独立的 `<button class="clip-hero">`（与正文按钮并列，不嵌套），
//!   点击直接进灯箱；列表/抽屉态仍用小缩略图，不加载大图。
//! - 辅助动作（收藏/置顶/详情/删除/打开链接）统一收进 DropdownMenu，
//!   菜单弹出不改变卡片高度，也不再挤占行内空间。
//!
//! 三种密度只影响「呈现」：舒适（大图 + 多行正文）、紧凑（小图 + 少行）、
//! 列表（单列行）。所有布局由 CSS Grid 区域决定，组件不做宽度测量。

import { useLayoutEffect, useRef } from "react";
import {
  ArrowUpRight, CheckSquare, Code2, Copy, ExternalLink, Files, Globe,
  Image as ImageIcon, Link2, Maximize2, MoreHorizontal, Pin, Square, Star, Trash2, Type,
} from "lucide-react";
import type { ClipboardItem } from "../../lib/bridge";
import {
  clipSource, clipboardTime, fileBaseName, formatBytes, kindLabel, linkSummary,
} from "../../lib/clipboardUi";
import { fileTypeFromName } from "../../lib/fileTypeUi";
import type { ClipboardDensity } from "../../lib/clipboardDensity";
import DropdownMenu from "../ui/DropdownMenu";
import { ClipboardHeroImage, ClipboardThumb, useInViewport } from "./Media";

const KIND_ICONS: Record<string, typeof Type> = {
  text: Type,
  url: Globe,
  html: Code2,
  image: ImageIcon,
  files: Files,
};

/** 文件行按密度收敛：舒适 5 行、紧凑 3 行、列表 2 行，其余用「+N」汇总。 */
function fileRowsForDensity(density?: ClipboardDensity): number {
  if (density === "comfort") return 5;
  if (density === "compact") return 3;
  return 2;
}

export default function ClipboardItemCard({
  item,
  selected,
  linkMode,
  removing,
  pending,
  density,
  onSelect,
  onCopy,
  onCopySwitch,
  onToggle,
  onDetail,
  onPreview,
  onDelete,
  onLink,
  onOpenImage,
  onOpenUrl,
}: {
  item: ClipboardItem;
  selected: boolean;
  linkMode: boolean;
  /** 已删除、正在播放退出动画：动画结束后才会从列表移除 */
  removing: boolean;
  /** 删除请求在途（后端尚未确认）：显示执行中并挡住重复操作 */
  pending: boolean;
  /** 页面密度；不传表示抽屉/工具面板的「行」布局（保持原行为）。 */
  density?: ClipboardDensity;
  onSelect: () => void;
  onCopy: () => void;
  /** 打开「复制并切换到…」完整面板；不传则不显示跳转箭头 */
  onCopySwitch?: () => void;
  onToggle: (flag: "favorite" | "pinned") => void;
  onDetail: () => void;
  /** 点卡片主体：在右栏显示所选内容预览（页面态）；不传时退回完整详情。 */
  onPreview?: () => void;
  onDelete: () => void;
  onLink: () => void;
  /** 图片条目：点图片直接看大图（不传则只是展示） */
  onOpenImage?: () => void;
  /** 链接条目：在浏览器中打开（显式用户操作，不自动访问） */
  onOpenUrl?: () => void;
}) {
  const Icon = KIND_ICONS[item.kind] ?? Type;
  const src = clipSource(item);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  // 在途或正在离场：整卡冻结，任何再次操作都只会制造第二次删除或打开已消失的详情
  const locked = removing || pending;
  // 标题优先展示（自动生成或手动编辑）；有标题时预览降为次行弱化信息
  const headline = item.title || "";
  const showPreview = item.preview !== "" || !headline;
  const cardRef = useRef<HTMLElement>(null);
  const [previewRef, viewportVisible] = useInViewport<HTMLElement>();

  // 收拢动画需要卡片自身的真实高度；只对被删除的卡片测量一次，不常驻、不轮询。
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (removing && el) el.style.setProperty("--clip-exit-h", `${el.offsetHeight}px`);
  }, [removing]);

  const isImage = item.kind === "image";
  // 卡片态：comfort/compact；list 与抽屉态都是「行」布局。
  const isCard = density === "comfort" || density === "compact";
  const hasHero = isImage && density === "comfort";
  const hasThumb = isImage && !hasHero;
  // 大图只在进入视口后才请求 640px 预览；离场/删除中的卡片不需要。
  const heroEnabled = viewportVisible && !locked && item.has_thumb;
  const link = item.kind === "url" ? linkSummary(item.preview) : null;
  const files = item.file_paths;
  const fileRows = files.slice(0, fileRowsForDensity(density));
  const openMain = locked ? undefined : (onPreview ?? onDetail);

  const moreItems = [
    ...(isImage && onOpenImage
      ? [{
          key: "image",
          label: "查看大图",
          icon: <ImageIcon size={12} aria-hidden="true" />,
          disabled: locked,
          onSelect: onOpenImage,
        }]
      : []),
    ...(link && onOpenUrl
      ? [{
          key: "open-url",
          label: "在浏览器中打开",
          icon: <ExternalLink size={12} aria-hidden="true" />,
          disabled: locked,
          onSelect: onOpenUrl,
        }]
      : []),
    {
      key: "favorite",
      label: item.favorite ? "取消收藏" : "收藏",
      icon: <Star size={12} aria-hidden="true" />,
      trailing: item.favorite ? <span className="clip-menu-state">已收藏</span> : undefined,
      disabled: locked,
      onSelect: () => onToggle("favorite"),
    },
    {
      key: "pinned",
      label: item.pinned ? "取消置顶" : "置顶",
      icon: <Pin size={12} aria-hidden="true" />,
      trailing: item.pinned ? <span className="clip-menu-state">已置顶</span> : undefined,
      disabled: locked,
      onSelect: () => onToggle("pinned"),
    },
    {
      key: "detail",
      label: "查看详情",
      icon: <Maximize2 size={12} aria-hidden="true" />,
      disabled: locked,
      onSelect: onDetail,
    },
    { key: "sep", separator: true as const, disabled: true },
    {
      key: "delete",
      label: "删除这条历史",
      description: "不会删除本地文件",
      icon: <Trash2 size={12} aria-hidden="true" />,
      danger: true,
      disabled: locked,
      onSelect: onDelete,
    },
  ];

  return (
    <article
      ref={previewRef}
      // 兼容既有滚动锚点/离场快照：id 仍写在卡片根节点。
      data-clip-id={item.id}
      className={`clip-item ${isCard ? "is-card" : "is-row"} ${hasHero ? "is-hero" : ""} ${
        hasThumb ? "is-thumb" : ""
      } ${selected ? "selected" : ""} ${removing ? "removing" : ""} ${pending ? "pending" : ""}`}
      // 离场期间整棵子树不可交互：不能只靠 pointer-events，Tab 仍能把焦点
      // 送进 aria-hidden 的元素（无障碍违规）；inert 把内部控件全部隔离。
      inert={removing || undefined}
      aria-busy={pending || undefined}
    >
      <button
        className="clip-check"
        aria-label={selected ? "取消选择" : "选择条目"}
        aria-pressed={selected}
        disabled={locked}
        onClick={(e) => {
          stop(e);
          onSelect();
        }}
      >
        {selected ? <CheckSquare size={14} /> : <Square size={14} />}
      </button>

      <div className="clip-item-top">
        <span className={`clip-kind kind-${item.kind}`}>
          <Icon size={11} /> {kindLabel(item.kind)}
        </span>
        {item.pinned && <Pin size={10} className="clip-flag" aria-label="已置顶" />}
        {item.favorite && <Star size={10} className="clip-flag favorite" aria-label="已收藏" />}
        <span className="clip-time">{clipboardTime(item.last_seen_at)}</span>
      </div>

      {hasHero && (
        <ClipboardHeroImage
          itemId={item.id}
          hasThumb={item.has_thumb}
          enabled={heroEnabled}
          onOpen={locked ? undefined : onOpenImage}
          label={`查看大图：${headline || item.preview || "剪贴板图片"}`}
        />
      )}

      {hasThumb && (
        <ClipboardThumb
          itemId={item.id}
          hasThumb={item.has_thumb}
          size={density === "compact" ? 64 : 44}
          enabled={viewportVisible && item.has_thumb}
          onOpen={locked ? undefined : onOpenImage}
        />
      )}

      {/* 主预览入口：真实按钮（不是包着按钮的假按钮），Enter/Space 只触发一次。
          `aria-label` 给出完整语义，正文仍留在按钮内供读屏逐段朗读。 */}
      <button
        type="button"
        className="clip-item-main"
        onClick={openMain}
        disabled={locked}
        aria-label={`${kindLabel(item.kind)}：${headline || item.preview || "空内容"}${
          openMain ? "，打开预览" : ""
        }`}
      >
        <span className="clip-preview">
          <span className="clip-preview-body">
            {headline && (
              <span className="clip-title" data-tip={`标题：${headline}`}>
                {headline}
              </span>
            )}
            {showPreview && (
              <span
                className={`${item.kind === "text" || item.kind === "html" ? "clip-text" : ""} ${
                  headline ? "clip-preview-sub" : ""
                }`}
              >
                {link ? (
                  <span className="clip-link-summary">
                    <span className="clip-link-domain">{link.domain}</span>
                    {link.rest && <span className="clip-link-rest">{link.rest}</span>}
                  </span>
                ) : (
                  item.preview || "（无文本预览）"
                )}
              </span>
            )}
          </span>
        </span>

        {/* 来源只是辅助元数据：应用名 + 「窗口」标题，不抢标题与预览的层级。
            窗口标题会被截断，完整内容与原始 exe 放进提示条。 */}
        <span className="clip-meta">
          <span className="clip-meta-app" title={src.appRaw || undefined}>
            {src.app}
          </span>
          {src.window && (
            <span className="clip-meta-window" data-tip={`窗口：${src.window}${src.appRaw ? `（来源进程 ${src.appRaw}）` : ""}`}>
              <span className="clip-meta-window-tag">窗口</span>
              {src.window}
            </span>
          )}
          <span>{formatBytes(item.byte_size)}</span>
          {item.copy_count > 0 && <span>使用 {item.copy_count} 次</span>}
        </span>

        {files.length > 0 && (
          <span className="clip-file-list">
            {fileRows.map((path, index) => {
              const type = fileTypeFromName(path);
              const FileIcon = type.icon;
              return (
                <span className="clip-file-row" key={`${path}-${index}`}>
                  <FileIcon size={12} className={`file-tone-${type.tone} clip-file-icon`} aria-hidden="true" />
                  <span className="clip-file-name" data-tip={path}>
                    {fileBaseName(path)}
                  </span>
                  <span className="clip-file-kind">{type.label}</span>
                </span>
              );
            })}
            {files.length > fileRows.length && (
              <span className="clip-file-row clip-file-more">
                <Files size={12} aria-hidden="true" />
                还有 {files.length - fileRows.length} 个文件
              </span>
            )}
            <span className="clip-file-note">仅记录路径，删除历史不会删除本地文件</span>
          </span>
        )}
      </button>

      <div className="clip-actions" onClick={stop}>
        {linkMode && (
          <button className="btn sm primary" onClick={onLink} disabled={locked} data-tip="关联到当前任务">
            <Link2 size={11} /> 关联
          </button>
        )}
        {/* 复制是最高频操作：给文字标签，不与「更多」共用同一种小图标外观。 */}
        <button
          className="btn sm clip-copy-btn"
          data-tip="复制到系统剪贴板"
          aria-label="复制"
          onClick={onCopy}
          disabled={locked}
        >
          <Copy size={12} aria-hidden="true" />
          复制
        </button>
        {/* 分体复制：主按钮保持「直接复制」不变，右侧箭头直接打开目标窗口选择器
            （里面再选「复制并切换」或「粘贴到该窗口」）。只有一个动作就不该再套一层菜单。 */}
        {onCopySwitch && (
          <button
            type="button"
            className="icon-btn sm"
            data-tip="复制或粘贴到目标窗口"
            aria-label="复制或粘贴到目标窗口"
            onClick={onCopySwitch}
            disabled={locked}
          >
            <ArrowUpRight size={12} />
          </button>
        )}
        <DropdownMenu
          trigger={({ ref, expanded, onClick, onKeyDown }) => (
            <button
              ref={ref}
              type="button"
              className={`icon-btn sm ${expanded ? "is-open" : ""}`}
              data-tip="更多操作"
              aria-label="更多操作"
              aria-expanded={expanded}
              aria-haspopup="menu"
              disabled={locked}
              onClick={onClick}
              onKeyDown={onKeyDown}
            >
              <MoreHorizontal size={12} />
            </button>
          )}
          items={moreItems}
          menuLabel={`条目更多操作：${headline || item.preview || kindLabel(item.kind)}`}
          menuMinWidth={200}
          placement="bottom-end"
          className="clip-item-menu"
        />
      </div>
    </article>
  );
}
