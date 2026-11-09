//! 设置页主分组折叠状态（仅本地 UI 偏好，不进业务配置、备份或 IPC）。
//!
//! 规则：
//! - 使用稳定分组 ID，绝不以中文标题持久化；
//! - 键名带版本号，结构为 `{ version: 1, sections: { [id]: boolean } }`；
//! - 首次无记录、数据损坏、版本不兼容或存储被拒时全部回退为折叠；
//! - 缺失的分组按折叠处理，允许同时展开多个分组。

export const SETTINGS_SECTIONS_STORAGE_KEY = "taskdock.settings.sections.v1";

export const SETTINGS_SECTION_IDS = [
  "appearance",
  "navigation",
  "window-hotkeys",
  "features",
  "apps",
  "clipboard",
  "notifications",
  "audio-sound",
  "tts",
  "tts-cache",
  "resource-cleanup",
  "help",
  "agent",
  "data",
  "diagnostics",
  "diagnostics-logs",
  "developer",
  "mobile-sync",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export type SettingsSectionOpenState = Record<SettingsSectionId, boolean>;

const STORAGE_VERSION = 1;

/** 全部折叠：首次进入与任何读取失败时的唯一安全默认。 */
export function collapsedSectionState(): SettingsSectionOpenState {
  return SETTINGS_SECTION_IDS.reduce((acc, id) => {
    acc[id] = false;
    return acc;
  }, {} as SettingsSectionOpenState);
}

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

/** 「自定义导航」跨模块定位：先持久化展开状态，再通知已挂载的设置页滚动定位。 */
export const SETTINGS_SECTION_REVEAL_KEY = "taskdock.settings.reveal.v1";
export const SETTINGS_SECTION_REVEAL_EVENT = "taskdock:settings-section-reveal";
export const SETTINGS_TTS_CACHE_REFRESH_EVENT = "taskdock:tts-cache-refresh";

/**
 * 请求展开并定位到某设置分区（幂等）。
 *
 * 用 sessionStorage 记录一次性意图，覆盖「设置页尚未挂载」的异步加载窗口；
 * 已挂载时由事件立即生效。写入失败不影响展开（只是不自动滚动）。
 */
export function requestSettingsSectionReveal(id: SettingsSectionId): void {
  const state = readSettingsSectionOpenState();
  state[id] = true;
  persistSettingsSectionOpenState(state);
  try {
    sessionStorage.setItem(SETTINGS_SECTION_REVEAL_KEY, id);
  } catch {
    // 存储被拒：仅失去自动滚动，展开状态已由 localStorage 持久化。
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SETTINGS_SECTION_REVEAL_EVENT, { detail: id }));
  }
}

/** 读取并清除一次性定位意图；缺失 / 损坏 / 未知 ID 返回 null。 */
export function consumeSettingsSectionReveal(): SettingsSectionId | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const value = sessionStorage.getItem(SETTINGS_SECTION_REVEAL_KEY);
    sessionStorage.removeItem(SETTINGS_SECTION_REVEAL_KEY);
    return value && isSettingsSectionId(value) ? value : null;
  } catch {
    return null;
  }
}

/** 读取展开状态；异常一律返回全部折叠，不向调用方抛出。 */
export function readSettingsSectionOpenState(): SettingsSectionOpenState {
  const state = collapsedSectionState();
  try {
    if (typeof localStorage === "undefined") return state;
    const raw = localStorage.getItem(SETTINGS_SECTIONS_STORAGE_KEY);
    if (!raw) return state;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== STORAGE_VERSION
    ) {
      return state;
    }
    const sections = (parsed as { sections?: unknown }).sections;
    if (typeof sections !== "object" || sections === null) return state;
    for (const [id, open] of Object.entries(sections)) {
      if (isSettingsSectionId(id) && typeof open === "boolean") state[id] = open;
    }
    return state;
  } catch {
    return state;
  }
}

/**
 * 立即持久化完整展开状态。写入失败（配额、权限、隐私模式）静默忽略：
 * 本次会话内的折叠交互仍然有效，下次启动回退为默认折叠。
 */
export function persistSettingsSectionOpenState(state: SettingsSectionOpenState): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      SETTINGS_SECTIONS_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, sections: state }),
    );
  } catch {
    // 存储不可用时不做降级写入，避免污染其他键或业务配置。
  }
}
