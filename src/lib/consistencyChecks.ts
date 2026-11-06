//! 关键状态一致性校验（轻量、事件驱动、只读）。
//!
//! 只靠异常捕获发现不了「配置与真实状态不一致」这类问题（例如布局里还留着一个
//! 已不存在的导航入口、配置损坏后静默回退默认值）。这里在**状态边界**做一次
//! 一次性校验：
//! - 不新增轮询、不注册长期监听（首次拿到设置后立即退订）；
//! - 不扫描全量数据、不改写用户数据（只记录诊断事件）；
//! - 校验逻辑复用已有纯函数（`normalizeNavigationLayout`），不复制业务规则；
//! - 正常收敛状态下不产生任何事件，避免假阳性刷屏。

import { logEvent } from "./diagnostics";
import { normalizeNavigationLayout } from "./navVisibility";
import { useSettingsStore } from "../store/useSettingsStore";

let installed = false;

/**
 * 导航布局一致性：存储的布局引用了注册中心已不存在的入口（孤儿项），
 * 或原始配置损坏只能回退默认值。两种情况都意味着「用户看到的入口清单
 * 与配置不一致」，是纯异常捕获发现不了的真实缺陷。
 */
export function checkNavigationLayout(rawLayout: unknown): void {
  try {
    const result = normalizeNavigationLayout(rawLayout);
    // 首次使用（无配置）也会走 default，这属于正常状态，不报告。
    if (rawLayout === null || rawLayout === undefined) return;
    if (result.source === "default") {
      logEvent({
        level: "WARN",
        module: "navigation",
        action: "layout_check",
        event: "invalid_fallback",
        status: "recovered",
        error_code: "CONFIG_ERROR",
        error_category: "config",
        message: "导航布局配置无法解析，已回退到默认可见性（用户自定义可能丢失）",
      });
      return;
    }
    if (result.migrated || result.dropped > 0) {
      logEvent({
        level: "WARN",
        module: "navigation",
        action: "layout_check",
        event: "orphan_entries",
        status: "recovered",
        error_code: "CONFIG_ERROR",
        error_category: "config",
        message: `导航布局含 ${result.dropped} 个无法识别的入口，已按注册中心对齐`,
        metadata: { count: result.dropped },
      });
    }
  } catch {
    // 校验自身失败不得影响启动。
  }
}

/**
 * 安装一次性一致性校验：设置首次加载完成后执行一次，然后立即退订。
 *
 * 幂等：重复调用（HMR / 多入口）不会重复注册。
 */
export function installStartupConsistencyChecks(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  let unsubscribe: (() => void) | null = null;
  const runOnce = () => {
    const state = useSettingsStore.getState();
    if (!state.settings) return false;
    try {
      checkNavigationLayout(state.settings.navigation_layout);
    } finally {
      unsubscribe?.();
      unsubscribe = null;
    }
    return true;
  };

  if (runOnce()) return;
  try {
    unsubscribe = useSettingsStore.subscribe(() => {
      runOnce();
    });
  } catch {
    // 订阅失败时放弃本次校验（不影响启动）。
  }
}
