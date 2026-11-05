//! 用户偏好（语言 / 桌面微件布局）的前端对账与镜像。
//!
//! 运行时权威来源仍是 localStorage（`taskdock.locale`、
//! `taskdock.widgets.layout.v1`）；本模块负责：
//! - 启动时读取数据目录镜像（`preferences.json`，经 bridge 命令），缺失的
//!   localStorage 用文件补齐，冲突时 localStorage 优先并回写文件；
//! - 恢复备份后（`apply_restore=true`）以文件为准覆盖 localStorage，并回执
//!   清除恢复标记，保证「恢复完重启」看到的仍是恢复后的配置；
//! - 变更时防抖镜像到后端（原子写），不产生重复监听或常驻轮询。
//!
//! 非 Tauri 环境（vitest / 浏览器预览）下所有后端调用直接跳过。

import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  getUserPreferences,
  setUserPreferences,
  type UserPreferencesView,
  type UserWidgetPreference,
} from "./bridge";
import { isLocalePreference, type LocalePreference } from "../i18n/messages";
import { normalizeLayout, type WidgetItem } from "./widgets/model";

export const LOCALE_STORAGE_KEY = "taskdock.locale";
export const WIDGETS_STORAGE_KEY = "taskdock.widgets.layout.v1";
export const WIDGETS_LAYOUT_VERSION = 1;
export const EVENT_USER_PREFERENCES_RESTORED = "user-preferences-restored";

/** 变更镜像防抖：连续拖动微件/切换语言只写一次文件。 */
const MIRROR_DELAY_MS = 300;

type LocaleAppliedListener = (preference: LocalePreference) => void;
type WidgetsAppliedListener = () => void;

const localeListeners = new Set<LocaleAppliedListener>();
const widgetsListeners = new Set<WidgetsAppliedListener>();

/** 注册「后端恢复的语言已写入 localStorage」回调；返回解绑函数。 */
export function onLocalePreferenceApplied(
  listener: LocaleAppliedListener,
): () => void {
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

/** 注册「微件布局已被替换」回调；返回解绑函数。 */
export function onWidgetsLayoutApplied(listener: WidgetsAppliedListener): () => void {
  widgetsListeners.add(listener);
  return () => widgetsListeners.delete(listener);
}

function notifyLocale(preference: LocalePreference): void {
  for (const listener of [...localeListeners]) {
    try {
      listener(preference);
    } catch {
      // 单个订阅方异常不影响其他窗口/模块。
    }
  }
}

function notifyWidgets(): void {
  for (const listener of [...widgetsListeners]) {
    try {
      listener();
    } catch {
      // 同上。
    }
  }
}

function storageAvailable(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 读取本机语言偏好；缺失或非法返回 null（非法值不参与「冲突优先」）。 */
export function readLocalLocalePreference(): LocalePreference | null {
  const storage = storageAvailable();
  if (!storage) return null;
  try {
    const raw = storage.getItem(LOCALE_STORAGE_KEY);
    return isLocalePreference(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeLocalLocalePreference(preference: LocalePreference): void {
  const storage = storageAvailable();
  if (!storage) return;
  try {
    storage.setItem(LOCALE_STORAGE_KEY, preference);
  } catch {
    // 存储不可用（隐私模式/配额满）时仅保留内存态；镜像仍会尝试写文件。
  }
}

/**
 * 读取本机微件布局并按模型归一化。
 * 缺失、损坏或版本不符返回 null，让文件镜像有机会补齐。
 */
export function readLocalWidgetsLayout(): WidgetItem[] | null {
  const storage = storageAvailable();
  if (!storage) return null;
  try {
    const raw = storage.getItem(WIDGETS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      (parsed as { version?: unknown }).version !== WIDGETS_LAYOUT_VERSION
    ) {
      return null;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "widgets" in parsed
    ) {
      return normalizeLayout((parsed as { widgets: unknown }).widgets);
    }
    return normalizeLayout(parsed);
  } catch {
    return null;
  }
}

export function writeLocalWidgetsLayout(widgets: WidgetItem[]): void {
  const storage = storageAvailable();
  if (!storage) return;
  try {
    storage.setItem(
      WIDGETS_STORAGE_KEY,
      JSON.stringify({ version: WIDGETS_LAYOUT_VERSION, widgets }),
    );
  } catch {
    // 同上：不影响当前交互。
  }
}

function layoutsEqual(
  left: WidgetItem[] | null,
  right: WidgetItem[] | null,
): boolean {
  if (left === null || right === null) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function serverWidgets(view: UserPreferencesView): WidgetItem[] | null {
  if (!view.widgets || !Array.isArray(view.widgets)) return null;
  return normalizeLayout(view.widgets as UserWidgetPreference[]);
}

function serverLocale(view: UserPreferencesView): LocalePreference | null {
  return isLocalePreference(view.locale) ? view.locale : null;
}

let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorInFlight: Promise<void> | null = null;
let mirrorDirty = false;

/** 把当前 localStorage 状态镜像到数据目录（原子写）。 */
export async function mirrorPreferencesNow(): Promise<void> {
  if (!isTauri()) return;
  if (mirrorInFlight) {
    // 写入期间又有变更：结束后再补写一次，避免丢失最后一次状态。
    mirrorDirty = true;
    return mirrorInFlight;
  }
  mirrorInFlight = (async () => {
    try {
      do {
        mirrorDirty = false;
        const locale = readLocalLocalePreference();
        const widgets = readLocalWidgetsLayout();
        await setUserPreferences(locale, widgets, null);
      } while (mirrorDirty);
    } catch {
      // 镜像失败不影响运行时；下一次变更或恢复会重试。
    } finally {
      mirrorInFlight = null;
      mirrorDirty = false;
    }
  })();
  return mirrorInFlight;
}

/** 取消尚未触发的防抖镜像（恢复应用期间避免旧值回写）。 */
function cancelPendingMirror(): void {
  if (mirrorTimer !== null) {
    clearTimeout(mirrorTimer);
    mirrorTimer = null;
  }
}

/** 变更后的防抖镜像：同一窗口只保留一个定时器与一次在途写入。 */
export function schedulePreferencesMirror(delay = MIRROR_DELAY_MS): void {
  if (!isTauri()) return;
  if (mirrorTimer !== null) {
    clearTimeout(mirrorTimer);
  }
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    void mirrorPreferencesNow();
  }, delay);
}

let syncInFlight: Promise<void> | null = null;

/**
 * 从后端读取偏好镜像并与 localStorage 对账（导出供启动/恢复事件/测试调用）。
 * 冲突规则：正常启动 localStorage 优先并回写文件；`apply_restore=true` 时
 * 文件优先（刚恢复的配置覆盖本机旧值），随后回执清除恢复标记。
 */
export function syncUserPreferences(force = false): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (syncInFlight) {
    // 恢复事件可能与启动对账并发：强制在一次在途同步结束后再读一次，
    // 避免事件到达时 get 已经返回「无恢复标记」而错过新配置。
    return force ? syncInFlight.then(() => syncUserPreferences(false)) : syncInFlight;
  }
  syncInFlight = (async () => {
    let view: UserPreferencesView;
    try {
      view = await getUserPreferences();
    } catch {
      return;
    }
    const remoteLocale = serverLocale(view);
    const remoteWidgets = serverWidgets(view);

    if (view.apply_restore) {
      // 恢复值优先：取消用户此前变更留下的防抖镜像，避免旧值稍后覆盖文件。
      cancelPendingMirror();
      if (remoteLocale !== null) {
        writeLocalLocalePreference(remoteLocale);
        notifyLocale(remoteLocale);
      }
      if (remoteWidgets !== null) {
        if (!layoutsEqual(readLocalWidgetsLayout(), remoteWidgets)) {
          writeLocalWidgetsLayout(remoteWidgets);
        }
        // 即使存储内容相同也通知一次：已挂载的 Store 可能仍是旧布局。
        notifyWidgets();
      }
      // 回执后清除 pending 标记；即使失败，下次启动仍会以文件为准重试。
      try {
        await setUserPreferences(
          readLocalLocalePreference(),
          readLocalWidgetsLayout(),
          view.restore_id,
        );
      } catch {
        // 忽略：标记保留，下次启动重试。
      }
      return;
    }

    // 正常启动：只补齐缺失项，已有 localStorage 值优先。
    if (readLocalLocalePreference() === null && remoteLocale !== null) {
      writeLocalLocalePreference(remoteLocale);
      notifyLocale(remoteLocale);
    }
    if (readLocalWidgetsLayout() === null && remoteWidgets !== null) {
      writeLocalWidgetsLayout(remoteWidgets);
      notifyWidgets();
    }
    // localStorage 为准并回写文件；写失败不影响启动。
    try {
      await setUserPreferences(
        readLocalLocalePreference(),
        readLocalWidgetsLayout(),
        null,
      );
    } catch {
      // 忽略。
    }
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

let initialized = false;

/**
 * 每个窗口启动调用一次（`initLocale` 内）：执行一次对账，并监听后端
 * 「恢复完成」事件立即重新应用。返回解绑函数（仅测试/热重载需要）。
 * 非 Tauri 环境直接返回空解绑函数，不产生监听或 IPC。
 */
export function initUserPreferences(): () => void {
  if (!isTauri() || initialized) return () => {};
  initialized = true;
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  void listen(EVENT_USER_PREFERENCES_RESTORED, () => {
    void syncUserPreferences(true);
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {
      // 事件 API 不可用时仍保留启动对账。
    });
  void syncUserPreferences();
  return () => {
    disposed = true;
    initialized = false;
    unlisten?.();
    unlisten = null;
  };
}

/** 仅供测试：清空镜像定时器、在途状态与订阅者。 */
export function __resetUserPreferencesForTests(): void {
  if (mirrorTimer !== null) {
    clearTimeout(mirrorTimer);
    mirrorTimer = null;
  }
  mirrorInFlight = null;
  mirrorDirty = false;
  syncInFlight = null;
  initialized = false;
  localeListeners.clear();
  widgetsListeners.clear();
}
