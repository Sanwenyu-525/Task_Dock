//! 规划中心（v0.7）：「我的项目」与「内置路线图」双数据源入口。
//!
//! - 我的项目：用户自建多项目（SQLite planning_* 表），可创建 / 编辑 / 归档 / 删除，
//!   规划功能、拆分步骤、记录进度（见 PlanningWorkspace 与 docs/roadmap/planning-center.md）；
//! - 内置路线图：Task Dock 自身的 31 项功能规划（lib/featureCatalog.ts 静态目录），
//!   只读展示，不受用户项目编辑影响（FeatureRoadmapPanel 原样保留）。
//!
//! 保留 roadmap Tab 身份：导航、快捷键（Ctrl+7）与既有测试不受改名影响。

import { useState } from "react";
import { Map as MapIcon } from "lucide-react";
import { useLocale } from "../../hooks/useLocale";
import ContextHelpButton from "../help/ContextHelpButton";
import FeatureRoadmapPanel from "./FeatureRoadmapPanel";
import PlanningWorkspace from "./PlanningWorkspace";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import "./planning-page.css";

type Source = "mine" | "builtin";

export default function PlanningCenterPanel() {
  const [source, setSource] = useState<Source>("mine");
  const { t } = useLocale();
  return (
    <div className="planning-panel page-fill">
      {/* 页面级页头（2026-11-15 统一）；数据源切换保留在下方。 */}
      <WorkbenchPageHeader
        icon={MapIcon}
        title={t("nav.roadmap")}
        subtitle={t("planning.pageSubtitle")}
        actions={<ContextHelpButton articleId="help.workflows.planning-center" />}
      />
      <div className="planning-source-switch">
        <span className="planning-source-label">数据来源</span>
        <div className="seg-group subtle" role="group" aria-label="规划数据来源">
          <button
            className={`seg-btn ${source === "mine" ? "active" : ""}`}
            onClick={() => setSource("mine")}
            aria-pressed={source === "mine"}
          >
            我的项目
          </button>
          <button
            className={`seg-btn ${source === "builtin" ? "active" : ""}`}
            onClick={() => setSource("builtin")}
            aria-pressed={source === "builtin"}
          >
            内置路线图
          </button>
        </div>
      </div>
      {source === "mine" ? <PlanningWorkspace /> : <FeatureRoadmapPanel />}
    </div>
  );
}
