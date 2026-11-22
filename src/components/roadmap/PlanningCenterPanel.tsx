//! 规划中心（v0.7）：「我的项目」与「内置路线图」双数据源入口。
//!
//! - 我的项目：用户自建多项目（SQLite planning_* 表），可创建 / 编辑 / 归档 / 删除，
//!   规划功能、拆分步骤、记录进度（见 PlanningWorkspace 与 docs/roadmap/planning-center.md）；
//! - 内置路线图：Task Dock 自身的功能目录（lib/featureCatalog.ts 静态目录，当前 61 项 / 7 分区），
//!   只读展示，不受用户项目编辑影响（FeatureRoadmapPanel 原样保留）。
//!
//! 保留 roadmap Tab 身份：导航、快捷键（Ctrl+9）与既有测试不受改名影响。

import { useState } from "react";
import { Map as MapIcon } from "lucide-react";
import { useLocale } from "../../hooks/useLocale";
import ContextHelpButton from "../help/ContextHelpButton";
import FeatureRoadmapPanel from "./FeatureRoadmapPanel";
import PlanningWorkspace from "./PlanningWorkspace";
import ProjectHubPanel from "./ProjectHubPanel";
import CollabPanel from "../collab/CollabPanel";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import { SectionTabs } from "../ui";
import "./planning-page.css";

type Source = "hub" | "mine" | "builtin" | "collab";

export default function PlanningCenterPanel() {
  const [source, setSource] = useState<Source>("hub");
  /** 兼容深链：项目中枢把当前 active 计划 ID 交给规划编辑器定位项目。 */
  const [planningTarget, setPlanningTarget] = useState<string | null>(null);
  const { t } = useLocale();
  const openPlanning = (planId: string | null) => {
    setPlanningTarget(planId);
    setSource("mine");
  };
  return (
    <div className="planning-panel page-fill">
      {/* 页面级页头（2026-11-15 统一）；项目中枢为默认入口，原规划编辑保留。 */}
      <WorkbenchPageHeader
        icon={MapIcon}
        title={t("nav.roadmap")}
        subtitle={t("planning.pageSubtitle")}
        actions={<ContextHelpButton articleId="help.workflows.planning-center" />}
      />
      {/* 数据来源是四个互斥内容面板的切换：统一 SectionTabs（升级为 tablist/tab/tabpanel 语义，
          原 seg-group + aria-pressed 结构废弃）。source / openPlanning / planningTarget 逻辑不变。 */}
      <div className="planning-source-switch">
        <span className="planning-source-label">数据来源</span>
        <SectionTabs
          items={[
            { id: "hub", label: "项目中枢" },
            { id: "mine", label: "规划编辑" },
            { id: "builtin", label: "内置路线图" },
            { id: "collab", label: "协作中心" },
          ]}
          activeId={source}
          onChange={setSource}
          aria-label="项目中枢数据来源"
          idPrefix="planning-source"
        />
      </div>
      <div
        id={`planning-source-panel-${source}`}
        role="tabpanel"
        aria-labelledby={`planning-source-tab-${source}`}
        className="page-fill"
      >
        {source === "hub" ? (
          <ProjectHubPanel onOpenPlanning={openPlanning} />
        ) : source === "mine" ? (
          <PlanningWorkspace initialProjectId={planningTarget} />
        ) : source === "builtin" ? (
          <FeatureRoadmapPanel />
        ) : (
          <CollabPanel />
        )}
      </div>
    </div>
  );
}
