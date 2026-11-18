//! 知识与 AI 能力中心（v72）：统一工作台页面。
//!
//! 五个子页共享同一页面骨架，但各自持有数据与操作状态：
//! 知识库 / Skill / MCP / 上下文 / 能力配方。
//! 不把功能塞进设置页；MCP Server 端管理仍在设置页，这里只做统一总览与外部 Server。

import { useState } from "react";
import { BookOpen, FlaskConical, LibraryBig, Layers3, Plug, Users } from "lucide-react";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import { useLocale } from "../../hooks/useLocale";
import type { MessageKey } from "../../i18n";
import KnowledgeSection from "./KnowledgeSection";
import SkillsSection from "./SkillsSection";
import McpServersSection from "./McpServersSection";
import ContextSection from "./ContextSection";
import RecipesSection from "./RecipesSection";
import AgentAccessSection from "./AgentAccessSection";
import "./capability.css";

type SectionId = "knowledge" | "skills" | "mcp" | "context" | "recipes" | "agent";

const SECTIONS: readonly { id: SectionId; labelKey: MessageKey; icon: typeof BookOpen }[] = [
  { id: "knowledge", labelKey: "cap.tab.knowledge", icon: BookOpen },
  { id: "skills", labelKey: "cap.tab.skills", icon: Layers3 },
  { id: "mcp", labelKey: "cap.tab.mcp", icon: Plug },
  { id: "context", labelKey: "cap.tab.context", icon: LibraryBig },
  { id: "recipes", labelKey: "cap.tab.recipes", icon: FlaskConical },
  { id: "agent", labelKey: "cap.tab.agent", icon: Users },
];

export default function CapabilityCenterPanel() {
  const { t } = useLocale();
  const [section, setSection] = useState<SectionId>("knowledge");

  return (
    <div className="capability-panel">
      <WorkbenchPageHeader
        icon={LibraryBig}
        title={t("cap.title")}
        subtitle={t("cap.subtitle")}
      />
      <div className="cap-tabs" role="tablist" aria-label={t("cap.title")}>
        {SECTIONS.map((item) => {
          const Icon = item.icon;
          const active = item.id === section;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="cap-tab"
              aria-selected={active}
              aria-controls={`cap-panel-${item.id}`}
              id={`cap-tab-${item.id}`}
              onClick={() => setSection(item.id)}
            >
              <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
              {t(item.labelKey)}
            </button>
          );
        })}
      </div>
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
        {section === "agent" ? <AgentAccessSection /> : null}
      </div>
    </div>
  );
}
