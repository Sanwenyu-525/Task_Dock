//! 剪贴板面板（胶囊内，对照 `docs/screenshots/v07/停靠效果图/03-clipboard.png`）。
//!
//! 数据：按需调用既有 `clipboard_view`（limit 20），**不新建采集服务**、
//! 不订阅第二份实时流；缩略图走既有 `ClipboardThumb`（进程内缓存、上限 240）。
//! 敏感内容只在展开面板内出现，轨道上永远不显示正文。
//!
//! 安全约束（与完整剪贴板工作区一致）：
//! - Dock 内复制由后端标记为内部复制，**不会**再次写回历史；
//! - 复制后不刷新列表（历史顺序不因复制而跳动）；
//! - 参考图里的勾选框代表多选，但 Lite 面板没有批量接口 —— 这里**不画**
//!   不可操作的勾选框，改为「类型色块 + 单项复制 + 进入完整页面做批量操作」。
//!
//! 分段筛选（全部 / 文本 / 图片 / 文件）是对同一份真实列表的本地过滤。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, Clipboard, Copy, FileText, Images, Layers } from "lucide-react";
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
import { EmptyState, PanelHead, Segmented, sizeLabel, type SegOption } from "./PanelKit";

type Filter = "all" | "text" | "image" | "file";

const FILTERS: readonly SegOption<Filter>[] = [
  { value: "all", label: "全部" },
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "file", label: "文件" },
];

const TEXT_KINDS = new Set(["text", "html", "link", "code"]);

function titleOf(item: ClipboardItem): string {
  const t = (item.title || "").trim();
  if (t) return t;
  const raw = (item.preview || item.text || "").replace(/\s+/g, " ").trim();
  if (raw) return raw;
  if (item.has_image) return "图片";
  if (item.file_paths.length > 0) return `${item.file_paths.length} 个文件`;
  return "（空内容）";
}

/** 行内类型 + 规格说明（真实字段，不推算）：图片尺寸 / 字数 / 文件数 / 体积。 */
function metaOf(item: ClipboardItem): string {
  if (item.has_image) {
    const dim = item.image_width && item.image_height ? `${item.image_width} × ${item.image_height}` : "图片";
    return `${dim} · ${sizeLabel(item.byte_size)}`;
  }
  if (item.file_paths.length > 0) return `文件 · ${sizeLabel(item.byte_size)}`;
  const chars = (item.text || item.preview || "").replace(/\s+/g, "").length;
  return chars > 0 ? `文本 · ${chars} 字` : `文本 · ${sizeLabel(item.byte_size)}`;
}

function toneOf(item: ClipboardItem): { cls: string; icon: typeof FileText } {
  if (item.has_image) return { cls: "tone-image", icon: Images };
  if (item.file_paths.length > 0) return { cls: "tone-files", icon: FileText };
  return { cls: "tone-text", icon: FileText };
}

export default function ClipboardLite() {
  const [items, setItems] = useState<ClipboardItem[] | null>(null);
  const [groups, setGroups] = useState<ClipboardGroup[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  /** 截图组 → 可作封面的条目 id（按需读详情，最多 2 组） */
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const view = await clipboardView({ limit: 20 });
      setItems(view.items);
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

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copyItem = async (id: string) => {
    try {
      await clipboardCopyItem(id);
      setCopied(id);
    } catch {
      // 失败不显示「已复制」
    }
  };

  const copyGroup = async (id: string) => {
    try {
      await clipboardCopyGroupRich(id);
      setCopied(id);
    } catch {
      // 同上
    }
  };

  const list = useMemo(() => {
    if (!items) return null;
    return items
      .filter((i) => {
        if (filter === "text") return TEXT_KINDS.has(i.kind) && !i.has_image;
        if (filter === "image") return i.has_image;
        if (filter === "file") return i.file_paths.length > 0;
        return TEXT_KINDS.has(i.kind) || i.has_image || i.file_paths.length > 0;
      })
      .slice(0, 8);
  }, [items, filter]);

  const showGroups = groups.length > 0 && (filter === "all" || filter === "image");
  const total = items?.length ?? 0;
  const empty = list !== null && list.length === 0 && !showGroups;

  return (
    <>
      <PanelHead
        title="剪贴板"
        sub={items === null ? "读取中" : `最近 ${total} 条 · 含 ${groups.length} 个截图组`}
        actions={
          <button
            type="button"
            className="cap-iconbtn"
            aria-label="打开剪贴板页"
            onClick={() => openFullApp("clipboard")}
          >
            <ArrowUpRight size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        }
      />

      <Segmented label="剪贴板类型筛选" options={FILTERS} value={filter} onChange={setFilter} />

      <div className="cap-list">
        {empty && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text={total === 0 ? "剪贴板暂无记录" : "该筛选下没有记录"}
            actionLabel="打开剪贴板页"
            onAction={() => openFullApp("clipboard")}
          />
        )}

        {showGroups &&
          groups.map((g) => (
            <div className="cap-item cap-clip-row" key={g.id}>
              <span className="cap-stack" aria-hidden="true">
                <i>
                  <Layers size={13} strokeWidth={1.8} />
                </i>
                <i />
                <i>
                  {covers[g.id] ? <ClipboardThumb itemId={covers[g.id]} hasThumb size={46} /> : null}
                </i>
              </span>
              <span className="cap-main">
                <span className="cap-item-title" title={g.name || "截图组"}>
                  {g.name || "截图组"}
                </span>
                <span className="cap-item-sub">
                  截图组 · {g.image_count} 张{g.item_count > g.image_count ? ` · 共 ${g.item_count} 项` : ""}
                </span>
              </span>
              <button
                type="button"
                className={`cap-mini is-icon${copied === g.id ? " is-ok" : ""}`}
                aria-label={`复制截图组「${g.name || "截图组"}」`}
                onClick={() => void copyGroup(g.id)}
              >
                {copied === g.id ? (
                  <Check size={13} strokeWidth={2.6} aria-hidden="true" />
                ) : (
                  <Copy size={13} strokeWidth={2} aria-hidden="true" />
                )}
              </button>
            </div>
          ))}

        {list?.map((it) => {
          const tone = toneOf(it);
          const Icon = tone.icon;
          return (
            <div className="cap-item cap-clip-row" key={it.id}>
              {it.has_image && it.has_thumb ? (
                <span className="cap-clip-thumb">
                  <ClipboardThumb itemId={it.id} hasThumb size={46} />
                </span>
              ) : (
                <span className={`cap-tile ${tone.cls}`} aria-hidden="true">
                  <Icon size={17} strokeWidth={1.8} />
                </span>
              )}
              <span className="cap-main">
                <span className="cap-item-title clip-2" title={titleOf(it)}>
                  {titleOf(it)}
                </span>
                <span className="cap-item-sub">{metaOf(it)}</span>
              </span>
              <button
                type="button"
                className={`cap-mini is-icon${copied === it.id ? " is-ok" : ""}`}
                aria-label={`复制「${titleOf(it)}」`}
                onClick={() => void copyItem(it.id)}
              >
                {copied === it.id ? (
                  <Check size={13} strokeWidth={2.6} aria-hidden="true" />
                ) : (
                  <Copy size={13} strokeWidth={2} aria-hidden="true" />
                )}
              </button>
            </div>
          );
        })}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">仅显示最近记录，复制不会写回历史</span>
        <button type="button" className="cap-link" onClick={() => openFullApp("clipboard")}>
          剪贴板页
        </button>
      </div>
    </>
  );
}
