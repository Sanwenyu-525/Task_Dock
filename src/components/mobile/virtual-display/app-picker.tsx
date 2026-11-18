//! Android 应用选择器：按需展开全部应用，默认只展示当前选中、最近使用与收藏。
//!
//! 名称/图标来自 Rust 侧的 Android PackageManager；搜索支持中文名、英文名、
//! 完整包名与包名片段。列表仍与设备 UID 绑定，父组件负责丢弃过期响应。

import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  Star,
} from "lucide-react";

import type { VdApp } from "../../../lib/bridge";
import { SearchField } from "../../ui";
import { filterApps, type Translate } from "./format";

export interface AppPickerProps {
  apps: VdApp[];
  loading: boolean;
  error: string | null;
  launchableKnown: boolean;
  includeAll: boolean;
  deviceUid: string;
  selectedPackage: string;
  recentPackages: string[];
  favoritePackages: string[];
  manual: boolean;
  manualPackage: string;
  manualError: string | null;
  disabled: boolean;
  t: Translate;
  onSelect: (packageName: string) => void;
  onToggleFavorite: (packageName: string) => void;
  onManualChange: (value: string) => void;
  onToggleManual: (open: boolean) => void;
  onToggleIncludeAll: () => void;
  onRefresh: () => void;
}

function appDisplayName(app: VdApp): string {
  return app.label?.trim() || app.package;
}

function AppIcon({ app }: { app: VdApp }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="vd-app-icon" aria-hidden="true">
      {app.icon && !broken ? (
        <img
          src={app.icon}
          alt=""
          width={24}
          height={24}
          draggable={false}
          onError={() => setBroken(true)}
        />
      ) : (
        <AppWindow size={14} />
      )}
    </span>
  );
}

function AppRow({
  app,
  selected,
  disabled,
  favorite,
  onSelect,
  onToggleFavorite,
  t,
  compact = false,
}: {
  app: VdApp;
  selected: boolean;
  disabled: boolean;
  favorite: boolean;
  onSelect: (packageName: string) => void;
  onToggleFavorite: (packageName: string) => void;
  t: Translate;
  compact?: boolean;
}) {
  const unavailable = app.launchable === false;
  return (
    <div className={`vd-app-item${selected ? " is-selected" : ""}${compact ? " is-compact" : ""}`}>
      <button
        type="button"
        className={`vd-app-row${selected ? " is-selected" : ""}${
          unavailable ? " is-disabled" : ""
        }`}
        aria-pressed={selected}
        disabled={disabled || unavailable}
        data-tip={
          unavailable ? app.reason ?? t("virtualDisplay.noLaunchable") : app.package
        }
        onClick={() => onSelect(app.package)}
      >
        <AppIcon app={app} />
        <span className="vd-app-main">
          <span className="vd-app-name">
            {appDisplayName(app)}
            {selected ? (
              <Check size={12} className="vd-app-check" aria-hidden="true" />
            ) : null}
          </span>
          {!compact ? <span className="vd-app-package">{app.package}</span> : null}
          {unavailable && !compact ? (
            <span className="vd-app-reason">
              {app.reason ?? t("virtualDisplay.noLaunchable")}
            </span>
          ) : null}
        </span>
        {!compact ? (
          <span className="vd-app-tags">
            <span className={`vd-app-tag is-${app.system ? "system" : "user"}`}>
              {t(app.system ? "virtualDisplay.systemApp" : "virtualDisplay.userApp")}
            </span>
          </span>
        ) : null}
      </button>
      {!unavailable ? (
        <button
          type="button"
          className={`vd-app-fav${favorite ? " is-favorite" : ""}`}
          aria-label={t(
            favorite
              ? "virtualDisplay.app.unfavorite"
              : "virtualDisplay.app.favorite",
          )}
          aria-pressed={favorite}
          data-tip={t(
            favorite
              ? "virtualDisplay.app.unfavorite"
              : "virtualDisplay.app.favorite",
          )}
          onClick={() => onToggleFavorite(app.package)}
        >
          <Star size={12} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export default function AppPicker({
  apps,
  loading,
  error,
  launchableKnown,
  includeAll,
  deviceUid,
  selectedPackage,
  recentPackages,
  favoritePackages,
  manual,
  manualPackage,
  manualError,
  disabled,
  t,
  onSelect,
  onToggleFavorite,
  onManualChange,
  onToggleManual,
  onToggleIncludeAll,
  onRefresh,
}: AppPickerProps) {
  const [query, setQuery] = useState("");
  const [browseAll, setBrowseAll] = useState(false);

  // 设备切换后清空旧搜索词；当前选中由父组件按包名保留/校验。
  useEffect(() => {
    setQuery("");
    setBrowseAll(false);
  }, [deviceUid]);

  const keyword = query.trim().toLowerCase();
  const filtered = useMemo(() => filterApps(apps, query), [apps, query]);

  const byPackage = useMemo(
    () => new Map(apps.map((app) => [app.package, app])),
    [apps],
  );
  const selectedApp = selectedPackage ? byPackage.get(selectedPackage) ?? null : null;
  const recentApps = recentPackages
    .map((pkg) => byPackage.get(pkg))
    .filter((app): app is VdApp => Boolean(app) && app!.launchable !== false);
  const favoriteApps = favoritePackages
    .map((pkg) => byPackage.get(pkg))
    .filter((app): app is VdApp => Boolean(app) && app!.launchable !== false);
  const showAll = browseAll || keyword.length > 0;
  const availableCount = apps.filter((app) => app.launchable !== false).length;
  const favoriteSet = useMemo(() => new Set(favoritePackages), [favoritePackages]);

  const rowProps = (app: VdApp, compact = false) => ({
    app,
    selected: app.package === selectedPackage,
    disabled,
    favorite: favoriteSet.has(app.package),
    onSelect,
    onToggleFavorite,
    t,
    compact,
  });

  return (
    <div className="vd-app-picker">
      <div className="vd-field-head">
        <span className="vd-field-label">{t("virtualDisplay.config.app")}</span>
        {!manual ? (
          <span className="vd-field-count">
            {loading
              ? t("virtualDisplay.app.loading")
              : t("virtualDisplay.app.count", { count: filtered.length })}
          </span>
        ) : null}
        {!manual ? (
          <button
            className="icon-btn sm"
            data-tip={t("virtualDisplay.app.refresh")}
            aria-label={t("virtualDisplay.app.refresh")}
            onClick={onRefresh}
            disabled={disabled || loading}
          >
            <RefreshCw size={12} className={loading ? "spin" : undefined} />
          </button>
        ) : null}
      </div>

      {manual ? (
        <div className="vd-manual-package">
          <input
            className={`vd-input${manualError ? " is-invalid" : ""}`}
            type="text"
            value={manualPackage}
            placeholder={t("virtualDisplay.packagePlaceholder")}
            aria-label={t("virtualDisplay.packagePlaceholder")}
            aria-invalid={manualError ? true : undefined}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => onManualChange(event.target.value)}
          />
          {manualError ? (
            <div className="vd-field-error" role="alert">
              {manualError}
            </div>
          ) : (
            <div className="vd-hint">{t("virtualDisplay.manualInputHint")}</div>
          )}
          <button
            type="button"
            className="vd-link"
            onClick={() => onToggleManual(false)}
            disabled={disabled}
          >
            {t("virtualDisplay.app.manualBack")}
          </button>
        </div>
      ) : (
        <>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t("virtualDisplay.app.search")}
            ariaLabel={t("virtualDisplay.app.search")}
            clearLabel={t("virtualDisplay.app.clearSearch")}
            size="compact"
            disabled={disabled && apps.length === 0}
          />

          {loading && apps.length === 0 ? (
            <div className="vd-app-state" role="status">
              <Loader2 size={14} className="spin" aria-hidden="true" />
              {t("virtualDisplay.app.loading")}
            </div>
          ) : error ? (
            <div className="vd-app-state is-error" role="alert">
              {error}
            </div>
          ) : showAll ? (
            filtered.length === 0 ? (
              <div className="vd-app-state">
                <span className="vd-app-state-title">{t("virtualDisplay.app.empty")}</span>
                <span className="vd-hint">{t("virtualDisplay.app.emptyHint")}</span>
              </div>
            ) : (
              <div
                className={`vd-app-list vd-app-grid${browseAll ? " is-browse" : ""}`}
                aria-label={t("virtualDisplay.app.allApps")}
              >
                {filtered.map((app) => (
                  <AppRow key={app.package} {...rowProps(app)} />
                ))}
              </div>
            )
          ) : (
            <>
              {selectedApp ? (
                <div className="vd-app-section">
                  <div className="vd-app-section-title">
                    <span>{t("virtualDisplay.app.selected")}</span>
                  </div>
                  <div className="vd-app-summary">
                    <AppRow {...rowProps(selectedApp, true)} />
                  </div>
                </div>
              ) : null}

              <div className="vd-app-section">
                <div className="vd-app-section-title">
                  <span>{t("virtualDisplay.app.recent")}</span>
                  {recentApps.length ? (
                    <span className="vd-app-section-count">{recentApps.length}</span>
                  ) : null}
                </div>
                {recentApps.length ? (
                  <div className="vd-app-grid is-quick">
                    {recentApps.slice(0, 4).map((app) => (
                      <AppRow key={app.package} {...rowProps(app, true)} />
                    ))}
                  </div>
                ) : (
                  <div className="vd-app-quiet">{t("virtualDisplay.app.recentEmpty")}</div>
                )}
              </div>

              {favoriteApps.length ? (
                <div className="vd-app-section">
                  <div className="vd-app-section-title">
                    <span>{t("virtualDisplay.app.favorites")}</span>
                    <span className="vd-app-section-count">{favoriteApps.length}</span>
                  </div>
                  <div className="vd-app-grid is-quick">
                    {favoriteApps.slice(0, 4).map((app) => (
                      <AppRow key={app.package} {...rowProps(app, true)} />
                    ))}
                  </div>
                </div>
              ) : null}

              <button
                type="button"
                className="vd-app-browse"
                onClick={() => setBrowseAll(true)}
                disabled={disabled}
              >
                <ChevronDown size={13} aria-hidden="true" />
                {t("virtualDisplay.app.browseAll", { count: availableCount })}
              </button>
            </>
          )}

          {showAll ? (
            <button
              type="button"
              className="vd-app-browse is-collapse"
              onClick={() => setBrowseAll(false)}
              disabled={disabled}
            >
              <ChevronUp size={13} aria-hidden="true" />
              {t("virtualDisplay.app.collapseAll")}
            </button>
          ) : null}

          <div className="vd-app-foot">
            <button
              type="button"
              className="vd-link"
              onClick={() => onToggleManual(true)}
              disabled={disabled}
            >
              {t("virtualDisplay.app.manualToggle")}
            </button>
            {launchableKnown ? (
              <button type="button" className="vd-link" onClick={onToggleIncludeAll}>
                {includeAll
                  ? t("virtualDisplay.hideAllApps")
                  : t("virtualDisplay.showAllApps")}
              </button>
            ) : null}
          </div>
          {launchableKnown ? null : (
            <div className="vd-hint">{t("virtualDisplay.app.launchableUnknown")}</div>
          )}
        </>
      )}
    </div>
  );
}
