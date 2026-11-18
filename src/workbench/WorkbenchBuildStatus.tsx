//! 底部状态栏「包信息」：一行给人和截图里的 AI 读的构建标识 + 一份可复制的结构化描述。
//!
//! 数据边界（2026-11-17 明确拆分）：
//! - **包内构建元数据**：`app_build_info` 返回编译期由 `build.rs` 注入的短/完整
//!   commit、构建时脏标记、构建时间、debug/release、exe 路径，以及运行期包元
//!   信息（包名/版本/标识/平台）。包被复制、升级、换机器后这些字段不变；
//! - **当前运行环境**：`app_runtime_git_info` 从当前 exe 向上找仓库并实时只读
//!   探测 HEAD/分支/未提交数，只代表「此刻这台机器上的工作区」，绝不拿来冒充
//!   安装包的构建提交。安装位置不在 Git 仓库时明确显示「不适用」。
//!
//! 安装包产物、构建 ID、包含任务属于构建台账（`tmp/integration/builds/`），运行时
//! 不可得，弹窗里只说明去哪看，不伪造这些字段。
//!
//! 降级：非 Tauri 预览或包信息 IPC 失败时整项不渲染；运行环境读取失败时仍保留
//! 状态栏与包信息，只在弹窗里把该区块标为「未知」，两种失败不混为一谈。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "../components/ui/Dialog";
import { useLocale } from "../hooks/useLocale";
import {
  appBuildInfo,
  appRuntimeGitInfo,
  type AppBuildInfo,
  type AppRuntimeGitInfo,
} from "../lib/bridge";
import { copyText } from "../lib/clipboard";

export interface WorkbenchBuildStatusProps {
  /** 读取包信息；测试注入替身，默认走 IPC。 */
  load?: () => Promise<AppBuildInfo>;
  /** 读取当前运行环境 Git 现场；测试注入替身，默认走 IPC。 */
  loadRuntime?: () => Promise<AppRuntimeGitInfo>;
  /** 复制文本；测试注入替身，默认走受控剪贴板。 */
  onCopy?: (text: string) => Promise<boolean>;
  /** 复制结果提示（父级统一 Toast）。 */
  onNotice?: (kind: "ok" | "error", text: string) => void;
}

/** 构建时间三视图：紧凑一行（状态栏）/完整本地时刻（弹窗）/ISO 与 Unix（机器读）。 */
export interface BuildStamp {
  compact: string;
  full: string;
  iso: string;
  unix: number;
}

/**
 * Unix 秒 → 本地时间。`unknown`、空值、非法值都返回 null，由调用方隐藏该字段，
 * 不显示「1970」这类假时间。
 */
export function formatBuildStamp(raw: string | number): BuildStamp | null {
  const unix = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(unix) || unix <= 0) return null;
  const date = new Date(unix * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return {
    compact: `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`,
    full: `${datePart} ${clock}`,
    iso: date.toISOString(),
    unix,
  };
}

/** ISO8601（运行期探测时间）→ 与构建时间同格式；非法值返回 null。 */
export function formatIsoStamp(raw: string | null | undefined): BuildStamp | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return formatBuildStamp(Math.floor(parsed / 1000));
}

/** 脏标记三态：只有明确 true 才提示「未提交」，unknown 不冒充干净。 */
function dirtyField(info: AppBuildInfo): "true" | "false" | "unknown" {
  return info.build.dirty === "true" || info.build.dirty === "false" ? info.build.dirty : "unknown";
}

/** 包内 commit 归一化：`unknown` / 空串都视为不可知，不用运行期 HEAD 补造。 */
function buildCommit(info: AppBuildInfo): { short: string | null; full: string | null } {
  const full =
    info.build.commit_full && info.build.commit_full.trim() && info.build.commit_full !== "unknown"
      ? info.build.commit_full.trim()
      : null;
  const rawShort = info.build.commit?.trim();
  const short =
    rawShort && rawShort !== "unknown" ? rawShort : full ? full.slice(0, 7) : null;
  return { short, full };
}

/**
 * 机器可读描述：键名与 IPC 字段一一对应，另加 `local`/`iso`/`unix` 三种时间视图，
 * 让 AI 既能按字段取值，也能把时间直接写进验收记录。运行环境单独放 `runtime`，
 * 并在字段名上明确 `observedAt`（不是安装包构建时间）。
 */
export function buildInfoSnapshot(
  info: AppBuildInfo,
  stamp: BuildStamp | null,
  runtime: AppRuntimeGitInfo | null = null,
) {
  const commit = buildCommit(info);
  return {
    name: info.name,
    version: info.version,
    identifier: info.identifier,
    platform: info.platform,
    build: {
      commit: commit.short ?? "unknown",
      commitFull: commit.full ?? "unknown",
      dirty: dirtyField(info),
      profile: info.build.profile,
      builtAt: stamp
        ? { local: stamp.full, iso: stamp.iso, unix: stamp.unix }
        : "unknown",
      exe: info.build.exe,
    },
    runtime: runtime
      ? {
          status: runtime.status,
          repoRoot: runtime.repoRoot,
          branch: runtime.branch,
          detached: runtime.detached,
          headSha: runtime.headSha,
          dirtyCount: runtime.dirtyCount,
          observedAt: runtime.probedAt,
        }
      : { status: "not_loaded" as const },
  };
}

export default function WorkbenchBuildStatus({
  load = appBuildInfo,
  loadRuntime = appRuntimeGitInfo,
  onCopy = copyText,
  onNotice,
}: WorkbenchBuildStatusProps) {
  const { t } = useLocale();
  const [info, setInfo] = useState<AppBuildInfo | null>(null);
  const [runtime, setRuntime] = useState<AppRuntimeGitInfo | null>(null);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    // 包信息是可选富信息：预览/单测等非 Tauri 环境 invoke 会拒绝，按「取不到就不渲染」降级。
    void load()
      .then((next) => {
        if (!disposed) setInfo(next);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [load]);

  useEffect(() => {
    let disposed = false;
    // 运行环境是独立读：包信息不因 git 不存在/仓库缺失而消失。
    void loadRuntime()
      .then((next) => {
        if (!disposed) setRuntime(next);
      })
      .catch(() => {
        if (!disposed) setRuntimeFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [loadRuntime]);

  const stamp = info ? formatBuildStamp(info.build.built_at_unix) : null;
  const dirty = info ? dirtyField(info) : "unknown";
  const commit = info ? buildCommit(info) : { short: null, full: null };
  const runtimeStamp = runtime ? formatIsoStamp(runtime.probedAt) : null;
  const machine = useMemo(
    () => (info ? JSON.stringify(buildInfoSnapshot(info, stamp, runtime), null, 2) : ""),
    [info, runtime, stamp],
  );

  const close = useCallback(() => setOpen(false), []);

  const handleCopy = useCallback(() => {
    if (!machine || busy) return;
    setBusy(true);
    void onCopy(machine)
      .then((ok) => {
        onNotice?.(
          ok ? "ok" : "error",
          t(ok ? "workbench.buildCopyOk" : "workbench.buildCopyFailed"),
        );
      })
      .finally(() => setBusy(false));
  }, [busy, machine, onCopy, onNotice, t]);

  // 连构建溯源都取不到（既无 commit 也无构建时间）时不占用状态栏：没有可核对的信息。
  if (!info) return null;
  if (commit.short === null && stamp === null) return null;

  const dirtyTag = dirty === "true" ? t("workbench.buildDirtyTag") : "";
  const timeText = stamp ? stamp.compact : t("workbench.buildUnknown");
  const commitText = commit.short ?? t("workbench.buildUnknown");
  const fullCommitText =
    commit.full ?? t("workbench.buildField.commitFullMissing");
  const channelText =
    info.build.profile === "debug"
      ? t("workbench.buildChannel.debug")
      : info.build.profile === "release"
        ? t("workbench.buildChannel.release")
        : t("workbench.buildUnknown");

  const packageRows: { label: string; value: string }[] = [
    { label: t("workbench.buildField.name"), value: info.name },
    { label: t("workbench.buildField.version"), value: info.version },
    { label: t("workbench.buildField.identifier"), value: info.identifier },
    { label: t("workbench.buildField.commitFull"), value: fullCommitText },
    { label: t("workbench.buildField.commitShort"), value: commitText },
    {
      label: t("workbench.buildField.builtAt"),
      value: stamp ? `${stamp.full}（Unix ${stamp.unix}）` : t("workbench.buildUnknown"),
    },
    { label: t("workbench.buildField.channel"), value: channelText },
    { label: t("workbench.buildField.worktree"), value: t(`workbench.buildDirty.${dirty}`) },
    { label: t("workbench.buildField.platform"), value: info.platform },
    { label: t("workbench.buildField.exe"), value: info.build.exe },
  ];

  const runtimeStateText = runtimeFailed
    ? t("workbench.buildRuntime.failed")
    : runtime === null
      ? t("workbench.buildRuntime.loading")
      : t(`workbench.buildRuntime.${runtime.status}`);

  const runtimeRows: { label: string; value: string }[] = [
    { label: t("workbench.buildField.gitStatus"), value: runtimeStateText },
  ];
  if (runtime && runtime.status === "ok") {
    runtimeRows.push(
      { label: t("workbench.buildField.repo"), value: runtime.repoRoot ?? t("workbench.buildUnknown") },
      {
        label: t("workbench.buildField.head"),
        value: runtime.headSha
          ? `${runtime.headSha.slice(0, 7)}（${runtime.headSha}）`
          : t("workbench.buildUnknown"),
      },
      {
        label: t("workbench.buildField.branch"),
        value: runtime.detached
          ? t("workbench.buildBranch.detached")
          : runtime.branch ?? t("workbench.buildUnknown"),
      },
      {
        label: t("workbench.buildField.runtimeDirty"),
        value:
          runtime.dirtyCount === null
            ? t("workbench.buildUnknown")
            : runtime.dirtyCount === 0
              ? t("workbench.buildRuntime.clean")
              : t("workbench.buildRuntime.dirty", { count: runtime.dirtyCount }),
      },
      {
        label: t("workbench.buildField.probedAt"),
        value: runtimeStamp ? runtimeStamp.full : t("workbench.buildUnknown"),
      },
    );
  }

  return (
    <>
      <button
        type="button"
        className="wb-status-item wb-status-build"
        data-tip={t("workbench.statusBuildTip", {
          name: info.name,
          version: info.version,
          commit: commit.full ?? commitText,
          profile: info.build.profile,
          time: timeText,
          identifier: info.identifier,
        })}
        aria-label={t("workbench.statusBuildAria", {
          version: info.version,
          commit: commitText,
        })}
        // 给自动读取（脚本/Agent 取 DOM）的稳定字段：与弹窗里可复制的 JSON 同源。
        data-build-version={info.version}
        data-build-identifier={info.identifier}
        data-build-platform={info.platform}
        data-build-commit={commit.short ?? "unknown"}
        data-build-commit-full={commit.full ?? "unknown"}
        data-build-dirty={dirty}
        data-build-profile={info.build.profile}
        data-build-built-at={stamp ? stamp.iso : "unknown"}
        data-build-built-at-unix={stamp ? stamp.unix : "unknown"}
        data-runtime-git-status={runtime?.status ?? (runtimeFailed ? "unavailable" : "loading")}
        data-runtime-git-dirty={runtime?.dirtyCount ?? "unknown"}
        onClick={() => setOpen(true)}
      >
        <span className="wb-status-build-text">
          {t("workbench.statusBuild", {
            commit: `${commitText}${dirtyTag}`,
            profile: info.build.profile,
            time: timeText,
          })}
        </span>
        {/* 窄窗只留最关键的提交号：状态栏还要放 Agent 会话数/磁盘/版本，不挤掉它们。 */}
        <span className="wb-status-build-short">
          {t("workbench.statusBuildShort", { commit: `${commitText}${dirtyTag}` })}
        </span>
      </button>

      <Dialog
        open={open}
        onClose={close}
        title={t("workbench.buildDialog.title")}
        size="md"
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              {t("workbench.buildClose")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={handleCopy}
              disabled={busy}
            >
              {t("workbench.buildCopy")}
            </button>
          </>
        }
      >
        <p className="wb-build-hint">{t("workbench.buildDialog.desc")}</p>

        <section className="wb-build-section">
          <div className="wb-build-section-title">
            {t("workbench.buildSection.package")}
          </div>
          <dl className="wb-build-list">
            {packageRows.map((row) => (
              <div className="wb-build-row" key={row.label}>
                <dt className="wb-build-label">{row.label}</dt>
                <dd className="wb-build-value">{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="wb-build-section" data-testid="wb-build-runtime">
          <div className="wb-build-section-title">
            {t("workbench.buildSection.runtime")}
          </div>
          <dl className="wb-build-list">
            {runtimeRows.map((row) => (
              <div className="wb-build-row" key={row.label}>
                <dt className="wb-build-label">{row.label}</dt>
                <dd className="wb-build-value">{row.value}</dd>
              </div>
            ))}
          </dl>
          <p className="wb-build-note">{t("workbench.buildRuntimeNote")}</p>
        </section>

        <p className="wb-build-note">{t("workbench.buildDialog.ledgerNote")}</p>
        <div className="wb-build-machine-title">{t("workbench.buildMachineTitle")}</div>
        <pre className="wb-build-machine" data-testid="wb-build-machine">
          {machine}
        </pre>
      </Dialog>
    </>
  );
}
