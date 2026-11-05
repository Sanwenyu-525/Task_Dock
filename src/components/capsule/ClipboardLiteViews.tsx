//! 剪贴板 Lite 二级视图：图片预览 / 文本查看 / 文件列表 / 截图组预览。
//!
//! 定位：**只在胶囊面板内替换内容区**，不新开窗口、不改面板尺寸与 Win32 裁剪区域。
//! - 图片复用 `useLargeImage`（既有原图 LRU 缓存上限 2 条、IPC 去重、按需加载）；
//! - 文本/文件/分组复用既有详情查询（clipboard_item / clipboard_group）与数据模型；
//! - 每个视图独立注册 `sublayer` 到 overlayStack：一次 Escape 只关当前一层，
//!   关闭后胶囊面板本身仍保留，再按一次才收起面板；
//! - 所有异步读取带请求序号，旧响应不得覆盖新视图。

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, FileText, ImageOff, Loader2 } from "lucide-react";
import {
  clipboardGroupItemPosition,
  clipboardGroupPage,
  clipboardItem,
  type ClipboardGroup,
  type ClipboardGroupItemPosition,
  type ClipboardGroupPage,
  type ClipboardItem,
} from "../../lib/bridge";
import { fileBaseName, kindLabel } from "../../lib/clipboardUi";
import { normalizeError } from "../../lib/errors";
import { useUiStore } from "../../store/useUiStore";
import { ClipboardThumb, useLargeImage } from "../clipboard/Media";
import { useFocusRestore, useOverlayLayer } from "../ui/overlay";
import { EmptyState, sizeLabel } from "./PanelKit";

/** 截图组内图片序列：只携带缩略图元数据，原图由预览组件按当前项按需读取。 */
export interface LiteImageSequence {
  group: ClipboardGroup;
  /** 已加载的缩略图（首屏或分页追加），顺序与组内真实顺序一致 */
  items: ClipboardItem[];
  /** 点击的图片在已加载序列中的位置 */
  index: number;
  /** 组内图片真实总数（不是已加载数） */
  total: number;
  /** 读取时的组内容版本；分页追加时用于发现内容变化 */
  revision: string;
  /** 预览翻到下一页时把新条目同步给下层截图组视图 */
  onAppend: (items: ClipboardItem[]) => void;
  /** 组 revision 变化并重建前缀时，把新前缀/总数/版本同步给下层组视图 */
  onReplace?: (items: ClipboardItem[], total: number, revision: string) => void;
}

/** 二级视图栈元素：分组预览可以再把某一页压入原图预览。 */
export type ClipboardLiteView =
  | { kind: "image"; item: ClipboardItem; sequence?: LiteImageSequence }
  | { kind: "text"; item: ClipboardItem }
  | { kind: "files"; item: ClipboardItem }
  | { kind: "group"; group: ClipboardGroup };

/** 文本一次性渲染上限：超出只显示前 N 字，避免超大文本撑爆面板渲染。 */
export const TEXT_RENDER_LIMIT = 20_000;
const FILE_LIST_LIMIT = 30;
const GROUP_THUMB_LIMIT = 9;
/**
 * 序列刷新时有界查找的页数上限（10 页 = 90 张缩略图元数据）。
 * 超出该范围的定位结果不再逐页重建，改为回到组首并给出明确提示。
 */
const GROUP_LOAD_PAGE_LIMIT = 10;

/** 按 id 合并分页缩略图，防止组内容变化后 offset 位移造成重复条目。 */
function mergeThumbs(
  base: readonly ClipboardItem[],
  extra: readonly ClipboardItem[],
): ClipboardItem[] {
  const seen = new Set<string>();
  const out: ClipboardItem[] = [];
  for (const item of [...base, ...extra]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

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

/** 图片原图预览：复用 useLargeImage（LRU 2 条 + 按需 IPC），不铺全屏遮罩。
 *
 * 从截图组打开时携带 `sequence`：左右按钮 / ←→ 在当前组内切换，
 * 序号按组内真实总数显示；已加载缩略图不足时只补下一页元数据，
 * 原图仍只加载当前一张。单图（列表直接打开）不显示切换控件。
 */
export function ClipboardLiteImageView({
  item,
  sequence,
  liveGroup,
  active = true,
  onBack,
  onOpenFull,
  onCopyItem,
}: LiteViewProps & {
  item: ClipboardItem;
  sequence?: LiteImageSequence;
  /** 当前快照里的组摘要：组内容在预览期间变化时刷新序列 */
  liveGroup?: ClipboardGroup;
  /** 是否为当前最上层视图：下层视图不得抢键盘/弹层事件 */
  active?: boolean;
  onCopyItem: (id: string, what: string) => Promise<boolean>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusRestore(active);
  useOverlayLayer("sublayer", active, onBack, rootRef);
  const showToast = useUiStore((s) => s.showToast);
  const [items, setItems] = useState<ClipboardItem[]>(() =>
    sequence && sequence.items.length > 0 ? sequence.items : [item],
  );
  const [index, setIndex] = useState(() =>
    sequence ? Math.max(0, Math.min(sequence.index, sequence.items.length - 1)) : 0,
  );
  const [total, setTotal] = useState(() => Math.max(1, sequence?.total ?? 1));
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const pageSeq = useRef(0);
  /**
   * 当前有效 revision：初次来自打开时的截图组；组内容变化/分页刷新后更新。
   * 后续翻页必须与它比较，不能继续使用打开时冻结的 `sequence.revision`，
   * 否则 revision 一旦更新，每次翻页都会误判为变化并回到第一页。
   */
  const revisionRef = useRef(sequence?.revision ?? "");
  const current = items[index] ?? item;
  const currentId = current.id;
  const { state, url, error, forId } = useLargeImage(currentId, true);
  // 切换条目后 effect 尚未执行时，state/url 仍属于上一张；按加载中处理，避免旧图配新元信息。
  const viewState = forId === currentId ? state : "loading";
  const dim =
    current.image_width && current.image_height
      ? `${current.image_width} × ${current.image_height}`
      : "图片";
  const multi = !!sequence && total > 1;

  // 卸载/返回后旧分页响应作废；原图加载由 useLargeImage 自己按条目守卫。
  useEffect(() => () => {
    pageSeq.current += 1;
  }, []);

  // 已加载序列变化时把位置钳制在有效范围（组内图片被删/分页刷新）。
  useEffect(() => {
    setIndex((prev) => Math.min(prev, Math.max(0, items.length - 1)));
  }, [items.length]);

  /**
   * revision 变化后的重建。核心规则是「按图片 ID 恢复身份」，不按旧序号回退：
   * 1) 当前图片仍在第一页 → 直接保持（位置可以变）；
   * 2) 否则走后端定位接口（clipboard_group_item_position，不走 groupPageCache）按 ID
   *    找回序位，按需顺序补页到该序位所在页（有界，最多 GROUP_LOAD_PAGE_LIMIT 页）；
   * 3) 图片已删除/移出本组 → 按旧序号 clamp 到新总数内选相邻图片，并给出明确提示；
   * 4) 组已删除（NotFound）→ 明确提示并退出组内预览；
   * 5) 超出查找上限 → 回到组首并明确提示。任何路径都不允许静默显示其他图片。
   * 定位与补页期间 revision 再次变化只整体重试一次；每次 await 后都做代际检查，
   * 旧请求一律不写任何 state。
   */
  const refreshSequence = useCallback(
    async (request: number, assumeGone = false) => {
      if (!sequence) return;
      const group = sequence.group;
      const stale = () => request !== pageSeq.current;
      /** 组已删除（NotFound）的统一出口：提示 + 退出组内预览。 */
      const leaveGroupGone = () => {
        showToast("截图组已删除，已退出预览", { kind: "info" });
        setLoadingMore(false);
        onBack();
      };
      const loadFirstPage = async (): Promise<ClipboardGroupPage> => {
        try {
          return await loadGroupPage(group, GROUP_THUMB_LIMIT, 0, true);
        } catch (e) {
          if (stale()) throw e;
          if (normalizeError(e).code === "NOT_FOUND") {
            leaveGroupGone();
            throw new Error("group-gone");
          }
          throw e;
        }
      };

      if (assumeGone) {
        // 组已从列表快照消失：分页缓存可能仍命中旧摘要（clearGroupPageCache 在父级
        // effect 中执行，晚于本 effect），不能靠第一页请求发现删除。定位接口不走
        // 缓存，NotFound 才是组删除的权威信号；仍存在则继续常规刷新兜底。
        try {
          await clipboardGroupItemPosition(group.id, currentId);
        } catch (e) {
          if (stale()) return;
          if (normalizeError(e).code === "NOT_FOUND") {
            leaveGroupGone();
            return;
          }
          throw e;
        }
        if (stale()) return;
      }

      let first = await loadFirstPage();
      if (stale()) return;
      if (first.items.length === 0) {
        setNotice("截图组图片已全部移除");
        setLoadingMore(false);
        onBack();
        return;
      }
      let revision = first.revision;
      const oldIndex = index;

      // ── 第 1 步：找回当前图片。第一页直接命中则无需定位接口；
      //    定位返回的 revision 与第一页不一致时整体重试一次，仍不一致按「未找到」处理。
      let loc: ClipboardGroupItemPosition | null = null;
      let retried = false;
      while (!first.items.some((entry) => entry.id === currentId)) {
        let probe: ClipboardGroupItemPosition;
        try {
          probe = await clipboardGroupItemPosition(group.id, currentId);
        } catch (e) {
          if (stale()) return;
          if (normalizeError(e).code === "NOT_FOUND") {
            leaveGroupGone();
            return;
          }
          throw e; // 其它错误交给调用方显示，绝不静默换图
        }
        if (stale()) return;
        if (probe.revision === revision) {
          loc = probe;
          break;
        }
        if (retried) {
          // 整体重试后仍不一致（内容变化过快）：按「未找到」降级，走相邻回退并提示。
          loc = { ...probe, found: false, index: null };
          break;
        }
        retried = true;
        first = await loadFirstPage();
        if (stale()) return;
        if (first.items.length === 0) {
          setNotice("截图组图片已全部移除");
          setLoadingMore(false);
          onBack();
          return;
        }
        revision = first.revision;
      }

      /**
       * 有界重建前缀：从 start 继续顺序补页直到覆盖 target 序位（含）或达到页数上限；
       * 返回是否未能覆盖 target（截断）。每页校验 revision，页空/变化即停止拼接，
       * 绝不把不同 revision 的页拼在一起。
       */
      const buildPrefix = async (
        start: ClipboardItem[],
        startTotal: number,
        target: number,
        maxExtraPages: number,
      ): Promise<{ items: ClipboardItem[]; total: number; truncated: boolean }> => {
        let built = start;
        let builtTotal = Math.max(startTotal, built.length, 1);
        let pages = 0;
        while (target >= built.length && built.length < builtTotal && pages < maxExtraPages) {
          pages += 1;
          const page = await loadGroupPage(group, GROUP_THUMB_LIMIT, built.length, true);
          if (stale()) return { items: built, total: builtTotal, truncated: true };
          if (page.revision !== revision || page.items.length === 0) break;
          built = mergeThumbs(built, page.items);
          builtTotal = Math.max(builtTotal, page.imageCount, built.length);
        }
        return { items: built, total: builtTotal, truncated: target >= built.length };
      };

      let nextItems: ClipboardItem[];
      let nextTotal: number;
      let nextIndex: number;
      let nextNotice: string;
      if (loc === null) {
        // 当前图片仍在第一页：位置可以变，身份不变。
        nextItems = first.items;
        nextTotal = Math.max(first.imageCount, nextItems.length, 1);
        nextIndex = Math.max(0, nextItems.findIndex((entry) => entry.id === currentId));
        nextNotice = "截图组内容已变化，已刷新";
      } else if (loc.found && loc.index !== null) {
        const p = loc.index;
        if (p >= GROUP_LOAD_PAGE_LIMIT * GROUP_THUMB_LIMIT) {
          // 超出有界查找能力：回到组首并明确提示（不允许静默显示其他图片）。
          nextItems = first.items;
          nextTotal = Math.max(loc.imageCount, 1);
          nextIndex = 0;
          nextNotice = `当前图片已移动到第 ${p + 1} 张，超出预载范围，已回到组首`;
        } else {
          const built = await buildPrefix(
            first.items,
            Math.max(loc.imageCount, first.imageCount),
            p,
            Math.floor(p / GROUP_THUMB_LIMIT),
          );
          if (stale()) return;
          // 防御：无论按序位还是按 ID，最终都必须以「当前图片确实在前缀里」为准。
          const keep = built.items.findIndex((entry) => entry.id === currentId);
          nextItems = built.items;
          nextTotal = Math.max(loc.imageCount, built.total, 1);
          if (keep >= 0) {
            nextIndex = keep;
            nextNotice = "截图组内容已变化，已刷新";
          } else {
            // revision 在补页期间再次变化导致前缀截断：明确提示相邻回退，不静默。
            nextIndex = Math.max(0, nextItems.length - 1);
            nextNotice = "截图组内容再次变化，未能找回当前图片，已切换到相邻图片";
          }
        }
      } else {
        // 当前图片已被删除/移出本组：按旧序号 clamp 到新总数内选相邻图片。
        const imageCount = Math.max(0, loc.imageCount);
        const target = imageCount > 0 ? Math.min(oldIndex, imageCount - 1) : 0;
        const built = await buildPrefix(
          first.items,
          Math.max(loc.imageCount, first.imageCount),
          target,
          GROUP_LOAD_PAGE_LIMIT - 1,
        );
        if (stale()) return;
        nextItems = built.items;
        nextTotal = Math.max(loc.imageCount, built.total, 1);
        nextIndex = Math.min(target, Math.max(0, nextItems.length - 1));
        nextNotice = retried
          ? "截图组内容变化过快，未能确认当前图片，已切换到相邻图片"
          : "截图组内容已变化，当前图片已不在截图组中，已切换到相邻图片";
      }

      if (stale()) return;
      revisionRef.current = revision;
      setItems(nextItems);
      setTotal(nextTotal);
      setIndex(nextIndex);
      setNotice(nextNotice);
      setLoadingMore(false);
      if (sequence.onReplace) {
        sequence.onReplace(nextItems, nextTotal, revision);
      } else if (nextItems.length > first.items.length) {
        sequence.onAppend(nextItems.slice(first.items.length));
      }
    },
    [sequence, currentId, index, onBack, showToast],
  );

  /**
   * 组摘要签名：预览期间组被删图/拆分/合并时，重新取第一页并校正当前位置；
   * 组从列表消失（liveGroup 变 undefined）同样触发一次刷新 —— 定位/分页接口会返回
   * NotFound，refreshSequence 据此提示并退出组内预览。只在变化时触发一次，不轮询。
   */
  const liveSignature = liveGroup
    ? `${liveGroup.updated_at}|${liveGroup.image_count}|${liveGroup.item_count}`
    : "";
  const liveSignatureRef = useRef(liveSignature);
  useEffect(() => {
    if (!sequence) return;
    const groupGone = !liveGroup && liveSignatureRef.current !== "";
    if (!groupGone && (!liveGroup || liveSignature === liveSignatureRef.current)) return;
    liveSignatureRef.current = liveSignature;
    const request = ++pageSeq.current;
    setLoadingMore(true);
    setLoadError("");
    void refreshSequence(request, groupGone).catch((e) => {
      if (request !== pageSeq.current) return;
      // 组删除的退出已在 refreshSequence 内完成，这里的 "group-gone" 哨兵不展示。
      if (e instanceof Error && e.message === "group-gone") return;
      setLoadError(normalizeError(e).message);
      setLoadingMore(false);
    });
    // 只在组摘要变化时刷新；currentId/index 由 refreshSequence 读取最新值，
    // 不能作为依赖，否则每次翻页都会重新触发刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSignature, liveGroup]);

  /** 只补下一页缩略图元数据，不预加载任何原图。 */
  const loadNextPage = useCallback(async () => {
    if (!sequence || loadingMore || items.length >= total) return;
    const request = ++pageSeq.current;
    setLoadingMore(true);
    setLoadError("");
    try {
      const page = await loadGroupPage(sequence.group, GROUP_THUMB_LIMIT, items.length, true);
      if (request !== pageSeq.current) return;
      if (page.revision !== revisionRef.current) {
        // 组内容已变化：不同 revision 的页不能拼接。重建最新前缀并同步 revision，
        // 下一次翻页继续使用新 revision，不会反复回到第一页。
        await refreshSequence(request);
        return;
      }
      if (page.items.length === 0) {
        setTotal(Math.max(items.length, 1));
        setLoadError("组内没有更多可加载的图片");
        return;
      }
      const merged = mergeThumbs(items, page.items);
      revisionRef.current = page.revision;
      setItems(merged);
      setTotal(Math.max(page.imageCount, merged.length, 1));
      setIndex(Math.min(items.length, merged.length - 1));
      setNotice("");
      sequence.onAppend(page.items);
    } catch (e) {
      if (request !== pageSeq.current) return;
      setLoadError(normalizeError(e).message);
    } finally {
      if (request === pageSeq.current) setLoadingMore(false);
    }
  }, [sequence, loadingMore, items, total, refreshSequence]);

  const goBy = useCallback(
    (delta: -1 | 1) => {
      if (!sequence || total <= 1 || loadingMore) return;
      const target = index + delta;
      if (target < 0 || target >= total) return;
      setNotice("");
      if (target < items.length) {
        setIndex(target);
        return;
      }
      // 已到已加载前缀末尾：先补下一页，追加后落到目标位置。
      if (target === items.length) void loadNextPage();
    },
    [sequence, total, loadingMore, index, items.length, loadNextPage],
  );
  const goRef = useRef(goBy);
  goRef.current = goBy;

  // 只在最上层注册方向键；输入框/文本域/组合输入中不拦截。
  useEffect(() => {
    if (!active || !multi) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      goRef.current(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, multi]);

  const stateNote =
    loadingMore
      ? "正在加载下一张…"
      : viewState === "loading"
        ? "原图读取中"
        : viewState === "missing"
          ? "图片文件缺失"
          : viewState === "error"
            ? "原图读取失败"
            : "原图按需读取";
  const footerNote = multi
    ? `${index + 1} / ${total} · ${stateNote}`
    : stateNote;

  return (
    <ClipboardLiteShell
      title={shortTitle(liteTitle(current))}
      sub={`${dim} · ${sizeLabel(current.byte_size)}`}
      rootRef={rootRef}
      onBack={onBack}
      onOpenFull={onOpenFull}
      footer={
        <>
          <span className="cap-foot-note">{footerNote}</span>
          <div className="cap-clip-foot-actions">
            <button
              type="button"
              className="cap-mini"
              disabled={viewState === "loading"}
              onClick={() => void onCopyItem(current.id, "图片")}
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
        {multi && (
          <>
            <button
              type="button"
              className="cap-clip-image-nav is-prev"
              aria-label="上一张图片"
              disabled={index <= 0 || loadingMore}
              onClick={() => goBy(-1)}
            >
              <ChevronLeft size={18} strokeWidth={2.2} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="cap-clip-image-nav is-next"
              aria-label="下一张图片"
              disabled={index >= total - 1 || loadingMore}
              onClick={() => goBy(1)}
            >
              <ChevronRight size={18} strokeWidth={2.2} aria-hidden="true" />
            </button>
            <span className="cap-clip-image-counter" aria-live="polite">
              {index + 1} / {total}
            </span>
          </>
        )}
        {viewState === "ready" && url ? (
          <img className="cap-clip-image" src={url} alt="剪贴板图片预览" draggable={false} />
        ) : (
          <div className="cap-clip-state" role={viewState === "error" ? "alert" : "status"}>
            {viewState === "loading" ? (
              <>
                <Loader2 size={16} className="spin" aria-hidden="true" />
                <span>正在加载原图…</span>
              </>
            ) : viewState === "missing" ? (
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
        {loadError ? (
          <div className="cap-clip-notice is-error" role="alert">
            加载下一张失败：{loadError}
            <button type="button" className="cap-link" onClick={() => void loadNextPage()}>
              重试
            </button>
          </div>
        ) : notice ? (
          <div className="cap-clip-notice" role="status">
            {notice}
          </div>
        ) : null}
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
  onPasteGroup,
  onOpenImage,
}: LiteViewProps & {
  group: ClipboardGroup;
  onCopyGroup: (id: string) => Promise<boolean>;
  onPasteGroup: (group: ClipboardGroup) => void;
  onOpenImage: (item: ClipboardItem, index: number, sequence: LiteImageSequence) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusRestore(true);
  useOverlayLayer("sublayer", true, onBack, rootRef);
  const [page, setPage] = useState<ClipboardGroupPage | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  const seq = useRef(0);
  /** 分页追加的缩略图：首屏之外的条目按用户操作逐页读取，不一次性拉取整组。 */
  const [extra, setExtra] = useState<ClipboardItem[]>([]);
  const [morePhase, setMorePhase] = useState<"idle" | "loading" | "error">("idle");
  const [moreErr, setMoreErr] = useState("");
  const moreSeq = useRef(0);

  const load = useCallback(() => {
    const n = ++seq.current;
    // 首屏重读时旧的后台分页结果一并作废，避免把上一份序列拼进来。
    moreSeq.current += 1;
    setExtra([]);
    setMorePhase("idle");
    setMoreErr("");
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
      moreSeq.current += 1;
    };
  }, [load]);

  const thumbs = page ? mergeThumbs(page.items, extra) : [];
  const remaining = page ? Math.max(0, page.imageCount - thumbs.length) : 0;

  /** 查看剩余图片：复用同一有界分页接口，每次只多读一页缩略图。 */
  const loadMore = useCallback(() => {
    if (!page || morePhase === "loading") return;
    if (thumbs.length >= page.imageCount) return;
    const n = ++moreSeq.current;
    setMorePhase("loading");
    setMoreErr("");
    loadGroupPage(group, GROUP_THUMB_LIMIT, thumbs.length, true).then(
      (d) => {
        if (n !== moreSeq.current) return;
        // 组内容在分页期间变化：offset 已不可信，放弃拼接并从第一页重读。
        if (d.revision !== page.revision) {
          setMorePhase("idle");
          load();
          return;
        }
        setExtra((prev) => {
          const merged = mergeThumbs(page.items, [...prev, ...d.items]);
          const fresh = merged.slice(page.items.length);
          return fresh.length === prev.length ? prev : fresh;
        });
        setMorePhase("idle");
      },
      (e) => {
        if (n !== moreSeq.current) return;
        setMoreErr(normalizeError(e).message);
        setMorePhase("error");
      },
    );
  }, [page, morePhase, thumbs.length, group, load]);
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
        : `共 ${page.imageCount} 张，已全部显示`
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
              aria-label={`逐项粘贴截图组「${group.name || "截图组"}」`}
              onClick={() => onPasteGroup(group)}
            >
              逐项粘贴
            </button>
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
                onClick={() =>
                  onOpenImage(img, i, {
                    group,
                    items: thumbs,
                    index: i,
                    total: page?.imageCount ?? thumbs.length,
                    revision: page?.revision ?? "",
                    // 预览翻页时把新页同步给下层组视图；返回后仍能看到已加载缩略图。
                    onAppend: (more) => {
                      setExtra((prev) => {
                        const base = page?.items ?? [];
                        const merged = mergeThumbs(base, [...prev, ...more]);
                        return merged.slice(base.length);
                      });
                    },
                    // revision 变化后下层组视图也切换到新前缀，避免返回后继续使用
                    // 旧 revision 的 page.items 去拼接（会混合两个版本）。
                    onReplace: (next, nextTotal, nextRevision) => {
                      setPage((prevPage) =>
                        prevPage
                          ? {
                              ...prevPage,
                              items: next,
                              imageCount: nextTotal,
                              limit: next.length,
                              revision: nextRevision,
                            }
                          : prevPage,
                      );
                      setExtra([]);
                      setMorePhase("idle");
                      setMoreErr("");
                    },
                  })
                }
              >
                <ClipboardThumb itemId={img.id} hasThumb={img.has_thumb} size={86} />
              </button>
            ))}
            {remaining > 0 && (
              <button
                type="button"
                className="cap-clip-tile is-more"
                aria-label={`加载更多截图，还有 ${remaining} 张`}
                disabled={morePhase === "loading"}
                onClick={loadMore}
              >
                {morePhase === "loading" ? (
                  <Loader2 size={14} className="spin" aria-hidden="true" />
                ) : (
                  <span>
                    还有
                    <br />
                    {remaining} 张
                  </span>
                )}
              </button>
            )}
          </div>
          {morePhase === "error" ? (
            <div className="cap-clip-state is-error" role="alert">
              <span>加载更多失败：{moreErr}</span>
              <button type="button" className="cap-link" onClick={loadMore}>
                重试
              </button>
            </div>
          ) : null}
        </div>
      )}
    </ClipboardLiteShell>
  );
}
