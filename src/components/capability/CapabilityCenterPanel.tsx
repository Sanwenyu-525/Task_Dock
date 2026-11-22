//! 知识与 AI 能力中心（v72）：统一工作台页面。
//!
//! 五个子页共享同一页面骨架，但各自持有数据与操作状态：
//! 知识库 / Skill / MCP / 上下文 / 能力配方。
//! 不把功能塞进设置页；MCP Server 端管理仍在设置页，这里只做统一总览与外部 Server。

import { useState } from "react";
import { ArrowUpRight, BookOpen, FlaskConical, LibraryBig, Layers3, Plug } from "lucide-react";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import KnowledgeSection from "./KnowledgeSection";
import SkillsSection from "./SkillsSection";
import McpServersSection from "./McpServersSection";
import ContextSection from "./ContextSection";
import RecipesSection from "./RecipesSection";
import { SectionTabs } from "../ui";
import { useUiStore } from "../../store/useUiStore";
import "./capability.css";

/**
 * 能力中心只保留**全局可复用能力资源**：知识库 / Skill / MCP / 上下文 / 配方。
 * 「Agent 接入与授权」（身份、权限、导入授权、同步、冲突、交接、操作历史、审计）
 * 不属于能力资源管理，已迁入 Agent 页面；这里只保留一行兼容入口。
 */
type SectionId = "knowledge" | "skills" | "mcp" | "context" | "recipes";

const SECTIONS: readonly { id: SectionId; labelKey: MessageKey; icon: typeof BookOpen }[] = [
  { id: "knowledge", labelKey: "cap.tab.knowledge", icon: BookOpen },
  { id: "skills", labelKey: "cap.tab.skills", icon: Layers3 },
  { id: "mcp", labelKey: "cap.tab.mcp", icon: Plug },
  { id: "context", labelKey: "cap.tab.context", icon: LibraryBig },
  { id: "recipes", labelKey: "cap.tab.recipes", icon: FlaskConical },
];

export default function CapabilityCenterPanel() {
  const { t } = useLocale();
  const [section, setSection] = useState<SectionId>("knowledge");
  const setTab = useUiStore((s) => s.setTab);
  const requestAgentSection = useUiStore((s) => s.requestAgentSection);

  return (
    <div className="capability-panel">
      <WorkbenchPageHeader
        icon={LibraryBig}
        title={t("cap.title")}
        subtitle={t("cap.subtitle")}
      />
      {/* 内容面板切换：统一 SectionTabs（docs/ui-themes/15-section-navigation.md），
          tab/panel ID 沿用既有 cap-tab-* / cap-panel-* 前缀，数据状态不变。 */}
      <SectionTabs
        items={SECTIONS.map((item) => ({ id: item.id, label: t(item.labelKey), icon: item.icon }))}
        activeId={section}
        onChange={setSection}
        aria-label={t("cap.title")}
        idPrefix="cap"
      />
      <div
        className="cap-body"
        id={`cap-panel-${section}`}
        role="tabpanel"
        aria-labelledby={`cap-tab-${section}`}
      >
        {section === "knowledge" ? <KnowledgeSection /> : null}
        {section === "skills" ? <SkillsSection /> : null}
        {section === "mcp" ? <McpServersSection /> : null}
        {section === "context" ? <ContextSection /> : null}
        {section === "recipes" ? <RecipesSection /> : null}
      </div>
      <div className="cap-moved-note" role="note">
        <div>
          <strong>{t("cap.agent.movedTitle")}</strong>
          <p>{t("cap.agent.movedBody")}</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            requestAgentSection("access");
            setTab("agents");
          }}
        >
          {t("cap.agent.movedAction")} <ArrowUpRight size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
