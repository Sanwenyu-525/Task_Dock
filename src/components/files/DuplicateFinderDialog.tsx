//! 重复文件查找：大小预筛 + 显式哈希确认；默认只报告，删除必须用户勾选并二次确认，
//! 实际删除由工作区面板走现有回收站流程。

import { useEffect, useRef, useState } from "react";
import { Files, Search, Square, Trash2 } from "lucide-react";
import { Dialog, ConfirmDialog } from "../ui/Dialog";
import Select from "../ui/Select";
import { useLocale } from "../../hooks/useLocale";
import type { VerifiedDuplicateDeleteGroup } from "../../lib/bridge";
import {
  collectWorkspaceFiles,
  hashDuplicateGroups,
  sizeGroups,
  type DuplicateGroup,
  type SearchProgress,
  type SearchSource,
} from "../../lib/filesWorkspace/workspaceSearch";

export interface DuplicateDeleteOutcome {
  ok: number;
  failed: number;
  failedPaths: string[];
}

/** 扫描完整性结论：任一维度异常都视为不完整，不得把结果伪装成完整扫描。 */
interface ScanIntegrity {
  complete: boolean;
  truncated: boolean;
  failedDirs: number;
  cancelled: boolean;
}

interface Props {
  open: boolean;
  sources: SearchSource[];
  onClose: () => void;
  onReveal: (paneId: string, dirPath: string, filePath: string) => void;
  onDelete: (groups: VerifiedDuplicateDeleteGroup[]) => Promise<DuplicateDeleteOutcome>;
}

export default function DuplicateFinderDialog({ open, sources, onClose, onReveal, onDelete }: Props) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<string[]>([]);
  const [depth, setDepth] = useState("2");
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [verified, setVerified] = useState(false);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [scanState, setScanState] = useState<ScanIntegrity | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<VerifiedDuplicateDeleteGroup[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 扫描请求代际：旧扫描（含哈希阶段）不得覆盖新目录/新深度的结果或运行状态。 */
  const scanSeq = useRef(0);

  const resetResults = () => {
    scanSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setGroups([]);
    setVerified(false);
    setChecked({});
    setConfirmDelete(null);
    setProgress(null);
    setScanState(null);
    setRunning(false);
  };

  useEffect(() => {
    if (!open) return;
    setSelected(sources.map((source) => source.paneId));
    resetResults();
    // resetResults 只清理由本次对话框持有的结果与请求，不触碰外部状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sources]);

  // 组件卸载时中止在途扫描并递增代际，避免晚到的扫描/哈希结果写入已卸载组件。
  useEffect(() => {
    return () => {
      scanSeq.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const stopScan = () => {
    scanSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    // 中止属于不完整扫描：如实标记取消，保留已收集的候选组供核对。
    setScanState({ complete: false, truncated: false, failedDirs: 0, cancelled: true });
  };

  const handleClose = () => {
    // 关闭弹窗（按钮 / Esc / 遮罩）必须中止在途扫描，旧请求不得再回写状态。
    scanSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    onClose();
  };

  const scan = async (withHash: boolean) => {
    if (running || selected.length === 0) return;
    abortRef.current?.abort();
    const seq = ++scanSeq.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setGroups([]);
    setChecked({});
    try {
      const scanResult = await collectWorkspaceFiles(
        sources.filter((source) => selected.includes(source.paneId)),
        Number(depth),
        (next) => {
          if (seq === scanSeq.current) setProgress(next);
        },
        controller.signal,
      );
      if (seq !== scanSeq.current) return;
      setScanState({
        complete: scanResult.complete,
        truncated: scanResult.truncated,
        failedDirs: scanResult.failedDirs ?? 0,
        cancelled: scanResult.cancelled,
      });
      const sizeCandidates = sizeGroups(scanResult.files);
      if (withHash) {
        const hashed = await hashDuplicateGroups(sizeCandidates, controller.signal);
        if (seq !== scanSeq.current) return;
        setGroups(hashed);
        setVerified(true);
      } else {
        setGroups(sizeCandidates);
        setVerified(false);
      }
    } catch (error) {
      if (seq !== scanSeq.current) return;
      if ((error as { name?: string }).name !== "AbortError") {
        setGroups([]);
        setScanState({ complete: false, truncated: false, failedDirs: 0, cancelled: false });
      }
    } finally {
      if (seq === scanSeq.current) {
        setRunning(false);
        abortRef.current = null;
      }
    }
  };

  const deleteChecked = () => {
    if (!verified) return;
    const request: VerifiedDuplicateDeleteGroup[] = [];
    for (const group of groups) {
      // 未哈希（hash 为 null）的组绝不进入删除请求。
      if (!group.hash) continue;
      const deletePaths = group.files.filter((file) => checked[file.path]).map((file) => file.path);
      if (!deletePaths.length) continue;
      request.push({
        keepPath: group.files[0].path,
        deletePaths,
        expectedSize: group.size,
        expectedHash: group.hash,
      });
    }
    if (!request.length) return;
    setConfirmDelete(request);
  };

  const runDelete = async () => {
    const request = confirmDelete ?? [];
    setConfirmDelete(null);
    if (!request.length || !verified) return;
    const outcome = await onDelete(request);
    if (outcome.failed === 0) {
      setChecked({});
    } else {
      // 只保留真实失败项，成功项不再显示为待删，避免误以为还被选中。
      const failed = new Set(outcome.failedPaths);
      setChecked((current) =>
        Object.fromEntries(Object.entries(current).filter(([path, value]) => value && failed.has(path))),
      );
    }
    await scan(true);
    if (outcome.failedPaths.length) {
      setChecked((current) => {
        const failed = new Set(outcome.failedPaths);
        return Object.fromEntries(Object.entries(current).filter(([path, value]) => value || failed.has(path)));
      });
    }
  };

  const depthOptions = ["0", "1", "2", "3", "4"].map((value) => ({
    value,
    label: value === "0" ? t("fw.search.depthCurrent") : t("fw.search.depthN", { count: value }),
  }));

  const checkedCount = Object.values(checked).filter(Boolean).length;
  const confirmDeleteCount = (confirmDelete ?? []).reduce((count, group) => count + group.deletePaths.length, 0);
  const incomplete =
    scanState !== null &&
    (!scanState.complete || scanState.cancelled || scanState.truncated || scanState.failedDirs > 0);

  return (
    <>
      <Dialog open={open} onClose={handleClose} title={t("fw.duplicates.title")} size="lg" className="fw-duplicate-dialog">
        <div className="fw-search-form">
          <div className="fw-search-field">
            <span>{t("fw.search.depth")}</span>
            <Select
              value={depth}
              options={depthOptions}
              onChange={(value) => {
                setDepth(value);
                resetResults();
              }}
              ariaLabel={t("fw.search.depth")}
              size="sm"
              block
            />
          </div>
          <div className="fw-search-note">{t("fw.duplicates.note")}</div>
        </div>
        <div className="fw-search-sources" role="group" aria-label={t("fw.search.sources")}>
          {sources.map((source) => (
            <button
              key={source.paneId}
              type="button"
              className={`fw-search-source${selected.includes(source.paneId) ? " is-on" : ""}`}
              aria-pressed={selected.includes(source.paneId)}
              title={source.path}
              onClick={() => {
                resetResults();
                setSelected((current) =>
                  current.includes(source.paneId) ? current.filter((id) => id !== source.paneId) : [...current, source.paneId],
                );
              }}
            >
              <span className="fw-search-source-label">{source.label}</span>
              <span className="fw-search-source-path">{source.path}</span>
            </button>
          ))}
        </div>
        {progress && (
          <div className="fw-search-progress" role="status">
            {t("fw.search.progress", { dirs: progress.dirsVisited, files: progress.filesScanned, hits: progress.hits })}
          </div>
        )}
        {scanState && (
          <div className={incomplete ? "fw-search-warn" : "fw-search-empty"} role={incomplete ? "alert" : "status"}>
            {!incomplete && <span>{t("fw.duplicates.scanComplete")}</span>}
            {scanState.truncated && <span> · {t("fw.duplicates.truncated")}</span>}
            {scanState.failedDirs > 0 && <span> · {t("fw.duplicates.failedDirs", { count: scanState.failedDirs })}</span>}
            {scanState.cancelled && <span> · {t("fw.duplicates.cancelled")}</span>}
            {incomplete && <div>{t("fw.duplicates.scanIncomplete")}</div>}
          </div>
        )}
        {running ? (
          <div className="fw-search-empty">{t("fw.search.searching")}</div>
        ) : groups.length === 0 ? (
          <div className="fw-search-empty">{t("fw.duplicates.empty")}</div>
        ) : (
          <div className="fw-duplicate-groups">
            {groups.map((group) => (
              <section key={`${group.size}-${group.hash ?? "size"}`} className="fw-duplicate-group">
                <header className="fw-duplicate-head">
                  <strong>{t("fw.duplicates.group", { size: group.files[0].size, count: group.files.length })}</strong>
                  {group.hash && <code>{group.hash.slice(0, 12)}</code>}
                  {!verified && <span className="fw-search-warn">{t("fw.duplicates.sizeOnly")}</span>}
                </header>
                {group.files.map((file, index) => (
                  <div key={file.path} className="fw-duplicate-row">
                    {index === 0 ? (
                      <span className="fw-duplicate-keep">{t("fw.duplicates.keep")}</span>
                    ) : verified && group.hash ? (
                      <input
                        type="checkbox"
                        checked={checked[file.path] ?? false}
                        aria-label={t("fw.duplicates.selectDelete", { name: file.name })}
                        onChange={(event) => setChecked((current) => ({ ...current, [file.path]: event.target.checked }))}
                      />
                    ) : (
                      <span className="fw-search-warn" aria-hidden="true">—</span>
                    )}
                    <button type="button" className="fw-duplicate-path" title={file.path} onClick={() => onReveal(file.paneId, file.dirPath, file.path)}>
                      {file.path}
                    </button>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
        <div className="fw-dialog-footer">
          <button type="button" className="btn sm" onClick={handleClose}>
            {t("common.close")}
          </button>
          {running && (
            <button type="button" className="btn sm danger" onClick={stopScan}>
              <Square size={12} aria-hidden="true" />
              {t("fw.duplicates.stop")}
            </button>
          )}
          {groups.length > 0 && !verified && !running && (
            <button type="button" className="btn sm" onClick={() => void scan(true)}>
              <Search size={12} aria-hidden="true" />
              {t("fw.duplicates.verify")}
            </button>
          )}
          {verified && groups.length > 0 && (
            <button type="button" className="btn sm danger" disabled={checkedCount === 0 || running} onClick={() => void deleteChecked()}>
              <Trash2 size={12} aria-hidden="true" />
              {t("fw.duplicates.deleteSelected", { count: checkedCount })}
            </button>
          )}
          {!running && (
            <button type="button" className="btn sm primary" disabled={selected.length === 0} onClick={() => void scan(false)}>
              <Files size={12} aria-hidden="true" />
              {t("fw.duplicates.scan")}
            </button>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("fw.duplicates.deleteTitle")}
        detail={
          <>
            {incomplete && <span role="alert">{t("fw.duplicates.scanIncomplete")}</span>}
            {t("fw.duplicates.deleteDetail", { count: confirmDeleteCount })}
          </>
        }
        confirmLabel={t("fw.duplicates.deletePermanent")}
        danger
        onConfirm={() => void runDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  );
}
