//! 暂存架详情子视图：安全预览（图片灯箱 / 文本只读 / 链接 / 元数据）、
//! 任务关联管理（增删、幂等）、备注编辑与条目操作。
//!
//! 预览边界：HTML 文件文本经前端白名单净化只读渲染（复用剪贴板 HtmlReader），
//! 不发起任何资源请求；未知格式只展示元数据，不自动执行。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft, Copy, ExternalLink, FolderOpen, Link2, Loader2, Plus, Save, Trash2, X,
} from "lucide-react";
import {
  listTasks,
  shelfCopyPaths,
  shelfLinkProject,
  shelfLinkTask,
  shelfOcrCancel,
  shelfOcrItem,
  shelfOpenItem,
  shelfProjectLinks,
  shelfReadImage,
  shelfReadText,
  shelfRevealItem,
  shelfTaskLinks,
  shelfUnlinkProject,
  workspaceProjectList,
  type ShelfItem,
  type ShelfProjectLink,
  type ShelfTaskLink,
} from "../../lib/bridge";
import { clipboardTime, formatBytes } from "../../lib/clipboardUi";
import { clipboardCopyText } from "../../lib/bridge";
import { shelfFileTypeUi } from "../../lib/fileTypeUi";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog } from "../ui/Dialog";
import Select from "../ui/Select";
import HtmlReader from "../clipboard/HtmlReader";
import ShelfImageLightbox from "./ShelfImageLightbox";
import { splitTagInput } from "./ShelfTagDialog";
import { shelfDeleteFeedback } from "./shelfDeleteFeedback";

/** 文本预览上限（后端已截断；这里只控制渲染量）。 */
const PREVIEW_RENDER_LIMIT = 200_000;

export default function ShelfDetail({
  item,
  onClose,
  onFileOp,
  onRelocate,
}: {
  item: ShelfItem;
  onClose: () => void;
  /** 打开「移动原文件到… / 复制到…」内嵌面板（由工作区复用同一面板） */
  onFileOp?: (op: "move" | "copy") => void;
  /** 失效引用条目重新选择外部路径 */
  onRelocate?: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const updateItem = useShelfStore((s) => s.updateItem);
  const verifyExists = useShelfStore((s) => s.verifyExists);
  const deletionBusy = useShelfStore((s) => s.deletionBusy);
  const retryShelfSync = useShelfStore((s) => s.retryShelfSync);
  const itemTags = useShelfStore((s) => s.itemTags);
  const tagItems = useShelfStore((s) => s.tagItems);

  const [lightbox, setLightbox] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [links, setLinks] = useState<ShelfTaskLink[]>([]);
  const [taskOptions, setTaskOptions] = useState<{ id: string; title: string }[]>([]);
  const [taskOptionsState, setTaskOptionsState] = useState<"loading" | "ready" | "error">("loading");
  const [taskOptionsError, setTaskOptionsError] = useState("");
  const [taskToLink, setTaskToLink] = useState("");
  const [projectLinks, setProjectLinks] = useState<ShelfProjectLink[]>([]);
  const [projectOptions, setProjectOptions] = useState<{ id: string; name: string }[]>([]);
  const [projectState, setProjectState] = useState<"loading" | "ready" | "error">("loading");
  const [projectError, setProjectError] = useState("");
  const [projectToLink, setProjectToLink] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrText, setOcrText] = useState("");
  const [ocrError, setOcrError] = useState("");
  const [ocrRequest, setOcrRequest] = useState("");
  const ocrSeq = useRef(0);
  const [noteDraft, setNoteDraft] = useState(item.note);
  const [savingNote, setSavingNote] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const noteDirty = noteDraft !== item.note;
  const protectedLabel = (() => {
    const labels: string[] = [];
    if (item.favorite && item.pinned) labels.push("收藏且置顶");
    else if (item.favorite) labels.push("收藏");
    else if (item.pinned) labels.push("置顶");
    if (item.scene_id) labels.push("被场景引用");
    return labels.length ? labels.join("，") : null;
  })();
  const loadedRef = useRef(false);

  useEffect(() => {
    setNoteDraft(item.note);
    setTextContent(null);
    setTextError(null);
    setOcrText("");
    setOcrError("");
    setOcrBusy(false);
    loadedRef.current = false;
  }, [item.id, item.note]);

  // 切换条目/卸载时取消还在跑的识别；取消只匹配同一 requestId。
  useEffect(() => {
    return () => {
      if (ocrRequest) void shelfOcrCancel(ocrRequest).catch(() => {});
    };
  }, [ocrRequest]);

  // 进入详情刷新一次存在性（引用失效立即如实呈现）
  useEffect(() => {
    void verifyExists([item.id]);
  }, [item.id, verifyExists]);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const loadText = async () => {
      if (item.kind === "text") {
        try {
          const r = await shelfReadText(item.id);
          setTextContent(r.content);
          setTruncated(r.truncated);
        } catch (e) {
          setTextError(String(e));
        }
        return;
      }
      const ext = item.file_ext ?? "";
      const textLike = ["txt", "md", "markdown", "json", "log", "csv", "ini", "cfg", "yaml", "yml", "toml", "xml", "js", "ts", "py", "rs", "css", "bat", "ps1", "sh", "sql"];
      if (item.kind === "file" && textLike.includes(ext)) {
        try {
          const r = await shelfReadText(item.id);
          setTextContent(r.content);
          setTruncated(r.truncated);
        } catch (e) {
          setTextError(String(e));
        }
      }
    };
    void loadText();
  }, [item.id, item.kind, item.file_ext]);

  const reloadLinks = async () => {
    try {
      setLinks(await shelfTaskLinks(item.id));
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  };

  const reloadProjectLinks = async () => {
    try {
      setProjectLinks(await shelfProjectLinks(item.id));
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  };

  const reloadTags = async () => {
    try {
      setTags(await itemTags(item.id));
    } catch {
      // 标签是辅助信息：读取失败不阻断详情，其他操作照常。
      setTags([]);
    }
  };

  useEffect(() => {
    setTags([]);
    setTagInput("");
    void reloadTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const addTag = async () => {
    const next = splitTagInput(tagInput);
    if (next.length === 0 || tagBusy) return;
    setTagBusy(true);
    try {
      const r = await tagItems([item.id], next, "add");
      if (r.success) setTagInput("");
      await reloadTags();
    } catch (e) {
      showToast(`添加标签失败：${String(e)}`, { kind: "error" });
    } finally {
      setTagBusy(false);
    }
  };

  const removeTag = async (tag: string) => {
    if (tagBusy) return;
    setTagBusy(true);
    try {
      await tagItems([item.id], [tag], "remove");
      await reloadTags();
    } catch (e) {
      showToast(`移除标签失败：${String(e)}`, { kind: "error" });
    } finally {
      setTagBusy(false);
    }
  };

  useEffect(() => {
    void reloadLinks();
    void reloadProjectLinks();
    let alive = true;
    setTaskOptionsState("loading");
    setTaskOptionsError("");
    setTaskToLink("");
    listTasks({ view: "all", limit: 200 })
      .then((tasks) => {
        if (!alive) return;
        setTaskOptions(tasks.map((t) => ({ id: t.id, title: t.title })));
        setTaskOptionsState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setTaskOptions([]);
        setTaskOptionsError(String(e));
        setTaskOptionsState("error");
      });

    setProjectState("loading");
    setProjectError("");
    setProjectToLink("");
    workspaceProjectList("active")
      .then(({ projects }) => {
        if (!alive) return;
        setProjectOptions(projects.map((p) => ({ id: p.id, name: p.name })));
        setProjectState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setProjectOptions([]);
        setProjectError(String(e));
        setProjectState("error");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const missing = item.exists_state === "missing";

  const linkPlaceholder =
    taskOptionsState === "loading"
      ? "正在加载任务…"
      : taskOptionsState === "error"
        ? "任务列表加载失败"
        : taskOptions.length === 0
          ? "暂无可关联任务"
          : "选择任务…";

  const addLink = async () => {
    if (!taskToLink) return;
    try {
      await shelfLinkTask(item.id, taskToLink);
      setTaskToLink("");
      await reloadLinks();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  };

  const addProjectLink = async () => {
    if (!projectToLink) return;
    try {
      await shelfLinkProject(item.id, projectToLink);
      setProjectToLink("");
      await reloadProjectLinks();
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  };

  const projectPlaceholder =
    projectState === "loading"
      ? "正在加载项目…"
      : projectState === "error"
        ? "项目列表加载失败"
        : projectOptions.length === 0
          ? "暂无可关联项目"
          : "选择项目…";

  const runOcr = async () => {
    if (ocrBusy) return;
    const requestId = `shelf-ocr-${item.id}-${++ocrSeq.current}`;
    setOcrRequest(requestId);
    setOcrBusy(true);
    setOcrError("");
    setOcrText("");
    try {
      const report = await shelfOcrItem(item.id, requestId);
      if (report.status === "ok") {
        setOcrText(report.text);
        if (!report.text.trim()) setOcrError("未识别到文字");
      } else if (report.status === "empty") {
        setOcrError("未识别到文字");
      } else if (report.status !== "cancelled") {
        setOcrError(report.reason || "识别失败，原图未受影响");
      }
    } catch (e) {
      setOcrError(String(e));
    } finally {
      setOcrBusy(false);
    }
  };

  const cancelOcr = () => {
    if (!ocrRequest) return;
    void shelfOcrCancel(ocrRequest).catch(() => {});
    setOcrBusy(false);
  };

  const saveOcrText = async () => {
    const text = ocrText.trim();
    if (!text) return;
    try {
      const created = await useShelfStore.getState().addText(text, null);
      // 保留与原图相同的项目/任务关联；单项失败不回滚已创建的文本条目。
      await Promise.allSettled([
        ...projectLinks.map((l) => shelfLinkProject(created.id, l.project_id)),
        ...links.map((l) => shelfLinkTask(created.id, l.task_id)),
      ]);
      await useShelfStore
        .getState()
        .updateItem(created.id, { note: `OCR 自：${item.display_name}` });
      showToast("已保存为文本条目并保留项目/任务关联", { kind: "success" });
      setOcrText("");
    } catch (e) {
      showToast(`保存 OCR 文本失败：${String(e)}`, { kind: "error" });
    }
  };

  const saveNote = async () => {
    setSavingNote(true);
    try {
      await updateItem(item.id, { note: noteDraft });
      showToast("备注已保存", { kind: "success" });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    } finally {
      setSavingNote(false);
    }
  };

  const metaRows = useMemo(
    () => [
      ["类型", shelfFileTypeUi(item).label],
      [
        "存储",
        item.kind === "link"
          ? "链接（无文件）"
          : item.kind === "text"
            ? "应用内文本"
            : item.storage_mode === "managed"
              ? "托管副本（Task Dock 拥有）"
              : "引用原文件（不复制）",
      ],
      ["大小", formatBytes(item.byte_size)],
      ["来源", item.source_kind],
      ["添加时间", clipboardTime(item.created_at)],
      ...(item.original_path ? [["路径", item.original_path]] : []),
      ...(item.managed_path ? [["托管位置", item.managed_path]] : []),
    ] as [string, string][],
    [item],
  );

  return (
    <div className="shelf-detail" role="region" aria-label={`详情：${item.display_name}`}>
      <div className="shelf-detail-head">
        <h3 className="shelf-detail-title" title={item.display_name}>
          {item.display_name}
        </h3>
        <button
          type="button"
          className="icon-btn sm"
          aria-label="关闭详情"
          data-tip="关闭"
          onClick={onClose}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      {missing && (
        <div className="shelf-detail-warning" role="status">
          文件已失效：{item.storage_mode === "managed" ? "托管副本丢失（可能被外部删除）" : "原文件不存在（可能被移动或删除）"}
          。引用模式的路径不会自动修复，请重新定位或移除条目。
        </div>
      )}

      {/* 预览区 */}
      {item.kind === "image" && !missing && (
        <button
          type="button"
          className="shelf-detail-image"
          aria-label="放大查看图片"
          onClick={() => setLightbox(true)}
        >
          <ShelfDetailThumb id={item.id} name={item.display_name} />
        </button>
      )}

      {item.kind === "image" && !missing && (
        <section className="shelf-detail-links" aria-label="图片文字识别">
          <h4>提取文字</h4>
          <p className="shelf-detail-hint">
            使用本机 Windows OCR，不上传图片；原图保持不变，识别结果可另存为文本条目。
          </p>
          <div className="shelf-links-add">
            <button
              type="button"
              className="btn sm"
              disabled={ocrBusy}
              onClick={() => void runOcr()}
            >
              {ocrBusy ? (
                <Loader2 size={13} className="spin" aria-hidden="true" />
              ) : (
                <span aria-hidden="true">文</span>
              )}
              {ocrBusy ? "正在识别…" : "识别图片文字"}
            </button>
            {ocrBusy && (
              <button type="button" className="btn sm" onClick={cancelOcr}>
                取消
              </button>
            )}
          </div>
          {ocrError && (
            <p className="shelf-links-status is-error" role="alert">
              {ocrError}
            </p>
          )}
          {ocrText && (
            <>
              <textarea
                className="shelf-note-input"
                value={ocrText}
                readOnly
                rows={5}
                aria-label="OCR 识别结果"
              />
              <div className="shelf-links-add">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    void clipboardCopyText(ocrText)
                      .then(() => showToast("识别文字已复制", { kind: "success" }))
                      .catch((e) => showToast(String(e), { kind: "error" }))
                  }
                >
                  <Copy size={13} aria-hidden="true" /> 复制文字
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => void saveOcrText()}
                >
                  保存为文本条目
                </button>
              </div>
            </>
          )}
        </section>
      )}
      {item.kind === "link" && item.content && (
        <div className="shelf-detail-link">
          <Link2 size={14} aria-hidden="true" />
          <span className="shelf-detail-url">{item.content}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              shelfOpenItem(item.id).catch((e) => showToast(String(e), { kind: "error" }));
            }}
          >
            <ExternalLink size={13} aria-hidden="true" /> 在浏览器打开
          </button>
        </div>
      )}
      {(item.kind === "text" || textContent !== null || textError) && (
        <div className="shelf-detail-text">
          {textError ? (
            <div className="shelf-text-error">{textError}</div>
          ) : textContent === null ? (
            <div className="shelf-text-loading">
              <Loader2 size={14} className="spin" aria-hidden="true" /> 加载预览…
            </div>
          ) : item.kind === "file" && (item.file_ext === "html" || item.file_ext === "htm") ? (
            <HtmlReader html={textContent.slice(0, PREVIEW_RENDER_LIMIT)} />
          ) : (
            <pre className="shelf-text-pre">
              {textContent.length > PREVIEW_RENDER_LIMIT
                ? `${textContent.slice(0, PREVIEW_RENDER_LIMIT)}\n…（预览已截断）`
                : textContent}
            </pre>
          )}
          {truncated && <div className="shelf-text-note">文件超过 512KB，仅显示前 512KB</div>}
        </div>
      )}

      {/* 元数据 */}
      <dl className="shelf-detail-meta">
        {metaRows.map(([k, v]) => (
          <div key={k} className="shelf-meta-row">
            <dt>{k}</dt>
            <dd title={v}>{v}</dd>
          </div>
        ))}
      </dl>

      {/* 文件操作（链接/文本除外） */}
      {item.kind !== "link" && item.kind !== "text" && (
        <div className="shelf-detail-actions">
          <button
            type="button"
            className="btn sm"
            disabled={missing}
            onClick={() => shelfOpenItem(item.id).catch((e) => showToast(String(e), { kind: "error" }))}
          >
            <ExternalLink size={13} aria-hidden="true" /> 打开
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={missing}
            onClick={() => shelfRevealItem(item.id).catch((e) => showToast(String(e), { kind: "error" }))}
          >
            <FolderOpen size={13} aria-hidden="true" /> 所在文件夹
          </button>
          {!missing && item.storage_mode === "reference" && onFileOp && (
            <button
              type="button"
              className="btn sm"
              data-tip="移动引用模式的原文件，文件物理位置会改变"
              onClick={() => onFileOp("move")}
            >
              <ArrowRightLeft size={13} aria-hidden="true" /> 移动原文件到…
            </button>
          )}
          {!missing &&
            (item.kind === "file" || item.kind === "image" || item.kind === "folder") &&
            onFileOp && (
              <button
                type="button"
                className="btn sm"
                data-tip={
                  item.storage_mode === "managed"
                    ? "导出托管副本，原副本保留；是否删除可在面板中选择"
                    : "复制到目标目录，原文件不动"
                }
                onClick={() => onFileOp("copy")}
              >
                <Copy size={13} aria-hidden="true" />{" "}
                {item.storage_mode === "managed" ? "导出副本到…" : "复制到…"}
              </button>
            )}
          {missing && item.storage_mode === "reference" && onRelocate && (
            <button type="button" className="btn sm" onClick={onRelocate}>
              重新定位…
            </button>
          )}
          {missing && item.storage_mode === "managed" && (
            <p className="shelf-detail-hint">
              托管副本已丢失：不支持指向外部文件，请通过备份恢复，或删除该记录后重新添加。
            </p>
          )}
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              shelfCopyPaths([item.id])
                .then(() => showToast("路径已复制", { kind: "success" }))
                .catch((e) => showToast(String(e), { kind: "error" }))
            }
          >
            <Copy size={13} aria-hidden="true" /> 复制路径
          </button>
        </div>
      )}

      {(item.kind === "file" || item.kind === "image" || item.kind === "folder") &&
        item.exists_state !== "missing" && (
          <p className="shelf-detail-hint">
            按住卡片可拖到资源管理器或其他窗口；复制/移动由目标应用按 Windows 默认规则处理。
          </p>
        )}

      {/* 任务关联 */}
      <section className="shelf-detail-links" aria-label="任务关联">
        <h4>关联任务</h4>
        {links.length === 0 && <p className="shelf-links-empty">尚未关联任务</p>}
        <ul className="shelf-links-list">
          {links.map((l) => (
            <li key={l.task_id}>
              <span className="shelf-links-title" title={l.task_title}>
                {l.task_title || l.task_id}
              </span>
              <button
                type="button"
                className="icon-btn sm"
                aria-label={`解除关联 ${l.task_title}`}
                onClick={() => {
                  useShelfStore
                    .getState()
                    .unlinkTask(item.id, l.task_id)
                    .then(() => reloadLinks())
                    .catch((e) => showToast(String(e), { kind: "error" }));
                }}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {taskOptionsState === "error" && (
          <p className="shelf-links-status is-error" role="alert">
            任务列表加载失败：{taskOptionsError}
          </p>
        )}
        <div className="shelf-links-add">
          <Select
            value={taskToLink}
            options={taskOptions.map((t) => ({ value: t.id, label: t.title }))}
            onChange={setTaskToLink}
            placeholder={linkPlaceholder}
            disabled={taskOptionsState !== "ready" || taskOptions.length === 0}
            ariaLabel="选择要关联的任务"
            size="sm"
            align="start"
            menuMinWidth={200}
            triggerClassName="shelf-task-select"
          />
          <button
            type="button"
            className="btn sm"
            disabled={!taskToLink}
            onClick={() => void addLink()}
          >
            <Plus size={13} aria-hidden="true" /> 关联
          </button>
        </div>
      </section>

      {/* 项目关联（v51）：直接关联既有工作空间项目，不复制项目/任务 */}
      <section className="shelf-detail-links" aria-label="项目关联">
        <h4>关联项目</h4>
        {projectLinks.length === 0 && <p className="shelf-links-empty">尚未关联项目</p>}
        <ul className="shelf-links-list">
          {projectLinks.map((l) => (
            <li key={l.project_id}>
              <span className="shelf-links-title" title={l.project_name}>
                {l.project_name || l.project_id}
              </span>
              <button
                type="button"
                className="icon-btn sm"
                aria-label={`解除项目关联 ${l.project_name}`}
                onClick={() => {
                  shelfUnlinkProject(item.id, l.project_id)
                    .then(() => reloadProjectLinks())
                    .catch((e) => showToast(String(e), { kind: "error" }));
                }}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {projectState === "error" && (
          <p className="shelf-links-status is-error" role="alert">
            项目列表加载失败：{projectError}
          </p>
        )}
        <div className="shelf-links-add">
          <Select
            value={projectToLink}
            options={projectOptions.map((p) => ({ value: p.id, label: p.name }))}
            onChange={setProjectToLink}
            placeholder={projectPlaceholder}
            disabled={projectState !== "ready" || projectOptions.length === 0}
            ariaLabel="选择要关联的项目"
            size="sm"
            align="start"
            menuMinWidth={200}
            triggerClassName="shelf-task-select"
          />
          <button
            type="button"
            className="btn sm"
            disabled={!projectToLink}
            onClick={() => void addProjectLink()}
          >
            <Plus size={13} aria-hidden="true" /> 关联
          </button>
        </div>
      </section>

      {/* 标签（v52）：只存关系，批量入口在暂存架多选操作栏 */}
      <section className="shelf-detail-links" aria-label="条目标签">
        <h4>标签</h4>
        {tags.length === 0 ? (
          <p className="shelf-links-empty">尚未添加标签</p>
        ) : (
          <ul className="shelf-tag-list">
            {tags.map((tag) => (
              <li key={tag} className="shelf-tag-chip">
                <span>{tag}</span>
                <button
                  type="button"
                  className="shelf-tag-remove"
                  aria-label={`移除标签 ${tag}`}
                  disabled={tagBusy}
                  onClick={() => void removeTag(tag)}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="shelf-links-add">
          <input
            className="input"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            placeholder="新增标签（空格或逗号分隔）"
            aria-label="新增标签"
            disabled={tagBusy}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addTag();
              }
            }}
          />
          <button
            type="button"
            className="btn sm"
            disabled={tagBusy || splitTagInput(tagInput).length === 0}
            onClick={() => void addTag()}
          >
            <Plus size={13} aria-hidden="true" /> 添加
          </button>
        </div>
      </section>

      {/* 备注 */}
      <section className="shelf-detail-note" aria-label="备注">
        <h4>备注</h4>
        <textarea
          className="shelf-note-input"
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          placeholder="为这份资料记点什么（可选）"
          rows={3}
        />
        {noteDirty && (
          <button
            type="button"
            className="btn sm primary shelf-note-save"
            disabled={savingNote}
            onClick={() => void saveNote()}
          >
            {savingNote ? (
              <Loader2 size={13} className="spin" aria-hidden="true" />
            ) : (
              <Save size={13} aria-hidden="true" />
            )}
            保存备注
          </button>
        )}
      </section>

      {/* 危险区 */}
      <div className="shelf-detail-danger">
        <button
          type="button"
          className="btn sm danger"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={13} aria-hidden="true" /> 删除条目
        </button>
      </div>

      {lightbox && <ShelfImageLightbox item={item} onClose={() => setLightbox(false)} />}
      <ConfirmDialog
        open={confirmDelete}
        title="删除暂存条目？"
        detail={
          `${protectedLabel ? `该条目已${protectedLabel}，确认后会一并删除。` : ""}${
            item.scene_id ? "删除后对应场景会失去该文件引用。" : ""
          }${
            item.storage_mode === "managed"
              ? "将删除 Task Dock 拥有的托管副本；用户原文件不受影响。"
              : "仅删除暂存记录；用户原文件不受影响。"
          }`
        }
        confirmLabel="删除"
        danger
        busy={deletionBusy}
        onConfirm={() => {
          void (async () => {
            try {
              const result = await useShelfStore.getState().deleteItems([item.id], true);
              const feedback = shelfDeleteFeedback(result, "delete");
              showToast(feedback.message, {
                kind: feedback.kind,
                ...(!result.synced
                  ? { action: { label: "重试同步", run: () => void retryShelfSync() } }
                  : {}),
              });
            } catch (e) {
              showToast(String(e), { kind: "error" });
            } finally {
              setConfirmDelete(false);
            }
          })();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/** 详情头部缩略图：优先缩略图，点击进入灯箱看原图。 */
function ShelfDetailThumb({ id, name }: { id: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    shelfReadImage(id, false)
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  if (!url) {
    return (
      <div className="shelf-detail-thumb-empty">
        <span>图片加载中或不可用（点击用灯箱重试原图）</span>
      </div>
    );
  }
  return <img src={url} alt={`图片：${name}`} draggable={false} />;
}
