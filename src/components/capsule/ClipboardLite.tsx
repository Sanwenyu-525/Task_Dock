//! 剪贴板面板（胶囊内）：最近文本 + 截图组 + 单项复制 + 打开剪贴板。
//!
//! 数据：按需调用既有 `clipboard_view`（limit 8），**不新建采集服务**、
//! 不订阅第二份实时流；缩略图走既有 `ClipboardThumb`（进程内缓存、上限 240）。
//! 敏感内容只在展开面板内出现，轨道上永远不显示正文。

import { useCallback, useEffect, useState } from "react";
import { Check, Clipboard, Copy, Images } from "lucide-react";
import {
  clipboardCopyGroupRich,
  clipboardCopyItem,
  clipboardGroup,
  clipboardView,
  type ClipboardGroup,
  type ClipboardItem,
} from "../../lib/bridge";
import { ClipboardThumb } from "../clipboard/Media";
import { openFullApp } from "./actions";

const TEXT_KINDS = new Set(["text", "html", "link", "code"]);

function previewOf(item: ClipboardItem): string {
  const raw = (item.preview || item.text || "").replace(/\s+/g, " ").trim();
  if (raw) return raw;
  if (item.has_image) return "图片";
  if (item.file_paths.length > 0) return `${item.file_paths.length} 个文件`;
  return "（空内容）";
}

export default function ClipboardLite() {
  const [items, setItems] = useState<ClipboardItem[] | null>(null);
  const [groups, setGroups] = useState<ClipboardGroup[]>([]);
  /** 截图组 → 可作封面的条目 id（按需读详情，最多 2 组） */
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const view = await clipboardView({ limit: 8 });
      setItems(view.items.filter((i) => TEXT_KINDS.has(i.kind) || i.has_image).slice(0, 6));
      setGroups(view.groups.filter((g) => g.image_count > 0).slice(0, 2));
    } catch {
      setItems([]);
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 封面：只为「有图的分组」读详情，且最多 2 组（有界、失败静默）
  useEffect(() => {
    if (groups.length === 0) return;
    let alive = true;
    void (async () => {
      for (const g of groups) {
        try {
          const detail = await clipboardGroup(g.id);
          const cover = detail.items.find((i) => i.has_thumb) ?? detail.items.find((i) => i.has_image);
          if (alive && cover) setCovers((prev) => ({ ...prev, [g.id]: cover.id }));
        } catch {
          // 缩略图失败不影响文案与复制
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [groups]);

  const flash = (id: string) => {
    setCopied(id);
    window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
  };

  const copyItem = async (id: string) => {
    try {
      await clipboardCopyItem(id);
      flash(id);
    } catch {
      // 失败不显示"已复制"
    }
  };

  const copyGroup = async (id: string) => {
    try {
      await clipboardCopyGroupRich(id);
      flash(id);
    } catch {
      // 同上
    }
  };

  const empty = items !== null && items.length === 0 && groups.length === 0;

  return (
    <>
      <header className="capsule-head">
        <span className="capsule-title">剪贴板</span>
        <span className="capsule-meta">{items === null ? "读取中" : `${items.length} 条最近`}</span>
      </header>

      <div className="capsule-body">
        {empty && (
          <div className="capsule-empty">
            <Clipboard size={20} strokeWidth={1.6} aria-hidden="true" />
            <p>剪贴板暂无记录</p>
            <button type="button" className="capsule-link" onClick={() => openFullApp("clipboard")}>
              打开剪贴板
            </button>
          </div>
        )}

        {groups.map((g) => (
          <div className="capsule-group" key={g.id}>
            <span className="capsule-group-thumb">
              {covers[g.id] ? (
                <ClipboardThumb itemId={covers[g.id]} hasThumb size={34} />
              ) : (
                <Images size={16} strokeWidth={1.6} aria-hidden="true" />
              )}
            </span>
            <span className="capsule-row-main">
              <span className="capsule-row-title">{g.name || "截图组"}</span>
              <span className="capsule-row-sub">
                {g.item_count} 项{g.image_count > 0 ? ` · ${g.image_count} 张图` : ""}
              </span>
            </span>
            <button
              type="button"
              className="capsule-icon-btn"
              aria-label={`复制截图组「${g.name || "截图组"}」`}
              onClick={() => void copyGroup(g.id)}
            >
              {copied === g.id ? (
                <Check size={13} strokeWidth={2.4} aria-hidden="true" />
              ) : (
                <Copy size={13} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </div>
        ))}

        {items?.map((it) => (
          <div className="capsule-row" key={it.id}>
            <span className="capsule-row-main">
              <span className="capsule-row-title clip-1">{previewOf(it)}</span>
              <span className="capsule-row-sub">
                {it.source_app || "未知来源"}
                {it.copy_count > 1 ? ` · 复制 ${it.copy_count} 次` : ""}
              </span>
            </span>
            <button
              type="button"
              className="capsule-icon-btn"
              aria-label="复制此条"
              onClick={() => void copyItem(it.id)}
            >
              {copied === it.id ? (
                <Check size={13} strokeWidth={2.4} aria-hidden="true" />
              ) : (
                <Copy size={13} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </div>
        ))}
      </div>

      <footer className="capsule-foot">
        <span className="capsule-hint">仅显示最近记录</span>
        <button type="button" className="capsule-link" onClick={() => openFullApp("clipboard")}>
          剪贴板页
        </button>
      </footer>
    </>
  );
}
