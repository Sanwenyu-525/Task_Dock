//! 打开快速捕获窗口的统一入口。
//!
//! 快速捕获是独立窗口：已打开时后端只聚焦，不会重建或收起。胶囊内用
//! `onNotice`（footer 提示）而不是 Toast，避免浮层被 Win32 区域裁剪。

import { useCallback, useState } from "react";
import { quickCaptureShow } from "../lib/bridge";
import { errorMessage } from "../lib/errors";

export interface QuickRecordController {
  openQuickRecord: () => Promise<void>;
  opening: boolean;
}

export function useQuickRecord(
  onNotice: (message: string) => void,
): QuickRecordController {
  const [opening, setOpening] = useState(false);

  const openQuickRecord = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    try {
      const result = await quickCaptureShow();
      // 旧后端可能返回 undefined（无结果契约）：按成功处理，不误报。
      if (result && result.visible && !result.focused) {
        onNotice(
          result.focusError
            ? `快速捕获已打开，但系统未允许自动聚焦：${result.focusError}`
            : "快速捕获已打开，但系统未允许自动聚焦；请点击窗口继续",
        );
      } else if (result && !result.visible) {
        onNotice("快速捕获窗口未能显示，请稍后重试");
      }
    } catch (e) {
      onNotice(`无法打开快速捕获：${errorMessage(e)}`);
    } finally {
      setOpening(false);
    }
  }, [onNotice, opening]);

  return { openQuickRecord, opening };
}
