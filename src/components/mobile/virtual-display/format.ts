//! 投屏面板共用格式化与状态映射。
//!
//! 只放纯函数：不读全局状态、不调用 IPC，便于前端单测与 UI 层复用。

import type { VdDevice, VdSession, VdSessionStatus } from "../../../lib/bridge";
import type { MessageKey } from "../../../i18n/messages";
import type { StatusTone } from "../../ui";

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** 从 `adb version` / `scrcpy --version` 首行提取版本号，避免长行截断。 */
export function shortVersion(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/\d+(?:\.\d+)+/);
  return match ? match[0] : raw;
}

export function formatDuration(startedAt: string, now: number): string | null {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || now < start) return null;
  const total = Math.floor((now - start) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function deviceStateKey(state: string): MessageKey {
  if (state === "device") return "virtualDisplay.state.device";
  if (state === "unauthorized") return "virtualDisplay.state.unauthorized";
  if (state === "offline") return "virtualDisplay.state.offline";
  if (state === "authorizing") return "virtualDisplay.state.authorizing";
  if (state === "connecting") return "virtualDisplay.state.connecting";
  return "virtualDisplay.state.unknown";
}

export function deviceTone(state: string): StatusTone {
  if (state === "device") return "success";
  if (state === "unauthorized" || state === "offline") return "danger";
  if (state === "authorizing" || state === "connecting") return "warning";
  return "neutral";
}

export function sessionStatusTone(status: VdSessionStatus): StatusTone {
  switch (status) {
    case "running":
      return "success";
    case "starting":
    case "stopping":
      return "warning";
    case "error":
    case "disconnected":
      return "danger";
    default:
      return "neutral";
  }
}

export function sessionStatusKey(status: VdSessionStatus): MessageKey {
  return `virtualDisplay.session.${status}`;
}

export function stageKey(stage: string): MessageKey | null {
  if (stage === "process") return "virtualDisplay.session.stage.process";
  if (stage === "display") return "virtualDisplay.session.stage.display";
  if (stage === "app") return "virtualDisplay.session.stage.app";
  if (stage === "video") return "virtualDisplay.session.stage.video";
  if (stage === "ready") return "virtualDisplay.session.stage.ready";
  return null;
}

export function connectionLabelKey(connection: VdDevice["connection"]): MessageKey {
  if (connection === "usb") return "virtualDisplay.connection.usb";
  if (connection === "wifi") return "virtualDisplay.connection.wifi";
  if (connection === "mdns") return "virtualDisplay.connection.mdns";
  return "virtualDisplay.connection.other";
}

export function isActiveSession(session: VdSession): boolean {
  return (
    session.status === "starting" ||
    session.status === "running" ||
    session.status === "stopping"
  );
}

/** 会话卡片标题：设备名 · 手机屏幕 / 设备名 · 应用名；绝不使用 UUID、PID 或完整包名。 */
export function sessionTitle(session: VdSession, deviceLabel: string, t: Translate): string {
  const device = session.device_model?.trim() || deviceLabel;
  if (session.mode === "mirror") {
    return t("virtualDisplay.sessions.sessionName.mirror", { device });
  }
  // 没有解析到应用名时用模式兜底，绝不把完整包名当标题。
  const app = session.app_label?.trim();
  if (!app) return t("virtualDisplay.sessions.sessionName.virtualFallback", { device });
  return t("virtualDisplay.sessions.sessionName.virtual", { device, app });
}

/** 当前设备的可读名称：型号优先，缺失时用中性名称，不暴露完整序列号/IP。 */
export function deviceLabel(device: VdDevice | null, t: Translate): string {
  if (!device) return t("virtualDisplay.noDevice");
  return device.model?.trim() || t("virtualDisplay.device.unnamed");
}

/** 会话标题使用的设备名：会话记录里的型号 → 当前选择设备 → 通用 Android。 */
export function sessionDeviceLabel(session: VdSession, fallback: VdDevice | null, _t?: Translate): string {
  return session.device_model?.trim() || fallback?.model?.trim() || "Android";
}

/** 启动阶段文案：把后端可核验的 stage 映射为普通用户能理解的进度。 */
export function launchStageKey(stage: string): MessageKey {
  if (stage === "display") return "virtualDisplay.start.creatingDisplay";
  if (stage === "app") return "virtualDisplay.start.startingApp";
  if (stage === "video") return "virtualDisplay.start.waitingVideo";
  if (stage === "ready") return "virtualDisplay.start.ready";
  return "virtualDisplay.start.connecting";
}

/** 包名校验与后端 `is_package_name` 保持一致：字母数字、点、下划线，不以短横线开头。 */
export function isValidPackageName(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 255 &&
    !trimmed.startsWith("-") &&
    /^[A-Za-z0-9._]+$/.test(trimmed)
  );
}
