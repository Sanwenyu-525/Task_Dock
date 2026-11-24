//! E4：Git / Worktree 风险探测面板（只读）。
//!
//! 边界：只展示探测事实与风险提示，不提供任何写 Git 操作入口；
//! 目录失效如实降级，不伪造分支 / 提交，不自动重建目录。
//!
//! ## 反馈契约
//! - 打开目录 / 打开开发工作台失败必须可见（走壳层通知 + 面板内提示），不允许
//!   `catch(() => undefined)` 静默吞掉。
//! - 改动清单读取失败（超时 / git 缺失）**不等于零改动**：面板显示「未读取」，
//!   不显示「改动文件（0）」这种假事实。
//! - 探测快照在本机最多保留 20 条、不跨机同步，界面按「本机瞬时留痕」口径展示。

import { useCallback, useEffect, useRef, useState } from "react";
import type { CreativeModuleProps } from "../types";
import { errorMessage } from "../../../lib/errors";
import { dwsGitRiskProbe, dwsRevealPath } from "./ipc";
import type { DwsProbeSnapshot, DwsRepoRisk, DwsRiskFlag } from "./types";

const STATUS_LABELS: Record<string, string> = {
  ok: "Git 仓库",
  not_a_repo: "非 Git 目录",
  git_unavailable: "git 不可用",
  path_missing: "路径失效",
};

const GIT_STATUS_LABELS: Record<string, string> = {
  ok: "正常",
  not_a_repo: "非 Git 仓库",
  git_unavailable: "git 不可用",
  path_missing: "路径失效",
  "": "未知",
};

function RiskFlag({ flag }: { flag: DwsRiskFlag }) {
  const tone = flag.level === "warn" ? "error" : "info";
  return (
    <li className="dws-risk" data-tone={tone}>
      <span className={`ws-badge dws-risk-badge ${flag.level === "warn" ? "ws-badge-unavailable" : "ws-badge-soft"}`}>
        {flag.code}
      </span>
      <span className="dws-risk-message">{flag.message}</span>
      {flag.files.length > 0 && (
        <span className="dws-risk-files" data-tip={flag.files.join("\n")}>
          {flag.files.slice(0, 5).join("、")}
          {flag.files.length > 5 ? ` 等 ${flag.files.length} 项` : ""}
        </span>
      )}
    </li>
  );
}

function ProbeHistory({ history }: { history: DwsProbeSnapshot[] }) {
  return (
    <section className="dws-section">
      <div className="dws-subhead">本机探测快照（{history.length}）</div>
      <div className="dws-run-sub">
        仅本机瞬时留痕（每项目最多 20 条，不跨机同步），用于核对「上次探测看到了什么」，不是验收依据。
      </div>
      {history.length === 0 ? (
        <div className="ws-empty">暂无本机探测快照。</div>
      ) : (
        <ul className="ws-list">
          {history.map((h) => (
            <li className="ws-row" key={h.id}>
              <div className="dws-run">
                <div className="dws-run-title">
                  {h.probedAt}
                  <span className="ws-badge ws-badge-soft">
                    {GIT_STATUS_LABELS[h.gitStatus] ?? h.gitStatus}
                  </span>
                  {h.truncated && <span className="ws-badge ws-badge-limited">改动已截断</span>}
                </div>
                <div className="dws-run-sub">
                  {h.branch ? `分支：${h.branch}` : "分支未知"}
                  {h.headSha ? ` · 提交：${h.headSha.slice(0, 8)}` : ""}
                  {h.dirtyCount === null ? " · 改动数未读取" : ` · 未提交 ${h.dirtyCount} 处`}
                  {h.repoCount > 0 ? ` · 收录仓库 ${h.repoCount} 个` : ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RepoCard({
  repo,
  onNotice,
}: {
  repo: DwsRepoRisk;
  onNotice: CreativeModuleProps["onNotice"];
}) {
  const [revealing, setRevealing] = useState(false);
  const git = repo.git;
  const statusLabel = STATUS_LABELS[git.status] ?? git.status;
  const headShort = git.headSha ? git.headSha.slice(0, 8) : null;
  const gitFactsUsable = repo.exists && git.status === "ok";

  const onReveal = () => {
    if (!repo.exists) {
      onNotice("error", "仓库目录已失效（被移动或删除），无法打开；请到项目设置重新关联仓库。");
      return;
    }
    if (revealing) return;
    setRevealing(true);
    dwsRevealPath(repo.rootPath)
      .catch((e) => onNotice("error", `打开仓库目录失败：${errorMessage(e)}`))
      .finally(() => setRevealing(false));
  };

  return (
    <div className="ws-card dws-repo">
      <div className="ws-card-head">
        <h3>{repo.name}</h3>
        <span className={`ws-badge ${repo.exists ? "ws-badge-available" : "ws-badge-unavailable"}`}>
          {repo.exists ? "目录有效" : "目录失效"}
        </span>
      </div>

      <div className="ws-row dws-facts">
        <span className="ws-badge ws-badge-soft">{statusLabel}</span>
        {/* 只在真的读到 Git 事实时才展示分支 / 提交 / 改动数，避免失效目录出现假状态。 */}
        {gitFactsUsable && git.branch && <span className="dws-fact">分支：{git.branch}</span>}
        {gitFactsUsable && git.detached && <span className="ws-badge ws-badge-limited">detached HEAD</span>}
        {gitFactsUsable && headShort && (
          <span className="dws-fact" data-tip={git.headSha ?? ""}>提交：{headShort}</span>
        )}
        {gitFactsUsable && (
          <span className="dws-fact">
            {git.dirtyCount === null ? "未提交：未读取" : `未提交：${git.dirtyCount} 处`}
          </span>
        )}
        {gitFactsUsable && git.isWorktree && (
          <span className="dws-fact" data-tip={git.mainRepoPath ?? ""}>linked worktree</span>
        )}
      </div>

      {repo.rootPath && <div className="dws-path" data-tip={repo.rootPath}>{repo.rootPath}</div>}

      <div className="dws-actions">
        <button type="button" className="ws-btn ws-btn-quiet" onClick={onReveal} disabled={!repo.exists || revealing}>
          {revealing ? "打开中…" : "打开仓库目录"}
        </button>
      </div>

      <div className="dws-files">
        <div className="dws-subhead">
          改动文件
          {repo.changedFilesKnown ? `（${repo.changedFiles.length}）` : "（未读取）"}
        </div>
        {!repo.changedFilesKnown ? (
          <div className="dws-run-sub">
            改动清单未读取（详见下方风险提示）；这不代表没有改动。
          </div>
        ) : repo.changedFiles.length === 0 ? (
          <div className="dws-run-sub">当前没有未提交改动。</div>
        ) : (
          <ul className="ws-list">
            {repo.changedFiles.map((f) => (
              <li className="ws-row" key={`${f.status}:${f.path}`}>
                <span className="dws-file-status">{f.status}</span>
                <span className="dws-file-path" data-tip={f.path}>{f.path}</span>
                <span className="ws-badge ws-badge-soft">{f.group}</span>
              </li>
            ))}
          </ul>
        )}
        {repo.changedFilesKnown && repo.truncated && (
          <div className="dws-truncated">
            改动条目超过上限，仅列出前 {repo.changedFiles.length} 项（实际可能更多，请以仓库内 git status 为准）。
          </div>
        )}
      </div>

      {repo.risks.length > 0 && (
        <ul className="dws-risk-list">
          {repo.risks.map((flag, i) => (
            <RiskFlag key={`${flag.code}-${i}`} flag={flag} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function GitRiskPanel({
  projectId,
  archived,
  onNotice,
  devProjectId,
  onOpenDevWorkbench,
  switchModule,
}: CreativeModuleProps) {
  const [risk, setRisk] = useState<DwsRepoRisk[] | null>(null);
  const [history, setHistory] = useState<DwsProbeSnapshot[]>([]);
  const [advice, setAdvice] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    dwsGitRiskProbe(projectId)
      .then(({ risk }) => {
        if (seq !== seqRef.current) return;
        setRisk(risk.repos);
        setAdvice(risk.advice);
        setHistory(risk.history ?? []);
      })
      .catch((e) => {
        if (seq !== seqRef.current) return;
        setError(errorMessage(e));
        onNotice("error", errorMessage(e));
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
  }, [projectId, onNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const openWorkbench = () => {
    if (!devProjectId) {
      onNotice("error", "该项目还没有关联开发项目；请先到「项目设置」关联开发仓库。");
      return;
    }
    if (!onOpenDevWorkbench) {
      onNotice("error", "当前模块未拿到开发工作台导航回调，无法跳转；请从项目概览或右栏进入。");
      return;
    }
    try {
      // 统一走壳层导航事务（未保存确认 / 上下文提交 / 失败回退都由壳层负责）。
      onOpenDevWorkbench(devProjectId);
    } catch (e) {
      onNotice("error", `打开开发工作台失败：${errorMessage(e)}`);
    }
  };

  return (
    <div className="dws-panel">
      <div className="ws-card-head">
        <h2 className="dws-title">Git 与风险探测</h2>
        <div className="dws-actions">
          <button type="button" className="ws-btn ws-btn-quiet" onClick={load} disabled={loading}>
            {loading ? "探测中…" : "重新探测"}
          </button>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={openWorkbench}>
            打开开发工作台
          </button>
          {!devProjectId && (
            <button type="button" className="ws-btn" onClick={() => switchModule("settings")}>
              去项目设置
            </button>
          )}
        </div>
      </div>

      {archived && (
        <div className="ws-notice" data-tone="info">
          <span>项目已归档：探测结果只读展示，不写入新的关联。</span>
        </div>
      )}

      {error && (
        <div className="ws-notice" data-tone="error">
          <span>{error}</span>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={load}>重试</button>
        </div>
      )}

      {!error && risk === null && loading && (
        <div className="ws-state" data-tone="muted">正在探测 Git 状态…</div>
      )}

      {!error && risk !== null && risk.length === 0 && (
        <div className="ws-empty dws-empty-cta">
          <span>
            尚未关联开发仓库。到「项目设置」把本开发项目关联到 dev_projects 后，
            这里展示分支、改动与冲突风险。
          </span>
          <button type="button" className="ws-btn" onClick={() => switchModule("settings")}>
            去项目设置关联仓库
          </button>
        </div>
      )}

      {!error && risk !== null && risk.length > 0 && (
        <div className="dws-repo-list">
          {risk.map((repo) => (
            <RepoCard key={repo.devProjectId ?? repo.rootPath} repo={repo} onNotice={onNotice} />
          ))}
        </div>
      )}

      {advice && (
        <div className="ws-notice" data-tone="info">
          <span>{advice}</span>
        </div>
      )}

      {!error && risk !== null && <ProbeHistory history={history} />}
    </div>
  );
}
