//! 项目中枢「专业工作进展」：一个统一外壳 + 五种领域内容（2026-11-23）。
//!
//! ## 为什么只有一层 UI
//! 五种项目类型的业务事实完全不同，重复的是「外壳」（标题、加载、空态、错误态）；
//! 因此本组件只维护一套状态机与一套语义化布局，领域差异由 `summary.kind` 的穷尽分支
//! 提供，不为每种类型复制整块面板。
//!
//! ## 异步生命周期（P0）
//! - `projectId` / `projectKind` 变化立即把状态打回 `loading`：旧项目的摘要不会在新项目下继续显示；
//! - 每次请求带自增代际号，过期响应（含 reject）直接丢弃，不写状态；
//! - 卸载时置位 `cancelled`，迟到的 resolve/reject 不再触发 `setState`；
//! - 失败只进入 `error`，不保留上一项目的数据，也不显示 0；
//! - 不轮询、不重试循环：只有用户点「重试」或工具栏刷新（`refreshToken` 变化）才重新请求。

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, Sparkles } from "lucide-react";
import { KIND_LABELS } from "../../lib/projectHub";
import type { ProjectKind } from "../../lib/projectHub/types";
import type { ComicOverviewStats } from "../../workbench/creative/comic/types";
import type { DwsDevelopmentSummary } from "../../workbench/creative/development/types";
import { buildStatusLabel } from "../../workbench/creative/game/types";
import type { GameOverviewStats } from "../../workbench/creative/game/types";
import type { GeneralStats } from "../../workbench/creative/general/ipc";
import type { NovelOverviewStats } from "../../workbench/creative/novel/types";
import {
  DOMAIN_SUMMARY_TITLE,
  domainSummaryUpdatedAt,
  fetchProjectDomainSummary,
  formatSummaryDate,
  formatWordCount,
  isDomainSummaryEmpty,
  isSupportedDomainKind,
  safePercent,
  summaryBelongsToProject,
  type ProjectDomainSummary,
} from "./projectHubDomainAdapter";

export interface ProjectHubDomainSummaryProps {
  projectId: string;
  /** 项目类型来自项目根 `kind`（不按名称猜测）。 */
  projectKind: string;
  /** 用户显式刷新（工具栏）时递增；只做手动刷新，不做常驻轮询。 */
  refreshToken?: number;
}

type SummaryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; summary: ProjectDomainSummary }
  | { status: "unsupported" }
  | { status: "error"; message: string };

type Tone = "ok" | "warn" | "danger";

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "未知错误";
}

function emptyHint(kind: ProjectDomainSummary["kind"]): string {
  switch (kind) {
    case "novel":
      return "这个小说项目还没有分卷、章节或人物设定；进入小说工作空间开始写作后，这里会显示真实章节与字数。";
    case "ai_comic":
      return "这个漫剧项目还没有剧集、分镜、角色或场景；进入漫剧工作空间建立剧集后，这里会显示制作进度。";
    case "game":
      return "这个游戏项目还没有登记资源、构建或测试记录；进入游戏工作空间登记后，这里会显示构建与测试状态。";
    case "development":
      return "这个开发项目还没有关联仓库或任务；在开发工作空间绑定仓库后，这里会显示仓库健康与任务进展。";
    case "general":
      return "这个通用项目还没有事项、里程碑或资料；进入通用工作空间后，这里会显示事项与里程碑进度。";
  }
}

export default function ProjectHubDomainSummary({
  projectId,
  projectKind,
  refreshToken = 0,
}: ProjectHubDomainSummaryProps) {
  const [state, setState] = useState<SummaryState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const requestSeq = useRef(0);

  useEffect(() => {
    // 代际号在 effect 进入时自增：任何更晚的请求都会让本次响应失效。
    const seq = ++requestSeq.current;
    let cancelled = false;

    if (!projectId || !isSupportedDomainKind(projectKind)) {
      // 未接入的类型不发请求，也不保留上一个项目的任何数据。
      setState(projectId ? { status: "unsupported" } : { status: "idle" });
      return () => {
        cancelled = true;
      };
    }

    // 切项目/切类型时立刻回到 loading：旧数据先在视觉上消失，再等新数据。
    setState({ status: "loading" });
    const kind = projectKind;
    fetchProjectDomainSummary(projectId, kind).then(
      (summary) => {
        if (cancelled || seq !== requestSeq.current) return;
        if (!summaryBelongsToProject(summary, projectId)) {
          // 一致性错误不落地：宁可如实报错，也不用错项目的数据渲染。
          setState({ status: "error", message: "专业摘要与当前项目不一致，请重试" });
          return;
        }
        setState({ status: "ready", summary });
      },
      (cause: unknown) => {
        if (cancelled || seq !== requestSeq.current) return;
        setState({ status: "error", message: errorText(cause) });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [projectId, projectKind, refreshToken, attempt]);

  const kindLabel = KIND_LABELS[projectKind as ProjectKind] ?? projectKind;
  const summary = state.status === "ready" ? state.summary : null;
  const updatedAt = summary ? domainSummaryUpdatedAt(summary) : null;

  return (
    <section
      className="ph-section ph-domain"
      aria-label={DOMAIN_SUMMARY_TITLE}
      data-kind={projectKind}
    >
      <div className="ph-domain-head">
        <h3>
          <Sparkles size={16} /> {DOMAIN_SUMMARY_TITLE}
        </h3>
        <span className="ph-tag" data-testid="ph-domain-kind">
          {kindLabel}
        </span>
        <span className="ph-domain-meta" role="status">
          {state.status === "loading"
            ? "读取中…"
            : updatedAt
              ? `最近更新 ${formatSummaryDate(updatedAt) ?? updatedAt}`
              : ""}
        </span>
      </div>

      {state.status === "unsupported" ? (
        <p className="ph-muted" data-testid="ph-domain-unsupported">
          尚未接入专业摘要：{kindLabel} 项目当前没有可用的领域统计接口。
        </p>
      ) : null}

      {state.status === "loading" ? (
        <div className="ph-domain-skeleton" role="status" aria-label="正在读取专业摘要">
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="ph-domain-error" role="alert" data-testid="ph-domain-error">
          <AlertTriangle size={14} />
          <span>专业摘要暂不可用{state.message ? `：${state.message}` : ""}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </button>
        </div>
      ) : null}

      {summary && isDomainSummaryEmpty(summary) ? (
        <p className="ph-muted" data-testid="ph-domain-empty">
          暂无专业数据。{emptyHint(summary.kind)}
        </p>
      ) : null}

      {summary && !isDomainSummaryEmpty(summary) ? (
        <>
          {summary.kind === "novel" ? <NovelSummary data={summary.data} /> : null}
          {summary.kind === "ai_comic" ? <ComicSummary data={summary.data} /> : null}
          {summary.kind === "game" ? <GameSummary data={summary.data} /> : null}
          {summary.kind === "development" ? <DevelopmentSummary data={summary.data} /> : null}
          {summary.kind === "general" ? <GeneralSummary data={summary.data} /> : null}
          <p className="ph-domain-foot">
            摘要只读，数据来自对应专业工作空间；需要修改请打开工作空间。
            <ChevronRight size={12} />
          </p>
        </>
      ) : null}
    </section>
  );
}

// ── 公共小部件（统一设计语言，业务内容由各领域提供）─────────────────────

function DomainMetric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string | null;
  tone?: Tone;
}) {
  return (
    <div className="ph-domain-metric">
      <span>{label}</span>
      <strong className={tone ? `tone-${tone}` : undefined}>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function DomainLine({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <li>
      <span>{label}</span>
      <b className={tone ? `tone-${tone}` : undefined}>{value}</b>
    </li>
  );
}

function ToneDot({ tone }: { tone: Tone }) {
  return <span className={`ph-dot ${tone === "ok" ? "ok" : tone === "warn" ? "warn" : "danger"}`} />;
}

// ── 小说：突出章节与字数 ────────────────────────────────────────────────

function NovelSummary({ data }: { data: NovelOverviewStats }) {
  const targetPercent =
    data.targetWords && data.targetWords > 0 ? safePercent(data.words, data.targetWords) : null;
  return (
    <>
      <div className="ph-domain-metrics">
        <DomainMetric label="章节" value={String(data.chapters)} hint={`${data.volumes} 卷`} />
        <DomainMetric
          label="总字数"
          value={formatWordCount(data.words)}
          hint={
            data.targetWords
              ? `目标 ${formatWordCount(data.targetWords)}${
                  targetPercent === null ? "" : ` · 完成 ${targetPercent}%`
                }`
              : "尚未设置全书目标字数"
          }
        />
        <DomainMetric
          label="角色"
          value={String(data.characters)}
          hint={data.characters === 0 ? "还没有人物档案" : "人物档案"}
        />
        <DomainMetric
          label="世界观"
          value={String(data.worldviews)}
          hint={data.locations > 0 ? `含地点 ${data.locations} 条` : "设定条目"}
        />
      </div>
      <ul className="ph-domain-lines">
        {/* 口径说明：后端没有按日字数增量历史，这两个字段是「近 7 天有保存的章节及其当前字数」。 */}
        <DomainLine
          label="近 7 天更新"
          value={`${data.recentChapters} 章 · 合计 ${formatWordCount(data.recentWords)}`}
        />
        {data.lastChapter ? (
          <DomainLine
            label="最近章节"
            value={`${
              data.lastChapter.volumeTitle ? `${data.lastChapter.volumeTitle} · ` : ""
            }${data.lastChapter.title} · ${formatWordCount(data.lastChapter.wordCount)}`}
          />
        ) : null}
      </ul>
    </>
  );
}

// ── 漫剧：突出剧集与分镜制作进度 ────────────────────────────────────────

function ComicSummary({ data }: { data: ComicOverviewStats }) {
  const shotPercent = safePercent(data.completedShotCount, data.shotCount);
  const episodePercent = safePercent(data.completedEpisodeCount, data.episodeCount);
  return (
    <>
      <div className="ph-domain-metrics">
        <DomainMetric
          label="剧集"
          value={String(data.episodeCount)}
          hint={`${data.completedEpisodeCount} 集已完成`}
        />
        <DomainMetric
          label="分镜"
          value={String(data.shotCount)}
          hint={`${data.completedShotCount} / ${data.shotCount} 已完成`}
          tone={data.blockedShotCount > 0 ? "warn" : undefined}
        />
        <DomainMetric
          label="角色"
          value={String(data.characterCount)}
          hint={data.characterCount === 0 ? "还没有角色档案" : "形象档案"}
        />
        <DomainMetric label="场景" value={String(data.sceneCount)} hint="场景参考" />
        <DomainMetric
          label="素材"
          value={String(data.mediaCount)}
          hint={`${data.adoptedMediaCount} 个已采用`}
        />
      </div>

      {data.shotCount > 0 && shotPercent !== null ? (
        <div className="ph-domain-progress">
          <div className="ph-domain-progress-head">
            <span>分镜完成度</span>
            <b>{shotPercent}%</b>
          </div>
          <div
            className="ph-domain-bar"
            role="progressbar"
            aria-label="分镜完成度"
            aria-valuenow={shotPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${shotPercent}%` }} />
          </div>
        </div>
      ) : null}

      <ul className="ph-domain-lines">
        {episodePercent !== null ? (
          <DomainLine label="剧集完成度" value={`${episodePercent}%`} />
        ) : null}
        <DomainLine label="待制作分镜" value={`${data.pendingShotCount} 个`} />
        <DomainLine label="制作中分镜" value={`${data.doingShotCount} 个`} />
        {data.blockedShotCount > 0 ? (
          <DomainLine label="受阻分镜" value={`${data.blockedShotCount} 个`} tone="warn" />
        ) : null}
      </ul>
    </>
  );
}

// ── 游戏：突出构建与测试状态 ────────────────────────────────────────────

function buildTone(status: string | null): Tone | undefined {
  if (status === "success") return "ok";
  if (status === "failed") return "danger";
  if (status === "planned") return "warn";
  return undefined;
}

function GameSummary({ data }: { data: GameOverviewStats }) {
  const latestDate = formatSummaryDate(data.latestBuildAt);
  return (
    <>
      <div className="ph-domain-metrics">
        <DomainMetric
          label="资源"
          value={String(data.assetCount)}
          hint={data.assetCount === 0 ? "还没有登记资源" : "已登记"}
        />
        <DomainMetric
          label="构建"
          value={String(data.buildCount)}
          hint={`${data.successfulBuildCount} 成功 · ${data.failedBuildCount} 失败`}
          tone={data.failedBuildCount > 0 ? "danger" : undefined}
        />
        <DomainMetric
          label="测试"
          value={String(data.testCount)}
          hint={`${data.passedTestCount} 通过 · ${data.failedTestCount} 失败`}
          tone={data.failedTestCount > 0 ? "danger" : undefined}
        />
      </div>

      <ul className="ph-domain-lines">
        {data.latestBuildStatus ? (
          <DomainLine
            label="最近构建"
            value={`${buildStatusLabel(data.latestBuildStatus)}${latestDate ? ` · ${latestDate}` : ""}`}
            tone={buildTone(data.latestBuildStatus)}
          />
        ) : (
          <DomainLine label="最近构建" value="还没有构建记录" />
        )}
        {data.plannedBuildCount > 0 ? (
          <DomainLine label="计划中构建" value={`${data.plannedBuildCount} 次`} />
        ) : null}
        {data.blockedTestCount > 0 ? (
          <DomainLine label="受阻测试" value={`${data.blockedTestCount} 次`} tone="warn" />
        ) : null}
      </ul>
    </>
  );
}

// ── 开发：突出仓库健康 ──────────────────────────────────────────────────

function gitStatusText(info: DwsDevelopmentSummary["devProjects"][number]["git"]): {
  label: string;
  tone: Tone;
} {
  switch (info.status) {
    case "ok":
      return { label: "Git 正常", tone: "ok" };
    case "path_missing":
      return { label: "路径失效", tone: "danger" };
    case "not_a_repo":
      return { label: "不是 Git 仓库", tone: "warn" };
    case "git_unavailable":
      return { label: "Git 不可用", tone: "warn" };
    default:
      return { label: "未识别", tone: "warn" };
  }
}

function dirtyText(info: DwsDevelopmentSummary["devProjects"][number]["git"]): string {
  // `dirtyCount = null` 表示未能统计（如 git 不可用），绝不能显示成 0 项改动。
  if (info.dirtyCount === null) return "改动未统计";
  if (info.dirtyCount === 0) return "工作区干净";
  return `${info.dirtyCount} 项未提交`;
}

function DevelopmentSummary({ data }: { data: DwsDevelopmentSummary }) {
  const repos = data.devProjects;
  const alive = repos.filter((repo) => repo.exists).length;
  const lost = repos.length - alive;
  const tasks = data.tasks;
  const doneTasks = tasks.filter((task) => task.status === "completed").length;
  // tasks 只有 pending / completed / missing（后端真实枚举），不存在「进行中」，不虚构该指标。
  const pendingTasks = tasks.filter((task) => task.status === "pending").length;
  const missingTasks = tasks.filter((task) => task.status === "missing").length;
  const shownRepos = repos.slice(0, 4);

  return (
    <>
      <div className="ph-domain-metrics">
        <DomainMetric
          label="关联仓库"
          value={String(repos.length)}
          hint={lost > 0 ? `${alive} 可用 · ${lost} 路径失效` : `${alive} 个可用`}
          tone={lost > 0 ? "danger" : undefined}
        />
        <DomainMetric
          label="关联任务"
          value={String(tasks.length)}
          hint={`${doneTasks} 已完成 · ${pendingTasks} 待完成`}
        />
        {data.archived ? (
          <DomainMetric label="项目状态" value="已归档" hint="只读查看" tone="warn" />
        ) : null}
      </div>

      {repos.length > 0 ? (
        <ul className="ph-domain-repos">
          {shownRepos.map((repo) => {
            const git = gitStatusText(repo.git);
            return (
              <li key={repo.devProjectId}>
                <div className="ph-domain-repo-head">
                  <ToneDot tone={git.tone} />
                  <strong title={repo.rootPath}>{repo.name}</strong>
                  <span className="ph-tag">{git.label}</span>
                </div>
                <small>
                  {repo.exists
                    ? `${repo.git.branch ?? "未识别分支"}${repo.git.detached ? "（detached）" : ""} · ${dirtyText(repo.git)}`
                    : `路径失效：${repo.rootPath}`}
                </small>
              </li>
            );
          })}
          {repos.length > shownRepos.length ? (
            <li className="ph-muted">另有 {repos.length - shownRepos.length} 个仓库，在开发工作空间查看。</li>
          ) : null}
        </ul>
      ) : (
        <p className="ph-muted">还没有关联开发仓库。</p>
      )}

      <ul className="ph-domain-lines">
        <DomainLine label="任务进展" value={`${doneTasks} / ${tasks.length} 已完成`} />
        {missingTasks > 0 ? (
          <DomainLine label="失效任务引用" value={`${missingTasks} 个（任务已删除）`} tone="danger" />
        ) : null}
        <DomainLine label="统计口径" value="仓库与任务分开计数，任务来自事项库弱引用" />
      </ul>
    </>
  );
}

// ── 通用：突出事项与里程碑 ──────────────────────────────────────────────

function GeneralSummary({ data }: { data: GeneralStats }) {
  const milestonePercent = safePercent(data.milestonesDone, data.milestonesTotal);
  return (
    <>
      <div className="ph-domain-metrics">
        <DomainMetric
          label="事项"
          value={String(data.totalItems)}
          hint={`${data.todoItems} 待办 · ${data.doingItems} 进行中 · ${data.doneItems} 已完成`}
        />
        <DomainMetric
          label="里程碑"
          value={String(data.milestonesTotal)}
          hint={
            milestonePercent === null
              ? `已完成 ${data.milestonesDone} 个`
              : `已完成 ${data.milestonesDone} / ${data.milestonesTotal} · ${milestonePercent}%`
          }
        />
        <DomainMetric
          label="资料"
          value={String(data.materialsTotal)}
          hint={`${data.materialsAlive} 个可用`}
          tone={data.materialsTotal > data.materialsAlive ? "warn" : undefined}
        />
        <DomainMetric
          label="关联任务"
          value={String(data.linkedTasks)}
          hint="事项库弱引用，与公共项目任务分开统计"
        />
      </div>

      <ul className="ph-domain-lines">
        {data.blockedItems > 0 ? (
          <DomainLine label="阻塞事项" value={`${data.blockedItems} 个`} tone="warn" />
        ) : null}
        {data.milestonesOpen > 0 ? (
          <DomainLine label="进行中里程碑" value={`${data.milestonesOpen} 个`} />
        ) : null}
        {data.currentMilestone ? (
          <DomainLine
            label="当前里程碑"
            value={`${data.currentMilestone.title}${
              data.currentMilestone.targetDate ? ` · ${data.currentMilestone.targetDate}` : ""
            }`}
          />
        ) : null}
        {data.milestonesSkipped > 0 ? (
          <DomainLine label="已跳过里程碑" value={`${data.milestonesSkipped} 个`} />
        ) : null}
      </ul>
    </>
  );
}
