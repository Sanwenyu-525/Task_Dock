//! 文件操作内嵌面板：移动原文件 / 复制 / 导出托管副本。
//!
//! 刻意不使用大模态：面板嵌在暂存架列表上方，包含目标目录（固定/最近/浏览）、
//! 同名策略、完成后处理与逐项结果。所有文件操作经 store → bridge 走后端，
//! 前端不拼接、不校验物理路径（后端按条目 id 取权威路径）。
//!
//! 边界：
//! - managed 托管副本只允许「导出副本」，移动入口由工作区过滤；
//! - 同批次执行单飞（busyRef 同步防重入），面板切换/卸载后旧响应不再更新状态或弹 Toast；
//! - 成功但托管清理失败时保留真实结果，不误报为全部失败。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FolderOpen, Loader2, Pin, PinOff, X } from "lucide-react";
import {
  shelfRecentDirPin,
  shelfRecentDirRemove,
  shelfRecentDirs,
  type ShelfConflictStrategy,
  type ShelfItem,
  type ShelfOpEntry,
  type ShelfOpReport,
  type ShelfRecentDir,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";
import { Checkbox, Select } from "../ui";

export interface ShelfFileOpRequest {
  op: "move" | "copy";
  ids: string[];
  items: ShelfItem[];
  /** 因类型/存储模式/失效被排除的数量（仅提示，不提交给后端） */
  excluded: number;
}

function dirName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export default function ShelfFileOpPanel({
  request,
  onClose,
}: {
  request: ShelfFileOpRequest;
  onClose: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const runFileOp = useShelfStore((s) => s.runFileOp);
  const [dirs, setDirs] = useState<ShelfRecentDir[]>([]);
  const [dirsLoading, setDirsLoading] = useState(false);
  const [targetDir, setTargetDir] = useState("");
  const [strategy, setStrategy] = useState<ShelfConflictStrategy>("skip");
  const [removeAfter, setRemoveAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirsBusy, setDirsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ShelfOpReport | null>(null);
  const [showFailed, setShowFailed] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [showPartial, setShowPartial] = useState(false);

  /** 同步单飞闸：state 更新有延迟，连点必须在 ref 层拦截。 */
  const busyRef = useRef(false);
  const dirsBusyRef = useRef(false);
  const mountedRef = useRef(true);
  /** 请求代号：面板切换/卸载后，旧响应不得写入新状态。 */
  const runSeqRef = useRef(0);
  const dirsSeqRef = useRef(0);
  const panelRef = useRef<HTMLElement>(null);

  const managedCount = useMemo(
    () => request.items.filter((i) => i.storage_mode === "managed").length,
    [request.items],
  );
  const referenceCount = request.items.length - managedCount;
  const isExport = request.op === "copy" && managedCount === request.items.length && managedCount > 0;
  const isMixedCopy = request.op === "copy" && managedCount > 0 && referenceCount > 0;
  const title =
    request.op === "move"
      ? "移动原文件到…"
      : isExport
        ? "导出副本到…"
        : isMixedCopy
          ? "复制 / 导出到…"
          : "复制到…";
  const actionLabel =
    request.op === "move" ? "移动" : isExport ? "导出副本" : isMixedCopy ? "复制 / 导出" : "复制";
  const doneVerb = request.op === "move" ? "已移动" : isExport ? "已导出" : "已复制";

  const pinnedDirs = dirs.filter((d) => d.pinned);
  const recentDirs = dirs.filter((d) => !d.pinned);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runSeqRef.current += 1;
      dirsSeqRef.current += 1;
    };
  }, []);

  const loadDirs = useCallback(async () => {
    const seq = ++dirsSeqRef.current;
    setDirsLoading(true);
    try {
      const raw = await shelfRecentDirs();
      // 预览 harness 尚未实现该命令时返回 null；按空列表兜底，不影响真实后端约定
      const list: ShelfRecentDir[] = Array.isArray(raw) ? raw : [];
      if (!mountedRef.current || seq !== dirsSeqRef.current) return;
      setDirs(list);
      // 保留用户已选/浏览过的目录（可能不在最近列表），仅在为空时回退到首个可用项
      setTargetDir((prev) => prev || list.find((d) => d.available)?.path || "");
    } catch (e) {
      if (!mountedRef.current || seq !== dirsSeqRef.current) return;
      showToast(`读取最近目录失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      if (mountedRef.current && seq === dirsSeqRef.current) setDirsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    // 切换批次：作废旧请求代号，重置本批次表单状态
    runSeqRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setReport(null);
    setError(null);
    setShowFailed(false);
    setShowSkipped(false);
    setStrategy("skip");
    setRemoveAfter(false);
    void loadDirs();
    // 菜单关闭后框架会把焦点还给触发器，下一帧再把焦点移入面板（键盘用户可直接操作）
    const raf = requestAnimationFrame(() => {
      if (mountedRef.current) panelRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [request, loadDirs]);

  const browse = async () => {
    if (busyRef.current) return;
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择目标目录",
      });
      if (typeof picked === "string") setTargetDir(picked);
    } catch (e) {
      if (!mountedRef.current) return;
      showToast(`选择目录失败：${errorMessage(e)}`, { kind: "error" });
    }
  };

  const togglePin = async (dir: ShelfRecentDir) => {
    if (dirsBusyRef.current) return;
    dirsBusyRef.current = true;
    setDirsBusy(true);
    try {
      await shelfRecentDirPin(dir.path, !dir.pinned);
      if (!mountedRef.current) return;
      await loadDirs();
    } catch (e) {
      if (!mountedRef.current) return;
      showToast(`更新固定目录失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      if (mountedRef.current) {
        dirsBusyRef.current = false;
        setDirsBusy(false);
      }
    }
  };

  const removeDir = async (dir: ShelfRecentDir) => {
    if (dirsBusyRef.current) return;
    dirsBusyRef.current = true;
    setDirsBusy(true);
    try {
      await shelfRecentDirRemove(dir.path);
      if (!mountedRef.current) return;
      if (targetDir === dir.path) setTargetDir("");
      await loadDirs();
    } catch (e) {
      if (!mountedRef.current) return;
      showToast(`移除目录失败：${errorMessage(e)}`, { kind: "error" });
    } finally {
      if (mountedRef.current) {
        dirsBusyRef.current = false;
        setDirsBusy(false);
      }
    }
  };

  /** 只清空未固定的最近记录；固定目录保留（逐条移除，失败即停并如实提示）。 */
  const clearRecentDirs = async () => {
    if (dirsBusyRef.current) return;
    const targets = dirs.filter((d) => !d.pinned);
    if (targets.length === 0) return;
    dirsBusyRef.current = true;
    setDirsBusy(true);
    let failed = 0;
    try {
      for (const d of targets) {
        try {
          await shelfRecentDirRemove(d.path);
        } catch {
          failed += 1;
        }
      }
      if (!mountedRef.current) return;
      if (targetDir && targets.some((d) => d.path === targetDir)) setTargetDir("");
      await loadDirs();
      if (failed > 0) {
        showToast(`有 ${failed} 个最近目录未能移除，请稍后重试`, { kind: "warning" });
      }
    } finally {
      if (mountedRef.current) {
        dirsBusyRef.current = false;
        setDirsBusy(false);
      }
    }
  };

  const execute = async () => {
    if (busyRef.current || !targetDir || request.ids.length === 0) return;
    busyRef.current = true;
    const seq = ++runSeqRef.current;
    setBusy(true);
    setReport(null);
    setError(null);
    setShowFailed(false);
    setShowSkipped(false);
    try {
      const r = await runFileOp(request.op, request.ids, targetDir, strategy, removeAfter);
      if (!mountedRef.current || seq !== runSeqRef.current) return;
      setReport(r);
      void loadDirs();
      const removeFailed = r.remove_failed_files ?? 0;
      const partial = r.partial ?? 0;
      const recordCleanupFailed = r.record_cleanup_failed ?? 0;
      const summary =
        `成功 ${r.success} 项 · 跳过 ${r.skipped} 项 · 失败 ${r.failed} 项` +
        (partial > 0 ? ` · 部分完成 ${partial} 项` : "");
      // 结果只经一条 Toast 呈现，避免同一批次重复提示。
      // partial / record_cleanup_failed 都是「有文件已落盘但仍有残留」，必须走 warning
      // 且不自动关闭面板，让用户看到恢复建议。
      if (
        r.failed === 0 &&
        r.skipped === 0 &&
        removeFailed === 0 &&
        partial === 0 &&
        recordCleanupFailed === 0
      ) {
        showToast(
          `${doneVerb} ${r.success} 项${r.removed > 0 ? `，并从暂存架移除 ${r.removed} 条记录` : ""}`,
          { kind: "success" },
        );
        onClose();
      } else if (r.success === 0 && r.skipped === 0 && r.failed > 0) {
        showToast(`全部 ${r.failed} 项失败，请查看失败原因`, { kind: "error" });
      } else if (partial > 0 || recordCleanupFailed > 0) {
        const cleanup = recordCleanupFailed > 0
          ? `；${recordCleanupFailed} 条记录清理失败`
          : "";
        showToast(`${summary}${cleanup}，请查看部分完成明细`, { kind: "warning" });
      } else if (r.success === 0 && r.failed === 0 && r.skipped > 0) {
        showToast(`${r.skipped} 项已跳过，请查看跳过原因`, { kind: "warning" });
      } else if (r.success > 0) {
        const keep = r.failed > 0 || r.skipped > 0 ? "，失败/跳过项已保留在暂存架" : "";
        const tail =
          removeFailed > 0
            ? `；${removeFailed} 个托管文件未能删除，将在后续清理时兜底`
            : "";
        showToast(`${summary}${keep}${tail}`, { kind: "warning" });
      } else {
        showToast(`${summary}，请查看明细`, { kind: "warning" });
      }
    } catch (e) {
      if (!mountedRef.current || seq !== runSeqRef.current) return;
      const msg = errorMessage(e);
      setError(msg);
      showToast(`${actionLabel}失败：${msg}`, { kind: "error" });
    } finally {
      if (mountedRef.current && seq === runSeqRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const entries: ShelfOpEntry[] = report?.entries ?? [];
  const failedEntries = entries.filter((e) => e.status === "failed");
  const skippedEntries = entries.filter((e) => e.status === "skipped");
  const partialEntries = entries.filter((e) => e.status === "partial");
  const removeFailed = report?.remove_failed_files ?? 0;
  const partial = report?.partial ?? 0;
  const recordCleanupFailed = report?.record_cleanup_failed ?? 0;

  const renderDirRow = (d: ShelfRecentDir) => (
    <li key={d.path} className={d.pinned ? "is-pinned" : undefined}>
      <button
        type="button"
        className={`shelf-fileop-dir${targetDir === d.path ? " is-active" : ""}`}
        aria-pressed={targetDir === d.path}
        aria-label={`使用目标目录 ${d.path}`}
        title={d.path}
        disabled={!d.available || busy || dirsBusy}
        onClick={() => setTargetDir(d.path)}
      >
        <FolderOpen size={13} aria-hidden="true" />
        <span className="shelf-fileop-dir-name">{dirName(d.path)}</span>
        <span className="shelf-fileop-dir-path">{d.path}</span>
        {!d.available && <span className="shelf-fileop-badge">不可用</span>}
      </button>
      <button
        type="button"
        className="icon-btn sm"
        aria-label={`${d.pinned ? "取消固定" : "固定"} ${d.path}`}
        aria-pressed={d.pinned}
        data-tip={d.pinned ? "取消固定" : "固定目录"}
        disabled={busy || dirsBusy}
        onClick={() => void togglePin(d)}
      >
        {d.pinned ? <PinOff size={12} aria-hidden="true" /> : <Pin size={12} aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="icon-btn sm"
        aria-label={`移除目录 ${d.path}`}
        data-tip="从列表移除"
        disabled={busy || dirsBusy}
        onClick={() => void removeDir(d)}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  );

  return (
    <section
      ref={panelRef}
      className="shelf-fileop"
      tabIndex={-1}
      role="region"
      aria-label={title}
      aria-busy={busy}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !busyRef.current) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header className="shelf-fileop-head">
        <h3>{title}</h3>
        <span className="shelf-fileop-count">已选 {request.ids.length} 项</span>
        {request.excluded > 0 && (
          <span className="shelf-fileop-hint">
            {request.excluded} 项因类型/存储模式/失效未参与
          </span>
        )}
        <button
          type="button"
          className="icon-btn sm shelf-fileop-close"
          aria-label="关闭文件操作面板"
          onClick={() => !busy && onClose()}
          disabled={busy}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      <div className="shelf-fileop-body">
        <div className="shelf-fileop-col">
          {dirsLoading && dirs.length === 0 ? (
            <p className="shelf-fileop-empty" aria-live="polite">
              正在读取目录…
            </p>
          ) : dirs.length === 0 ? (
            <p className="shelf-fileop-empty">
              暂无最近目录，点击右侧「浏览其他目录…」选择。
            </p>
          ) : (
            <>
              {pinnedDirs.length > 0 && (
                <div className="shelf-fileop-group">
                  <div className="shelf-fileop-row-head">
                    <span>固定目录</span>
                    <span className="shelf-fileop-hint">始终保留</span>
                  </div>
                  <ul className="shelf-fileop-dirlist">{pinnedDirs.map(renderDirRow)}</ul>
                </div>
              )}
              {recentDirs.length > 0 && (
                <div className="shelf-fileop-group">
                  <div className="shelf-fileop-row-head">
                    <span>最近目录（最多 8 个）</span>
                    <button
                      type="button"
                      className="link-btn"
                      aria-label="清空最近目录（保留固定目录）"
                      disabled={busy || dirsBusy}
                      onClick={() => void clearRecentDirs()}
                    >
                      清空最近
                    </button>
                  </div>
                  <ul className="shelf-fileop-dirlist">{recentDirs.map(renderDirRow)}</ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="shelf-fileop-col shelf-fileop-settings">
          <div className="shelf-fileop-target">
            <span className="shelf-fileop-label">目标目录</span>
            <div className="shelf-fileop-target-row">
              <span className="shelf-fileop-target-path" title={targetDir || undefined}>
                {targetDir || "尚未选择"}
              </span>
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => void browse()}
              >
                <FolderOpen size={13} aria-hidden="true" /> 浏览其他目录…
              </button>
            </div>
          </div>

          <p className="shelf-fileop-mode-hint">
            {request.op === "move"
              ? "移动原文件：文件的物理位置会改变，暂存记录改为指向新路径；托管副本请使用「导出副本」。"
              : isExport
                ? "导出副本：把托管副本复制到目标目录，暂存架仍保留该副本（是否删除见下方选项）。"
                : isMixedCopy
                  ? `所选含 ${managedCount} 项托管副本与 ${referenceCount} 项引用文件：托管项导出副本，引用项复制到目标目录，原文件均不移动。`
                  : "复制：在目标目录生成副本，原文件与暂存记录保持不变。"}
          </p>

          <div className="shelf-fileop-field">
            <span className="shelf-fileop-label">同名文件</span>
            <Select
              ariaLabel="同名文件处理策略"
              size="sm"
              value={strategy}
              options={[
                { value: "skip", label: "跳过（默认，不覆盖）" },
                { value: "rename", label: "自动重命名（名称 (1)）" },
              ]}
              onChange={(v) => setStrategy(v as ShelfConflictStrategy)}
              disabled={busy}
            />
          </div>

          <Checkbox
            className="shelf-fileop-check"
            checked={removeAfter}
            onChange={setRemoveAfter}
            ariaLabel="处理成功后从暂存架移除记录"
            disabled={busy}
            label={
              request.op === "copy" && managedCount > 0
                ? "复制成功后移除记录并删除托管副本"
                : request.op === "move"
                  ? "移动成功后从暂存架移除记录"
                  : "复制成功后从暂存架移除记录"
            }
          />
          {removeAfter && request.op === "copy" && managedCount > 0 && (
            <p className="shelf-fileop-warn is-danger">
              <AlertTriangle size={12} aria-hidden="true" /> 会删除 Task Dock 拥有的托管副本（仅在复制校验成功后执行）；导出的目标文件与用户原文件不受影响。
            </p>
          )}
          {removeAfter && request.op === "move" && (
            <p className="shelf-fileop-warn">
              移除的只是暂存记录；已移动到目标目录的文件不受影响。
            </p>
          )}
          {removeAfter && request.op === "copy" && managedCount === 0 && (
            <p className="shelf-fileop-warn">仅删除暂存记录，原文件不受影响。</p>
          )}
          {!removeAfter && request.op === "copy" && managedCount > 0 && (
            <p className="shelf-fileop-warn">托管副本会保留在暂存架，继续占用托管空间。</p>
          )}

          {error && (
            <p className="shelf-fileop-warn is-danger" role="alert">
              {error}
            </p>
          )}

          <div className="shelf-fileop-actions">
            <button type="button" className="btn sm" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || !targetDir || request.ids.length === 0}
              onClick={() => void execute()}
            >
              {busy && <Loader2 size={13} className="spin" aria-hidden="true" />}
              {busy ? "正在处理…" : actionLabel}
            </button>
          </div>
        </div>
      </div>

      {report && (
        <div className="shelf-fileop-result" aria-live="polite">
          <p className="shelf-fileop-summary">
            成功 {report.success} 项 · 跳过 {report.skipped} 项 · 失败 {report.failed} 项
            {partial > 0 ? ` · 部分完成 ${partial} 项` : ""}
            {report.removed > 0 ? ` · 已移除 ${report.removed} 条记录` : ""}
          </p>
          {removeFailed > 0 && (
            <p className="shelf-fileop-warn is-danger">
              {removeFailed} 个托管文件未能删除（暂存记录已按选择移除，将在后续清理时兜底）。
            </p>
          )}
          {recordCleanupFailed > 0 && (
            <p className="shelf-fileop-warn is-danger">
              {recordCleanupFailed} 条暂存记录清理失败
              {report.record_cleanup_error ? `：${report.record_cleanup_error}` : "，请稍后重试或手动处理。"}
            </p>
          )}
          {partialEntries.length > 0 && (
            <>
              <button
                type="button"
                className="link-btn"
                aria-expanded={showPartial}
                onClick={() => setShowPartial((v) => !v)}
              >
                {showPartial ? "收起部分完成项" : `查看部分完成项（${partialEntries.length}）`}
              </button>
              {showPartial && (
                <ul className="shelf-fileop-failures">
                  {partialEntries.map((e, i) => (
                    <li key={`${e.id}-${i}`}>
                      <span className="shelf-fileop-failure-name" title={e.display_name || e.id}>
                        {e.display_name || e.id}
                      </span>
                      <span className="shelf-fileop-failure-reason">
                        {e.reason ?? "文件已写入目标，但源清理或记录更新未完成"}
                        {e.residual_source ? ` · 残留源：${e.residual_source}` : ""}
                        {e.recovery ? ` · 建议：${e.recovery}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {failedEntries.length > 0 && (
            <>
              <button
                type="button"
                className="link-btn"
                aria-expanded={showFailed}
                onClick={() => setShowFailed((v) => !v)}
              >
                {showFailed ? "收起失败项" : `查看失败项（${failedEntries.length}）`}
              </button>
              {showFailed && (
                <ul className="shelf-fileop-failures">
                  {failedEntries.map((e, i) => (
                    <li key={`${e.id}-${i}`}>
                      <span className="shelf-fileop-failure-name" title={e.display_name || e.id}>
                        {e.display_name || e.id}
                      </span>
                      <span className="shelf-fileop-failure-reason">{e.reason ?? "未知原因"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {skippedEntries.length > 0 && (
            <>
              <button
                type="button"
                className="link-btn"
                aria-expanded={showSkipped}
                onClick={() => setShowSkipped((v) => !v)}
              >
                {showSkipped ? "收起跳过项" : `查看跳过项（${skippedEntries.length}）`}
              </button>
              {showSkipped && (
                <ul className="shelf-fileop-failures">
                  {skippedEntries.map((e, i) => (
                    <li key={`${e.id}-${i}`}>
                      <span className="shelf-fileop-failure-name" title={e.display_name || e.id}>
                        {e.display_name || e.id}
                      </span>
                      <span className="shelf-fileop-failure-reason">{e.reason ?? "已跳过"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
