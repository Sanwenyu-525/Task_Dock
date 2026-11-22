//! 磁盘分区 · 应用数据占用分布（只读）。
//!
//! 只展示后端扫描到的应用自有目录：`regenerable` 表示可重新生成的缓存，
//! `persistent` 表示业务数据/备份/数据库。本组件不提供任何删除入口，
//! 清理统一走「可清理类别」的预览 → 确认流程。
//!
//! 占比条的分母**只**是已统计的应用数据总量（`totalBytes`），绝不是整盘容量；
//! 统计不完整（`truncated` 或某项 `partial`）时明确标注「仅已扫描部分」。

import { useEffect, useRef } from "react";
import { resourceDiskUsage, type ResourceStorageEntry } from "../../lib/bridge";
import { useAsyncResource } from "../../lib/asyncResource";
import { formatBytes } from "../../lib/clipboardUi";
import { resourceStamp } from "../../lib/resourceTime";
import { buildBreakdown, formatPercent } from "../../lib/resourceMetrics";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import { ChartSwatch, StackedBar } from "./charts";

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
  /** 清理完成/页面级刷新时递增，触发重新统计（隐藏分区不会被动重扫）。 */
  refreshToken: number;
  /** 嵌入折叠区块时不再渲染自己的标题与说明（由外层折叠头提供）。 */
  embedded?: boolean;
  /** 统计进行中状态：页头刷新按钮据此显示忙碌态。 */
  onLoadingChange?: (loading: boolean) => void;
}

function entryStatusKey(entry: ResourceStorageEntry): MessageKey | null {
  if (entry.status === "missing") return "resource.storage.missing";
  if (entry.status === "partial") return "resource.storage.partial";
  return null;
}

export default function DiskStoragePanel({
  refreshToken,
  embedded = false,
  onLoadingChange,
}: DiskStoragePanelProps) {
  const { t } = useLocale();
  const data = useAsyncResource("resource:diskUsage", resourceDiskUsage);
  /** 首次挂载由请求槽负责；只有 token 真正变化（清理完成/页面刷新）才重新统计。 */
  const prevTokenRef = useRef(refreshToken);

  useEffect(() => {
    if (prevTokenRef.current === refreshToken) return;
    prevTokenRef.current = refreshToken;
    data.reload();
  }, [refreshToken, data.reload]);

  // 统计中状态上报给页头：磁盘页刷新按钮需要覆盖目录统计而不只是快照。
  useEffect(() => {
    onLoadingChange?.(data.loading);
  }, [data.loading, onLoadingChange]);

  const rows = data.data;
  const incomplete = Boolean(
    rows &&
      (rows.truncated || rows.entries.some((entry) => entry.status === "partial")),
  );
  /** 按容量降序；零字节项保留在图例末尾（条形图会跳过它们）。 */
  const sorted = [...(rows?.entries ?? [])].sort((left, right) => right.bytes - left.bytes);
  const slices = buildBreakdown(
    sorted.map((entry) => ({ id: entry.id, bytes: entry.bytes })),
    rows?.totalBytes ?? null,
  );
  /** 调色板序号按整体容量排序固定：分组展示时图例与条形仍同序同色。 */
  const colorIndexById = new Map(sorted.map((entry, index) => [entry.id, index + 1]));
  const groups = (
    [
      { kind: "regenerable", label: "resource.storage.groupRegenerable" },
      { kind: "persistent", label: "resource.storage.groupPersistent" },
    ] as const
  )
    .map((group) => ({
      ...group,
      rows: sorted.filter((entry) => entry.kind === group.kind),
    }))
    .filter((group) => group.rows.length > 0);
  const sampled = resourceStamp(rows?.sampledAt);

  return (
    <section
      className={`resource-storage${embedded ? " is-embedded" : ""}`}
      aria-labelledby={embedded ? undefined : "resource-storage-title"}
      aria-label={embedded ? t("resource.storage.title") : undefined}
      aria-busy={data.loading}
    >
      {!embedded && (
        <>
          <div className="resource-cleanup-section-head">
            <h3
              className="resource-cleanup-heading resource-anchor-heading"
              id="resource-storage-title"
              data-resource-anchor-focus
              tabIndex={-1}
            >
              {t("resource.storage.title")}
            </h3>
          </div>
          <p className="setting-note">{t("resource.storage.desc")}</p>
        </>
      )}
      {data.error && (
        <div className="setting-note resource-cleanup-error" role="alert">
          {t("resource.storage.failed", { error: data.error })}
          <button type="button" className="btn sm" onClick={data.reload}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {data.loading && !rows && (
        <p className="setting-note" role="status">
          {t("resource.reading")}
        </p>
      )}
      {/* 刷新中沿用上次统计避免闪烁，但明说这是上次结果。 */}
      {data.loading && rows && (
        <p className="setting-note" role="status">
          {t("resource.updating")}
        </p>
      )}
      {rows && rows.entries.length === 0 && (
        <p className="setting-note" role="status">
          {t("resource.storage.empty")}
        </p>
      )}
      {rows && rows.entries.length > 0 && (
        <>
          <div className="resource-storage-total">
            <span>{t("resource.storage.total")}</span>
            <strong>{formatBytes(rows.totalBytes)}</strong>
          </div>
          {sampled && (
            <p className="resource-storage-sampled" data-tip={sampled.full}>
              {t("resource.time.updated", { time: sampled.time })}
            </p>
          )}
          <StackedBar
            slices={slices.map((slice, index) => ({ ...slice, colorIndex: index + 1 }))}
            ariaLabel={t("resource.aria.breakdown", {
              total: formatBytes(rows.totalBytes),
              count: rows.entries.length,
            })}
            emptyLabel={t("resource.storage.empty")}
          />
          <p className="setting-note resource-share-note">
            {incomplete ? t("resource.storage.sharePartial") : t("resource.storage.shareNote")}
          </p>
          {groups.map((group) => (
            <div className="resource-storage-group" key={group.kind}>
              <h4 className="resource-storage-group-title">
                {t(group.label)}
                <span>{t("resource.storage.groupCount", { count: group.rows.length })}</span>
              </h4>
              <ul className="resource-storage-list">
                {group.rows.map((entry) => {
                  const colorIndex = colorIndexById.get(entry.id) ?? 1;
                  const percent = slices[colorIndex - 1]?.percent ?? null;
                  const statusKey = entryStatusKey(entry);
                  return (
                    <li className="resource-storage-row" key={entry.id}>
                      <ChartSwatch colorIndex={colorIndex} />
                      <span className="resource-storage-name" data-tip={t(ENTRY_LABELS[entry.id] ?? entry.id)}>
                        {ENTRY_LABELS[entry.id] ? t(ENTRY_LABELS[entry.id]) : entry.id}
                      </span>
                      <span className="resource-storage-share">
                        {entry.bytes === 0
                          ? "—"
                          : percent === null
                            ? t("settings.resourceCleanup.unavailable")
                            : formatPercent(percent)}
                      </span>
                      <span className="resource-storage-meta">
                        {entry.status === "missing"
                          ? t("resource.storage.missing")
                          : `${formatBytes(entry.bytes)} · ${t("settings.resourceCleanup.files", {
                              count: entry.files,
                            })}`}
                        {statusKey && entry.status !== "missing" ? ` · ${t(statusKey)}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <p className="setting-note">{t("resource.storage.keepNote")}</p>
        </>
      )}
    </section>
  );
}
