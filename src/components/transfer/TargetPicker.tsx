//! 目标目录选择器：选择 / 校验 / 明确不可用原因。
//!
//! 校验走真实后端 `transfer_validate_target`（目录存在且可写、未被数据目录保护），
//! 没有目标或目标失效时不允许进入发送预览。

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Folder, FolderSearch, Loader2, TriangleAlert } from "lucide-react";
import { pickFolder } from "../../lib/filesWorkspace/folderPicker";
import { errorMessage } from "../../lib/errors";
import { validateTarget } from "../../lib/crossTab/transferClient";
import { useLocale } from "../../hooks/useLocale";
import type { Notify } from "./ActionDispatcher";

export interface TargetPickerProps {
  value: string;
  onChange: (path: string) => void;
  onNotify: Notify;
  onValidityChange?: (valid: boolean, message: string) => void;
  disabled?: boolean;
}

interface ValidationState {
  checking: boolean;
  valid: boolean;
  message: string;
}

export default function TargetPicker({
  value,
  onChange,
  onNotify,
  onValidityChange,
  disabled,
}: TargetPickerProps) {
  const { t } = useLocale();
  const [state, setState] = useState<ValidationState>({ checking: false, valid: false, message: "" });
  const seq = useRef(0);

  useEffect(() => {
    const request = ++seq.current;
    if (!value.trim()) {
      setState({ checking: false, valid: false, message: t("transfer.targetNone") });
      onValidityChange?.(false, "");
      return;
    }
    setState((prev) => ({ ...prev, checking: true }));
    const timer = window.setTimeout(() => {
      void validateTarget({ module: "files", ref: value })
        .then((result) => {
          if (request !== seq.current) return;
          const next = { checking: false, valid: result.valid, message: result.message };
          setState(next);
          onValidityChange?.(result.valid, result.message);
        })
        .catch((error) => {
          if (request !== seq.current) return;
          const message = errorMessage(error);
          setState({ checking: false, valid: false, message });
          onValidityChange?.(false, message);
        });
    }, 200);
    return () => window.clearTimeout(timer);
    // onValidityChange 由调用方保证稳定（useCallback）；这里只在目标变化时重新校验。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  async function choose() {
    const result = await pickFolder({ title: t("transfer.chooseTarget") });
    if (result.status === "ok") {
      onChange(result.path);
      return;
    }
    if (result.status === "invalid") {
      onNotify(`${t("transfer.targetInvalid")} ${result.message ?? result.reason}`, "error");
    }
  }

  return (
    <div className="tp-target">
      <span className="tp-target-label">{t("transfer.target")}</span>
      <div className="tp-target-row">
        <button
          type="button"
          className={`tp-target-value${value ? "" : " is-empty"}`}
          data-tip={value || t("transfer.targetNone")}
          disabled={disabled}
          onClick={() => void choose()}
        >
          <Folder size={12} aria-hidden="true" />
          <span className="tp-ellipsis">{value || t("transfer.targetNone")}</span>
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={t("transfer.chooseTarget")}
          data-tip={t("transfer.chooseTarget")}
          disabled={disabled}
          onClick={() => void choose()}
        >
          <FolderSearch size={13} />
        </button>
      </div>
      {value && (
        <span
          className={`tp-target-state${state.valid ? " is-ok" : state.checking ? "" : " is-bad"}`}
          aria-live="polite"
        >
          {state.checking ? (
            <>
              <Loader2 size={11} className="tp-spin" aria-hidden="true" /> {t("common.loading")}
            </>
          ) : state.valid ? (
            <>
              <CheckCircle2 size={11} aria-hidden="true" /> {t("transfer.targetReady")}
            </>
          ) : (
            <>
              <TriangleAlert size={11} aria-hidden="true" /> {state.message || t("transfer.targetInvalid")}
            </>
          )}
        </span>
      )}
    </div>
  );
}
