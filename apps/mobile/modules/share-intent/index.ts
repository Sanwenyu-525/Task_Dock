// 系统分享接收（Android ACTION_SEND text/plain）的 JS 侧封装。
// 载荷只经内存流转：冷启动 takePendingShare() 拉取 + 已运行 onShareReceived 事件，
// 两条通道读写原生同一个待处理槽，订阅方按 offerId 去重（见 src/lib/pendingShare.ts）。
import { NativeModule, requireOptionalNativeModule } from "expo-modules-core";

export interface ShareIntentPayload {
  /** 单调递增序号：同一载荷可能经事件与拉取双通道到达，按 id 去重 */
  offerId: number;
  /** 已按 4000 码点截断后的文本（截断策略与收集箱上限一致） */
  text: string;
  /** true = 原文超长被截断 */
  truncated: boolean;
  /** 截断前的原文长度（Unicode 码点） */
  originalLength: number;
  receivedAt: number;
}

type ShareIntentEvents = {
  onShareReceived: (payload: ShareIntentPayload) => void;
};

declare class ShareIntentNativeModule extends NativeModule<ShareIntentEvents> {
  /** 取走待处理分享（取走即清空）；冷启动时首次调用会解析启动 Intent。 */
  takePendingShare(): ShareIntentPayload | null;
  /** 清空待处理分享（用户取消/返回时调用，不残留旧载荷）。 */
  clearPendingShare(): void;
}

const native = requireOptionalNativeModule<ShareIntentNativeModule>("ShareIntent");

export const shareIntentAvailable = native != null;

export default native as ShareIntentNativeModule | null;
