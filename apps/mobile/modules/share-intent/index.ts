// 系统分享接收（Android）的 JS 侧封装：文本 + 图片 + 音频 + 文件 + 多选。
// 载荷只经内存流转：冷启动 takePendingShare() 拉取 + 已运行 onShareReceived 事件，
// 两条通道读写原生同一个待处理槽，订阅方按 offerId 去重（见 src/lib/pendingShare.ts）。
//
// 原生侧已经把文件字节复制进应用私有目录（content:// 授权不可依赖），因此 items[].path
// 是可以长期使用的绝对路径；用户放弃保存时必须由 JS 删除这些文件（见 pendingShare.discard）。
import { NativeModule, requireOptionalNativeModule } from "expo-modules-core";

export type ShareItemKind = "image" | "audio" | "file";

export interface ShareIntentItem {
  kind: ShareItemKind;
  mime: string;
  /** 展示名（外部应用提供，已清洗；不用于路径拼接） */
  name: string;
  size: number;
  /** 应用私有目录内的绝对路径（file://） */
  path: string;
}

export interface ShareIntentRejection {
  name: string;
  reason: string;
}

export interface ShareIntentPayload {
  /** 单调递增序号：同一载荷可能经事件与拉取双通道到达，按 id 去重 */
  offerId: number;
  /** 文本（纯图片分享时为 null） */
  text: string | null;
  /** true = 原文超长被截断 */
  truncated: boolean;
  /** 截断前的原文长度（Unicode 码点） */
  originalLength: number;
  receivedAt: number;
  /** 已复制到私有存储的附件（最多 9 项） */
  items: ShareIntentItem[];
  /** 被拒收的分享项（超限/无权限/空内容），UI 需要明确告知用户 */
  rejected: ShareIntentRejection[];
}

type ShareIntentEvents = {
  onShareReceived: (payload: ShareIntentPayload) => void;
};

declare class ShareIntentNativeModule extends NativeModule<ShareIntentEvents> {
  /** 取走待处理分享（取走即清空）；冷启动时首次调用会解析启动 Intent。 */
  takePendingShare(): ShareIntentPayload | null;
  /** 清空待处理分享引用（不删已复制文件，文件所有权已交给 JS）。 */
  clearPendingShare(): void;
  /** 主动分享文本（开发者工具用，用户点一次才调用）。 */
  shareTextAsync(text: string, subject: string): Promise<boolean>;
  /** 主动分享应用私有目录内的文件（FileProvider → content://）。 */
  shareFileAsync(fileUri: string, mime: string, subject: string): Promise<boolean>;
}

const native = requireOptionalNativeModule<ShareIntentNativeModule>("ShareIntent");

export const shareIntentAvailable = native != null;

export default native as ShareIntentNativeModule | null;
