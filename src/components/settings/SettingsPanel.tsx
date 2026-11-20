//! 设置中心：组合层（2026-11-20 设置中心重构）。
//!
//! 职责：页头（标题 + 搜索入口）、树形二级导航、当前子页面挂载、右栏
//! 「当前配置」摘要、跨模块定位意图（reveal / appConfig / AppPicker）。
//! 各设置域的业务细节已拆分到 `pages/`（原分组的全部行为原样保留），
//! 本文件不再承载具体表单，也不维护第二份分类索引（注册表唯一事实源）。
//!
//! 布局与滚动：`.settings-panel` 是容器查询容器（settings-page.css），
//! `.settings-page-host` 是页面级唯一滚动区；导航自定义页在其内部自管
//! 列表滚动（拖拽自动滚动依赖列表自身可滚）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { Combobox } from "../ui";
import "./settings-page.css";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import { WorkbenchPageDetail, WorkbenchDetailFacts } from "../../workbench/pageDetail";
import { useWorkbenchLayout } from "../../lib/workbenchLayout";
import { useSettingsResponsiveLayout } from "../../hooks/useSettingsResponsiveLayout";
import { useLocale } from "../../hooks/useLocale";
import { resolveVisualPreset } from "../../lib/theme";
import {
  SETTINGS_SECTION_REVEAL_EVENT,
  consumeSettingsSectionReveal,
  isSettingsSectionId,
  type SettingsSectionId,
} from "../../lib/settingsSections";
import {
  matchesSettingsQuery,
  persistSettingsActiveSection,
  readSettingsActiveSection,
  settingsCategory,
  settingsSectionMeta,
  SETTINGS_SECTION_META,
  type SettingsCategoryId,
} from "../../lib/settingsCategories";
import SettingsNavigation from "./SettingsNavigation";
import AppPicker from "../navigation/AppPicker";
import AppearanceSettingsPage from "./pages/AppearanceSettingsPage";
import NavigationSettingsPage from "./pages/NavigationSettingsPage";
import WindowHotkeysSettingsPage from "./pages/WindowHotkeysSettingsPage";
import FeaturesSettingsPage from "./pages/FeaturesSettingsPage";
import AppsSettingsPage from "./pages/AppsSettingsPage";
import ClipboardSettingsPage from "./pages/ClipboardSettingsPage";
import NotificationSettingsPage from "./pages/NotificationSettingsPage";
import {
  AudioSoundSettingsPage,
  TtsSettingsPage,
  TtsCacheSettingsPage,
} from "./AudioSettings";
import ResourceCleanupSettingsPage from "./pages/ResourceCleanupSettingsPage";
import DataBackupSettingsPage from "./pages/DataBackupSettingsPage";
import AgentSettingsPage from "./pages/AgentSettingsPage";
import DiagnosticsLogsSettingsPage from "./pages/DiagnosticsLogsSettingsPage";
import DiagnosticsSettingsPage from "./pages/DiagnosticsSettingsPage";
import DeveloperSettingsPage from "./pages/DeveloperSettingsPage";
import HelpSettingsPage from "./pages/HelpSettingsPage";

/** 二级页面 → 组件。apps 需要 onRequestAdd（AppPicker 子页面入口），单独处理。 */
const SETTINGS_PAGE_COMPONENTS: Partial<
  Record<SettingsSectionId, React.ComponentType>
> = {
  appearance: AppearanceSettingsPage,
  navigation: NavigationSettingsPage,
  "window-hotkeys": WindowHotkeysSettingsPage,
  features: FeaturesSettingsPage,
  clipboard: ClipboardSettingsPage,
  notifications: NotificationSettingsPage,
  "audio-sound": AudioSoundSettingsPage,
  tts: TtsSettingsPage,
  "tts-cache": TtsCacheSettingsPage,
  "resource-cleanup": ResourceCleanupSettingsPage,
  data: DataBackupSettingsPage,
  agent: AgentSettingsPage,
  "diagnostics-logs": DiagnosticsLogsSettingsPage,
  diagnostics: DiagnosticsSettingsPage,
  developer: DeveloperSettingsPage,
  help: HelpSettingsPage,
};

export default function SettingsPanel() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  // 右栏「当前配置」只读摘要：布局值来自同一份 workbench_layout，
  // 不在设置页另存一份宽度，避免与外壳拖拽后的值漂移。
  const workbenchLayout = useWorkbenchLayout();

  // 容器查询容器：响应式模式由实际内容区宽度决定（窗口宽度≠工作区宽度）。
  const containerRef = useRef<HTMLDivElement | null>(null);
  const layoutMode = useSettingsResponsiveLayout(containerRef);

  /** 当前二级页面（持久化 UI 偏好；业务配置仍全部走 useSettingsStore）。 */
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() =>
    readSettingsActiveSection(),
  );
  /**
   * 页面标题焦点标记：外部定位（搜索 / reveal / appConfig）切页时把焦点移到
   * 页面标题；树形导航自身激活（方向键/点击）不抢焦点——导航项已持有焦点，
   * 抢走会打断键盘连续移动。
   */
  const focusHeadingRef = useRef(false);
  /** 外部定位序号：同一页面重复选中时也要重新定位（activeSection 不变）。 */
  const [focusNonce, setFocusNonce] = useState(0);
  /** 页面级滚动容器：切页/定位要回到顶部，否则新页面从上一页的滚动位置开始。 */
  const pageHostRef = useRef<HTMLDivElement | null>(null);

  /** 切换二级页面：持久化 + 状态更新。草稿保护由各页面卸载守卫承担。 */
  const selectSection = useCallback((section: SettingsSectionId) => {
    persistSettingsActiveSection(section);
    setActiveSection(section);
  }, []);

  /** 外部定位入口：切页 + 焦点交给页面标题（搜索/reveal/appConfig 共用）。 */
  const navigateToSection = useCallback((section: SettingsSectionId) => {
    focusHeadingRef.current = true;
    selectSection(section);
    // 同一页面再次命中时 activeSection 不变，用序号驱动一次重新定位。
    setFocusNonce((n) => n + 1);
  }, [selectSection]);

  // 跨模块定位（「更多 → 自定义导航」/全局搜索/剪贴板工作区）：
  // 设置页尚未挂载时由 sessionStorage 意图兜底；已挂载时直接走事件。
  // 旧版「展开折叠分组」语义由切页直达替代；协议（事件 + 意图键）不变。
  useEffect(() => {
    const pending = consumeSettingsSectionReveal();
    if (pending) navigateToSection(pending);
    const onReveal = (event: Event) => {
      // 事件路径也消费一次性意图，避免下次重新挂载时重复滚动。
      consumeSettingsSectionReveal();
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id === "string" && isSettingsSectionId(id)) navigateToSection(id);
    };
    window.addEventListener(SETTINGS_SECTION_REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(SETTINGS_SECTION_REVEAL_EVENT, onReveal);
  }, [navigateToSection]);

  // 工具面板「应用」页的一次性配置意图（消费后立即清除，避免反复自动弹出）。
  const appConfig = useUiStore((s) => s.appConfig);
  const clearAppConfig = useUiStore((s) => s.clearAppConfig);
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [pendingPicker, setPendingPicker] = useState(false);
  const snapPhase = useEdgeSnapStore((s) => s.phase);

  useEffect(() => {
    if (!appConfig) return;
    const kind = appConfig.kind;
    clearAppConfig();
    if (kind === "picker") {
      // 胶囊仍处于 Win32 区域裁剪时先挂起，等解除停靠进入 free 再挂载选择器，
      // 避免大型模态被裁掉。同时把页面切到「应用管理」：关闭选择器后用户
      // 落在应用设置所在页面，而不是回到别的页面再找一次。
      navigateToSection("apps");
      setPendingPicker(true);
      return;
    }
    // 管理意图：直达「应用管理」页面（与「更多 → 自定义导航」同一路径）。
    navigateToSection("apps");
  }, [appConfig, clearAppConfig, navigateToSection]);

  useEffect(() => {
    if (!pendingPicker || snapPhase !== "free") return;
    setPendingPicker(false);
    setAppPickerOpen(true);
  }, [pendingPicker, snapPhase]);

  // 外部定位切页后：先把页面滚动区归零，再把焦点移到页面标题（DOM 提交后一帧内查询）。
  // 滚动归零是搜索定位正确性的前提——否则搜索命中一个短页面时，用户看到的是
  // 上一页遗留的滚动位置（表现为「点了结果却找不到那个设置」）。
  // rAF 生命周期与组件一致，卸载时统一取消。
  const headingFocusRaf = useRef<number | null>(null);
  useEffect(() => {
    if (pageHostRef.current) pageHostRef.current.scrollTop = 0;
  }, [activeSection]);

  useEffect(() => {
    if (!focusHeadingRef.current) return;
    focusHeadingRef.current = false;
    if (pageHostRef.current) pageHostRef.current.scrollTop = 0;
    headingFocusRaf.current = requestAnimationFrame(() => {
      headingFocusRaf.current = null;
      containerRef.current
        ?.querySelector<HTMLElement>(".settings-page-title")
        ?.focus({ preventScroll: true });
    });
    return () => {
      if (headingFocusRaf.current !== null) {
        cancelAnimationFrame(headingFocusRaf.current);
        headingFocusRaf.current = null;
      }
    };
  }, [activeSection, focusNonce]);

  /** 添加应用：进入 AppPicker 整页子视图（替换设置内容，返回后状态不丢）。 */
  const openAppPicker = useCallback(() => setAppPickerOpen(true), []);

  // 「查找设置」候选：分组标题 + 所属分类 + 注册表别名（中文连续子串 / 英文不区分大小写）。
  // 顺序 = 分类顺序 + 分类内页面顺序；命中后直达对应二级页面。
  const searchOptions = useMemo(
    () =>
      SETTINGS_SECTION_META.map((meta) => {
        const owner = settingsCategory(meta.category);
        return {
          value: meta.id,
          label: t(meta.labelKey),
          hint: owner ? t(owner.labelKey) : "",
        };
      }),
    [t],
  );

  if (!settings) return <div className="empty-hint">{t("settings.loading")}</div>;

  // 添加应用改为内容区子页面：替换设置内容，不叠覆盖式大 Modal；
  // 组件保持挂载，返回后各设置项状态不丢失。
  if (appPickerOpen) {
    return <AppPicker standalone variant="page" onClose={() => setAppPickerOpen(false)} />;
  }

  const activeMeta = settingsSectionMeta(activeSection);
  const activeCategory: SettingsCategoryId = activeMeta?.category ?? "general";
  const PageComponent =
    activeSection === "apps" ? (
      <AppsSettingsPage onRequestAdd={openAppPicker} />
    ) : (
      (() => {
        const Component = SETTINGS_PAGE_COMPONENTS[activeSection];
        return Component ? <Component /> : null;
      })()
    );

  const themeLabel =
    settings.theme === "dark"
      ? t("settings.appearance.theme.dark")
      : settings.theme === "light"
        ? t("settings.appearance.theme.light")
        : t("settings.appearance.theme.system");
  const presetLabel =
    resolveVisualPreset(settings.visual_preset) === "frosted"
      ? t("settings.preset.frosted.name")
      : t("settings.preset.dreamGradient.name");
  const materialLabel =
    settings.material === "solid"
      ? t("settings.appearance.material.solid")
      : t("settings.appearance.material.glass");

  return (
    <div ref={containerRef} className="settings-panel page-fill">
      {/* 页面级页头（2026-11-15 统一）；搜索入口收进页头动作区（2026-11-20）。 */}
      <WorkbenchPageHeader
        icon={SettingsIcon}
        title={t("nav.settings")}
        subtitle={t("settings.pageSubtitle")}
        actions={
          <Combobox
            ariaLabel={t("settings.jump.label")}
            size="sm"
            className="settings-search"
            value={null}
            placeholder={t("settings.jump.placeholder")}
            clearLabel={t("settings.jump.clear")}
            emptyText={t("settings.jump.empty")}
            options={searchOptions}
            // 只做搜索：不给下拉箭头、不用全量列表冒充下拉；分类浏览交给左侧导航。
            browse={false}
            // 命中范围：页面标题 + 所属分类 + 注册表别名（中文连续子串 / 英文不区分大小写）。
            filter={(option, query) => {
              const meta = settingsSectionMeta(option.value as SettingsSectionId);
              return matchesSettingsQuery(
                {
                  label: option.label,
                  categoryLabel: option.hint ?? "",
                  aliases: meta?.aliases,
                },
                query,
              );
            }}
            onChange={(sectionId) => navigateToSection(sectionId as SettingsSectionId)}
          />
        }
      />
      <div className="settings-body">
        <SettingsNavigation
          activeSection={activeSection}
          onSelectSection={selectSection}
          layoutMode={layoutMode}
        />
        <div className="settings-page-host page-scroll" ref={pageHostRef}>
          {/* 二级页面：只挂载当前页面，切页即卸载（数据读取随页面挂载走，
              草稿保护由页面卸载守卫承担；外壳层对整个设置页保活）。 */}
          {PageComponent}
        </div>
      </div>

      {/* 右栏当前配置摘要（对齐效果图 13）：只读展示当前生效的外观与布局，
          具体修改仍在中央页面，避免右栏再长出一套表单。 */}
      <WorkbenchPageDetail title={t("settings.currentConfig.title")}>
        <WorkbenchDetailFacts
          rows={[
            {
              label: t("settings.currentConfig.page"),
              value: activeMeta ? t(activeMeta.labelKey) : "",
            },
            {
              label: t("settings.currentConfig.category"),
              value: settingsCategory(activeCategory)
                ? t(settingsCategory(activeCategory)!.labelKey)
                : "",
            },
            {
              label: t("settings.currentConfig.theme"),
              value: themeLabel,
            },
            {
              label: t("settings.currentConfig.preset"),
              value: presetLabel,
            },
            {
              label: t("settings.currentConfig.material"),
              value: materialLabel,
            },
            {
              label: t("settings.currentConfig.layout"),
              value: t("settings.currentConfig.layoutValue", {
                nav: workbenchLayout.navWidth,
                detail: workbenchLayout.detailWidth,
                state: workbenchLayout.detailOpen
                  ? t("settings.currentConfig.open")
                  : t("settings.currentConfig.closed"),
              }),
            },
          ]}
        />
        <div className="setting-note">{t("settings.currentConfig.hint")}</div>
      </WorkbenchPageDetail>
    </div>
  );
}
