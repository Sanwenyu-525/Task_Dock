//! 文章正文渲染：结构化 section → 纯 React（无 markdown 解析器）。
//! 元信息（状态徽标 / 翻译状态 / 适用版本）与「复制操作步骤」也在这里，
//! 列表视图与 ContextHelpButton 只取 summary，不渲染本组件。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale } from "../../hooks/useLocale";
import type { HelpArticle, HelpLocale, HelpSection } from "../../help/types";
import { articleStepsText, hasNativeTranslation } from "../../help/registry";
import { HELP_STATUS_META } from "../../help/statusMeta";
import { StatusBadge } from "../ui";

function renderSection(
  section: HelpSection,
  labels: { tip: string; note: string; callout: string },
  key: number,
): ReactNode {
  switch (section.type) {
    case "heading":
      return (
        <h3 key={key} className="help-h">
          {section.text}
        </h3>
      );
    case "paragraph":
      return (
        <p key={key} className="help-p">
          {section.text}
        </p>
      );
    case "steps":
      return (
        <ol key={key} className="help-steps">
          {section.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      );
    case "tip":
      return (
        <p key={key} className="help-tip">
          <strong className="help-tip-label">{labels.tip}</strong>
          {section.text}
        </p>
      );
    case "note":
      return (
        <p key={key} className="help-note">
          <strong className="help-note-label">{labels.note}</strong>
          {section.text}
        </p>
      );
    case "callout":
      return (
        <p key={key} className="help-callout">
          <strong className="help-callout-label">{labels.callout}</strong>
          {section.text}
        </p>
      );
  }
}

export interface HelpArticleBodyProps {
  article: HelpArticle;
  /** 渲染语言；文章缺该语言时回退 zh-CN 并显示「暂无英文版」徽标 */
  locale: HelpLocale;
}

export default function HelpArticleBody({ article, locale }: HelpArticleBodyProps) {
  const { t } = useLocale();
  // zh 展示：当前语言缺失时回退 zh-CN（UI 明示，不伪称国际化完成）
  const content = article.translations[locale] ?? article.translations["zh-CN"];
  const statusMeta = HELP_STATUS_META[article.status];
  const showTranslationBadge = !hasNativeTranslation(article, locale);

  // 「已复制」只在下一次复制或切换文章时复位（不设常驻定时器）；
  // 超时/卸载路径由本 effect 的清理兜底，避免遗留计时器。
  const [copied, setCopied] = useState<null | "ok" | "failed">(null);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => {
    setCopied(null);
    return () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
        copyTimer.current = null;
      }
    };
  }, [article.id]);

  const stepsText = articleStepsText(article, locale);

  async function copySteps() {
    if (!stepsText) return;
    try {
      await navigator.clipboard.writeText(stepsText);
      setCopied("ok");
    } catch {
      // 剪贴板权限被拒 / 环境不支持：如实提示，不伪装成功
      setCopied("failed");
    }
    // 复制结果提示 3 秒后自动复位（可取消，卸载/切文即清理）
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      copyTimer.current = null;
      setCopied(null);
    }, 3000);
  }

  return (
    <div className="help-article">
      <div className="help-badges">
        <StatusBadge
          tone={statusMeta.tone}
          size="sm"
          dataTip={t("help.articleStatusAria", { status: t(statusMeta.labelKey) })}
        >
          {t(statusMeta.labelKey)}
        </StatusBadge>
        {showTranslationBadge && (
          <StatusBadge tone="neutral" size="sm">
            {t("help.translationMissing")}
          </StatusBadge>
        )}
        <span className="help-meta-text">
          {t("help.appliesTo", { version: article.reviewedForVersion })}
          {" · "}
          {t("help.reviewedFor", { version: article.reviewedForVersion })}
          {" · v"}
          {article.contentVersion}
        </span>
      </div>
      <h3 className="help-article-title">{content.title}</h3>
      <p className="help-article-summary">{content.summary}</p>
      <div className="help-sections">
        {content.sections.map((section, i) =>
          renderSection(
            section,
            { tip: t("help.section.tip"), note: t("help.section.note"), callout: t("help.section.callout") },
            i,
          ),
        )}
      </div>
      {stepsText && (
        <div className="help-badges">
          <button type="button" className="btn sm" onClick={() => void copySteps()}>
            {t("help.copySteps")}
          </button>
          {copied === "ok" && (
            <span className="help-meta-text" role="status">
              {t("help.copied")}
            </span>
          )}
          {copied === "failed" && (
            <span className="help-meta-text" role="alert">
              {t("help.copyFailed")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
