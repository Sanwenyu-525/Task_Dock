//! 历史条目卡片：类型/预览/来源/时间 + 复制、收藏、置顶、删除、关联。
//!
//! 2026-11-19 第三轮精修：
//! - 卡片内部固定为「顶行 → [大图] → 正文 → 动作」四段式；正文区吃掉行内剩余
//!   高度，元数据贴底，动作行对齐，同一网格行的卡片因此能真正等高。
//! - 删除卡片底部的「查看详情」图标：卡片主体打开右栏预览，右栏提供完整详情；
//!   没有右栏宿主时主体自动回退完整详情，不再保留第二个同义入口。
//! - 复制与目标窗口组成分体按钮（同一块表面、明确分隔），避免两枚独立按钮
//!   看起来像两个互不相关的动作。
//! - `previewed` 与 `selected` 是两条独立状态：前者表示右栏正在展示，后者表示
//!   批量勾选；两者可同时存在，样式不互相覆盖。
//!
//! 三种密度只影响「呈现」：舒适（大图 + 多行正文）、紧凑（小图 + 少行）、
//! 列表（单列行）。所有布局由 CSS Grid 区域决定，组件不做宽度测量。

import { useLayoutEffect, useRef } from "react";
import {
  ArrowUpRight, CheckSquare, Code2, Copy, Eye, ExternalLink, Files, Globe,
  Image as ImageIcon, Link2, MoreHorizontal, Pin, Square, Star, Trash2, Type,
} from "lucide-react";
import type { ClipboardItem } from "../../lib/bridge";
import {
  clipSource, clipboardTime, fileBaseName, fileDirName, formatBytes, kindLabel, linkSummary,
} from "../../lib/clipboardUi";
import { fileTypeFromName } from "../../lib/fileTypeUi";
import type { ClipboardDensity } from "../../lib/clipboardDensity";
import DropdownMenu, { type DropdownMenuItem } from "../ui/DropdownMenu";
import { ClipboardHeroImage, ClipboardThumb, useCompactViewport, useInViewport } from "./Media";

/** 卡片窄于此宽度（含内边距）时辅助动作收回菜单，避免动作行溢出或挤掉复制。 */
const AUX_ACTIONS_MIN_WIDTH = 260;

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
  previewed = false,
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
  /** 右栏正在展示这条内容；与 `selected`（批量勾选）互不覆盖。 */
  previewed?: boolean;
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
  const headline = (item.title || "").trim();
  const rawPreview = (item.preview || "").trim();
  const isImage = item.kind === "image";
  const files = item.file_paths;
  const isFiles = item.kind === "files";
  const link = item.kind === "url" ? linkSummary(item.preview) : null;
  // 图片自动标题就是分辨率（截图 1280×720）：分辨率已在元数据里，卡面不再重复一行；
  // 有真实文件名的图片仍显示标题。
  const autoImageTitle = isImage && /^截图\s*\d+[×x]\d+$/i.test(headline);
  // 链接标题恰好等于域名且 URL 没有更多路径时不重复；有路径仍要展示 URL 摘要。
  const linkTitleIsDomain =
    !!link && !!headline && !link.rest && link.domain.toLowerCase() === headline.toLowerCase();
  // 标题已经重复表达了同一信息时不再多画一行：
  // - 图片自动标题「截图 1280×720」与 preview 相同；
  // - 链接标题本身就是域名（此时正文只保留域名 + 路径）；
  // - 文件卡片的「3 个文件」由文件清单与标题共同表达。
  const duplicatePreview =
    (isImage && !!headline && rawPreview === headline) ||
    linkTitleIsDomain ||
    (isFiles && files.length > 0);
  const showPreview = !duplicatePreview && (rawPreview !== "" || !headline);
  const cardRef = useRef<HTMLElement>(null);
  const [previewRef, viewportVisible] = useInViewport<HTMLElement>();

  // 收拢动画需要卡片自身的真实高度；只对被删除的卡片测量一次，不常驻、不轮询。
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (removing && el) el.style.setProperty("--clip-exit-h", `${el.offsetHeight}px`);
  }, [removing]);

  // 卡片态：comfort/compact；list 与抽屉态都是「行」布局。
  const isCard = density === "comfort" || density === "compact";
  const hasHero = isImage && density === "comfort";
  const hasThumb = isImage && !hasHero;
  // 竖图（长截图 / 手机截图）在固定高度的舞台里会被缩成一条窄带，
  // 无法直接识别内容；给舒适卡一个更高舞台，宽图仍保持矮卡，避免无谓拉高。
  const isTallImage = hasHero && (item.image_height ?? 0) > (item.image_width ?? 0) * 1.2;
  // 大图只在进入视口后才请求 640px 预览；离场/删除中的卡片不需要。
  const heroEnabled = viewportVisible && !locked && item.has_thumb;
  const fileRows = files.slice(0, fileRowsForDensity(density));
  const firstFileDir = files[0] ? fileDirName(files[0]) : "";
  const openMain = locked ? undefined : (onPreview ?? onDetail);
  const openLabel = onPreview ? "打开右侧预览" : "打开完整详情";

  // 辅助动作是否内联：页面态卡片才有独立动作行（抽屉是行布局），任务关联模式
  // 还要放「关联」按钮，二者都保持收进菜单；宽度测量沿用分组卡片的同一 hook，
  // 只在翻转时 setState，不做轮询或高频测量。
  const narrowCard = useCompactViewport(previewRef, AUX_ACTIONS_MIN_WIDTH);
  const inlineAux = density !== undefined && !linkMode && !narrowCard;

  // 类型专属项先排；删除单独留在菜单末尾。
  // 图片大图与卡片主体预览都由大图/正文入口承担，不在菜单里再放同义项。
  const leadingItems: DropdownMenuItem[] = [
    ...(link && onOpenUrl
      ? [{
          key: "open-url",
          label: "在浏览器中打开",
          icon: <ExternalLink size={12} aria-hidden="true" />,
          disabled: locked,
          onSelect: onOpenUrl,
        }]
      : []),
    // 收藏/置顶在宽卡片已经内联；窄卡才作为兜底入口。详情不再出现在菜单里：
    // 卡片主体 + 右栏「完整详情」已经是唯一入口链。
    ...(inlineAux
      ? []
      : [
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
        ]),
  ];

  const moreItems: DropdownMenuItem[] = [
    ...leadingItems,
    // 分隔线只在删除前确有普通动作时出现；菜单仅剩删除时不做一条悬空的分隔线。
    ...(leadingItems.length > 0
      ? [{ key: "sep", separator: true, disabled: true } as DropdownMenuItem]
      : []),
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
      } ${isTallImage ? "is-tall" : ""} ${selected ? "selected" : ""} ${
        previewed ? "previewed" : ""
      } ${removing ? "removing" : ""} ${pending ? "pending" : ""}`}
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
        {previewed && (
          <span className="clip-preview-tag" data-tip="当前右侧面板正在预览这条内容">
            <Eye size={10} aria-hidden="true" /> 预览中
          </span>
        )}
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
          src.app ? `；来源 ${src.app}${src.window ? ` · ${src.window}` : ""}` : ""
        }${openMain ? `，${openLabel}` : ""}`}
      >
        <span className="clip-preview">
          <span className="clip-preview-body">
            {headline && !autoImageTitle && (
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
            {firstFileDir && (
              <span className="clip-file-note clip-file-dir" data-tip={firstFileDir}>
                来源目录 {firstFileDir}
              </span>
            )}
            <span className="clip-file-note">仅记录路径，删除历史不会删除本地文件</span>
          </span>
        )}

        {/* 来源只是辅助元数据：应用名 + 窗口标题 + 大小/次数/分辨率统一贴底。
            窗口标题在窄卡隐藏（完整值仍在主按钮 aria-label 与右栏中），
            避免元数据换行把同一行卡片重新拉出参差。 */}
        <span className="clip-meta">
          <span className="clip-meta-app" title={src.appRaw || undefined}>
            {src.app}
          </span>
          {src.window && density !== "compact" && !narrowCard && (
            <span className="clip-meta-window" data-tip={`窗口：${src.window}${src.appRaw ? `（来源进程 ${src.appRaw}）` : ""}`}>
              <span className="clip-meta-window-tag">窗口</span>
              {src.window}
            </span>
          )}
          <span className="clip-meta-facts">
            {isImage && item.image_width && item.image_height && (
              <span>{item.image_width}×{item.image_height}</span>
            )}
            <span>{formatBytes(item.byte_size)}</span>
            {item.copy_count > 0 && <span className="clip-meta-use">使用 {item.copy_count} 次</span>}
          </span>
        </span>
      </button>

      <div className="clip-actions" onClick={stop}>
        {linkMode && (
          <button className="btn sm primary" onClick={onLink} disabled={locked} data-tip="关联到当前任务">
            <Link2 size={11} /> 关联
          </button>
        )}
        {/* 复制是最高频操作：文字标签 + 同一块表面里的目标窗口箭头。
            主按钮 = 直接复制；箭头 = 打开目标窗口选择器（复制并切换 / 粘贴）。 */}
        <span className="clip-copy-split">
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
          {onCopySwitch && (
            <button
              type="button"
              className="clip-copy-arrow"
              data-tip="复制或粘贴到目标窗口"
              aria-label="复制或粘贴到目标窗口"
              onClick={onCopySwitch}
              disabled={locked}
            >
              <ArrowUpRight size={12} aria-hidden="true" />
            </button>
          )}
        </span>
        {/* 空间足够时辅助动作直接常显：图标语义、状态反馈（aria-pressed + active）
            与详情页同一口径；窄卡仍走「更多」菜单，不在两处重复同一动作。
            详情入口已从动作行移除：卡片主体 → 右栏预览 → 完整详情，一条链路。 */}
        {inlineAux && (
          <>
            <button
              type="button"
              className={`icon-btn sm ${item.favorite ? "active" : ""}`}
              data-tip={item.favorite ? "取消收藏" : "收藏"}
              aria-label={item.favorite ? "取消收藏" : "收藏"}
              aria-pressed={item.favorite}
              onClick={() => onToggle("favorite")}
              disabled={locked}
            >
              <Star size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`icon-btn sm ${item.pinned ? "active" : ""}`}
              data-tip={item.pinned ? "取消置顶" : "置顶"}
              aria-label={item.pinned ? "取消置顶" : "置顶"}
              aria-pressed={item.pinned}
              onClick={() => onToggle("pinned")}
              disabled={locked}
            >
              <Pin size={12} aria-hidden="true" />
            </button>
          </>
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
