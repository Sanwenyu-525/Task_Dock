//! 剪贴板面板（胶囊内，对照 `docs/design-refs/v07/停靠效果图/03-clipboard.png`）。
//!
//! 数据：**不再自持列表**。视图来自 `useClipboardStore.lite`（挂载时
//! loadLite() 取一次 clipboard_view(limit 20)），实时更新复用 store 里
//! 全局唯一的 clipboard-changed 监听（引用计数，不会重复注册）；
//! 缩略图走既有 `ClipboardThumb`（进程内缓存、上限 240）。
//! 敏感内容只在展开面板内出现，轨道上永远不显示正文。
//!
//! 安全约束（与完整剪贴板工作区一致）：
//! - Dock 内复制由后端标记为内部复制，**不会**再次写回历史；
//! - 复制后不刷新列表（历史顺序不因复制而跳动）；
//! - 参考图里的勾选框代表多选，但 Lite 面板没有批量接口 —— 这里**不画**
//!   不可操作的勾选框，改为「类型色块 + 单项复制 + 进入完整页面做批量操作」。
//!
//! 分段筛选（全部 / 文本 / 图片 / 文件）是对同一份真实列表的本地过滤。

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, Clipboard, Copy, FileText, Images, Layers } from "lucide-react";
import {
  clipboardCopyGroupRich,
  clipboardCopyItem,
  clipboardGroup,
  type ClipboardItem,
} from "../../lib/bridge";
import { useClipboardStore } from "../../store/useClipboardStore";
import { ClipboardThumb } from "../clipboard/Media";
import { openFullApp } from "./actions";
import { EmptyState, PanelHead, Segmented, sizeLabel, type SegOption } from "./PanelKit";

/** 监听状态的展示文案与状态点色调（与列表数据状态分开显示）。 */
const MONITOR_TEXT: Record<string, { text: string; tone: "none" | "ok" | "warn" | "bad" }> = {
  checking: { text: "检查中…", tone: "none" },
  ok: { text: "监听中", tone: "ok" },
  paused: { text: "已暂停", tone: "warn" },
  disabled: { text: "剪贴板模块已关闭", tone: "warn" },
  configError: { text: "配置异常，采集被拒绝", tone: "bad" },
  notRunning: { text: "监听线程未运行", tone: "warn" },
  unknown: { text: "状态未知", tone: "warn" },
};

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
  const lite = useClipboardStore((s) => s.lite);
  const liteStatus = useClipboardStore((s) => s.liteStatus);
  const monitor = useClipboardStore((s) => s.monitor);
  const loadLite = useClipboardStore((s) => s.loadLite);
  const loadMonitor = useClipboardStore((s) => s.loadMonitor);
  const releaseLite = useClipboardStore((s) => s.releaseLite);
  const setLive = useClipboardStore((s) => s.setLive);
  const items = lite?.items ?? null;
  // 只给「有图的分组」取封面，最多 2 组，顺序按后端返回
  const groups = useMemo(
    () => (lite?.groups ?? []).filter((g) => g.image_count > 0).slice(0, 2),
    [lite],
  );
  const [filter, setFilter] = useState<Filter>("all");
  /** 截图组 → 可作封面的条目 id（按需读详情，最多 2 组） */
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  // 面板打开 → 取一次轻量视图 + 监听状态，并接入全局唯一的 clipboard-changed
  // 监听（store 内部引用计数：完整页面与胶囊面板共用同一个监听，不会重复注册）。
  useEffect(() => {
    void loadLite();
    void loadMonitor();
    setLive(true);
    return () => {
      setLive(false);
      releaseLite();
    };
  }, [loadLite, loadMonitor, releaseLite, setLive]);

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
  // 数据错误与监听状态分开：error 时有旧数据 → 旧列表 + 错误条；无数据 → 错误空态
  const dataError = liteStatus === "error";
  const loadingData = liteStatus === "loading" && lite === null;
  // 成功且整表确无记录（items 与 groups 都空）才是真空态；否则按筛选显示局部空态
  const trulyEmpty = liteStatus === "empty";
  const empty = !dataError && list !== null && list.length === 0 && !showGroups;
  const monitorInfo = MONITOR_TEXT[monitor] ?? MONITOR_TEXT.unknown;

  return (
    <>
      <PanelHead
        title="剪贴板"
        sub={
          loadingData
            ? "读取中"
            : dataError && items === null
              ? "读取失败"
              : `最近 ${total} 条 · 含 ${groups.length} 个截图组`
        }
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

      {/* 监听运行状态（clipboardStatus 派生，独立于列表错误；unknown 可重查） */}
      <div className="cap-summary" role="status">
        <span
          className={`cap-state-dot${monitorInfo.tone === "none" ? "" : ` tone-${monitorInfo.tone}`}`}
          aria-hidden="true"
        />
        <span>监听状态：{monitorInfo.text}</span>
        {monitor === "unknown" && (
          <button type="button" className="cap-link" aria-label="重新检查监听状态" onClick={() => void loadMonitor()}>
            重查
          </button>
        )}
      </div>

      <Segmented label="剪贴板类型筛选" options={FILTERS} value={filter} onChange={setFilter} />

      <div className="cap-list">
        {/* 错误优先于空态：有旧数据 → 旧列表 + 可重试错误条；无数据 → 错误空态 */}
        {dataError && items !== null && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">刷新失败，显示的是上次结果</span>
            <button type="button" className="cap-mini" aria-label="重试读取剪贴板记录" onClick={() => void loadLite()}>
              重试
            </button>
          </div>
        )}

        {dataError && items === null && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="剪贴板记录读取失败"
            actionLabel="重试"
            onAction={() => void loadLite()}
          />
        )}

        {empty && trulyEmpty && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="剪贴板暂无记录"
            actionLabel="打开剪贴板页"
            onAction={() => openFullApp("clipboard")}
          />
        )}

        {empty && !trulyEmpty && (
          <EmptyState
            icon={<Clipboard size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="该筛选下没有记录"
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
