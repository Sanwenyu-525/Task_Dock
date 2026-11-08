//! 磁盘空间分析（只读）：选目录 → 统计直接子目录占用与最大文件。
//!
//! 产品边界：
//! - 只读：不删除、不写入、不打开文件内容；只请求后端读取目录项元数据；
//! - 不自动扫描：进入页面只填默认路径，必须用户点「开始分析」；
//! - 有界：后端 8 秒 / 24 万条目上限，超限显示「已扫描部分」；
//! - 结果可逐层进入子目录、返回上一级；大文件可「在资源管理器中显示」，
//!   删除仍由用户自己在资源管理器完成，本页不提供删除入口。

import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ExternalLink,
  FolderOpen,
  FolderUp,
  RefreshCw,
  ScanSearch,
} from "lucide-react";
import {
  resourceDiskAnalyze,
  type ResourceDiskScanReport,
} from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { localizedErrorMessage } from "../../i18n/errors";
import { formatPercent, proportionPercent } from "../../lib/resourceMetrics";
import { useLocale } from "../../hooks/useLocale";
import { MiniMeter } from "./charts";

interface DiskSpaceAnalyzerProps {
  /** 初始目录（通常是数据目录所在卷的根，如 `C:\`）；不会自动扫描。 */
  defaultPath: string | null;
}

function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : path;
}

export default function DiskSpaceAnalyzer({ defaultPath }: DiskSpaceAnalyzerProps) {
  const { t } = useLocale();
  const [path, setPath] = useState(defaultPath ?? "");
  const [report, setReport] = useState<ResourceDiskScanReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  // 首屏快照晚于组件挂载时补默认路径；不触发扫描。
  useEffect(() => {
    if (!path && defaultPath) setPath(defaultPath);
  }, [defaultPath, path]);

  async function scan(target?: string) {
    const next = (target ?? path).trim();
    if (!next || loading) return;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    setRevealError(null);
    try {
      const result = await resourceDiskAnalyze(next);
      if (!mountedRef.current || request !== requestRef.current) return;
      setReport(result);
      setPath(result.path);
    } catch (reason) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setError(localizedErrorMessage(reason));
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }

  async function chooseFolder() {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("resource.analysis.choose"),
      });
      if (typeof picked !== "string" || !picked) return;
      setPath(picked);
      await scan(picked);
    } catch (reason) {
      setError(localizedErrorMessage(reason));
    }
  }

  async function reveal(filePath: string) {
    setRevealError(null);
    try {
      await revealItemInDir(filePath);
    } catch (reason) {
      setRevealError(localizedErrorMessage(reason));
    }
  }

  const summary = report
    ? t("resource.analysis.summary", {
        bytes: formatBytes(report.totalBytes),
        files: report.totalFiles,
        dirs: report.totalDirs,
        ms: report.elapsedMs,
      })
    : null;

  return (
    <section className="resource-analysis" aria-labelledby="resource-analysis-title">
      <div className="resource-cleanup-section-head">
        <h3 className="resource-cleanup-heading" id="resource-analysis-title">
          {t("resource.analysis.title")}
        </h3>
        {report && (
          <span className="resource-volume-count">
            {t("resource.analysis.dirCount", { count: report.totalDirs })}
          </span>
        )}
      </div>
      <p className="setting-note">{t("resource.analysis.desc")}</p>

      <div className="resource-analysis-pathbar">
        <span className="resource-analysis-path" data-tip={path || undefined}>
          {path || t("resource.analysis.noPath")}
        </span>
        <div className="resource-analysis-actions">
          <button type="button" className="btn sm" onClick={() => void chooseFolder()} disabled={loading}>
            <FolderOpen size={12} aria-hidden="true" /> {t("resource.analysis.choose")}
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => void scan()}
            disabled={loading || !path}
          >
            {loading ? (
              <RefreshCw size={12} className="spin" aria-hidden="true" />
            ) : (
              <ScanSearch size={12} aria-hidden="true" />
            )}{" "}
            {t(report ? "resource.analysis.rescan" : "resource.analysis.scan")}
          </button>
          {report?.parent && (
            <button
              type="button"
              className="btn sm"
              onClick={() => void scan(report.parent ?? undefined)}
              disabled={loading}
            >
              <FolderUp size={12} aria-hidden="true" /> {t("resource.analysis.up")}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("resource.analysis.failed", { error })}
          <button type="button" className="btn sm" onClick={() => void scan()} disabled={loading}>
            {t("common.retry")}
          </button>
        </div>
      )}

      {loading && (
        <p className="setting-note" role="status">
          {t("resource.analysis.loading")}
        </p>
      )}
      {!report && !loading && !error && (
        <p className="setting-note">{t("resource.analysis.notScanned")}</p>
      )}

      {report && (
        <div className="resource-analysis-result" aria-busy={loading}>
          <p className="resource-analysis-summary">{summary}</p>
          {(report.truncated || report.skippedErrors > 0) && (
            <div className="setting-note resource-cleanup-error" role="status">
              {report.truncated && <span>{t("resource.analysis.truncated")}</span>}
              {report.skippedErrors > 0 && (
                <span>
                  {t("resource.analysis.skippedErrors", { count: report.skippedErrors })}
                </span>
              )}
            </div>
          )}
          {report.skippedLinks > 0 && (
            <p className="setting-note">
              {t("resource.analysis.skippedLinks", { count: report.skippedLinks })}
            </p>
          )}

          {report.folders.length === 0 && report.rootFilesBytes === 0 ? (
            <p className="setting-note" role="status">
              {t("resource.analysis.empty")}
            </p>
          ) : (
            <>
              <h4 className="resource-analysis-subtitle">{t("resource.analysis.folders")}</h4>
              <ul className="resource-analysis-list">
                {report.rootFilesBytes > 0 && (
                  <li className="resource-analysis-root-row">
                    <span className="resource-analysis-name">
                      {t("resource.analysis.rootFiles")}
                    </span>
                    <span className="resource-analysis-size">
                      {formatBytes(report.rootFilesBytes)}
                    </span>
                    <MiniMeter
                      percent={proportionPercent(report.rootFilesBytes, report.totalBytes)}
                      tone="neutral"
                      ariaLabel={t("resource.aria.analysisRootFiles", {
                        bytes: formatBytes(report.rootFilesBytes),
                      })}
                    />
                    <span className="resource-analysis-meta">
                      {t("resource.analysis.rootFilesMeta", {
                        files: report.rootFiles,
                        percent:
                          formatPercent(
                            proportionPercent(report.rootFilesBytes, report.totalBytes),
                          ) ?? "—",
                      })}
                    </span>
                  </li>
                )}
                {report.folders.map((folder) => {
                  const unscanned = folder.bytes === null || folder.files === null;
                  const share = unscanned
                    ? null
                    : proportionPercent(folder.bytes, report.totalBytes);
                  const sizeText = unscanned ? "—" : formatBytes(folder.bytes as number);
                  const aria = t("resource.aria.analysisFolder", {
                    name: folder.name,
                    bytes: sizeText,
                  });
                  return (
                    <li key={folder.path}>
                      <button
                        type="button"
                        className={`resource-analysis-folder${unscanned ? " is-unscanned" : ""}`}
                        onClick={() => void scan(folder.path)}
                        disabled={loading}
                        aria-label={aria}
                      >
                        <span className="resource-analysis-name" data-tip={folder.name}>
                          {folder.name}
                        </span>
                        <span className="resource-analysis-size">{sizeText}</span>
                        {!unscanned && (
                          <MiniMeter
                            percent={share}
                            tone="neutral"
                            ariaLabel={aria}
                          />
                        )}
                        <span className="resource-analysis-meta">
                          {unscanned
                            ? t("resource.analysis.unscanned")
                            : t("resource.analysis.folderMeta", {
                                files: folder.files ?? 0,
                                percent: formatPercent(share) ?? "—",
                              })}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {report.files.length > 0 && (
                <>
                  <h4 className="resource-analysis-subtitle">{t("resource.analysis.files")}</h4>
                  <ul className="resource-analysis-list">
                    {report.files.map((file) => (
                      <li className="resource-analysis-file" key={file.path}>
                        <span className="resource-analysis-file-main">
                          <span className="resource-analysis-name" data-tip={file.path}>
                            {file.name}
                          </span>
                          <span className="resource-analysis-file-parent" data-tip={file.path}>
                            {parentOf(file.path)}
                          </span>
                        </span>
                        <span className="resource-analysis-size">
                          {formatBytes(file.bytes)}
                        </span>
                        <button
                          type="button"
                          className="resource-icon-btn"
                          onClick={() => void reveal(file.path)}
                          aria-label={t("resource.analysis.reveal")}
                          data-tip={t("resource.analysis.reveal")}
                        >
                          <ExternalLink size={12} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {report.totalFiles > report.files.length && (
                    <p className="setting-note">{t("resource.analysis.filesNote")}</p>
                  )}
                </>
              )}
              {revealError && (
                <p className="setting-note resource-cleanup-error" role="status">
                  {t("resource.analysis.revealFailed", { error: revealError })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
