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
  shelfLinkTask,
  shelfOpenItem,
  shelfReadImage,
  shelfReadText,
  shelfRevealItem,
  shelfTaskLinks,
  SHELF_KIND_LABELS,
  type ShelfItem,
  type ShelfTaskLink,
} from "../../lib/bridge";
import { clipboardTime, formatBytes } from "../../lib/clipboardUi";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog } from "../ui/Dialog";
import Select from "../ui/Select";
import HtmlReader from "../clipboard/HtmlReader";
import ShelfImageLightbox from "./ShelfImageLightbox";
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

  const [lightbox, setLightbox] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [links, setLinks] = useState<ShelfTaskLink[]>([]);
  const [taskOptions, setTaskOptions] = useState<{ id: string; title: string }[]>([]);
  const [taskOptionsState, setTaskOptionsState] = useState<"loading" | "ready" | "error">("loading");
  const [taskOptionsError, setTaskOptionsError] = useState("");
  const [taskToLink, setTaskToLink] = useState("");
  const [noteDraft, setNoteDraft] = useState(item.note);
  const [savingNote, setSavingNote] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const noteDirty = noteDraft !== item.note;
  const protectedLabel = item.favorite && item.pinned
    ? "收藏且置顶"
    : item.favorite
      ? "收藏"
      : item.pinned
        ? "置顶"
        : null;
  const loadedRef = useRef(false);

  useEffect(() => {
    setNoteDraft(item.note);
    setTextContent(null);
    setTextError(null);
    loadedRef.current = false;
  }, [item.id, item.note]);

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

  useEffect(() => {
    void reloadLinks();
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
      ["类型", SHELF_KIND_LABELS[item.kind]],
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
