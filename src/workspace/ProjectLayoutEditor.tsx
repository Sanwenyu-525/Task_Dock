//! 项目模块布局编辑：排序 + 显隐，保存走 `saveLayout`（与模块切换同一条串行写链）。
//!
//! 边界：
//! - 只编辑当前 Profile 已声明的模块，不展示未接入的计划能力；
//! - `overview` 固定首位且不可隐藏，保证任何布局下都有可落脚的概览；
//! - 每个项目独立保存，切换项目后编辑的是新项目自己的布局。
//!
//! 2026-11-20：小说 Profile 声明了展示层分组（概览 / 正文 / 设定 / 推进 / 项目设置），
//! 编辑器改为「一级分组排序 + 组内模块排序 + 子模块显隐」；保存时仍然展平成
//! 原有模块 ID 数组，`layout_json` 格式与版本不变，旧布局无需迁移。
//! 未声明分组的类型继续使用原平铺列表（渲染与按钮语义保持不变）。

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";

import { Dialog } from "../components/ui/Dialog";
import type { WorkspaceActionResult } from "./useWorkspaceProjectContext";
import {
  WORKSPACE_LAYOUT_VERSION,
  hasNavGroups,
  resolveSafeActiveModule,
  type WorkspaceLayoutConfig,
  type WorkspaceModuleId,
  type WorkspaceProfile,
} from "./workspaceProfiles";
import "./ProjectLayoutEditor.css";

interface Props {
  open: boolean;
  profile: WorkspaceProfile;
  layout: WorkspaceLayoutConfig;
  archived: boolean;
  onClose: () => void;
  onSave: (layout: WorkspaceLayoutConfig) => Promise<WorkspaceActionResult>;
  onNotice?: (message: string, kind?: "success" | "warning" | "error") => void;
}

interface EditorGroup {
  /** 声明分组 ID；未归组的模块用 `module:<id>` 兜底。 */
  id: string;
  label: string;
  /** 组内模块（含隐藏项），顺序与当前编辑顺序一致。 */
  moduleIds: WorkspaceModuleId[];
}

/** Profile 的模块顺序为底，叠加用户顺序；概览固定首位。 */
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

/**
 * 按分组把顺序整理成连续块：组顺序取组内首个模块在 order 中的位置，
 * 组内保持原有先后。这样一级排序/组内排序都有确定的落点。
 */
function normalizeOrder(profile: WorkspaceProfile, ids: WorkspaceModuleId[]): WorkspaceModuleId[] {
  if (!hasNavGroups(profile)) return ids;
  return buildGroups(profile, ids).flatMap((group) => group.moduleIds);
}

/** 由当前顺序推导编辑器分组；未归组的模块各自成为一个分组。 */
function buildGroups(profile: WorkspaceProfile, order: WorkspaceModuleId[]): EditorGroup[] {
  const groups: EditorGroup[] = [];
  const used = new Set<WorkspaceModuleId>();
  if (profile.navGroups) {
    for (const group of profile.navGroups) {
      const moduleIds = order.filter((id) => group.modules.includes(id));
      for (const id of moduleIds) used.add(id);
      if (moduleIds.length > 0) groups.push({ id: group.id, label: group.label, moduleIds });
    }
  }
  // 新增模块尚未登记分组时仍然可排序/显隐，不被吞掉。
  const byId = new Map(profile.modules.map((module) => [module.id, module]));
  for (const id of order) {
    if (used.has(id)) continue;
    const module = byId.get(id);
    if (!module) continue;
    groups.push({ id: `module:${id}`, label: module.label, moduleIds: [id] });
  }
  if (hasNavGroups(profile)) {
    groups.sort(
      (a, b) => order.indexOf(a.moduleIds[0]) - order.indexOf(b.moduleIds[0]),
    );
  }
  return groups;
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
    setOrder(normalizeOrder(profile, orderedIds(profile, layout)));
    setHidden(new Set(layout.hiddenModules));
    setSaving(false);
    setError(null);
  }, [open, profile, layout]);

  const modules = useMemo(
    () => new Map(profile.modules.map((module) => [module.id, module])),
    [profile],
  );

  const grouped = hasNavGroups(profile);
  const groups = useMemo(
    () => (grouped ? buildGroups(profile, order) : []),
    [grouped, profile, order],
  );

  /** 平铺模式：模块上移/下移（概览固定首位）。 */
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

  /** 分组模式：一级分组整体上移/下移（概览分组固定在首位）。 */
  const moveGroup = (groupId: string, delta: number) => {
    if (groupId === "overview") return;
    setOrder((prev) => {
      const current = buildGroups(profile, prev);
      const index = current.findIndex((group) => group.id === groupId);
      const target = index + delta;
      if (index < 0 || target < 1 || target >= current.length) return prev;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next.flatMap((group) => group.moduleIds);
    });
  };

  /** 分组模式：组内模块上移/下移。 */
  const moveChild = (groupId: string, id: WorkspaceModuleId, delta: number) => {
    setOrder((prev) => {
      const group = buildGroups(profile, prev).find((item) => item.id === groupId);
      if (!group) return prev;
      const index = group.moduleIds.indexOf(id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= group.moduleIds.length) return prev;
      const nextMembers = [...group.moduleIds];
      nextMembers.splice(index, 1);
      nextMembers.splice(target, 0, id);
      // 分组块在 order 中是连续的：把原块位置上的 ID 依次换成新顺序。
      const blockStart = prev.indexOf(group.moduleIds[0]);
      const next = [...prev];
      if (blockStart >= 0) {
        next.splice(blockStart, group.moduleIds.length, ...nextMembers);
      }
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
    const next: WorkspaceLayoutConfig = {
      version: WORKSPACE_LAYOUT_VERSION,
      moduleOrder: order,
      hiddenModules: [...hidden].filter((id) => id !== "overview"),
      activeModule: layout.activeModule,
    };
    // 当前模块被隐藏：同组还有可见模块就落在同组，否则回概览。
    next.activeModule = resolveSafeActiveModule(profile, next);
    const result = await onSave(next);
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

  const renderVisibility = (id: WorkspaceModuleId) => {
    const module = modules.get(id);
    if (!module) return null;
    const isOverview = id === "overview";
    const isHidden = hidden.has(id);
    return (
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
    );
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
        {grouped
          ? "一级分组可整体排序，组内模块可单独排序与显隐；概览固定首位且不可隐藏。隐藏当前模块后会自动回退到同组可见模块，整组隐藏则回到概览。"
          : "排序与显隐只作用于当前项目；概览固定首位且不可隐藏。隐藏当前模块后会自动回到概览。"}
      </p>
      {archived && <p className="ws-notice">项目已归档，布局只读。</p>}
      {error && <p className="ws-notice" data-tone="error" role="alert">{error}</p>}

      {grouped ? (
        <div className="ws-layout-groups">
          {groups.map((group, groupIndex) => {
            const single = group.moduleIds.length === 1;
            const groupModule = single ? group.moduleIds[0] : null;
            const isOverviewGroup = group.id === "overview";
            return (
              <section className="ws-layout-group" key={group.id} aria-label={`${group.label}分组`}>
                <div className="ws-layout-group-head">
                  <span className="ws-layout-name">{group.label}</span>
                  {isOverviewGroup && <span className="ws-layout-badge">固定</span>}
                  {single && hidden.has(group.moduleIds[0]) && (
                    <span className="ws-layout-badge">已隐藏</span>
                  )}
                  <span className="ws-layout-actions">
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet"
                      aria-label={`上移分组 ${group.label}`}
                      disabled={archived || groupIndex <= 1}
                      onClick={() => moveGroup(group.id, -1)}
                    >
                      <ChevronUp size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="ws-btn ws-btn-quiet"
                      aria-label={`下移分组 ${group.label}`}
                      disabled={archived || groupIndex === 0 || groupIndex >= groups.length - 1}
                      onClick={() => moveGroup(group.id, 1)}
                    >
                      <ChevronDown size={14} aria-hidden="true" />
                    </button>
                    {groupModule && renderVisibility(groupModule)}
                  </span>
                </div>
                {!single && (
                  <ul className="ws-layout-list">
                    {group.moduleIds.map((id, index) => {
                      const module = modules.get(id);
                      if (!module) return null;
                      const isHidden = hidden.has(id);
                      return (
                        <li key={id} className={`ws-layout-row is-child${isHidden ? " is-hidden" : ""}`}>
                          <span className="ws-layout-name">{module.label}</span>
                          {isHidden && <span className="ws-layout-badge">已隐藏</span>}
                          <span className="ws-layout-actions">
                            <button
                              type="button"
                              className="ws-btn ws-btn-quiet"
                              aria-label={`上移 ${module.label}`}
                              disabled={archived || index === 0}
                              onClick={() => moveChild(group.id, id, -1)}
                            >
                              <ChevronUp size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="ws-btn ws-btn-quiet"
                              aria-label={`下移 ${module.label}`}
                              disabled={archived || index === group.moduleIds.length - 1}
                              onClick={() => moveChild(group.id, id, 1)}
                            >
                              <ChevronDown size={14} aria-hidden="true" />
                            </button>
                            {renderVisibility(id)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      ) : (
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
                  {renderVisibility(id)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
