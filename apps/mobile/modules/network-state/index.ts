// 网络计费状态的原生模块封装（Android）。
//
// 只读 ConnectivityManager 的当前网络能力，不注册常驻监听：
// 自动同步在每次触发前现查一次即可，避免后台回调与生命周期管理。
// 模块缺失或能力不可判定时返回 metered=null，调用方 fail-closed。
import { NativeModule, requireOptionalNativeModule } from "expo-modules-core";

export type NetworkType = "wifi" | "cellular" | "ethernet" | "vpn" | "none" | "unknown";

export interface NetworkStateSnapshot {
  /** true=计费网络；false=非计费；null=无法判定（调用方按计费处理） */
  metered: boolean | null;
  type: NetworkType;
}

declare class NetworkStateNativeModule extends NativeModule {
  getNetworkState(): NetworkStateSnapshot;
}

const native = requireOptionalNativeModule<NetworkStateNativeModule>("NetworkState");

export const networkStateAvailable = native != null;

export default native;
