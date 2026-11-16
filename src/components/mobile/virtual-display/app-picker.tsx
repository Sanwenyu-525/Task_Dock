//! Android 应用选择器：名称/包名实时搜索、用户/系统标识、可启动状态与手动包名。
//!
//! 应用列表与设备 UID 绑定：父组件在设备切换时递增请求序号并丢弃迟到响应；
//! 本组件只负责展示与本地过滤，不缓存跨设备数据。

import { useEffect, useMemo, useState } from "react";
import { AppWindow, Check, Loader2, RefreshCw } from "lucide-react";

import type { VdApp } from "../../../lib/bridge";
import { SearchField } from "../../ui";
import type { Translate } from "./format";

export interface AppPickerProps {
  apps: VdApp[];
  loading: boolean;
  error: string | null;
  launchableKnown: boolean;
  includeAll: boolean;
  deviceUid: string;
  selectedPackage: string;
  manual: boolean;
  manualPackage: string;
  manualError: string | null;
  disabled: boolean;
  t: Translate;
  onSelect: (packageName: string) => void;
  onManualChange: (value: string) => void;
  onToggleManual: (open: boolean) => void;
  onToggleIncludeAll: () => void;
  onRefresh: () => void;
}

export default function AppPicker({
  apps,
  loading,
  error,
  launchableKnown,
  includeAll,
  deviceUid,
  selectedPackage,
  manual,
  manualPackage,
  manualError,
  disabled,
  t,
  onSelect,
  onManualChange,
  onToggleManual,
  onToggleIncludeAll,
  onRefresh,
}: AppPickerProps) {
  const [query, setQuery] = useState("");

  // 设备切换后清空旧搜索词：避免新设备的应用被上一台手机的搜索条件过滤掉。
  useEffect(() => {
    setQuery("");
  }, [deviceUid]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return apps;
    return apps.filter(
      (app) =>
        (app.label ?? "").toLowerCase().includes(keyword) ||
        app.package.toLowerCase().includes(keyword),
    );
  }, [apps, query]);

  return (
    <div className="vd-app-picker">
      <div className="vd-field-head">
        <span className="vd-field-label">{t("virtualDisplay.config.app")}</span>
        {!manual ? (
          <span className="vd-field-count">
            {t("virtualDisplay.app.count", { count: filtered.length })}
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
          ) : filtered.length === 0 ? (
            <div className="vd-app-state">
              <span className="vd-app-state-title">{t("virtualDisplay.app.empty")}</span>
              <span className="vd-hint">{t("virtualDisplay.app.emptyHint")}</span>
            </div>
          ) : (
            <div className="vd-app-list" aria-label={t("virtualDisplay.app")}>
              {filtered.map((app) => {
                const unavailable = app.launchable === false;
                const selected = app.package === selectedPackage;
                return (
                  <button
                    type="button"
                    key={app.package}
                    className={`vd-app-row${selected ? " is-selected" : ""}${
                      unavailable ? " is-disabled" : ""
                    }`}
                    aria-pressed={selected}
                    disabled={disabled || unavailable}
                    data-tip={unavailable ? app.reason ?? t("virtualDisplay.noLaunchable") : undefined}
                    onClick={() => onSelect(app.package)}
                  >
                    <span className="vd-app-icon" aria-hidden="true">
                      <AppWindow size={14} />
                    </span>
                    <span className="vd-app-main">
                      <span className="vd-app-name">
                        {app.label ?? app.package}
                        {selected ? (
                          <Check size={12} className="vd-app-check" aria-hidden="true" />
                        ) : null}
                      </span>
                      {app.label ? (
                        <span className="vd-app-package">{app.package}</span>
                      ) : null}
                      {unavailable ? (
                        <span className="vd-app-reason">
                          {app.reason ?? t("virtualDisplay.noLaunchable")}
                        </span>
                      ) : null}
                    </span>
                    <span className="vd-app-tags">
                      <span
                        className={`vd-app-tag is-${app.system ? "system" : "user"}`}
                      >
                        {t(
                          app.system
                            ? "virtualDisplay.systemApp"
                            : "virtualDisplay.userApp",
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

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
