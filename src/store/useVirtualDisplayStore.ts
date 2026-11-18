//! 投屏启动配置（页面级状态的唯一事实源）。
//!
//! 背景：MobileTransferPanel 只挂载当前 pane，切换到「文件互传」会卸载
//! VirtualDisplaySection；此前模式/应用/多屏开关存在组件临时 state 里，切页即重置。
//! 这里把配置提升到 store，**页面卸载不清除**，只有用户显式修改或设备被移除时才变化。
//!
//! 以物理设备 UID 为键（而不是 sessionId）：配置发生在「启动投屏之前」，
//! 此时还没有 session；同一台手机换 transport / 重开窗口都必须恢复同一份配置。

import { create } from "zustand";

import type { VdMode } from "../lib/bridge";

export interface VirtualDisplayConfig {
  mode: VdMode;
  selectedPackage?: string;
  size?: string;
  multiDisplayEnabled: boolean;
  clipboardSync?: boolean;
}

interface VirtualDisplayState {
  configs: Record<string, VirtualDisplayConfig>;
  getVirtualDisplayConfig(deviceUid: string): VirtualDisplayConfig | undefined;
  setVirtualDisplayConfig(deviceUid: string, config: VirtualDisplayConfig): void;
  restoreVirtualDisplayConfig(deviceUid: string): VirtualDisplayConfig | undefined;
  clearVirtualDisplayConfig(deviceUid: string): void;
}

export const useVirtualDisplayStore = create<VirtualDisplayState>((set, get) => ({
  configs: {},
  getVirtualDisplayConfig: (deviceUid) => {
    if (!deviceUid) return undefined;
    return get().configs[deviceUid];
  },
  setVirtualDisplayConfig: (deviceUid, config) => {
    if (!deviceUid) return;
    set((state) => ({
      configs: { ...state.configs, [deviceUid]: { ...config } },
    }));
  },
  // 语义别名：页面重新挂载时只读恢复，不做任何清理。
  restoreVirtualDisplayConfig: (deviceUid) => {
    if (!deviceUid) return undefined;
    return get().configs[deviceUid];
  },
  clearVirtualDisplayConfig: (deviceUid) => {
    if (!deviceUid) return;
    set((state) => {
      if (!(deviceUid in state.configs)) return state;
      const next = { ...state.configs };
      delete next[deviceUid];
      return { configs: next };
    });
  },
}));
