//! 剪贴板条目详情：完整正文/图片/文件、复制、收藏、置顶、任务关联与 Agent 导出。

import { useEffect, useState } from "react";
import {
  ArrowLeft, Code2, Copy, FileText, Link2, Pin, Star, Trash2,
} from "lucide-react";
import {
  clipboardCopyItem,
  clipboardDeleteItems,
  clipboardItem,
  clipboardLinkTask,
  clipboardToggleItem,
  type ClipboardItem,
} from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import {
  clipboardTime, fileBaseName, formatBytes, kindLabel, sourceLabel,
} from "../../lib/clipboardUi";
import { useUiStore } from "../../store/useUiStore";
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
      onChanged();
    } catch (e) {
      showToast(`复制失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(flag: "favorite" | "pinned") {
    try {
      setItem(await clipboardToggleItem(itemId, flag));
      onChanged();
    } catch (e) {
      showToast(String(e), { kind: "error" });
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
    askConfirm({
      title: "删除这条剪贴板历史？",
      detail: "将同时从所属分组和任务关联中移除；文件条目不会删除磁盘上的原始文件。",
      confirmLabel: "删除",
      danger: true,
      run: async () => {
        const r = await clipboardDeleteItems([itemId]);
        showToast(`已删除 ${r.deleted} 条`, { kind: "success" });
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
