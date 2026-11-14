//! 剪贴板条目详情：完整正文/图片/文件、类型专属预览与操作、收藏、置顶、
//! 任务关联与 Agent 导出。
//!
//! 统一详情结构：标题 → 元信息 → 类型专属预览区 → 类型专属操作 → 通用操作。
//! 类型专属部分只换预览与就近操作，不另起一套页面骨架。

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Check, CircleCheck, Code2, Copy, ExternalLink, Eye, FileText,
  FolderOpen, Link2, Loader2, Pencil, Pin, ScanText, Search, Star, Trash2, X, AppWindow, Info,
} from "lucide-react";
import {
  clipboardCopyItem,
  clipboardDeleteItems,
  clipboardItem,
  clipboardLinkTask,
  clipboardOcr,
  clipboardOcrCancel,
  clipboardOpenLocalPath,
  clipboardOpenUrl,
  clipboardPathStatus,
  clipboardRenameItem,
  clipboardRevealLocalPath,
  clipboardToggleItem,
  type ClipboardItem,
  type ClipboardOcrReport,
} from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import { errorMessage, normalizeError } from "../../lib/errors";
import {
  clipSource, clipboardTime, fileBaseName, formatBytes, kindLabel, looksLikeCode, objectHint,
  urlDomain,
} from "../../lib/clipboardUi";
import { useUiStore } from "../../store/useUiStore";
import { useClipboardStore } from "../../store/useClipboardStore";
import AgentExportPanel from "./AgentExportPanel";
import HtmlReader from "./HtmlReader";
import ImageLightbox from "./ImageLightbox";
import { ClipboardLargeImage } from "./Media";
import TaskLinkBar from "./TaskLinkBar";
import WorkspaceLinkBar from "./WorkspaceLinkBar";
import type { AskConfirm, LinkTask } from "./types";

/** 文件路径状态：ok / missing / inaccessible / checking / unknown（查询失败，不可确认）。 */
type PathState = "ok" | "missing" | "inaccessible" | "checking" | "unknown";

/** OCR 面板状态：同一详情内展示结果，不弹模态框。 */
type OcrView =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "result"; report: ClipboardOcrReport }
  | { kind: "notice"; tone: "unavailable" | "error"; message: string };

/** 搜索关键词上限：只填代表性片段，绝不把整篇长文塞进搜索框。 */
const OCR_SEARCH_KEYWORD_MAX = 24;

/** 每次请求使用独立 id，用于精准取消与「迟到结果不落地」校验。 */
function newOcrRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 取第一段有内容的文字并截断，作为历史搜索关键词。 */
function ocrSearchKeyword(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const collapsed = line.replace(/[ \t\u3000]+/g, " ");
  return collapsed.length > OCR_SEARCH_KEYWORD_MAX
    ? collapsed.slice(0, OCR_SEARCH_KEYWORD_MAX)
    : collapsed;
}

/** 后端返回的是字符串：非预期的取值一律按「无法确认」处理，不默认成存在。 */
function normalizePathState(v: unknown): PathState {
  return v === "ok" || v === "missing" || v === "inaccessible" ? v : "unknown";
}

export default function ClipboardItemDetail({
  itemId,
  linkTask,
  askConfirm,
  onBack,
  onChanged,
  onSearchHistory,
}: {
  itemId: string;
  linkTask: LinkTask;
  askConfirm: AskConfirm;
  onBack: () => void;
  onChanged: () => void;
  /** 在当前剪贴板历史里按关键词搜索；由列表容器提供，分组详情内没有搜索框时可缺省。 */
  onSearchHistory?: (query: string) => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const bumpLink = useUiStore((s) => s.bumpClipboardLink);
  const closeDrawer = useUiStore((s) => s.closeClipboard);
  const [item, setItem] = useState<ClipboardItem | null>(null);
  const [htmlView, setHtmlView] = useState<"read" | "source">("read");
  const [codeView, setCodeView] = useState<boolean | null>(null); // null = 未决定，用自动识别
  const [lightbox, setLightbox] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [pathStates, setPathStates] = useState<Record<string, PathState>>({});
  /** 批量状态查询是否失败：失败时所有路径按「未知」处理，绝不按「存在」放行。 */
  const [pathCheckFailed, setPathCheckFailed] = useState(false);
  /**
   * 失败是否属于「后台繁忙」（并发配额已满）：与「无法确认状态」共用 unknown 语义，
   * 但提示文案要区分，避免把繁忙误说成文件丢失。查询失败不做自动重试，
   * 只在用户重新进入详情时再试一次。
   */
  const [pathCheckBusy, setPathCheckBusy] = useState(false);
  /** 图片文字识别面板：结果留在本详情内，不另开弹窗。 */
  const [ocr, setOcr] = useState<OcrView>({ kind: "idle" });
  /** 当前有效请求 id；切换条目/卸载时据此精准取消，迟到的旧结果不落地。 */
  const activeOcr = useRef<string | null>(null);

  // 切换条目或离开详情：立即取消进行中的识别，丢弃旧结果，面板回到初始态。
  useEffect(() => {
    setOcr({ kind: "idle" });
    setLightbox(false);
    return () => {
      const rid = activeOcr.current;
      activeOcr.current = null;
      if (rid) void clipboardOcrCancel(rid).catch(() => {});
    };
  }, [itemId]);

  useEffect(() => {
    let alive = true;
    setItem(null);
    setLightbox(false);
    clipboardItem(itemId)
      .then((i) => {
        if (alive) setItem(i);
      })
      .catch((e) => {
        if (alive) {
          showToast(`读取条目失败：${errorMessage(e)}`, { kind: "error" });
          onBack();
        }
      });
    return () => {
      alive = false;
    };
  }, [itemId]);

  // 文件存在性一次性批量查询（≤200 条），用于区分「已移动/删除」与「无权限」
  const pathsKey = (item?.file_paths ?? []).join("\n");
  useEffect(() => {
    if (!item || pathsKey === "") return;
    let alive = true;
    const paths = pathsKey.split("\n").slice(0, 200);
    setPathCheckFailed(false);
    setPathCheckBusy(false);
    setPathStates(Object.fromEntries(paths.map((p) => [p, "checking" as PathState])));
    clipboardPathStatus(paths)
      .then((states) => {
        if (alive) {
          setPathStates(
            Object.fromEntries(
              paths.map((p, i) => [p, normalizePathState(states[i])]),
            ),
          );
        }
      })
      .catch((e) => {
        // 查询失败不阻塞详情，但也不能虚报：统一落到「未知」，操作按钮一律禁用。
        // 仅在文案上区分「后台繁忙」（配额已满），绝不把繁忙显示成文件丢失。
        if (alive) {
          setPathStates({});
          setPathCheckFailed(true);
          setPathCheckBusy(normalizeError(e).code === "SERVICE_OVERLOADED");
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, pathsKey]);

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
      // 写入成功即成功；统计失败等降级项显示「部分成功」，不报告成复制失败
      const partial = r.warnings.length > 0 || r.stats_recorded === false;
      showToast(
        `已复制${partial ? "（部分成功）" : ""}（${r.mode.toUpperCase()}，${formatBytes(r.bytes)}）${warn}`,
        { kind: partial ? "info" : "success" },
      );
      await reload();
      // 复制只增加使用次数；列表就地更新，避免整表刷新导致分页与滚动位置变化。
      // 统计没落库时不能本地加次数。
      if (r.stats_recorded !== false) useClipboardStore.getState().bumpItemCopy(itemId);
    } catch (e) {
      showToast(`复制失败：${errorMessage(e)}`, { kind: "error" });
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
      showToast(`更新收藏/置顶失败：${errorMessage(e)}`, { kind: "error" });
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
      showToast(`标题保存失败：${errorMessage(e)}`, { kind: "error" });
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
      showToast(`关联失败：${errorMessage(e)}`, { kind: "error" });
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

  async function onOpenUrl() {
    if (!item) return;
    try {
      await clipboardOpenUrl(item.id);
      showToast("已交给系统默认浏览器打开", { kind: "success" });
    } catch (e) {
      showToast(`打开失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  async function onOpenFile(path: string) {
    try {
      await clipboardOpenLocalPath(path);
      showToast("已交给系统关联程序打开", { kind: "success" });
    } catch (e) {
      showToast(`打开失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  async function onRevealFile(path: string) {
    try {
      await clipboardRevealLocalPath(path);
      showToast("已在资源管理器中定位", { kind: "success" });
    } catch (e) {
      showToast(`定位失败：${errorMessage(e)}`, { kind: "error" });
    }
  }

  // ── 图片文字识别（按需执行，同一详情内展示） ──

  async function onExtractText() {
    if (!item || ocr.kind === "running") return;
    const rid = newOcrRequestId();
    const target = item.id;
    activeOcr.current = rid;
    setOcr({ kind: "running" });
    try {
      const report = await clipboardOcr(target, rid);
      // 已切换条目或已离开详情：旧请求的结果一律丢弃，不覆盖新条目的面板。
      if (activeOcr.current !== rid) return;
      activeOcr.current = null;
      switch (report.status) {
        case "ok":
        case "empty":
          setOcr({ kind: "result", report });
          break;
        case "unavailable":
          setOcr({
            kind: "notice",
            tone: "unavailable",
            message: report.reason || "本机无法使用 Windows 本地文字识别",
          });
          break;
        case "busy":
          // 不排队、不自动重试：明确告诉用户另一张图正在识别，按钮立即恢复。
          setOcr({ kind: "idle" });
          showToast(report.reason || "另一张图片正在识别，请稍后重试", { kind: "warning" });
          break;
        case "cancelled":
          setOcr({ kind: "idle" });
          break;
        case "too_large":
          // 不是「没有识别到文字」：明确提示图片超出识别预算并建议截取局部。
          setOcr({
            kind: "notice",
            tone: "error",
            message: report.reason || "图片过大，请截取需要的局部后再识别",
          });
          break;
        default:
          setOcr({
            kind: "notice",
            tone: "error",
            message: report.reason || "识别失败，请稍后重试",
          });
          break;
      }
    } catch (e) {
      if (activeOcr.current !== rid) return;
      activeOcr.current = null;
      setOcr({ kind: "notice", tone: "error", message: errorMessage(e) });
    }
  }

  async function onCopyOcrText(text: string) {
    const ok = await copyText(text);
    showToast(ok ? "识别文字已复制" : "复制失败", { kind: ok ? "success" : "error" });
  }

  function onSearchOcrText(text: string) {
    if (!onSearchHistory) return;
    const keyword = ocrSearchKeyword(text);
    if (!keyword) return;
    onSearchHistory(keyword);
    showToast(`已用「${keyword}」搜索历史`, { kind: "info" });
  }

  /** 只有用户主动点击才会写入标题；识别完成绝不自动覆盖，包括手动标题。 */
  async function onUseOcrTitle(title: string) {
    try {
      const updated = await clipboardRenameItem(itemId, title);
      setItem(updated);
      useClipboardStore.getState().renameItem(itemId, updated.title, updated.title_source);
      showToast("已将识别文字设为标题", { kind: "success" });
    } catch (e) {
      showToast(`标题保存失败：${errorMessage(e)}`, { kind: "error" });
    }
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

  const isUrl = item.kind === "url";
  const domain = isUrl ? urlDomain(item.text) : "";
  // 来源是三个展示位置共用的结构（应用名 / 窗口标题 / 识别方式），不在这里另写一套格式化
  const src = clipSource(item);
  const files = item.file_paths;
  const isCode = codeView ?? (item.kind === "text" && looksLikeCode(item.text));

  const PATH_STATE_META: Record<PathState, { label: string; cls: string }> = {
    ok: { label: "存在", cls: "ok" },
    missing: { label: "已不存在", cls: "missing" },
    inaccessible: { label: "无权限", cls: "inaccessible" },
    checking: { label: "检查中", cls: "checking" },
    unknown: { label: "无法确认", cls: "unknown" },
  };

  /** 行内按钮、顶部按钮、状态徽标共用同一判定，不允许两套口径。 */
  const pathStateOf = (p: string): PathState =>
    pathCheckFailed ? "unknown" : (pathStates[p] ?? "checking");

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

      {/* 条目详情修饰类：页面态宽屏下「采集环境」右栏化（见 clipboard-page.css） */}
      <div className="clip-detail-body clip-detail-item-body">
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
          <span className="clip-detail-app" title={src.appRaw || undefined}>{src.app}</span>
          <span>创建 {clipboardTime(item.created_at)}</span>
          <span>最近 {clipboardTime(item.last_seen_at)}</span>
          {item.copy_count > 0 && <span>已使用 {item.copy_count} 次</span>}
          {item.kind === "image" && item.image_width && item.image_height && (
            <span>{item.image_width}×{item.image_height}</span>
          )}
        </div>

        {/* 采集环境：讲清楚「这条内容是在什么应用、什么窗口下被采集的」。
            来源是辅助元数据，不等于内容本身，也不等于用户按下 Ctrl+C 的那个程序。 */}
        <section className="clip-source-block" aria-label="采集环境">
          <div className="clip-source-title">
            <AppWindow size={12} /> 采集环境
          </div>
          <div className="clip-source-rows">
            <div className="clip-source-row">
              <span className="clip-source-key">应用</span>
              <span className="clip-source-val" title={src.appRaw || undefined}>
                {src.app}
              </span>
            </div>
            <div className="clip-source-row">
              <span className="clip-source-key">窗口</span>
              <span
                className="clip-source-val"
                tabIndex={src.window ? 0 : undefined}
                data-tip={src.window ? `窗口：${src.windowRaw}` : undefined}
              >
                {src.window || "（未记录窗口标题）"}
              </span>
            </div>
            <div className="clip-source-row">
              <span className="clip-source-key">识别方式</span>
              <span className="clip-source-val">
                {src.trust}
                {src.appRaw && (
                  <span className="clip-source-raw">· 来源进程 {src.appRaw}</span>
                )}
              </span>
            </div>
          </div>
          <p className="clip-source-note">
            <Info size={11} />
            这里记录的是采集时识别到的应用与窗口环境，不一定是实际执行复制操作的程序。
          </p>
        </section>

        {/* ── 类型专属预览区 ── */}

        {item.kind === "image" && (
          <div className="clip-image-wrap">
            <ClipboardLargeImage itemId={item.id} onOpen={() => setLightbox(true)} />
            <div className="clip-hint">点击图片进入大图预览，支持缩放与拖拽。</div>
          </div>
        )}

        {/* 图片详情内就地提取文字：按需执行，结果不弹新窗口，加载与结果使用同一高度区域。 */}
        {item.kind === "image" && (
          <section className="clip-ocr-block" aria-label="图片文字识别">
            <div className="clip-block-head">
              <span>图片文字</span>
              <div className="clip-block-head-actions">
                <button
                  className="btn sm"
                  onClick={() => void onExtractText()}
                  disabled={ocr.kind === "running"}
                  aria-busy={ocr.kind === "running"}
                  data-tip="使用本机 Windows 文字识别，离线执行，不上传图片"
                >
                  {ocr.kind === "running" ? (
                    <Loader2 size={11} className="spin" aria-hidden="true" />
                  ) : (
                    <ScanText size={11} aria-hidden="true" />
                  )}
                  {ocr.kind === "running" ? "识别中…" : "提取文字"}
                </button>
              </div>
            </div>

            {ocr.kind === "idle" && (
              <div className="clip-ocr-status">
                识别这张图片中的文字，全程在本机离线执行，不上传图片或文字。
              </div>
            )}

            {ocr.kind === "running" && (
              <div className="clip-ocr-status" role="status">
                正在识别图片文字…
              </div>
            )}

            {ocr.kind === "result" && ocr.report.status === "ok" && (
              <>
                <textarea
                  className="clip-ocr-text"
                  readOnly
                  spellCheck={false}
                  aria-label="识别出的文字"
                  value={ocr.report.text}
                />
                <div className="clip-ocr-actions">
                  <button
                    className="btn sm"
                    onClick={() => void onCopyOcrText(ocr.report.text)}
                  >
                    <Copy size={11} /> 复制文字
                  </button>
                  {onSearchHistory && ocrSearchKeyword(ocr.report.text) !== "" && (
                    <button
                      className="btn sm"
                      onClick={() => onSearchOcrText(ocr.report.text)}
                      data-tip="只把开头的关键词填入搜索框，不会搜索整篇长文"
                    >
                      <Search size={11} /> 用文字搜索历史
                    </button>
                  )}
                  {ocr.report.suggestedTitle && (
                    <button
                      className="btn sm"
                      onClick={() => void onUseOcrTitle(ocr.report.suggestedTitle!)}
                      data-tip="仅在你点击时写入标题；不会自动覆盖现有标题"
                    >
                      <Pencil size={11} /> 设为标题
                    </button>
                  )}
                  <span className="clip-ocr-meta">
                    {ocr.report.chars} 字 · {ocr.report.lines} 行
                    {ocr.report.cached
                      ? " · 缓存结果"
                      : ` · ${ocr.report.durationMs} ms`}
                  </span>
                </div>
              </>
            )}

            {ocr.kind === "result" && ocr.report.status === "empty" && (
              <div className="clip-ocr-status" role="status">
                未识别到文字
              </div>
            )}

            {ocr.kind === "notice" && (
              <>
                <div
                  className={`clip-ocr-status is-${ocr.tone}`}
                  role={ocr.tone === "error" ? "alert" : "status"}
                >
                  {ocr.message}
                </div>
                {ocr.tone === "unavailable" && (
                  <div className="clip-hint">
                    需要系统已安装中文 / 英文 OCR 语言包。本应用不会自动下载模型，也不会改用云端识别。
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {isUrl && (
          <div className="clip-url-block">
            <div className="clip-url-line">
              <span className="clip-url-domain" title={domain || undefined}>
                {domain || "（域名不可用）"}
              </span>
              {domain && (
                <button
                  className="btn sm primary"
                  onClick={onOpenUrl}
                  data-tip="使用系统默认浏览器打开"
                >
                  <ExternalLink size={11} /> 打开链接
                </button>
              )}
            </div>
            <div className="clip-url-full" title={item.text}>{item.text}</div>
            <div className="clip-url-actions">
              <button
                className="btn sm"
                onClick={async () => {
                  const ok = await copyText(item.text);
                  showToast(ok ? "链接已复制" : "复制失败", { kind: ok ? "success" : "error" });
                }}
              >
                <Copy size={11} /> 复制链接
              </button>
            </div>
            {!domain && <div className="clip-hint">这不是有效的 http/https 链接，打开已被禁止。</div>}
          </div>
        )}

        {files.length > 0 && (
          <div className="clip-path-block">
            <div className="clip-block-head">
              <span>文件路径（{files.length}）</span>
              <div className="clip-block-head-actions">
                <button
                  className="btn sm"
                  onClick={async () => {
                    const ok = await copyText(files.join("\n"));
                    showToast(ok ? "路径已复制" : "复制失败", { kind: ok ? "success" : "error" });
                  }}
                >
                  <Copy size={11} /> 复制路径
                </button>
                {files.length === 1 && (() => {
                  // 与行内按钮同一判定：只有确认存在才放行，未确认/失败一律禁用
                  const st = pathStateOf(files[0]);
                  const canOpen = st === "ok";
                  const why = PATH_STATE_META[st].label;
                  return (
                    <>
                      <button
                        className="btn sm"
                        onClick={() => void onOpenFile(files[0])}
                        disabled={!canOpen}
                        data-tip={canOpen ? undefined : `文件状态：${why}，暂不可打开`}
                      >
                        <FolderOpen size={11} /> 打开文件
                      </button>
                      <button
                        className="btn sm"
                        onClick={() => void onRevealFile(files[0])}
                        disabled={!canOpen}
                        data-tip={canOpen ? undefined : `文件状态：${why}，暂不可定位`}
                      >
                        <Search size={11} /> 资源管理器定位
                      </button>
                    </>
                  );
                })()}
              </div>
            </div>
            <ul className="clip-path-list">
              {files.slice(0, 200).map((p) => {
                const st = pathStateOf(p);
                const meta = PATH_STATE_META[st];
                return (
                  <li key={p} className={`clip-path-row is-${meta.cls}`} title={p}>
                    <FileText size={11} />
                    <span className="clip-path-name">{fileBaseName(p)}</span>
                    <span className="clip-path-full">{p}</span>
                    <span className={`clip-path-state ${meta.cls}`} title={meta.label}>
                      <CircleCheck size={11} aria-hidden="true" />
                      {meta.label}
                    </span>
                    <span className="clip-path-actions">
                      <button
                        className="icon-btn sm"
                        data-tip="打开文件"
                        aria-label={`打开 ${fileBaseName(p)}`}
                        disabled={st !== "ok"}
                        onClick={() => void onOpenFile(p)}
                      >
                        <FolderOpen size={11} />
                      </button>
                      <button
                        className="icon-btn sm"
                        data-tip="资源管理器定位"
                        aria-label={`定位 ${fileBaseName(p)}`}
                        disabled={st !== "ok"}
                        onClick={() => void onRevealFile(p)}
                      >
                        <Search size={11} />
                      </button>
                      <button
                        className="icon-btn sm"
                        data-tip="复制路径"
                        aria-label={`复制路径 ${fileBaseName(p)}`}
                        onClick={async () => {
                          const ok = await copyText(p);
                          showToast(ok ? "路径已复制" : "复制失败", { kind: ok ? "success" : "error" });
                        }}
                      >
                        <Copy size={11} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
            {pathCheckFailed && (
              <div className="clip-hint">
                {pathCheckBusy
                  ? "文件状态查询任务较多（后台繁忙），无法确认路径是否仍存在；打开与定位已暂时禁用，稍后返回重新进入可再试一次。"
                  : "文件状态查询失败，无法确认路径是否仍存在；打开与定位已暂时禁用，返回后重新进入可再试一次。"}
              </div>
            )}
            <div className="clip-hint">
              打开使用系统文件关联程序；文件被移动或删除后将无法打开，粘贴也可能缺失。
            </div>
          </div>
        )}

        {item.html && (
          <div className="clip-html-block">
            <div className="clip-block-head">
              <div className="clip-view-tabs" role="tablist" aria-label="富文本视图">
                <button
                  className={`clip-view-tab ${htmlView === "read" ? "active" : ""}`}
                  role="tab"
                  aria-selected={htmlView === "read"}
                  onClick={() => setHtmlView("read")}
                >
                  <Eye size={11} /> 阅读视图
                </button>
                <button
                  className={`clip-view-tab ${htmlView === "source" ? "active" : ""}`}
                  role="tab"
                  aria-selected={htmlView === "source"}
                  onClick={() => setHtmlView("source")}
                >
                  <Code2 size={11} /> 源码
                </button>
              </div>
              <div className="clip-block-head-actions">
                <button
                  className="btn sm"
                  onClick={async () => {
                    const ok = await copyText(item.text || item.html);
                    showToast(ok ? "纯文本已复制" : "复制失败", { kind: ok ? "success" : "error" });
                  }}
                >
                  <Copy size={11} /> 复制纯文本
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await clipboardCopyItem(item.id);
                      const warn = r.warnings.length > 0 ? `；${r.warnings.join("；")}` : "";
                      const partial = r.warnings.length > 0 || r.stats_recorded === false;
                      // 写入成功即成功；统计失败只降级为「部分成功」，不报复制失败
                      showToast(`已复制富文本${partial ? "（部分成功）" : ""}（${formatBytes(r.bytes)}）${warn}`, {
                        kind: partial ? "info" : "success",
                      });
                      if (r.stats_recorded !== false) useClipboardStore.getState().bumpItemCopy(item.id);
                    } catch (e) {
                      showToast(`复制失败：${errorMessage(e)}`, { kind: "error" });
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  <Copy size={11} /> 复制富文本
                </button>
              </div>
            </div>
            {htmlView === "read" ? (
              <HtmlReader html={item.html} />
            ) : (
              <pre className="clip-html" tabIndex={0}>{item.html}</pre>
            )}
            <div className="clip-hint">
              阅读视图为安全白名单渲染：脚本、外链图片与表单不会加载；复制时保留原始 HTML 格式。
            </div>
          </div>
        )}

        {item.text && !isUrl && (
          <div className="clip-text-block">
            {item.kind === "text" && (
              <div className="clip-block-head">
                <div className="clip-view-tabs" role="tablist" aria-label="文本视图">
                  <button
                    className={`clip-view-tab ${!isCode ? "active" : ""}`}
                    role="tab"
                    aria-selected={!isCode}
                    onClick={() => setCodeView(false)}
                  >
                    <FileText size={11} /> 普通文本
                  </button>
                  <button
                    className={`clip-view-tab ${isCode ? "active" : ""}`}
                    role="tab"
                    aria-selected={isCode}
                    onClick={() => setCodeView(true)}
                  >
                    <Code2 size={11} /> 代码阅读
                  </button>
                </div>
                {isCode && (
                  <div className="clip-block-head-actions">
                    <button
                      className="btn sm"
                      onClick={async () => {
                        const ok = await copyText(item.text);
                        showToast(ok ? "代码已复制" : "复制失败", { kind: ok ? "success" : "error" });
                      }}
                    >
                      <Copy size={11} /> 复制代码
                    </button>
                  </div>
                )}
              </div>
            )}
            <pre className={`clip-full-text ${isCode ? "as-code" : ""}`} tabIndex={0}>
              {item.text}
            </pre>
          </div>
        )}

        {!item.text && item.file_paths.length === 0 && item.kind !== "image" && (
          <div className="clip-hint">该条目没有可展示的正文（内容可能已被清理）。</div>
        )}

        <TaskLinkBar targetType="item" targetId={item.id} />
        <WorkspaceLinkBar targetType="item" targetId={item.id} />
        <AgentExportPanel targetType="item" targetId={item.id} taskId={linkTask?.id ?? null} />
      </div>

      {lightbox && <ImageLightbox
          item={item}
          askConfirm={askConfirm}
          onClose={() => setLightbox(false)}
        />}
    </div>
  );
}
