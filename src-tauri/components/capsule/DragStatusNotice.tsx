//! 结构化拖入状态行（胶囊「文件」子页）。
//!
//! 与轻提示（`flash` 的 3.2s 单行文本）分工：
//! - 读取中 / 成功 / 部分成功 / 失败 / 不支持各有独立语义与图标；
//! - 失败与部分成功**不自动消失**，由用户关闭或下一条状态替换；
//! - 诊断码用等宽小字单独展示，详情默认折叠（`aria-expanded`），
//!   绝不把后端原始结构错误/路径/正文塞进一句话；
//! - 状态行始终在文档流内，不覆盖列表/卡片，也不参与任何落点命中。

import { useId, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Info,
  Loader2,
  X,
} from "lucide-react";
import { useLocale } from "../../hooks/useLocale";

export type DragStatusTone = "busy" | "success" | "warn" | "error" | "info";

export interface DragStatusNoticeProps {
  tone: DragStatusTone;
  /** 一句短标题：失败时说明发生了什么，成功时说明结果。 */
  title: string;
  /** 可选详情：默认折叠，点击「详情」展开。 */
  detail?: string;
  /** 稳定诊断码（DRAG_*），只做等宽小字展示，不替代标题。 */
  code?: string;
  /** 有会话 id 才给「查看诊断」入口；没有就不渲染假入口。 */
  operationId?: string;
  onDiagnostics?: (operationId: string) => void;
  onDismiss: () => void;
}

const TONE_ICON = {
  busy: Loader2,
  success: Check,
  warn: AlertTriangle,
  error: AlertTriangle,
  info: Info,
} as const;

export default function DragStatusNotice({
  tone,
  title,
  detail,
  code,
  operationId,
  onDiagnostics,
  onDismiss,
}: DragStatusNoticeProps) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const Icon = TONE_ICON[tone];
  const canExpand = Boolean(detail);

  return (
    <div
      className={`cap-drop-notice is-${tone}`}
      role={tone === "error" ? "alert" : "status"}
      data-drag-notice={tone}
    >
      <span className="cap-drop-notice-icon" aria-hidden="true">
        <Icon
          size={14}
          strokeWidth={2.2}
          className={tone === "busy" ? "spin" : undefined}
        />
      </span>
      <div className="cap-drop-notice-body">
        <div className="cap-drop-notice-line">
          <span className="cap-drop-notice-title">{title}</span>
          <button
            type="button"
            className="cap-mini is-icon cap-drop-notice-close"
            aria-label={t("common.close")}
            data-tip={t("common.close")}
            onClick={onDismiss}
          >
            <X size={11} strokeWidth={2.4} aria-hidden="true" />
          </button>
        </div>
        {(code || canExpand || (operationId && onDiagnostics)) && (
          <div className="cap-drop-notice-meta">
            {code && <code className="cap-drop-notice-code">{code}</code>}
            {canExpand && (
              <button
                type="button"
                className="cap-drop-notice-toggle"
                aria-expanded={expanded}
                aria-controls={expanded ? detailId : undefined}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded
                  ? t("capsule.inboxDrop.noticeHideDetails")
                  : t("capsule.inboxDrop.noticeDetails")}
                <ChevronDown
                  size={11}
                  strokeWidth={2.2}
                  aria-hidden="true"
                  className={expanded ? "is-open" : undefined}
                />
              </button>
            )}
            {operationId && onDiagnostics && (
              <button
                type="button"
                className="cap-link"
                onClick={() => onDiagnostics(operationId)}
              >
                {t("capsule.inboxDrop.viewDiagnostics")}
              </button>
            )}
          </div>
        )}
        {canExpand && expanded && (
          <p className="cap-drop-notice-detail" id={detailId}>
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
