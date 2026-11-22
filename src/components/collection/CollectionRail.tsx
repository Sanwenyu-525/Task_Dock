//! 「收集与暂存 · 文件暂存」左侧导航（原右列信息栏，2026-11-22 精修）。
//!
//! 只读既有 Store：
//! - 分类计数与空间来自 `useShelfStore.stats`（后端 `shelf_stats`，由暂存架自身
//!   的 `refreshMeta` 取回，本组件不额外发请求）；
//! - 未取到统计时退回「已加载项」的口径，并在文案里写明，绝不把局部当全量；
//! - 投递目标来自 `useDropTargetsStore.targets`（暂存架挂载时已加载）。
//!
//! 交互：分类 / 分组 = 设置暂存架筛选（与暂存架工具栏同一 Store，不另建筛选状态）。
//! 布局：分类与分组是同级的导航列表，统计收敛为一条紧凑说明，避免四张大数字
//! 卡把左栏撑满、把「分类」压成统计报表。

import { useEffect } from "react";
import { FolderOpen, HardDrive, Layers, Target } from "lucide-react";

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
  const groups = useShelfStore((s) => s.groups);
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

  // 六类都要能直达：文件夹/文本不属于「常用四类」，但确实是真实分类。
  const kinds: Array<{ kind: FilterKind; label: string; value: number }> = [
    { kind: "all", label: t("workbench.page.filterAll"), value: count.total },
    { kind: "image", label: t("shelf.kind.image"), value: count.image },
    { kind: "file", label: t("shelf.kind.file"), value: count.file },
    { kind: "link", label: t("shelf.kind.link"), value: count.link },
    { kind: "folder", label: t("shelf.kind.folder"), value: count.folder },
    { kind: "text", label: t("shelf.kind.text"), value: count.text },
  ];

  const usedBytes = stats ? stats.disk_bytes : items.reduce((sum, i) => sum + (i.byte_size || 0), 0);
  const quotaBytes = stats?.quota_mb ? stats.quota_mb * 1024 * 1024 : 0;
  const quotaPercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0;

  return (
    <aside className="col-rail col-rail-sidebar" aria-label={t("collection.title")}>
      <div className="workspace-rail-head">
        <span className="workspace-rail-eyebrow">STAGING</span>
        <h2>{t("workbench.page.collectionCategories")}</h2>
      </div>

      <section className="col-rail-section" aria-label={t("workbench.page.collectionCategories")}>
        <p className="col-rail-label">类型</p>
        <div className="col-rail-nav">
          {kinds.map((entry) => {
            const active = filter.kind === entry.kind;
            return (
              <button
                key={entry.kind}
                type="button"
                className={`col-rail-item${active ? " is-active" : ""}`}
                aria-pressed={active}
                data-kind={entry.kind}
                onClick={() => void setFilter({ kind: entry.kind })}
              >
                <span>{entry.label}</span>
                <em>{entry.value}</em>
              </button>
            );
          })}
        </div>
        {!stats && (
          <p className="col-rail-note">
            {t("workbench.page.collectionLoadedNote", { loaded, total })}
          </p>
        )}
      </section>

      {groups.length > 0 && (
        <section className="col-rail-section" aria-label={t("shelf.group.title")}>
          <p className="col-rail-label">{t("shelf.group.title")}</p>
          <div className="col-rail-nav">
            <button
              type="button"
              className={`col-rail-item${filter.group_id === "all" ? " is-active" : ""}`}
              aria-pressed={filter.group_id === "all"}
              onClick={() => void setFilter({ group_id: "all" })}
            >
              <span>{t("shelf.group.all")}</span>
            </button>
            {groups.map((group) => (
              <button
                key={group.id}
                type="button"
                className={`col-rail-item${filter.group_id === group.id ? " is-active" : ""}`}
                aria-pressed={filter.group_id === group.id}
                onClick={() => void setFilter({ group_id: group.id })}
              >
                <span>
                  <FolderOpen size={12} aria-hidden="true" />
                  {group.name}
                </span>
                <em>{group.item_count}</em>
              </button>
            ))}
            <button
              type="button"
              className={`col-rail-item${filter.group_id === "none" ? " is-active" : ""}`}
              aria-pressed={filter.group_id === "none"}
              onClick={() => void setFilter({ group_id: "none" })}
            >
              <span>
                <Layers size={12} aria-hidden="true" />
                {t("shelf.group.none")}
              </span>
            </button>
          </div>
        </section>
      )}

      <section className="col-rail-section col-rail-section--space" aria-label={t("workbench.page.collectionSpace")}>
        <p className="col-rail-label">
          <HardDrive size={11} aria-hidden="true" /> {t("workbench.page.collectionSpace")}
        </p>
        <div className="col-space">
          <span className="col-space-value">{formatBytes(usedBytes)}</span>
          {quotaBytes > 0 && (
            <span className="col-space-bar" role="img" aria-label={`${quotaPercent}%`}>
              <i style={{ width: `${quotaPercent}%` }} />
            </span>
          )}
        </div>
        <p className="col-rail-note">{t("workbench.page.collectionSpaceNote")}</p>
      </section>

      <section className="col-rail-section col-rail-section--targets" aria-label={t("workbench.page.collectionTargets")}>
        <p className="col-rail-label">
          <Target size={11} aria-hidden="true" /> {t("workbench.page.collectionTargets")}
          <button type="button" className="link-btn" onClick={() => requestManage()}>
            {t("workbench.page.collectionManageTargets")}
          </button>
        </p>
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
