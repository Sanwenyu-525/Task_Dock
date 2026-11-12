//! 开发现场区块（dev workbench Round 1）：当前项目 + 只读 Git 摘要。
//!
//! 数据边界：
//! - 当前项目是用户显式设置（`workbench_current_project`），不自动推断；
//!   项目被删除后保留原值，读侧校验并如实展示失效状态（不静默清空）。
//! - Git 摘要来自 `dev_project_probe`（只读：分支 / 未提交数 / worktree 标记，
//!   不读取任何文件内容）；status 非 ok 时按状态降级展示，不伪造分支名。
//! - probe 结果与项目列表使用模块级缓存（30s TTL）：本区块与胶囊 TasksLite
//!   chip 共享同一份，重复挂载不重复请求；手动刷新强制绕过缓存。
//! - 目录失效（exists=false）只显示徽标，绝不自动删除项目。

import { useCallback, useEffect, useState } from "react";
import { FolderGit2, RefreshCw } from "lucide-react";
import { ConfirmDialog, Select } from "../ui";
import {
  devProjectDelete,
  devProjectList,
  devProjectProbe,
  devProjectSave,
  type DevGitInfo,
  type DevProject,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import type { MessageKey, MessageParams } from "../../i18n";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";

/** 缓存有效期：项目列表与 probe 共用，重复挂载在窗口内不重复请求。 */
export const DEV_PROJECT_CACHE_TTL_MS = 30_000;

/** 项目列表模块级缓存：DevProjectContext 与胶囊 TasksLite chip 共享。 */
let projectListCache: { at: number; projects: DevProject[] } | null = null;

/** probe 结果模块级缓存（按 rootPath 键控）。 */
const probeCache = new Map<string, { at: number; info: DevGitInfo }>();

/** 项目列表或 Git 摘要发生变化（保存/删除/手动刷新）后调用，作废全部缓存。 */
export function invalidateDevProjectCache(): void {
  projectListCache = null;
  probeCache.clear();
}

/**
 * 读取项目列表（30s TTL 缓存）。`force = true` 绕过缓存（手动刷新/变更后重读）。
 * 后端命令失败时抛出原错误，由调用方如实展示。
 */
export function fetchDevProjectListCached(force = false): Promise<DevProject[]> {
  if (!force && projectListCache && Date.now() - projectListCache.at < DEV_PROJECT_CACHE_TTL_MS) {
    return Promise.resolve(projectListCache.projects);
  }
  return devProjectList().then(({ projects }) => {
    projectListCache = { at: Date.now(), projects };
    return projects;
  });
}

/** 读取某目录的 Git 摘要（30s TTL 缓存）。`force = true` 绕过缓存。 */
export function probeDevGitCached(rootPath: string, force = false): Promise<DevGitInfo> {
  const hit = probeCache.get(rootPath);
  if (!force && hit && Date.now() - hit.at < DEV_PROJECT_CACHE_TTL_MS) {
    return Promise.resolve(hit.info);
  }
  return devProjectProbe(rootPath).then((info) => {
    probeCache.set(rootPath, { at: Date.now(), info });
    return info;
  });
}

/** 胶囊 chip 摘要：项目名 +（probe ok 时的）分支。列表未命中返回 null。 */
export interface DevProjectChipSummary {
  name: string;
  /** 仅 probe status=ok 且分支非空时提供；其余情况 chip 只显示项目名。 */
  branch: string | null;
}

/** 供 TasksLite chip 使用的轻量解析：命中列表 + 复用 30s probe 缓存。 */
export function resolveDevProjectChip(projectId: string): Promise<DevProjectChipSummary | null> {
  return fetchDevProjectListCached().then((projects) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return null;
    return probeDevGitCached(project.rootPath)
      .then((info) => ({
        name: project.name,
        branch: info.status === "ok" ? info.branch : null,
      }))
      .catch(() => ({ name: project.name, branch: null }));
  });
}

export default function DevProjectContext() {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const currentId = useSettingsStore((s) => s.settings?.workbench_current_project ?? "") || null;

  const [projects, setProjects] = useState<DevProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [git, setGit] = useState<DevGitInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 删除确认走 ConfirmDialog（既有确认原语）；pendingDeleteId 非空即打开。 */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const currentProject = projects?.find((p) => p.id === currentId) ?? null;

  const refreshList = useCallback(
    (force: boolean) => {
      return fetchDevProjectListCached(force)
        .then((rows) => {
          setProjects(rows);
          setLoadError(null);
        })
        .catch((e) => setLoadError(errorMessage(e)));
    },
    [],
  );

  // 挂载读一次（命中缓存则不重复请求）
  useEffect(() => {
    void refreshList(false);
  }, [refreshList]);

  // 当前项目的 Git 摘要：挂载/切换项目时 probe 一次（30s TTL 缓存内复用）
  const currentRoot = currentProject?.rootPath ?? null;
  useEffect(() => {
    if (!currentRoot) {
      setGit(null);
      setProbeError(null);
      return;
    }
    let alive = true;
    setProbing(true);
    setProbeError(null);
    probeDevGitCached(currentRoot)
      .then((info) => {
        if (alive) setGit(info);
      })
      .catch((e) => {
        if (alive) setProbeError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, [currentRoot]);

  const setCurrent = useCallback(
    (id: string) => {
      void useSettingsStore
        .getState()
        .update({ workbench_current_project: id })
        .catch((e) =>
          showToast(t("devwork.project.setCurrentFailed", { error: errorMessage(e) }), {
            kind: "error",
          }),
        );
    },
    [showToast, t],
  );

  const manualRefresh = useCallback(() => {
    invalidateDevProjectCache();
    void refreshList(true);
  }, [refreshList]);

  const submitNewProject = useCallback(() => {
    // 表单校验：名称与目录路径必填；错误就地显示，不弹窗
    const trimmedName = name.trim();
    const trimmedPath = rootPath.trim();
    if (!trimmedName) {
      setFormError(t("devwork.project.formNameRequired"));
      return;
    }
    if (!trimmedPath) {
      setFormError(t("devwork.project.formPathRequired"));
      return;
    }
    setFormError(null);
    setSaving(true);
    devProjectSave({ id: null, name: trimmedName, rootPath: trimmedPath })
      .then(({ project }) => {
        showToast(t("devwork.project.saveDone", { name: project.name }), { kind: "success" });
        invalidateDevProjectCache();
        setName("");
        setRootPath("");
        setFormOpen(false);
        void refreshList(true);
      })
      .catch((e) => {
        // 保存失败不关表单、不清输入，用户可直接重试
        setFormError(t("devwork.project.saveFailed", { error: errorMessage(e) }));
      })
      .finally(() => setSaving(false));
  }, [name, rootPath, refreshList, showToast, t]);

  const confirmDelete = useCallback(() => {
    if (!pendingDeleteId) return;
    const target = projects?.find((p) => p.id === pendingDeleteId);
    setDeleting(true);
    devProjectDelete(pendingDeleteId)
      .then(() => {
        showToast(
          t("devwork.project.deleteDone", { name: target?.name ?? pendingDeleteId }),
          { kind: "success" },
        );
        invalidateDevProjectCache();
        setPendingDeleteId(null);
        void refreshList(true);
      })
      .catch((e) => {
        showToast(t("devwork.project.deleteFailed", { error: errorMessage(e) }), { kind: "error" });
      })
      .finally(() => setDeleting(false));
  }, [pendingDeleteId, projects, refreshList, showToast, t]);

  const projectOptions = (projects ?? []).map((p) => ({
    value: p.id,
    label: p.exists ? p.name : `${p.name}（${t("devwork.project.staleBadge")}）`,
  }));

  return (
    <section className="wb-card" aria-label={t("devwork.project.title")}>
      <div className="wb-section-head">
        <h3 className="wb-section-title">
          <FolderGit2 size={13} aria-hidden="true" /> {t("devwork.project.title")}
        </h3>
        <span className="flex-spacer" />
        <button
          type="button"
          className="icon-btn sm"
          aria-label={t("devwork.project.refreshAria")}
          data-tip={t("devwork.project.refresh")}
          onClick={manualRefresh}
        >
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      </div>

      {loadError && (
        <div className="wb-error-row" role="alert">
          <span>{t("workbench.loadFailed", { error: loadError })}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              invalidateDevProjectCache();
              void refreshList(true);
            }}
          >
            {t("workbench.retry")}
          </button>
        </div>
      )}

      {!loadError && projects === null && (
        <div className="empty-hint" role="status">
          {t("nav.loading")}
        </div>
      )}

      {/* 未设置 / 列表为空：空态 + 新建入口，不伪造任何现场 */}
      {projects !== null && projects.length === 0 && !formOpen && (
        <div className="wb-empty">
          <p className="wb-empty-title">{t("devwork.project.emptyTitle")}</p>
          <p className="endpoint-hint">{t("devwork.project.empty")}</p>
          <button
            type="button"
            className="btn sm wb-empty-more"
            onClick={() => setFormOpen(true)}
          >
            {t("devwork.project.newProject")}
          </button>
        </div>
      )}

      {projects !== null && projects.length > 0 && (
        <>
          {currentId && !currentProject && (
            <div className="wb-stale" role="alert">
              <span className="wb-stale-text">{t("devwork.project.stale")}</span>
              <button
                type="button"
                className="btn sm"
                onClick={() => void useSettingsStore.getState().update({ workbench_current_project: "" })}
              >
                {t("devwork.project.clearCurrent")}
              </button>
            </div>
          )}

          {currentProject && (
            <div className="wb-dev-current">
              <div className="wb-dev-current-head">
                <span className="wb-row-title">{currentProject.name}</span>
                {!currentProject.exists && (
                  <span className="badge subtle wb-dev-stale-badge">
                    {t("devwork.project.staleBadge")}
                  </span>
                )}
                <span className="badge subtle">{t("devwork.project.currentMark")}</span>
              </div>
              <div
                className="wb-dev-path"
                data-tip={currentProject.rootPath}
              >
                {currentProject.rootPath}
              </div>
              <div className="wb-dev-gitline" role="status">
                {probing
                  ? t("devwork.project.gitProbing")
                  : probeError
                    ? t("devwork.project.gitProbeFailed", { error: probeError })
                    : git
                      ? gitSummaryLine(git, t)
                      : null}
              </div>
            </div>
          )}

          <div className="wb-dev-select-row">
            <label className="wb-dev-select-label" htmlFor="dev-project-select">
              {t("devwork.project.selectLabel")}
            </label>
            <Select
              value={currentId ?? ""}
              options={projectOptions}
              onChange={(v) => setCurrent(v)}
              placeholder={t("devwork.project.selectPlaceholder")}
              ariaLabel={t("devwork.project.selectLabel")}
              size="sm"
              block
              className="wb-dev-select"
            />
          </div>

          <div className="wb-dev-rows" role="list" aria-label={t("devwork.project.listAria")}>
            {(projects ?? []).map((p) => (
              <div className="wb-dev-row" role="listitem" key={p.id}>
                <span className="wb-row-main">
                  <span className="wb-row-title">
                    {p.name}
                    {!p.exists && (
                      <span className="badge subtle wb-dev-stale-badge">
                        {t("devwork.project.staleBadge")}
                      </span>
                    )}
                    {p.id === currentId && (
                      <span className="badge subtle">{t("devwork.project.currentMark")}</span>
                    )}
                  </span>
                  <span className="wb-row-sub wb-dev-path" data-tip={p.rootPath}>
                    {p.rootPath}
                  </span>
                </span>
                {p.id !== currentId && (
                  <button
                    type="button"
                    className="btn sm"

                    onClick={() => setCurrent(p.id)}
                  >
                    {t("devwork.project.setAsCurrent")}
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label={t("devwork.project.deleteAria", { name: p.name })}
                  data-tip={t("devwork.project.delete")}

                  onClick={() => setPendingDeleteId(p.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {!formOpen && (
            <button
              type="button"
              className="btn sm wb-dev-add"
              onClick={() => setFormOpen(true)}
            >
              {t("devwork.project.newProject")}
            </button>
          )}
        </>
      )}

      {formOpen && (
        <form
          className="wb-dev-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitNewProject();
          }}
        >
          <label className="field">
            <span>{t("devwork.project.formName")}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label={t("devwork.project.formName")}
              maxLength={100}
            />
          </label>
          <label className="field">
            <span>{t("devwork.project.formPath")}</span>
            <input
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              aria-label={t("devwork.project.formPath")}
              maxLength={500}
              placeholder="D:\\path\\to\\repo"
            />
          </label>
          {formError && (
            <div className="wb-error-row" role="alert">
              <span>{formError}</span>
            </div>
          )}
          <div className="wb-dev-form-actions">
            <button type="submit" className="btn primary sm" disabled={saving}>
              {t("devwork.project.formSave")}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setFormOpen(false);
                setFormError(null);
              }}
            >
              {t("devwork.project.formCancel")}
            </button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title={t("devwork.project.deleteTitle")}
        detail={t("devwork.project.deleteDetail", {
          name: projects?.find((p) => p.id === pendingDeleteId)?.name ?? "",
        })}
        confirmLabel={t("devwork.project.delete")}
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDeleteId(null)}
      />
    </section>
  );
}

/** Git 摘要行：status=ok 显示「分支 · N 处未提交 · worktree」，其余按状态降级。 */
export function gitSummaryLine(
  info: DevGitInfo,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  switch (info.status) {
    case "ok": {
      const parts: string[] = [];
      if (info.detached) parts.push(t("devwork.project.gitDetached"));
      parts.push(info.branch ?? t("devwork.project.gitNoBranch"));
      // dirtyCount=null 表示未能统计：不显示该段，也绝不显示为 0
      if (info.dirtyCount !== null) {
        parts.push(t("devwork.project.gitDirty", { count: info.dirtyCount }));
      }
      if (info.isWorktree) parts.push(t("devwork.project.gitWorktree"));
      return parts.join(" · ");
    }
    case "not_a_repo":
      return t("devwork.project.gitNotRepo");
    case "git_unavailable":
      return t("devwork.project.gitUnavailable");
    case "path_missing":
      return t("devwork.project.gitPathMissing");
  }
}
