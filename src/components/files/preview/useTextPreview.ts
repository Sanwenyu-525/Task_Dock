//! 文本读取的单一入口（供文本与 Markdown 预览共用）。
//!
//! 只做「读一次 + 取消 + 重试」：模式切换、搜索、换行都不重新读盘；
//! 读取失败保留错误与重试入口，绝不返回空白页。

import { useCallback, useEffect, useState } from "react";
import { fsReadText, type FsTextPreview } from "../../../lib/bridge";
import { errorMessage } from "../../../lib/errors";
import { TEXT_PREVIEW_BYTES } from "./previewKind";

export interface TextPreviewState {
  preview: FsTextPreview | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

export function useTextPreview(path: string): TextPreviewState {
  const [preview, setPreview] = useState<FsTextPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);
    fsReadText(path, TEXT_PREVIEW_BYTES)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setLoading(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(errorMessage(cause));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { preview, loading, error, retry };
}
