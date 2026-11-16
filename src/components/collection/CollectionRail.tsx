//! 「收集与暂存 · 文件暂存」右侧信息栏（对照效果图 04 的右列）。
//!
//! 只读既有 Store：
//! - 分类计数与空间来自 `useShelfStore.stats`（后端 `shelf_stats`，由暂存架自身
//!   的 `refreshMeta` 取回，本组件不额外发请求）；
//! - 未取到统计时退回「已加载项」的口径，并在文案里写明，绝不把局部当全量；
//! - 投递目标来自 `useDropTargetsStore.targets`（暂存架挂载时已加载）。
//!
//! 交互：分类卡 = 设置暂存架筛选（与暂存架工具栏同一 Store，不另建筛选状态）。

import { useEffect } from "react";
import { FolderSymlink, HardDrive, LayoutGrid, Target } from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import { useShelfStore } from "../../store/useShelfStore";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";
import { formatBytes } from "../../lib/clipboardUi";
import type { ShelfKind } from "../../lib/bridge";

type FilterKind = ShelfKind | "all";

export default function CollectionRail() {
  const { t } = useLocale();
  const stats = useShelfStore((s) => s.stats);
  const items = useShelfStore((s) => s.items);
  const total = useShelfStore((s) => s.total);
  const filter = useShelfStore((s) => s.filter);
  const setFilter = useShelfStore((s) => s.setFilter);
  const targets = useDropTargetsStore((s) => s.targets);
  const targetsLoaded = useDropTargetsStore((s) => s.loaded);
  const targetsLoading = useDropTargetsStore((s) => s.loading);
  const loadTargets = useDropTargetsStore((s) => s.load);
  const requestManage = useDropTargetsStore((s) => s.requestManage);

  // 投递目标是配置读取（非高频采样）：只在尚未加载时取一次，
  // 暂存架本身已加载时不会重复请求。
  useEffect(() => {
    if (!targetsLoaded && !targetsLoading) void loadTargets();
  }, [targetsLoaded, targetsLoading, loadTargets]);

  const loaded = items.length;
  const count = {
    total: stats?.total ?? total,
    image: stats?.image_count ?? items.filter((i) => i.kind === "image").length,
    file: stats?.file_count ?? items.filter((i) => i.kind === "file").length,
    link: stats?.link_count ?? items.filter((i) => i.kind === "link").length,
    folder: stats?.folder_count ?? items.filter((i) => i.kind === "folder").length,
    text: stats?.text_count ?? items.filter((i) => i.kind === "text").length,
  };

  const tiles: Array<{ kind: FilterKind; label: string; value: number }> = [
    { kind: "all", label: t("workbench.page.filterAll"), value: count.total },
    { kind: "image", label: t("shelf.kind.image"), value: count.image },
    { kind: "file", label: t("shelf.kind.file"), value: count.file },
    { kind: "link", label: t("shelf.kind.link"), value: count.link },
  ];

  const usedBytes = stats ? stats.disk_bytes : items.reduce((sum, i) => sum + (i.byte_size || 0), 0);
  const quotaBytes = stats?.quota_mb ? stats.quota_mb * 1024 * 1024 : 0;
  const quotaPercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0;

  return (
    <aside className="col-rail col-rail-sidebar" aria-label={t("collection.title")}>
      <section className="col-rail-card">
        <header className="col-rail-head">
          <h3>
            <LayoutGrid size={13} aria-hidden="true" /> {t("workbench.page.collectionCategories")}
          </h3>
        </header>
        <div className="col-rail-tiles">
          {tiles.map((tile) => {
            const active = filter.kind === tile.kind;
            return (
              <button
                key={tile.kind}
                type="button"
                className={`col-tile${active ? " is-active" : ""}`}
                aria-pressed={active}
                data-kind={tile.kind}
                onClick={() => void setFilter({ kind: tile.kind })}
              >
                <span className="col-tile-value">{tile.value}</span>
                <span className="col-tile-label">{tile.label}</span>
              </button>
            );
          })}
        </div>
        <p className="col-rail-note">
          {t("shelf.kind.folder")} {count.folder} · {t("shelf.kind.text")} {count.text}
          {stats
            ? null
            : ` · ${t("workbench.page.collectionLoadedNote", { loaded, total })}`}
        </p>
      </section>

      <section className="col-rail-card">
        <header className="col-rail-head">
          <h3>
            <HardDrive size={13} aria-hidden="true" /> {t("workbench.page.collectionSpace")}
          </h3>
        </header>
        <p className="col-space-value">{formatBytes(usedBytes)}</p>
        {quotaBytes > 0 && (
          <span className="col-space-bar" role="img" aria-label={`${quotaPercent}%`}>
            <i style={{ width: `${quotaPercent}%` }} />
          </span>
        )}
        <p className="col-rail-note">{t("workbench.page.collectionSpaceNote")}</p>
      </section>

      <section className="col-rail-card">
        <header className="col-rail-head">
          <h3>
            <FolderSymlink size={13} aria-hidden="true" /> {t("workbench.page.collectionTargets")}
          </h3>
          <button type="button" className="btn sm" onClick={() => requestManage()}>
            <Target size={12} aria-hidden="true" /> {t("workbench.page.collectionManageTargets")}
          </button>
        </header>
        {targets.length === 0 ? (
          <p className="col-rail-note">
            {targetsLoaded
              ? t("workbench.page.collectionTargetsEmpty")
              : t("common.loading")}
          </p>
        ) : (
          <ul className="col-target-list">
            {targets.slice(0, 3).map((target) => (
              <li key={target.id}>
                <span className="col-target-name">{target.name}</span>
                <span
                  className={`col-target-state${target.available ? "" : " is-off"}`}
                >
                  {target.available
                    ? t("shelf.dropTarget.available")
                    : t("workbench.page.collectionTargetUnavailable")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
