//! 项目模块布局编辑：排序 + 显隐，保存走 `saveLayout`（与模块切换同一条串行写链）。
//!
//! 边界：
//! - 只编辑当前 Profile 已声明的模块，不展示未接入的计划能力；
//! - `overview` 固定首位且不可隐藏，保证任何布局下都有可落脚的概览；
//! - 每个项目独立保存，切换项目后编辑的是新项目自己的布局。

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";

import { Dialog } from "../components/ui/Dialog";
import type { WorkspaceActionResult } from "./useWorkspaceProjectContext";
import {
  WORKSPACE_LAYOUT_VERSION,
  type WorkspaceLayoutConfig,
  type WorkspaceModuleId,
  type WorkspaceProfile,
} from "./workspaceProfiles";

interface Props {
  open: boolean;
  profile: WorkspaceProfile;
  layout: WorkspaceLayoutConfig;
  archived: boolean;
  onClose: () => void;
  onSave: (layout: WorkspaceLayoutConfig) => Promise<WorkspaceActionResult>;
  onNotice?: (message: string, kind?: "success" | "warning" | "error") => void;
}

function orderedIds(profile: WorkspaceProfile, layout: WorkspaceLayoutConfig): WorkspaceModuleId[] {
  const base = profile.modules.map((module) => module.id);
  const result: WorkspaceModuleId[] = [];
  for (const id of layout.moduleOrder) {
    if (base.includes(id) && !result.includes(id)) result.push(id);
  }
  for (const id of base) {
    if (!result.includes(id)) result.push(id);
  }
  // 概览固定首位：即使旧 layout 把它排在后面，编辑界面也按真实约束展示。
  return result.includes("overview")
    ? ["overview", ...result.filter((id) => id !== "overview")]
    : result;
}

export default function ProjectLayoutEditor({
  open,
  profile,
  layout,
  archived,
  onClose,
  onSave,
  onNotice,
}: Props) {
  const [order, setOrder] = useState<WorkspaceModuleId[]>([]);
  const [hidden, setHidden] = useState<Set<WorkspaceModuleId>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOrder(orderedIds(profile, layout));
    setHidden(new Set(layout.hiddenModules));
    setSaving(false);
    setError(null);
  }, [open, profile, layout]);

  const modules = useMemo(
    () => new Map(profile.modules.map((module) => [module.id, module])),
    [profile],
  );

  const move = (id: WorkspaceModuleId, delta: number) => {
    if (id === "overview") return;
    setOrder((prev) => {
      const index = prev.indexOf(id);
      const target = index + delta;
      if (index < 0 || target < 1 || target >= prev.length) return prev;
      const next = [...prev];
      next.splice(index, 1);
      next.splice(target, 0, id);
      return next;
    });
  };

  const toggle = (id: WorkspaceModuleId) => {
    if (id === "overview") return;
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    if (archived || saving) return;
    setSaving(true);
    setError(null);
    const active = hidden.has(layout.activeModule) ? "overview" : layout.activeModule;
    const result = await onSave({
      version: WORKSPACE_LAYOUT_VERSION,
      moduleOrder: order,
      hiddenModules: [...hidden].filter((id) => id !== "overview"),
      activeModule: active,
    });
    setSaving(false);
    if (result === "ok") {
      onNotice?.("布局已保存", "success");
      onClose();
    } else if (result === "stale") {
      onNotice?.("项目已切换，布局未回显到当前项目", "warning");
      onClose();
    } else {
      setError("保存失败，布局保持原样");
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="编辑模块布局"
      size="sm"
      footer={
        <>
          <button type="button" className="ws-btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="ws-btn ws-btn-primary"
            onClick={() => void save()}
            disabled={archived || saving}
          >
            {saving ? "保存中…" : "保存布局"}
          </button>
        </>
      }
    >
      <p className="ws-layout-hint">
        排序与显隐只作用于当前项目；概览固定首位且不可隐藏。隐藏当前模块后会自动回到概览。
      </p>
      {archived && <p className="ws-notice">项目已归档，布局只读。</p>}
      {error && <p className="ws-notice" data-tone="error" role="alert">{error}</p>}
      <ul className="ws-layout-list">
        {order.map((id, index) => {
          const module = modules.get(id);
          if (!module) return null;
          const isOverview = id === "overview";
          const isHidden = hidden.has(id);
          return (
            <li key={id} className={`ws-layout-row${isHidden ? " is-hidden" : ""}`}>
              <span className="ws-layout-name">{module.label}</span>
              {isOverview && <span className="ws-layout-badge">固定</span>}
              {isHidden && <span className="ws-layout-badge">已隐藏</span>}
              <span className="ws-layout-actions">
                <button
                  type="button"
                  className="ws-btn ws-btn-quiet"
                  aria-label={`上移 ${module.label}`}
                  disabled={archived || isOverview || index <= 1}
                  onClick={() => move(id, -1)}
                >
                  <ChevronUp size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="ws-btn ws-btn-quiet"
                  aria-label={`下移 ${module.label}`}
                  disabled={archived || isOverview || index === order.length - 1}
                  onClick={() => move(id, 1)}
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="ws-btn ws-btn-quiet"
                  aria-label={isHidden ? `显示 ${module.label}` : `隐藏 ${module.label}`}
                  data-tip={isHidden ? "显示模块" : "隐藏模块"}
                  disabled={archived || isOverview}
                  onClick={() => toggle(id)}
                >
                  {isHidden ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
