//! 历史条目卡片：类型/预览/来源/时间 + 复制、收藏、置顶、详情、删除、关联。

import { useLayoutEffect, useRef } from "react";
import {
  CheckSquare, Code2, Copy, Files, Globe, Image as ImageIcon, Link2, Maximize2,
  Pin, Square, Star, Trash2, Type,
} from "lucide-react";
import type { ClipboardItem } from "../../lib/bridge";
import { clipSource, clipboardTime, fileBaseName, formatBytes, kindLabel } from "../../lib/clipboardUi";
import { ClipboardThumb } from "./Media";

const KIND_ICONS: Record<string, typeof Type> = {
  text: Type,
  url: Globe,
  html: Code2,
  image: ImageIcon,
  files: Files,
};

export default function ClipboardItemCard({
  item,
  selected,
  linkMode,
  removing,
  pending,
  onSelect,
  onCopy,
  onToggle,
  onDetail,
  onDelete,
  onLink,
  onOpenImage,
}: {
  item: ClipboardItem;
  selected: boolean;
  linkMode: boolean;
  /** 已删除、正在播放退出动画：动画结束后才会从列表移除 */
  removing: boolean;
  /** 删除请求在途（后端尚未确认）：显示执行中并挡住重复操作 */
  pending: boolean;
  onSelect: () => void;
  onCopy: () => void;
  onToggle: (flag: "favorite" | "pinned") => void;
  onDetail: () => void;
  onDelete: () => void;
  onLink: () => void;
  /** 图片条目：点缩略图直接看大图（不传则缩略图只是展示） */
  onOpenImage?: () => void;
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

  // 收拢动画需要卡片自身的真实高度；只对被删除的卡片测量一次，不常驻、不轮询。
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (removing && el) el.style.setProperty("--clip-exit-h", `${el.offsetHeight}px`);
  }, [removing]);

  return (
    <article
      ref={cardRef}
      data-clip-id={item.id}
      className={`clip-item ${selected ? "selected" : ""} ${removing ? "removing" : ""} ${pending ? "pending" : ""}`}
      onClick={locked ? undefined : onDetail}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !locked) onDetail();
      }}
      tabIndex={locked ? -1 : 0}
      role="button"
      aria-hidden={removing || undefined}
      // 离场期间整棵子树不可交互：不能只靠 pointer-events，Tab 仍能把焦点
      // 送进 aria-hidden 的元素（无障碍违规）；inert 把内部控件全部隔离。
      inert={removing || undefined}
      aria-busy={pending || undefined}
      aria-label={`${kindLabel(item.kind)}：${headline || item.preview || "空内容"}`}
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
        onKeyDown={(e) => e.stopPropagation()}
      >
        {selected ? <CheckSquare size={14} /> : <Square size={14} />}
      </button>

      <div className="clip-item-main">
        <div className="clip-item-top">
          <span className={`clip-kind kind-${item.kind}`}>
            <Icon size={11} /> {kindLabel(item.kind)}
          </span>
          {item.pinned && <Pin size={10} className="clip-flag" aria-label="已置顶" />}
          {item.favorite && <Star size={10} className="clip-flag favorite" aria-label="已收藏" />}
          <span className="clip-time">{clipboardTime(item.last_seen_at)}</span>
        </div>

        <div className={`clip-preview ${item.kind === "image" ? "with-thumb" : ""}`}>
          {item.kind === "image" && (
            <ClipboardThumb
              itemId={item.id}
              hasThumb={item.has_thumb}
              size={44}
              onOpen={locked ? undefined : onOpenImage}
            />
          )}
          <div className="clip-preview-body">
            {headline && (
              <span
                className="clip-title"
                tabIndex={0}
                data-tip={`标题：${headline}`}
                aria-label={`标题：${headline}`}
              >
                {headline}
              </span>
            )}
            {showPreview && (
              <span
                className={`${
                  item.kind === "text" || item.kind === "html" ? "clip-text" : ""
                } ${headline ? "clip-preview-sub" : ""}`}
              >
                {item.preview || "（无文本预览）"}
              </span>
            )}
          </div>
        </div>

        {/* 来源只是辅助元数据：应用名 + 「窗口」标题，不抢标题与预览的层级。
            窗口标题会被截断，完整内容与原始 exe 放进提示条；
            `data-tip` 同时覆盖鼠标悬停与键盘焦点（TooltipLayer 监听 focusin）。 */}
        <div className="clip-meta">
          <span className="clip-meta-app" title={src.appRaw || undefined}>
            {src.app}
          </span>
          {src.window && (
            <span
              className="clip-meta-window"
              tabIndex={0}
              data-tip={`窗口：${src.window}${src.appRaw ? `（来源进程 ${src.appRaw}）` : ""}`}
              aria-label={`窗口：${src.window}`}
            >
              <span className="clip-meta-window-tag">窗口</span>
              {src.window}
            </span>
          )}
          <span>{formatBytes(item.byte_size)}</span>
          {item.copy_count > 0 && <span>使用 {item.copy_count} 次</span>}
        </div>

        {item.file_paths.length > 0 && (
          <div className="clip-file-list">
            {item.file_paths.slice(0, 3).map((p) => (
              <span key={p} title={p}>{fileBaseName(p)}</span>
            ))}
            {item.file_paths.length > 3 && <span>… 共 {item.file_paths.length} 个</span>}
          </div>
        )}
      </div>

      <div className="clip-actions" onClick={stop}>
        {linkMode && (
          <button className="btn sm primary" onClick={onLink} disabled={locked} data-tip="关联到当前任务">
            <Link2 size={11} /> 关联
          </button>
        )}
        <button className="icon-btn sm" data-tip="复制" aria-label="复制" onClick={onCopy} disabled={locked}>
          <Copy size={12} />
        </button>
        <button
          className={`icon-btn sm ${item.pinned ? "active" : ""}`}
          data-tip={item.pinned ? "取消置顶" : "置顶"}
          aria-label={item.pinned ? "取消置顶" : "置顶"}
          aria-pressed={item.pinned}
          onClick={() => onToggle("pinned")}
          disabled={locked}
        >
          <Pin size={12} />
        </button>
        <button
          className={`icon-btn sm ${item.favorite ? "active" : ""}`}
          data-tip={item.favorite ? "取消收藏" : "收藏"}
          aria-label={item.favorite ? "取消收藏" : "收藏"}
          aria-pressed={item.favorite}
          onClick={() => onToggle("favorite")}
          disabled={locked}
        >
          <Star size={12} />
        </button>
        <button className="icon-btn sm" data-tip="详情" aria-label="详情" onClick={onDetail} disabled={locked}>
          <Maximize2 size={12} />
        </button>
        <button
          className="icon-btn sm danger-ghost"
          data-tip="删除"
          aria-label="删除"
          onClick={onDelete}
          disabled={locked}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </article>
  );
}
