//! 剪贴板条目详情：完整正文/图片/文件、类型专属预览与操作、收藏、置顶、
//! 任务关联与 Agent 导出。
//!
//! 统一详情结构：标题 → 元信息 → 类型专属预览区 → 类型专属操作 → 通用操作。
//! 类型专属部分只换预览与就近操作，不另起一套页面骨架。

import { useEffect, useState } from "react";
import {
  ArrowLeft, Check, CircleCheck, Code2, Copy, ExternalLink, Eye, FileText,
  FolderOpen, Link2, Pencil, Pin, Search, Star, Trash2, X, AppWindow, Info,
} from "lucide-react";
import {
  clipboardCopyItem,
  clipboardDeleteItems,
  clipboardItem,
  clipboardLinkTask,
  clipboardOpenLocalPath,
  clipboardOpenUrl,
  clipboardPathStatus,
  clipboardRenameItem,
  clipboardRevealLocalPath,
  clipboardToggleItem,
  type ClipboardItem,
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
      showToast(
        `已复制（${r.mode.toUpperCase()}，${formatBytes(r.bytes)}）${warn}`,
        { kind: r.warnings.length > 0 ? "info" : "success" },
      );
      await reload();
      // 复制只增加使用次数；列表就地更新，避免整表刷新导致分页与滚动位置变化。
      useClipboardStore.getState().bumpItemCopy(itemId);
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
                      showToast(`已复制富文本（${formatBytes(r.bytes)}）`, { kind: "success" });
                      useClipboardStore.getState().bumpItemCopy(item.id);
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
