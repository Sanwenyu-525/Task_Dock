//! 上下文帮助按钮（可复用基元）：? 图标 + 轻量 Popover。
//!
//! 用法（第二轮将逐面板接入，见 docs/help/README.md）：
//!   <ContextHelpButton articleId="help.quickstart.capture" />
//!
//! 行为约定：
//! - 文章 ID 未注册时不渲染（避免死按钮），由契约测试保证 ID 有效；
//! - 弹层接入 overlayStack（layer=menu）：一次 Escape 只关本层，
//!   不遮挡面板操作按钮（小尺寸锚定弹层，非模态）；
//! - 显示摘要 + 状态徽标 + 「查看完整教程」：点击后 setTab("help") 并携带
//!   一次性意图（useUiStore.requestHelpArticle），由 HelpCenterPanel 消费打开文章。

import { useRef, useState } from "react";
import { HelpCircle } from "lucide-react";
import type { Placement } from "@floating-ui/react";
import { Popover, StatusBadge } from "../ui";
import { useLocale } from "../../hooks/useLocale";
import { getHelpArticle, hasNativeTranslation, helpContent } from "../../help/registry";
import { HELP_STATUS_META } from "../../help/statusMeta";
import { useUiStore } from "../../store/useUiStore";
import "./help-center.css";

export interface ContextHelpButtonProps {
  /** 已注册的教程 ID（help.<category>.<slug>） */
  articleId: string;
  /** 弹层方向；默认 bottom-end（面板标题行右侧使用居多） */
  placement?: Placement;
  /** 附加类名（调整外边距等） */
  className?: string;
}

export default function ContextHelpButton({
  articleId,
  placement = "bottom-end",
  className,
}: ContextHelpButtonProps) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const article = getHelpArticle(articleId);

  // 未注册 ID：不渲染，避免「点了没反应」的死按钮
  if (!article) return null;

  const content = helpContent(article, locale);
  const statusMeta = HELP_STATUS_META[article.status];
  const resolvedArticleId = article.id;
  const aria = t("help.context.buttonAria", { title: content.title });

  function openFullGuide() {
    setOpen(false);
    const ui = useUiStore.getState();
    const returnTab = ui.tab;
    ui.setTab("help", {
      after: () => {
        ui.setHelpReturnTab(returnTab);
        ui.requestHelpArticle(resolvedArticleId);
      },
    });
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`icon-btn sm help-context-btn${className ? ` ${className}` : ""}`}
        aria-label={aria}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip={aria}
        onClick={() => setOpen((v) => !v)}
      >
        <HelpCircle size={13} strokeWidth={1.9} aria-hidden="true" />
      </button>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement={placement}
        layer="menu"
        role="dialog"
        ariaLabel={aria}
        className="help-context-pop"
      >
        <p className="help-context-title">{content.title}</p>
        <p className="help-context-summary">{content.summary}</p>
        <div className="help-badges">
          <StatusBadge tone={statusMeta.tone} size="sm">
            {t(statusMeta.labelKey)}
          </StatusBadge>
          {locale === "en-US" && !hasNativeTranslation(article, locale) && (
            <StatusBadge tone="neutral" size="sm">
              {t("help.translationMissing")}
            </StatusBadge>
          )}
        </div>
        <div className="help-context-actions">
          <button type="button" className="btn sm" onClick={openFullGuide}>
            {t("help.context.viewFull")}
          </button>
        </div>
      </Popover>
    </>
  );
}
