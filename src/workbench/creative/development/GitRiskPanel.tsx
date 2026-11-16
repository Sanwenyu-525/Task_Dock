//! E4：Git / Worktree 风险探测面板（只读）。
//!
//! 边界：只展示探测事实与风险提示，不提供任何写 Git 操作入口；
//! 目录失效如实降级，不伪造分支 / 提交，不自动重建目录。

import { useCallback, useEffect, useRef, useState } from "react";
import type { CreativeModuleProps } from "../types";
import { errorMessage } from "../../../lib/errors";
import {
  dwsGitRiskProbe,
  dwsOpenDevWorkbench,
  dwsRevealPath,
} from "./ipc";
import type { DwsRepoRisk, DwsRiskFlag } from "./types";

const STATUS_LABELS: Record<string, string> = {
  ok: "Git 仓库",
  not_a_repo: "非 Git 目录",
  git_unavailable: "git 不可用",
  path_missing: "路径失效",
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

function RepoCard({ repo }: { repo: DwsRepoRisk }) {
  const git = repo.git;
  const statusLabel = STATUS_LABELS[git.status] ?? git.status;
  const headShort = git.headSha ? git.headSha.slice(0, 8) : null;

  const onReveal = () => {
    if (!repo.exists) return;
    dwsRevealPath(repo.rootPath).catch(() => undefined);
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
        {git.branch && <span className="dws-fact">分支：{git.branch}</span>}
        {git.detached && <span className="ws-badge ws-badge-limited">detached HEAD</span>}
        {headShort && <span className="dws-fact" data-tip={git.headSha ?? ""}>提交：{headShort}</span>}
        {git.dirtyCount !== null && (
          <span className="dws-fact">未提交：{git.dirtyCount} 处</span>
        )}
        {git.isWorktree && (
          <span className="dws-fact" data-tip={git.mainRepoPath ?? ""}>linked worktree</span>
        )}
      </div>

      {repo.rootPath && (
        <div className="dws-path" data-tip={repo.rootPath}>{repo.rootPath}</div>
      )}

      <div className="dws-actions">
        <button type="button" className="ws-btn ws-btn-quiet" onClick={onReveal} disabled={!repo.exists}>
          打开仓库目录
        </button>
      </div>

      {repo.changedFiles.length > 0 && (
        <div className="dws-files">
          <div className="dws-subhead">改动文件（{repo.changedFiles.length}）</div>
          <ul className="ws-list">
            {repo.changedFiles.map((f) => (
              <li className="ws-row" key={f.path}>
                <span className="dws-file-status">{f.status}</span>
                <span className="dws-file-path" data-tip={f.path}>{f.path}</span>
                <span className="ws-badge ws-badge-soft">{f.group}</span>
              </li>
            ))}
          </ul>
          {repo.truncated && <div className="dws-truncated">改动较多，仅列出前 {repo.changedFiles.length} 项。</div>}
        </div>
      )}

      {repo.risks.length > 0 && (
        <ul className="dws-risk-list">
          {repo.risks.map((flag) => (
            <RiskFlag key={flag.code} flag={flag} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function GitRiskPanel({ projectId, archived, onNotice }: CreativeModuleProps) {
  const [risk, setRisk] = useState<DwsRepoRisk[] | null>(null);
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
    dwsOpenDevWorkbench(projectId).catch(() => undefined);
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
        <div className="ws-empty">尚未关联开发仓库；关联后这里展示分支、改动与冲突风险。</div>
      )}

      {!error && risk !== null && risk.length > 0 && (
        <div className="dws-repo-list">
          {risk.map((repo) => (
            <RepoCard key={repo.devProjectId ?? repo.rootPath} repo={repo} />
          ))}
        </div>
      )}

      {advice && (
        <div className="ws-notice" data-tone="info">
          <span>{advice}</span>
        </div>
      )}
    </div>
  );
}
