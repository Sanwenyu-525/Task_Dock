//! 磁盘分区 · 应用数据占用分布（只读）。
//!
//! 只展示后端扫描到的应用自有目录：`regenerable` 表示可重新生成的缓存，
//! `persistent` 表示业务数据/备份/数据库。本组件不提供任何删除入口，
//! 清理统一走「可清理类别」的预览 → 确认流程。

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  resourceDiskUsage,
  type ResourceStorageBreakdown,
  type ResourceStorageEntry,
} from "../../lib/bridge";
import { formatBytes } from "../../lib/clipboardUi";
import { localizedErrorMessage } from "../../i18n/errors";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";

const ENTRY_LABELS: Record<string, MessageKey> = {
  tts_cache: "resource.storage.ttsCache",
  clipboard_images: "resource.storage.clipboardImages",
  clipboard_thumbs: "resource.storage.clipboardThumbs",
  shelf_files: "resource.storage.shelfFiles",
  shelf_images: "resource.storage.shelfImages",
  shelf_thumbs: "resource.storage.shelfThumbs",
  agent_inbox: "resource.storage.agentInbox",
  backups: "resource.storage.backups",
  diagnostics: "resource.storage.diagnostics",
  database: "resource.storage.database",
};

interface DiskStoragePanelProps {
  /** 清理完成/快照刷新时递增，触发重新统计。 */
  refreshToken: number;
}

function entryStatusKey(entry: ResourceStorageEntry): MessageKey | null {
  if (entry.status === "missing") return "resource.storage.missing";
  if (entry.status === "partial") return "resource.storage.partial";
  return null;
}

export default function DiskStoragePanel({ refreshToken }: DiskStoragePanelProps) {
  const { t } = useLocale();
  const [data, setData] = useState<ResourceStorageBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const busyRef = useRef(false);

  async function load() {
    if (busyRef.current) return;
    busyRef.current = true;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await resourceDiskUsage();
      if (!mountedRef.current || request !== requestRef.current) return;
      setData(result);
    } catch (reason: unknown) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setData(null);
      setError(localizedErrorMessage(reason));
    } finally {
      busyRef.current = false;
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
    // refreshToken 变化表示清理已完成/页面已刷新，需要重新统计。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const regenerable = data?.entries.filter((entry) => entry.kind === "regenerable") ?? [];
  const persistent = data?.entries.filter((entry) => entry.kind !== "regenerable") ?? [];

  return (
    <section className="resource-storage" aria-labelledby="resource-storage-title">
      <div className="resource-cleanup-section-head">
        <h3 className="resource-cleanup-heading" id="resource-storage-title">
          {t("resource.storage.title")}
        </h3>
        <button type="button" className="btn sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={12} className={loading ? "spin" : undefined} aria-hidden="true" />{" "}
          {t(loading ? "settings.resourceCleanup.refreshing" : "settings.resourceCleanup.refresh")}
        </button>
      </div>
      <p className="setting-note">{t("resource.storage.desc")}</p>
      {error && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("resource.storage.failed", { error })}
        </div>
      )}
      {data && (
        <>
          <div className="resource-storage-total">
            <span>{t("resource.storage.total")}</span>
            <strong>{formatBytes(data.totalBytes)}</strong>
          </div>
          {[
            { key: "regenerable" as const, rows: regenerable },
            { key: "persistent" as const, rows: persistent },
          ].map((group) => (
            <div className="resource-storage-group" key={group.key}>
              <span className="resource-overview-label">
                {t(
                  group.key === "regenerable"
                    ? "resource.storage.groupRegenerable"
                    : "resource.storage.groupPersistent",
                )}
              </span>
              <ul className="resource-storage-list">
                {group.rows.map((entry) => {
                  const statusKey = entryStatusKey(entry);
                  return (
                    <li className="resource-storage-row" key={entry.id}>
                      <span className="resource-storage-name">
                        {ENTRY_LABELS[entry.id] ? t(ENTRY_LABELS[entry.id]) : entry.id}
                      </span>
                      <span className="resource-storage-meta">
                        {entry.status === "missing"
                          ? t("resource.storage.missing")
                          : `${formatBytes(entry.bytes)} · ${t("settings.resourceCleanup.files", {
                              count: entry.files,
                            })}`}
                        {statusKey && entry.status !== "missing"
                          ? ` · ${t(statusKey)}`
                          : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {data.truncated && (
            <p className="setting-note">{t("resource.storage.truncated")}</p>
          )}
          <p className="setting-note">{t("resource.storage.keepNote")}</p>
        </>
      )}
    </section>
  );
}
