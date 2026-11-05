//! 剪贴板 Lite 二级视图：图片预览 / 文本查看 / 文件列表 / 截图组预览。
//!
//! 定位：**只在胶囊面板内替换内容区**，不新开窗口、不改面板尺寸与 Win32 裁剪区域。
//! - 图片复用 `useLargeImage`（既有原图 LRU 缓存上限 2 条、IPC 去重、按需加载）；
//! - 文本/文件/分组复用既有详情查询（clipboard_item / clipboard_group）与数据模型；
//! - 每个视图独立注册 `sublayer` 到 overlayStack：一次 Escape 只关当前一层，
//!   关闭后胶囊面板本身仍保留，再按一次才收起面板；
//! - 所有异步读取带请求序号，旧响应不得覆盖新视图。

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ArrowUpRight, FileText, ImageOff, Loader2 } from "lucide-react";
import {
  clipboardGroupPage,
  clipboardItem,
  type ClipboardGroup,
  type ClipboardGroupPage,
  type ClipboardItem,
} from "../../lib/bridge";
import { fileBaseName, kindLabel } from "../../lib/clipboardUi";
import { normalizeError } from "../../lib/errors";
import { ClipboardThumb, useLargeImage } from "../clipboard/Media";
import { useFocusRestore, useOverlayLayer } from "../ui/overlay";
import { EmptyState, sizeLabel } from "./PanelKit";

/** 二级视图栈元素：分组预览可以再把某一页压入原图预览。 */
export type ClipboardLiteView =
  | { kind: "image"; item: ClipboardItem }
  | { kind: "text"; item: ClipboardItem }
  | { kind: "files"; item: ClipboardItem }
  | { kind: "group"; group: ClipboardGroup };

/** 文本一次性渲染上限：超出只显示前 N 字，避免超大文本撑爆面板渲染。 */
export const TEXT_RENDER_LIMIT = 20_000;
const FILE_LIST_LIMIT = 30;
const GROUP_THUMB_LIMIT = 9;

/**
 * 组摘要：列表快照里的计数/更新时间。后端 revision 只在响应里返回，
 * 前端用它做最终缓存键；摘要则用于在发请求前判断「列表已显示内容变化」，
 * 两者叠加才能既复用又不在删除/移动后返回旧图。
 */
function groupSignature(group: ClipboardGroup): string {
  return `${group.updated_at}|${group.item_count}|${group.image_count}`;
}

/**
 * 缓存键：组 + 分页范围 + 是否仅图片 + 后端 revision；任一项变化都不复用。
 * `revision` 未知时返回空串，表示该组尚无可用缓存（必须真实请求一次）。
 */
export function groupPageCacheKey(
  groupId: string,
  limit: number,
  offset: number,
  imagesOnly: boolean,
  revision: string | null,
): string {
  if (!revision) return "";
  return `${groupId}|${limit}|${offset}|${imagesOnly ? 1 : 0}|${revision}`;
}

const GROUP_PAGE_CACHE_MAX = 12;
/** 缓存值同时记录抓取时的组摘要，命中前再校验一次列表快照。 */
interface CachedGroupPage {
  page: ClipboardGroupPage;
  signature: string;
}
const groupPageCache = new Map<string, CachedGroupPage>();
const groupPageInflight = new Map<string, Promise<ClipboardGroupPage>>();
/** 每个组最近一次的 revision：用于算出探测键；清空后重新从后端取。 */
const groupPageRevision = new Map<string, string>();
/** 列表快照变化时自增：清空后旧的 in-flight 响应不得再写回缓存。 */
let groupPageEpoch = 0;

/** 列表快照变化（新增/删除/移动/分组修改）时整体失效封面与预览缓存。 */
export function clearGroupPageCache() {
  groupPageEpoch += 1;
  groupPageCache.clear();
  groupPageInflight.clear();
  groupPageRevision.clear();
}

/**
 * 有界读取组条目：同一 revision + 同一范围只发一次 IPC（并发也合并），
 * 不同组/分页/范围/内容不复用；失败不写缓存。
 */
export function loadGroupPage(
  group: ClipboardGroup,
  limit: number,
  offset = 0,
  imagesOnly = false,
): Promise<ClipboardGroupPage> {
  const signature = groupSignature(group);
  const revision = groupPageRevision.get(group.id) ?? null;
  const key = groupPageCacheKey(group.id, limit, offset, imagesOnly, revision);
  if (key) {
    const hit = groupPageCache.get(key);
    if (hit) {
      if (hit.signature === signature) return Promise.resolve(hit.page);
      // 列表摘要已变（例如组内图片被删/移动），该 revision 下的缓存不再可信。
      groupPageCache.delete(key);
      groupPageRevision.delete(group.id);
    }
  }
  const pendingKey =
    key || `${group.id}|${limit}|${offset}|${imagesOnly ? 1 : 0}|?|${signature}`;
  const pending = groupPageInflight.get(pendingKey);
  if (pending) return pending;
  const epoch = groupPageEpoch;
  const p = clipboardGroupPage(group.id, { limit, offset, imagesOnly }).then(
    (page) => {
      groupPageInflight.delete(pendingKey);
      if (epoch === groupPageEpoch) {
        const pageRevision = page.revision || "0";
        const pageKey = groupPageCacheKey(group.id, limit, offset, imagesOnly, pageRevision);
        // 该组 revision 已变化：旧 revision 的条目（含其它分页/封面）全部作废；
        // 同 revision 的其它范围（封面 limit 1 / 预览 limit 9）继续保留。
        for (const [oldKey, entry] of groupPageCache) {
          if (entry.page.groupId === group.id && entry.page.revision !== pageRevision) {
            groupPageCache.delete(oldKey);
          }
        }
        if (
          pageKey &&
          !groupPageCache.has(pageKey) &&
          groupPageCache.size >= GROUP_PAGE_CACHE_MAX
        ) {
          const oldest = groupPageCache.keys().next().value;
          if (oldest !== undefined) groupPageCache.delete(oldest);
        }
        if (pageKey) groupPageCache.set(pageKey, { page, signature });
        groupPageRevision.set(group.id, pageRevision);
      }
      return page;
    },
    (e) => {
      groupPageInflight.delete(pendingKey);
      throw e;
    },
  );
  groupPageInflight.set(pendingKey, p);
  return p;
}

function shortTitle(text: string, max = 40): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 与列表一致的标题：手动标题优先，其次正文预览，最后按类型兜底。 */
export function liteTitle(item: ClipboardItem): string {
  const t = (item.title || "").trim();
  if (t) return t;
  const raw = (item.preview || item.text || "").replace(/\s+/g, " ").trim();
  if (raw) return raw;
  if (item.has_image) return "图片";
  if (item.file_paths.length > 0) return `${item.file_paths.length} 个文件`;
  return "（空内容）";
}

/** 与列表一致的规格说明：只展示真实字段，不做推算。 */
export function liteMeta(item: ClipboardItem): string {
  if (item.has_image) {
    const dim =
      item.image_width && item.image_height ? `${item.image_width} × ${item.image_height}` : "图片";
    return `${dim} · ${sizeLabel(item.byte_size)}`;
  }
  if (item.file_paths.length > 0) return `文件 · ${sizeLabel(item.byte_size)}`;
  const chars = (item.text || item.preview || "").replace(/\s+/g, "").length;
  return chars > 0 ? `文本 · ${chars} 字` : `文本 · ${sizeLabel(item.byte_size)}`;
}

function dirOf(path: string): string {
  const name = fileBaseName(path);
  return path.slice(0, Math.max(0, path.length - name.length)).replace(/[\\/]+$/, "");
}

interface LiteViewProps {
  onBack: () => void;
  onOpenFull: () => void;
}

interface LiteShellProps extends LiteViewProps {
  title: string;
  sub?: ReactNode;
  rootRef: RefObject<HTMLDivElement | null>;
  footer?: ReactNode;
  children: ReactNode;
}

/** 二级视图统一外壳：返回 → 简短标题 → 完整页入口，内容滚动，底部操作条。 */
function ClipboardLiteShell({
  title,
  sub,
  rootRef,
  onBack,
  onOpenFull,
  footer,
  children,
}: LiteShellProps) {
  return (
    <div className="cap-clip-shell" ref={rootRef}>
      <header className="cap-head cap-clip-head">
        <button
          type="button"
          className="cap-iconbtn cap-clip-back"
          aria-label="返回列表"
          onClick={onBack}
        >
          <ArrowLeft size={15} strokeWidth={2.2} aria-hidden="true" />
        </button>
        <div className="cap-head-text cap-clip-head-text">
          <span className="cap-title cap-clip-title" title={title}>
            {title}
          </span>
          {sub ? <span className="cap-sub">{sub}</span> : null}
        </div>
        <div className="cap-actions">
          <button
            type="button"
            className="cap-iconbtn"
            aria-label="打开完整剪贴板"
            onClick={onOpenFull}
          >
            <ArrowUpRight size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="cap-clip-body">{children}</div>
      {footer ? <div className="cap-foot cap-clip-foot">{footer}</div> : null}
    </div>
  );
}

/** 图片原图预览：复用 useLargeImage（LRU 2 条 + 按需 IPC），不铺全屏遮罩。 */
export function ClipboardLiteImageView({
  item,
  onBack,
  onOpenFull,
  onCopyItem,
}: LiteViewProps & {
  item: ClipboardItem;
  onCopyItem: (id: string, what: string) => Promise<boolean>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusRestore(true);
  useOverlayLayer("sublayer", true, onBack, rootRef);
  const { state, url, error } = useLargeImage(item.id, true);
  const dim =
    item.image_width && item.image_height
      ? `${item.image_width} × ${item.image_height}`
      : "图片";
  const stateNote =
    state === "loading"
      ? "原图读取中"
      : state === "missing"
        ? "图片文件缺失"
        : state === "error"
          ? "原图读取失败"
          : "原图按需读取";
  return (
    <ClipboardLiteShell
      title={shortTitle(liteTitle(item))}
      sub={`${dim} · ${sizeLabel(item.byte_size)}`}
      rootRef={rootRef}
      onBack={onBack}
      onOpenFull={onOpenFull}
      footer={
        <>
          <span className="cap-foot-note">{stateNote}</span>
          <div className="cap-clip-foot-actions">
            <button
              type="button"
              className="cap-mini"
              disabled={state === "loading"}
              onClick={() => void onCopyItem(item.id, "图片")}
            >
              复制图片
            </button>
            <button type="button" className="cap-link" onClick={onOpenFull}>
              完整剪贴板
            </button>
          </div>
        </>
      }
    >
      <div className="cap-clip-image-stage">
        {state === "ready" && url ? (
          <img className="cap-clip-image" src={url} alt="剪贴板图片预览" draggable={false} />
        ) : (
          <div className="cap-clip-state" role={state === "error" ? "alert" : "status"}>
            {state === "loading" ? (
              <>
                <Loader2 size={16} className="spin" aria-hidden="true" />
                <span>正在加载原图…</span>
              </>
            ) : state === "missing" ? (
              <>
                <ImageOff size={16} aria-hidden="true" />
                <span>图片文件缺失或已被清理</span>
              </>
            ) : (
              <>
                <ImageOff size={16} aria-hidden="true" />
                <span>图片读取失败：{error}</span>
              </>
            )}
          </div>
        )}
      </div>
    </ClipboardLiteShell>
  );
}

/** 文本查看：按需读完整正文，超过上限只渲染前 N 字并给出全文入口。 */
export function ClipboardLiteTextView({
  item,
  onBack,
  onOpenFull,
  onCopyItem,
}: LiteViewProps & {
  item: ClipboardItem;
  onCopyItem: (id: string, what: string) => Promise<boolean>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusRestore(true);
  useOverlayLayer("sublayer", true, onBack, rootRef);
  const [detail, setDetail] = useState<ClipboardItem | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  const seq = useRef(0);

  const load = useCallback(() => {
    const n = ++seq.current;
    setPhase("loading");
    setErr("");
    clipboardItem(item.id).then(
      (d) => {
        if (n !== seq.current) return;
        setDetail(d);
        setPhase("ready");
      },
      (e) => {
        if (n !== seq.current) return;
        setErr(normalizeError(e).message);
        setPhase("error");
      },
    );
  }, [item.id]);

  useEffect(() => {
    load();
    return () => {
      seq.current += 1; // 卸载/换条目后旧响应作废
    };
  }, [load]);

  const full = detail?.text ?? "";
  const text = full.trim() || detail?.preview || "";
  const truncated = text.length > TEXT_RENDER_LIMIT;
  const shown = truncated ? text.slice(0, TEXT_RENDER_LIMIT) : text;
  const kind = detail?.kind ?? item.kind;
  const sub =
    phase === "ready"
      ? `${kindLabel(kind)} · ${text.length} 字`
      : `${kindLabel(kind)} · 读取中`;
  return (
    <ClipboardLiteShell
      title={shortTitle(liteTitle(item))}
      sub={sub}
      rootRef={rootRef}
      onBack={onBack}
      onOpenFull={onOpenFull}
      footer={
        <>
          <span className="cap-foot-note">
            {truncated ? `内容较长，仅显示前 ${TEXT_RENDER_LIMIT} 字` : `${text.length} 字`}
          </span>
          <div className="cap-clip-foot-actions">
            <button
              type="button"
              className="cap-mini"
              onClick={() => void onCopyItem(item.id, "文本")}
            >
              复制文本
            </button>
            <button type="button" className="cap-link" onClick={onOpenFull}>
              完整剪贴板
            </button>
          </div>
        </>
      }
    >
      {phase === "loading" ? (
        <div className="cap-clip-state" role="status">
          <Loader2 size={16} className="spin" aria-hidden="true" />
          <span>正在读取完整内容…</span>
        </div>
      ) : phase === "error" ? (
        <div className="cap-clip-state is-error" role="alert">
          <span>读取完整内容失败：{err}</span>
          <button type="button" className="cap-link" onClick={load}>
            重试
          </button>
        </div>
      ) : (
        <div className="cap-clip-scroll">
          {truncated ? (
            <p className="cap-clip-notice">
              内容较长，仅显示前 {TEXT_RENDER_LIMIT} 字；完整内容请在剪贴板页查看。
            </p>
          ) : null}
          {shown ? (
            <pre className="cap-clip-text">{shown}</pre>
          ) : (
            <EmptyState
              icon={<FileText size={20} strokeWidth={1.6} aria-hidden="true" />}
              text="没有可显示的文本内容"
            />
          )}
        </div>
      )}
    </ClipboardLiteShell>
  );
}

/** 文件列表查看：只展示已有路径与数量，不做扫描、移动或删除。 */
export function ClipboardLiteFilesView({
  item,
  onBack,
  onOpenFull,
  onCopyItem,
}: LiteViewProps & {
  item: ClipboardItem;
  onCopyItem: (id: string, what: string) => Promise<boolean>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusRestore(true);
  useOverlayLayer("sublayer", true, onBack, rootRef);
  const paths = item.file_paths;
  const shown = paths.slice(0, FILE_LIST_LIMIT);
  return (
    <ClipboardLiteShell
      title={shortTitle(liteTitle(item))}
      sub={`文件 · ${paths.length} 个 · ${sizeLabel(item.byte_size)}`}
      rootRef={rootRef}
      onBack={onBack}
      onOpenFull={onOpenFull}
      footer={
        <>
          <span className="cap-foot-note">
            {paths.length > FILE_LIST_LIMIT
              ? `仅显示前 ${FILE_LIST_LIMIT} 个文件`
              : `${paths.length} 个文件`}
          </span>
          <div className="cap-clip-foot-actions">
            <button
              type="button"
              className="cap-mini"
              disabled={paths.length === 0}
              onClick={() => void onCopyItem(item.id, "文件列表")}
            >
              复制文件列表
            </button>
            <button type="button" className="cap-link" onClick={onOpenFull}>
              完整剪贴板
            </button>
          </div>
        </>
      }
    >
      {paths.length === 0 ? (
        <EmptyState
          icon={<FileText size={20} strokeWidth={1.6} aria-hidden="true" />}
          text="没有可显示的文件"
        />
      ) : (
        <div className="cap-clip-scroll">
          {shown.map((path) => {
            const dir = dirOf(path);
            return (
              <div className="cap-clip-file" key={path} title={path}>
                <span className="cap-clip-file-name">{fileBaseName(path)}</span>
                {dir ? <span className="cap-clip-file-dir">{dir}</span> : null}
              </div>
            );
          })}
        </div>
      )}
    </ClipboardLiteShell>
  );
}

/** 截图组轻量预览：有界读取（limit 9 / imagesOnly），点缩略图再进原图预览。 */
export function ClipboardLiteGroupView({
  group,
  onBack,
  onOpenFull,
  onCopyGroup,
  onOpenImage,
}: LiteViewProps & {
  group: ClipboardGroup;
  onCopyGroup: (id: string) => Promise<boolean>;
  onOpenImage: (item: ClipboardItem) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusRestore(true);
  useOverlayLayer("sublayer", true, onBack, rootRef);
  const [page, setPage] = useState<ClipboardGroupPage | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  const seq = useRef(0);

  const load = useCallback(() => {
    const n = ++seq.current;
    setPhase("loading");
    setErr("");
    loadGroupPage(group, GROUP_THUMB_LIMIT, 0, true).then(
      (d) => {
        if (n !== seq.current) return;
        setPage(d);
        setPhase("ready");
      },
      (e) => {
        if (n !== seq.current) return;
        setErr(normalizeError(e).message);
        setPhase("error");
      },
    );
  }, [group]);

  useEffect(() => {
    load();
    return () => {
      seq.current += 1;
    };
  }, [load]);

  const thumbs = (page?.items ?? []).slice(0, GROUP_THUMB_LIMIT);
  // 总数/图片数一律来自有界查询响应，不用到手条目数冒充组内总数。
  const sub =
    phase === "ready" && page
      ? `${page.imageCount} 张${page.totalCount > page.imageCount ? ` · 共 ${page.totalCount} 项` : ""}`
      : phase === "error"
        ? "读取失败"
        : "读取中";
  const footNote =
    phase === "ready" && page
      ? page.imageCount > thumbs.length
        ? `共 ${page.imageCount} 张，仅显示前 ${thumbs.length} 张`
        : "组内图片按需预览"
      : sub;
  return (
    <ClipboardLiteShell
      title={shortTitle(group.name || "截图组")}
      sub={sub}
      rootRef={rootRef}
      onBack={onBack}
      onOpenFull={onOpenFull}
      footer={
        <>
          <span className="cap-foot-note">{footNote}</span>
          <div className="cap-clip-foot-actions">
            <button
              type="button"
              className="cap-mini"
              onClick={() => void onCopyGroup(group.id)}
            >
              复制整组
            </button>
            <button type="button" className="cap-link" onClick={onOpenFull}>
              完整剪贴板
            </button>
          </div>
        </>
      }
    >
      {phase === "loading" ? (
        <div className="cap-clip-state" role="status">
          <Loader2 size={16} className="spin" aria-hidden="true" />
          <span>正在读取截图组…</span>
        </div>
      ) : phase === "error" ? (
        <div className="cap-clip-state is-error" role="alert">
          <span>读取截图组失败：{err}</span>
          <button type="button" className="cap-link" onClick={load}>
            重试
          </button>
        </div>
      ) : thumbs.length === 0 ? (
        <EmptyState
          icon={<FileText size={20} strokeWidth={1.6} aria-hidden="true" />}
          text="该截图组没有可预览的图片"
        />
      ) : (
        <div className="cap-clip-scroll">
          <div className="cap-clip-grid">
            {thumbs.map((img, i) => (
              <button
                key={img.id}
                type="button"
                className="cap-clip-tile"
                aria-label={`查看截图组第 ${i + 1} 张图片`}
                onClick={() => onOpenImage(img)}
              >
                <ClipboardThumb itemId={img.id} hasThumb={img.has_thumb} size={86} />
              </button>
            ))}
          </div>
        </div>
      )}
    </ClipboardLiteShell>
  );
}
