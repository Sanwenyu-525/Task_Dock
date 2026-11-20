//! 外观与主题页（自 SettingsPanel「外观与主题」分组原样迁移，2026-11-20）。
//! 视觉预设与明暗/材质正交，切换即时生效且不影响业务状态；预设卡片本身
//! 就是可视化预览，不另建右栏预览面板。

import { Palette, RotateCcw } from "lucide-react";
import { Select } from "../../ui";
import SettingsPageLayout from "../SettingsPageLayout";
import LanguageSetting from "../../../i18n/LanguageSetting";
import { useSettingsStore } from "../../../store/useSettingsStore";
import { useUiStore } from "../../../store/useUiStore";
import { VISUAL_PRESETS, resolveVisualPreset } from "../../../lib/theme";
import { resetWorkbenchChromeLayout } from "../../../lib/workbenchLayout";
import { errorMessage } from "../../../lib/errors";
import { useLocale } from "../../../hooks/useLocale";

export default function AppearanceSettingsPage() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const materialInfo = useSettingsStore((s) => s.materialInfo);
  const reapplyFromSystem = useSettingsStore((s) => s.reapplyFromSystem);
  const showToast = useUiStore((s) => s.showToast);

  if (!settings) return null;

  const glassDowngraded =
    settings.material === "glass" && materialInfo?.resolved === "solid";

  return (
    <SettingsPageLayout
      icon={Palette}
      title={t("settings.section.appearance")}
      description={t("settings.section.appearanceDesc")}
    >
      {/* v0.6：视觉预设（设计语言）与明暗/材质正交，切换即时生效且不影响业务状态 */}
      <div className="setting-row column">
        <span>{t("settings.appearance.preset")}</span>
        <div className="preset-picker" role="radiogroup" aria-label={t("settings.appearance.preset")}>
          {VISUAL_PRESETS.map((id) => {
            const active = resolveVisualPreset(settings.visual_preset) === id;
            const presetLabels =
              id === "frosted"
                ? {
                    name: t("settings.preset.frosted.name"),
                    tagline: t("settings.preset.frosted.tagline"),
                  }
                : {
                    name: t("settings.preset.dreamGradient.name"),
                    tagline: t("settings.preset.dreamGradient.tagline"),
                  };
            return (
              <button
                key={id}
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                className={`preset-card preset-${id} ${active ? "active" : ""}`}
                onClick={() => update({ visual_preset: id })}
                data-tip={presetLabels.tagline}
                onKeyDown={(e) => {
                  // ARIA radiogroup 契约：一组只保留一个 tab 停靠点，
                  // 方向键在组内移动并即时选中（验收 UI-15）。
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
                  e.preventDefault();
                  const items = [
                    ...(e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                      '[role="radio"]',
                    ) ?? []),
                  ];
                  const index = items.indexOf(e.currentTarget);
                  if (index < 0 || items.length === 0) return;
                  const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
                  const next = items[(index + delta + items.length) % items.length];
                  next?.focus();
                  next?.click();
                }}
              >
                <span className="preset-preview" aria-hidden="true">
                  <span className="pp-rail" />
                  <span className="pp-body">
                    <span className="pp-card c1" />
                    <span className="pp-card c2" />
                    <span className="pp-card c3" />
                    <span className="pp-row" />
                  </span>
                </span>
                <span className="preset-meta">
                  <strong>{presetLabels.name}</strong>
                  <em>{presetLabels.tagline}</em>
                </span>
                <span className="preset-radio" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
      <div className="setting-row">
        <span>{t("settings.appearance.color")}</span>
        <Select
          ariaLabel={t("settings.appearance.color")}
          size="sm"
          triggerClassName="settings-select-trigger"
          align="end"
          value={settings.theme}
          options={[
            { value: "system", label: t("settings.appearance.theme.system") },
            { value: "light", label: t("settings.appearance.theme.light") },
            { value: "dark", label: t("settings.appearance.theme.dark") },
          ]}
          onChange={(v) => update({ theme: v as never })}
        />
      </div>
      {/* 清透预设已下线，clear_foreground 仅保留键兼容、不再读取。 */}
      <div className="setting-row">
        <span>{t("settings.appearance.material")}</span>
        <Select
          ariaLabel={t("settings.appearance.material")}
          size="sm"
          triggerClassName="settings-select-trigger"
          align="end"
          value={settings.material}
          options={[
            { value: "glass", label: t("settings.appearance.material.glass") },
            { value: "solid", label: t("settings.appearance.material.solid") },
          ]}
          onChange={(v) => update({ material: v as never })}
        />
      </div>
      <LanguageSetting />
      {/* 工作台分栏默认值：解决「代码里的 DEFAULTS 改不动用户已保存宽度」。
          只重置导航宽度 / 详情栏宽度 / 详情栏开关，主题与导航排序不受影响。 */}
      <div className="setting-row">
        <span>{t("settings.appearance.workbenchLayout")}</span>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            void resetWorkbenchChromeLayout()
              .then(() =>
                showToast(t("settings.appearance.workbenchLayoutResetDone"), { kind: "success" }),
              )
              .catch((e) =>
                showToast(
                  t("settings.appearance.workbenchLayoutResetFailed", {
                    error: errorMessage(e),
                  }),
                  { kind: "error" },
                ),
              );
          }}
        >
          <RotateCcw size={11} /> {t("settings.appearance.workbenchLayoutReset")}
        </button>
      </div>
      <div className="setting-note">
        {t("settings.appearance.workbenchLayoutNote")}
      </div>
      <div className="setting-note">
        {settings.material === "glass" ? (
          materialInfo?.materialError ? (
            // 失败原因与「系统不支持」区分：失败是可通过重试恢复的
            <>{t("settings.appearance.materialFailed", { error: materialInfo.materialError })}
              <button type="button" className="btn sm" onClick={() => reapplyFromSystem()}>
                {t("settings.appearance.reapply")}
              </button>
            </>
          ) : glassDowngraded ? (
            <>{t("settings.appearance.glassDowngraded", {
              version: materialInfo?.osVersion || t("settings.appearance.versionUnknown"),
            })}</>
          ) : materialInfo?.applied ? (
            materialInfo.effect === "css" ? (
              <>{t("settings.appearance.cssGlass")}</>
            ) : (
              <>{t("settings.appearance.nativeGlass", { effect: materialInfo.effect })}</>
            )
          ) : (
            <>{t("settings.appearance.probing")}</>
          )
        ) : (
          <>{t("settings.appearance.opaque")}</>
        )}
      </div>
    </SettingsPageLayout>
  );
}
