//! 重复文件查找：大小预筛 + 显式哈希确认；默认只报告，删除必须用户勾选并二次确认，
//! 实际删除由工作区面板走现有回收站流程。

import { useEffect, useRef, useState } from "react";
import { Files, Search, Trash2 } from "lucide-react";
import { Dialog, ConfirmDialog } from "../ui/Dialog";
import Select from "../ui/Select";
import { useLocale } from "../../hooks/useLocale";
import {
  collectWorkspaceFiles,
  hashDuplicateGroups,
  sizeGroups,
  type DuplicateGroup,
  type SearchProgress,
  type SearchSource,
} from "../../lib/filesWorkspace/workspaceSearch";

interface Props {
  open: boolean;
  sources: SearchSource[];
  onClose: () => void;
  onReveal: (paneId: string, dirPath: string, filePath: string) => void;
  onDelete: (paths: string[]) => Promise<void>;
}

export default function DuplicateFinderDialog({ open, sources, onClose, onReveal, onDelete }: Props) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<string[]>([]);
  const [depth, setDepth] = useState("2");
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [verified, setVerified] = useState(false);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(sources.map((source) => source.paneId));
    setGroups([]);
    setVerified(false);
    setChecked({});
    setProgress(null);
    setTruncated(false);
    setRunning(false);
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open, sources]);

  const scan = async (withHash: boolean) => {
    if (running || selected.length === 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setGroups([]);
    setChecked({});
    try {
      const scanResult = await collectWorkspaceFiles(
        sources.filter((source) => selected.includes(source.paneId)),
        Number(depth),
        setProgress,
        controller.signal,
      );
      setTruncated(scanResult.truncated);
      const sizeCandidates = sizeGroups(scanResult.files);
      if (withHash) {
        setGroups(await hashDuplicateGroups(sizeCandidates, controller.signal));
        setVerified(true);
      } else {
        setGroups(sizeCandidates);
        setVerified(false);
      }
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") setGroups([]);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const deleteChecked = async () => {
    const paths = Object.entries(checked)
      .filter(([, value]) => value)
      .map(([path]) => path);
    if (!paths.length) return;
    setConfirmDelete(paths);
  };

  const runDelete = async () => {
    const paths = confirmDelete ?? [];
    setConfirmDelete(null);
    if (!paths.length) return;
    await onDelete(paths);
    setChecked({});
    await scan(verified);
  };

  const depthOptions = ["0", "1", "2", "3", "4"].map((value) => ({
    value,
    label: value === "0" ? t("fw.search.depthCurrent") : t("fw.search.depthN", { count: value }),
  }));

  const checkedCount = Object.values(checked).filter(Boolean).length;

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t("fw.duplicates.title")} size="lg" className="fw-duplicate-dialog">
        <div className="fw-search-form">
          <div className="fw-search-field">
            <span>{t("fw.search.depth")}</span>
            <Select value={depth} options={depthOptions} onChange={setDepth} ariaLabel={t("fw.search.depth")} size="sm" block />
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
              onClick={() =>
                setSelected((current) =>
                  current.includes(source.paneId) ? current.filter((id) => id !== source.paneId) : [...current, source.paneId],
                )
              }
            >
              <span className="fw-search-source-label">{source.label}</span>
              <span className="fw-search-source-path">{source.path}</span>
            </button>
          ))}
        </div>
        {progress && (
          <div className="fw-search-progress" role="status">
            {t("fw.search.progress", { dirs: progress.dirsVisited, files: progress.filesScanned, hits: progress.hits })}
            {truncated && <span className="fw-search-warn"> · {t("fw.search.truncated")}</span>}
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
                    ) : (
                      <input
                        type="checkbox"
                        checked={checked[file.path] ?? false}
                        aria-label={t("fw.duplicates.selectDelete", { name: file.name })}
                        onChange={(event) => setChecked((current) => ({ ...current, [file.path]: event.target.checked }))}
                      />
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
          <button type="button" className="btn sm" onClick={onClose}>
            {t("common.close")}
          </button>
          {groups.length > 0 && !verified && !running && (
            <button type="button" className="btn sm" onClick={() => void scan(true)}>
              <Search size={12} aria-hidden="true" />
              {t("fw.duplicates.verify")}
            </button>
          )}
          {groups.length > 0 && (
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
        detail={t("fw.duplicates.deleteDetail", { count: confirmDelete?.length ?? 0 })}
        confirmLabel={t("fw.duplicates.deletePermanent")}
        danger
        onConfirm={() => void runDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  );
}
