// 语音速记的原生模块封装（Android）。
//
// 可用性：模块缺失（未 prebuild、iOS、单测环境）时导出 null，采集页按「不可用」降级，
// 不允许在 JS 侧假装录音成功。
import { NativeModule, requireOptionalNativeModule } from "expo-modules-core";

export interface VoiceRecordingState {
  recording: boolean;
  path: string | null;
  playing: boolean;
}

export interface StartedRecording {
  /** 应用私有目录内的绝对路径（Kotlin 生成，JS 不能指定任意路径） */
  path: string;
  startedAt: number;
}

export interface StoppedRecording {
  path: string;
  durationMs: number;
  size: number;
}

declare class VoiceRecorderNativeModule extends NativeModule {
  startRecording(fileName?: string | null): StartedRecording;
  stopRecording(): StoppedRecording;
  cancelRecording(): void;
  getState(): VoiceRecordingState;
  play(path: string): void;
  stopPlayback(): void;
  deleteFile(path: string): void;
}

const native = requireOptionalNativeModule<VoiceRecorderNativeModule>("VoiceRecorder");

export const voiceRecorderAvailable = native != null;

export default native;
