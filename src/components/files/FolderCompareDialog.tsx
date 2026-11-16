//! 文件夹对比：两层可解释差异 + 用户显式哈希 + 确认后才复制（默认不删除）。

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../ui/Dialog";
import { Checkbox } from "../ui";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { fsHashFiles, fsListDir, type FsHashEntry, type FsOpReport } from "../../lib/bridge";
import { formatSize } from "../../lib/filesWorkspace/fileMeta";
import {
  applyHashesByPath,
  compareEntries,
  hashTargets,
  type CompareItem,
  type CompareStatus,
} from "../../lib/filesWorkspace/folderCompare";
import { errorMessage } from "../../lib/errors";

export interface CompareTarget {
  paneId: string;
  label: string;
  dir: string;
}

export interface CompareRequest {
  sourceDir: string;
  sourceLabel: string;
  targets: CompareTarget[];
}

interface Props {
  request: CompareRequest | null;
  onClose: () => void;
  onCopy: (paths: string[], targetDir: string) => Promise<FsOpReport | null>;
}

const STATUS_KEY = {
  leftOnly: "fw.compare.status.leftOnly",
  rightOnly: "fw.compare.status.rightOnly",
  kindDiff: "fw.compare.status.kindDiff",
  sizeDiff: "fw.compare.status.sizeDiff",
  timeDiff: "fw.compare.status.timeDiff",
  contentSame: "fw.compare.status.contentSame",
  contentDiff: "fw.compare.status.contentDiff",
  same: "fw.compare.status.same",
} as const satisfies Record<CompareStatus, string>;

export default function FolderCompareDialog({ request, onClose, onCopy }: Props) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const [targetPaneId, setTargetPaneId] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [items, setItems] = useState<CompareItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hashRunning, setHashRunning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ leftToRight: string[]; rightToLeft: string[] } | null>(null);
  const [copying, setCopying] = useState(false);

  const target = request?.targets.find((item) => item.paneId === targetPaneId) ?? request?.targets[0] ?? null;
  const loadSeq = useRef(0);

  useEffect(() => {
    if (!request) return;
    loadSeq.current += 1;
    setTargetPaneId(request.targets[0]?.paneId ?? "");
    setSelected(new Set());
    setConfirm(null);
  }, [request]);

  useEffect(() => {
    // 切换右侧目标时，旧目标的选中项与确认内容不能继续生效；同时让在途
    // 目录读取晚到的结果失效，避免旧结果覆盖新目标。
    loadSeq.current += 1;
    setSelected(new Set());
    setConfirm(null);
  }, [target?.paneId]);

  const reload = async () => {
    if (!request || !target) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const [left, right] = await Promise.all([
        fsListDir(request.sourceDir, false, 0),
        fsListDir(target.dir, false, 0),
      ]);
      if (seq !== loadSeq.current) return;
      setHasMore(left.hasMore || right.hasMore);
      setItems(compareEntries(left.entries, right.entries));
    } catch (e) {
      if (seq !== loadSeq.current) return;
      showToast(errorMessage(e), { kind: "error" });
      setItems([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, target?.dir]);

  const counts = useMemo(() => {
    const result: Record<CompareStatus, number> = {
      leftOnly: 0,
      rightOnly: 0,
      kindDiff: 0,
      sizeDiff: 0,
      timeDiff: 0,
      contentSame: 0,
      contentDiff: 0,
      same: 0,
    };
    for (const item of items) result[item.status] += 1;
    return result;
  }, [items]);

  const hashedPairs = items.filter(
    (item) =>
      item.left?.kind === "file" &&
      item.right?.kind === "file" &&
      (item.status === "contentSame" || item.status === "contentDiff"),
  ).length;

  const prepare = () => {
    const leftToRight: string[] = [];
    const rightToLeft: string[] = [];
    for (const item of items) {
      if (!selected.has(item.name)) continue;
      if (item.status === "leftOnly" && item.left) leftToRight.push(item.left.name);
      if (item.status === "rightOnly" && item.right) rightToLeft.push(item.right.name);
    }
    if (!leftToRight.length && !rightToLeft.length) {
      showToast(t("fw.compare.nothingSelected"), { kind: "warning" });
      return;
    }
    setConfirm({ leftToRight, rightToLeft });
  };

  type DirectionResult = {
    ok: number;
    failedNames: string[];
    partial: number;
    skipped: number;
    error: string | null;
  };

  const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

  const copyDirection = async (
    names: string[],
    paths: string[],
    targetDir: string,
  ): Promise<DirectionResult> => {
    if (!names.length) return { ok: 0, failedNames: [], partial: 0, skipped: 0, error: null };
    let report: FsOpReport | null;
    try {
      report = await onCopy(paths, targetDir);
    } catch (e) {
      return { ok: 0, failedNames: names, partial: 0, skipped: 0, error: errorMessage(e) };
    }
    if (!report) {
      return {
        ok: 0,
        failedNames: names,
        partial: 0,
        skipped: 0,
        error: t("fw.compare.copyNotConfirmed"),
      };
    }
    const entries = report.entries ?? [];
    const badCount = report.failed + report.partial + report.skipped;
    const failedNames = names.filter((name) => {
      const entry = entries.find((item) => baseName(item.source).toLocaleLowerCase() === name.toLocaleLowerCase());
      // 没有逐项结果时按汇总计数 fail-closed：只要报告里有非成功项，就不清空现场。
      return entry ? entry.status !== "ok" : badCount > 0;
    });
    return {
      ok: report.ok,
      failedNames,
      partial: report.partial,
      skipped: report.skipped,
      error: null,
    };
  };

  const executeCopy = async () => {
    if (!request || !target || !confirm || copying) return;
    const sep = request.sourceDir.includes("\\") ? "\\" : "/";
    const leftPaths = confirm.leftToRight.map((name) => `${request.sourceDir.replace(/[\\/]$/, "")}${sep}${name}`);
    const rightPaths = confirm.rightToLeft.map((name) => `${target.dir.replace(/[\\/]$/, "")}${sep}${name}`);
    setCopying(true);
    try {
      const left = await copyDirection(confirm.leftToRight, leftPaths, target.dir);
      const right = await copyDirection(confirm.rightToLeft, rightPaths, request.sourceDir);
      const failedNames = [...left.failedNames, ...right.failedNames];
      const error = left.error ?? right.error;
      if (failedNames.length === 0) {
        setConfirm(null);
        setSelected(new Set());
        await reload();
        showToast(t("fw.compare.copyDone", { count: left.ok + right.ok }), { kind: "success" });
      } else {
        // 部分/失败/跳过都保留在确认区与勾选中；不能因为另一方向成功就整体清空。
        setConfirm({
          leftToRight: left.failedNames,
          rightToLeft: right.failedNames,
        });
        setSelected(new Set(failedNames));
        await reload();
        if (error) {
          showToast(t("fw.compare.copyFailed", { error }), { kind: "error" });
        } else {
          showToast(
            t("fw.compare.copyPartial", {
              ok: left.ok + right.ok,
              failed: failedNames.length,
              partial: left.partial + right.partial,
              skipped: left.skipped + right.skipped,
            }),
            { kind: "error" },
          );
        }
      }
    } finally {
      setCopying(false);
    }
  };

  const runHash = async () => {
    if (!request || !target || hashRunning) return;
    const targets = hashTargets(items, request.sourceDir, target.dir);
    if (!targets.length) {
      showToast(t("fw.compare.noHashTargets"), { kind: "info" });
      return;
    }
    setHashRunning(true);
    try {
      const hashes: FsHashEntry[] = [];
      for (let index = 0; index < targets.length; index += 100) {
        hashes.push(...(await fsHashFiles(targets.slice(index, index + 100))));
      }
      setItems((current) => applyHashesByPath(current, request.sourceDir, target.dir, hashes));
      showToast(t("fw.compare.hashDone", { count: Math.floor(targets.length / 2) }), { kind: "success" });
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    } finally {
      setHashRunning(false);
    }
  };

  if (!request) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("fw.compare.title")}
      size="lg"
      ariaLabel={t("fw.compare.title")}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn" disabled={hashRunning || loading} onClick={() => void runHash()}>
            {hashRunning ? t("fw.compare.hashing") : t("fw.compare.hashAction")}
          </button>
          <button type="button" className="btn primary" disabled={!selected.size} onClick={prepare}>
            {t("fw.compare.copySelected", { count: selected.size })}
          </button>
        </>
      }
    >
      <div className="fw-compare-panes">
        <div className="fw-compare-pane">
          <span className="fw-compare-label">{t("fw.compare.left")}</span>
          <span className="fw-compare-name">{request.sourceLabel}</span>
          <span className="fw-compare-path" title={request.sourceDir}>
            {request.sourceDir}
          </span>
        </div>
        <div className="fw-compare-pane">
          <span className="fw-compare-label">{t("fw.compare.right")}</span>
          <div className="fw-compare-targets">
            {request.targets.map((item) => (
              <button
                key={item.paneId}
                type="button"
                className={`fw-compare-target${target?.paneId === item.paneId ? " is-active" : ""}`}
                onClick={() => setTargetPaneId(item.paneId)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="fw-compare-path" title={target?.dir}>
            {target?.dir}
          </span>
        </div>
      </div>

      <div className="fw-compare-stats" role="status">
        {(["leftOnly", "rightOnly", "sizeDiff", "timeDiff", "contentSame", "contentDiff", "same"] as CompareStatus[]).map(
          (status) => (
            <span key={status} className={`fw-compare-stat is-${status}`}>
              {t(STATUS_KEY[status])} {counts[status]}
            </span>
          ),
        )}
        {hashedPairs > 0 && (
          <span className="fw-compare-stat is-hashed">{t("fw.compare.hashedPairs", { count: hashedPairs })}</span>
        )}
      </div>

      {hasMore && <p className="fw-template-hint">{t("fw.compare.truncated")}</p>}
      <p className="fw-template-hint">{t("fw.compare.safeCopyHint")}</p>

      {loading ? (
        <p className="fw-compare-empty">{t("fw.compare.loading")}</p>
      ) : items.length === 0 ? (
        <p className="fw-compare-empty">{t("fw.compare.empty")}</p>
      ) : (
        <div className="fw-compare-table" role="table" aria-label={t("fw.compare.tableAria")}>
          <div className="fw-compare-row is-head" role="row">
            <span role="columnheader" aria-label={t("fw.compare.select")} />
            <span role="columnheader">{t("fw.compare.columnName")}</span>
            <span role="columnheader">{t("fw.compare.columnStatus")}</span>
            <span role="columnheader">{t("fw.compare.columnLeft")}</span>
            <span role="columnheader">{t("fw.compare.columnRight")}</span>
          </div>
          {items.map((item) => {
            const selectable = item.status === "leftOnly" || item.status === "rightOnly";
            return (
              <div key={item.name} className={`fw-compare-row is-${item.status}`} role="row">
                <span role="cell">
                  {selectable ? (
                    <Checkbox
                      checked={selected.has(item.name)}
                      ariaLabel={t("fw.compare.selectItem", { name: item.name })}
                      onChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(item.name);
                          else next.delete(item.name);
                          return next;
                        })
                      }
                    />
                  ) : null}
                </span>
                <span className="fw-compare-name-cell" role="cell" title={item.name}>
                  {item.name}
                </span>
                <span className="fw-compare-status" role="cell">
                  <span className={`fw-compare-dot is-${item.status}`} aria-hidden="true" />
                  {t(STATUS_KEY[item.status])}
                </span>
                <span className="fw-compare-size" role="cell">
                  {item.left ? formatSize(item.left.size) : "—"}
                </span>
                <span className="fw-compare-size" role="cell">
                  {item.right ? formatSize(item.right.size) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {confirm && (
        <div className="fw-compare-confirm" role="alert">
          <p>
            {t("fw.compare.confirmBody", {
              left: confirm.leftToRight.length,
              right: confirm.rightToLeft.length,
            })}
          </p>
          <div className="fw-compare-confirm-actions">
            <button type="button" className="btn" onClick={() => setConfirm(null)} disabled={copying}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary" onClick={() => void executeCopy()} disabled={copying}>
              {copying ? t("fw.compare.copying") : t("fw.compare.confirmCopy")}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
