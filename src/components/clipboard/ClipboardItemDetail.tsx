//! 剪贴板条目详情：完整正文/图片/文件、复制、收藏、置顶、任务关联与 Agent 导出。

import { useEffect, useState } from "react";
import {
  ArrowLeft, Check, Code2, Copy, FileText, Link2, Pencil, Pin, Star, Trash2, X,
} from "lucide-react";
import {
  clipboardCopyItem,
  clipboardDeleteItems,
  clipboardItem,
  clipboardLinkTask,
  clipboardRenameItem,
  clipboardToggleItem,
  type ClipboardItem,
} from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import {
  clipboardTime, fileBaseName, formatBytes, kindLabel, objectHint, sourceLabel,
} from "../../lib/clipboardUi";
import { useUiStore } from "../../store/useUiStore";
import { useClipboardStore } from "../../store/useClipboardStore";
import AgentExportPanel from "./AgentExportPanel";
import { ClipboardLargeImage } from "./Media";
import TaskLinkBar from "./TaskLinkBar";
import WorkspaceLinkBar from "./WorkspaceLinkBar";
import type { AskConfirm, LinkTask } from "./types";

export default function ClipboardItemDetail({
  itemId,
  linkTask,
  askConfirm,
  onBack,
  onChanged,
}: {
  itemId: string;
  linkTask: LinkTask;
  askConfirm: AskConfirm;
  onBack: () => void;
  onChanged: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const bumpLink = useUiStore((s) => s.bumpClipboardLink);
  const closeDrawer = useUiStore((s) => s.closeClipboard);
  const [item, setItem] = useState<ClipboardItem | null>(null);
  const [showHtml, setShowHtml] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    let alive = true;
    setItem(null);
    clipboardItem(itemId)
      .then((i) => {
        if (alive) setItem(i);
      })
      .catch((e) => {
        if (alive) {
          showToast(`读取条目失败：${String(e)}`, { kind: "error" });
          onBack();
        }
      });
    return () => {
      alive = false;
    };
  }, [itemId]);

  async function reload() {
    try {
      setItem(await clipboardItem(itemId));
    } catch {
      // 删除后由调用方返回列表
    }
  }

  async function onCopy() {
    setBusy(true);
    try {
      const r = await clipboardCopyItem(itemId);
      const warn = r.warnings.length > 0 ? `；${r.warnings.join("；")}` : "";
      showToast(
        `已复制（${r.mode.toUpperCase()}，${formatBytes(r.bytes)}）${warn}`,
        { kind: r.warnings.length > 0 ? "info" : "success" },
      );
      await reload();
      // 复制只增加使用次数；列表就地更新，避免整表刷新导致分页与滚动位置变化。
      useClipboardStore.getState().bumpItemCopy(itemId);
    } catch (e) {
      showToast(`复制失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(flag: "favorite" | "pinned") {
    try {
      const updated = await clipboardToggleItem(itemId, flag);
      setItem(updated);
      // 列表里的那一行也就地同步图标状态，不等整表刷新
      useClipboardStore.getState().patchItem(updated);
      showToast(
        flag === "favorite"
          ? updated.favorite ? "已收藏" : "已取消收藏，内容仍保留在历史中"
          : updated.pinned ? "已置顶，将排到列表前面" : "已取消置顶",
        { kind: "success" },
      );
      onChanged();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onRename() {
    try {
      const updated = await clipboardRenameItem(itemId, titleDraft);
      setItem(updated);
      // 列表就地更新标题，不整表刷新
      useClipboardStore.getState().renameItem(itemId, updated.title, updated.title_source);
      showToast(
        updated.title_source === "manual" ? "标题已更新" : "已恢复自动标题",
        { kind: "success" },
      );
      setEditingTitle(false);
    } catch (e) {
      showToast(`标题保存失败：${String(e)}`, { kind: "error" });
    }
  }

  async function onLinkTask() {
    if (!linkTask) return;
    try {
      await clipboardLinkTask(linkTask.id, "item", itemId);
      bumpLink();
      showToast(`已关联到任务「${linkTask.title}」`, { kind: "success" });
      closeDrawer();
    } catch (e) {
      showToast(`关联失败：${String(e)}`, { kind: "error" });
    }
  }

  function onDelete() {
    if (!item) return;
    const hint = objectHint(item);
    askConfirm({
      title: "删除这条剪贴板历史？",
      detail: "将同时从所属分组和任务关联中移除；文件条目不会删除磁盘上的原始文件。",
      confirmLabel: "删除",
      danger: true,
      run: async () => {
        const r = await clipboardDeleteItems([itemId]);
        if (r.deleted <= 0) {
          // 后端什么都没删掉：如实说明，不报成功
          showToast("这条内容已经不存在，列表已刷新", { kind: "warning" });
        } else {
          showToast(`已删除「${hint}」`, { kind: "success" });
          // 详情页没有离场动画，但必须立刻把这一行从本地视图摘掉，
          // 否则返回列表后到刷新落地前会短暂看到已经删掉的内容。
          useClipboardStore.getState().endExit([itemId]);
        }
        onChanged();
        onBack();
      },
    });
  }

  if (!item) {
    return (
      <div className="clip-detail">
        <div className="clip-detail-head">
          <button className="icon-btn sm" onClick={onBack} data-tip="返回" aria-label="返回列表">
            <ArrowLeft size={13} />
          </button>
          <span>条目详情</span>
        </div>
        <div className="clip-loading">正在读取完整内容…</div>
      </div>
    );
  }

  return (
    <div className="clip-detail">
      <div className="clip-detail-head">
        <button className="icon-btn sm" onClick={onBack} data-tip="返回" aria-label="返回列表">
          <ArrowLeft size={13} />
        </button>
        <span>
          {kindLabel(item.kind)} · {formatBytes(item.byte_size)}
        </span>
        <div className="clip-detail-actions">
          {linkTask && (
            <button className="btn sm primary" onClick={onLinkTask}>
              <Link2 size={11} /> 关联到当前任务
            </button>
          )}
          <button className="icon-btn sm" data-tip="复制" aria-label="复制" onClick={onCopy} disabled={busy}>
            <Copy size={12} />
          </button>
          <button
            className={`icon-btn sm ${item.pinned ? "active" : ""}`}
            data-tip={item.pinned ? "取消置顶" : "置顶"}
            aria-label={item.pinned ? "取消置顶" : "置顶"}
            aria-pressed={item.pinned}
            onClick={() => onToggle("pinned")}
          >
            <Pin size={12} />
          </button>
          <button
            className={`icon-btn sm ${item.favorite ? "active" : ""}`}
            data-tip={item.favorite ? "取消收藏" : "收藏"}
            aria-label={item.favorite ? "取消收藏" : "收藏"}
            aria-pressed={item.favorite}
            onClick={() => onToggle("favorite")}
          >
            <Star size={12} />
          </button>
          <button className="icon-btn sm danger-ghost" data-tip="删除" aria-label="删除" onClick={onDelete}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <div className="clip-detail-body">
        <div className="clip-title-row">
          {editingTitle ? (
            <>
              <input
                className="clip-title-input"
                value={titleDraft}
                maxLength={80}
                placeholder="输入标题；清空则恢复自动生成"
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onRename();
                  else if (e.key === "Escape") setEditingTitle(false);
                }}
              />
              <button
                className="icon-btn sm"
                data-tip="保存标题"
                aria-label="保存标题"
                onClick={() => void onRename()}
              >
                <Check size={12} />
              </button>
              <button
                className="icon-btn sm"
                data-tip="取消"
                aria-label="取消编辑标题"
                onClick={() => setEditingTitle(false)}
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <>
              <span className="clip-title-text" title={item.title}>
                {item.title || item.preview || "（无标题）"}
              </span>
              {item.title_source === "manual" && (
                <span className="clip-title-flag">手动</span>
              )}
              <button
                className="icon-btn sm"
                data-tip={item.title ? "编辑标题" : "设置标题"}
                aria-label={item.title ? "编辑标题" : "设置标题"}
                onClick={() => {
                  setTitleDraft(item.title);
                  setEditingTitle(true);
                }}
              >
                <Pencil size={12} />
              </button>
            </>
          )}
        </div>
        <div className="clip-detail-meta">
          <span title={item.source_title || item.source_app}>{sourceLabel(item.source_app, item.source_title)}</span>
          <span>创建 {clipboardTime(item.created_at)}</span>
          <span>最近 {clipboardTime(item.last_seen_at)}</span>
          {item.copy_count > 0 && <span>已使用 {item.copy_count} 次</span>}
          {item.kind === "image" && item.image_width && item.image_height && (
            <span>{item.image_width}×{item.image_height}</span>
          )}
        </div>

        {item.kind === "image" && (
          <div className="clip-image-wrap">
            <ClipboardLargeImage itemId={item.id} />
          </div>
        )}

        {item.file_paths.length > 0 && (
          <div className="clip-path-block">
            <div className="clip-block-head">
              <span>文件路径（{item.file_paths.length}）</span>
              <button
                className="btn sm"
                onClick={async () => {
                  const ok = await copyText(item.file_paths.join("\n"));
                  showToast(ok ? "路径已复制" : "复制失败", { kind: ok ? "success" : "error" });
                }}
              >
                <Copy size={11} /> 复制路径
              </button>
            </div>
            <ul className="clip-path-list">
              {item.file_paths.map((p) => (
                <li key={p} title={p}>
                  <FileText size={11} />
                  <span className="clip-path-name">{fileBaseName(p)}</span>
                  <span className="clip-path-full">{p}</span>
                </li>
              ))}
            </ul>
            <div className="clip-hint">复制文件使用原始路径；文件被移动或删除后粘贴会缺失。</div>
          </div>
        )}

        {item.text && (
          <pre className="clip-full-text" tabIndex={0}>
            {item.text}
          </pre>
        )}

        {item.html && (
          <div className="clip-html-block">
            <button className="link-btn" onClick={() => setShowHtml((v) => !v)}>
              <Code2 size={11} /> {showHtml ? "隐藏原始 HTML" : "查看原始 HTML"}
            </button>
            {showHtml && <pre className="clip-html">{item.html}</pre>}
            <div className="clip-hint">复制时保留 HTML 格式；目标应用不支持时会退回纯文本。</div>
          </div>
        )}

        {!item.text && item.file_paths.length === 0 && item.kind !== "image" && (
          <div className="clip-hint">该条目没有可展示的正文（内容可能已被清理）。</div>
        )}

        <TaskLinkBar targetType="item" targetId={item.id} />
        <WorkspaceLinkBar targetType="item" targetId={item.id} />
        <AgentExportPanel targetType="item" targetId={item.id} taskId={linkTask?.id ?? null} />
      </div>
    </div>
  );
}
