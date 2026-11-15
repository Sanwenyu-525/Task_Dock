// 网络类型探测（JS 侧）：只暴露「是否计费网络」，不监听常驻网络变化。
//
// Android 端由本地模块 modules/network-state 读取 ConnectivityManager /
// NetworkCapabilities.NET_CAPABILITY_NOT_METERED；模块缺失（iOS 构建、测试环境）
// 时返回 unknown，调用方按 fail-closed 处理（自动同步不启动）。
import NetworkStateModule from "../../../modules/network-state";

export type NetworkMetering = "unmetered" | "metered" | "unknown";

/** 当前网络是否计费。判定不可用一律 unknown，绝不默认「不计费」。 */
export function probeNetworkMetering(): NetworkMetering {
  if (!NetworkStateModule) return "unknown";
  try {
    const state = NetworkStateModule.getNetworkState();
    if (typeof state?.metered !== "boolean") return "unknown";
    return state.metered ? "metered" : "unmetered";
  } catch {
    return "unknown";
  }
}
