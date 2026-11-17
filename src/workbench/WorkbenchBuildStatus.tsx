//! 底部状态栏「包信息」：一行给人和截图里的 AI 读的构建标识 + 一份可复制的结构化描述。
//!
//! 数据边界：`app_build_info` 只返回编译期注入的构建溯源（短 commit、脏标记、
//! 构建时间、debug/release、exe 路径）与运行期包元信息（包名/版本/标识/平台）。
//! 安装包产物、构建 ID、包含任务属于构建台账（`tmp/integration/builds/`），运行时
//! 不可得，弹窗里只说明去哪看，不伪造这些字段。
//!
//! 降级：非 Tauri 预览或 IPC 失败时整项不渲染（与状态栏其它可选项同一策略）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "../components/ui/Dialog";
import { useLocale } from "../hooks/useLocale";
import { appBuildInfo, type AppBuildInfo } from "../lib/bridge";
import { copyText } from "../lib/clipboard";

export interface WorkbenchBuildStatusProps {
  /** 读取包信息；测试注入替身，默认走 IPC。 */
  load?: () => Promise<AppBuildInfo>;
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

/** 脏标记三态：只有明确 true 才提示「未提交」，unknown 不冒充干净。 */
function dirtyField(info: AppBuildInfo): "true" | "false" | "unknown" {
  return info.build.dirty === "true" || info.build.dirty === "false" ? info.build.dirty : "unknown";
}

/**
 * 机器可读描述：键名与 IPC 字段一一对应，另加 `local`/`iso`/`unix` 三种时间视图，
 * 让 AI 既能按字段取值，也能把时间直接写进验收记录。
 */
export function buildInfoSnapshot(info: AppBuildInfo, stamp: BuildStamp | null) {
  return {
    name: info.name,
    version: info.version,
    identifier: info.identifier,
    platform: info.platform,
    build: {
      commit: info.build.commit,
      dirty: dirtyField(info),
      profile: info.build.profile,
      builtAt: stamp
        ? { local: stamp.full, iso: stamp.iso, unix: stamp.unix }
        : "unknown",
      exe: info.build.exe,
    },
  };
}

export default function WorkbenchBuildStatus({
  load = appBuildInfo,
  onCopy = copyText,
  onNotice,
}: WorkbenchBuildStatusProps) {
  const { t } = useLocale();
  const [info, setInfo] = useState<AppBuildInfo | null>(null);
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

  const stamp = info ? formatBuildStamp(info.build.built_at_unix) : null;
  const dirty = info ? dirtyField(info) : "unknown";
  const machine = useMemo(
    () => (info ? JSON.stringify(buildInfoSnapshot(info, stamp), null, 2) : ""),
    [info, stamp],
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
  if (info.build.commit === "unknown" && stamp === null) return null;

  const dirtyTag = dirty === "true" ? t("workbench.buildDirtyTag") : "";
  const timeText = stamp ? stamp.compact : t("workbench.buildUnknown");

  const rows: { label: string; value: string }[] = [
    { label: t("workbench.buildField.name"), value: info.name },
    { label: t("workbench.buildField.version"), value: info.version },
    { label: t("workbench.buildField.identifier"), value: info.identifier },
    { label: t("workbench.buildField.commit"), value: `${info.build.commit}${dirtyTag}` },
    {
      label: t("workbench.buildField.builtAt"),
      value: stamp ? `${stamp.full}（Unix ${stamp.unix}）` : t("workbench.buildUnknown"),
    },
    { label: t("workbench.buildField.worktree"), value: t(`workbench.buildDirty.${dirty}`) },
    { label: t("workbench.buildField.profile"), value: info.build.profile },
    { label: t("workbench.buildField.platform"), value: info.platform },
    { label: t("workbench.buildField.exe"), value: info.build.exe },
  ];

  return (
    <>
      <button
        type="button"
        className="wb-status-item wb-status-build"
        data-tip={t("workbench.statusBuildTip", {
          name: info.name,
          version: info.version,
          identifier: info.identifier,
        })}
        aria-label={t("workbench.statusBuildAria", {
          version: info.version,
          commit: info.build.commit,
        })}
        // 给自动读取（脚本/Agent 取 DOM）的稳定字段：与弹窗里可复制的 JSON 同源。
        data-build-version={info.version}
        data-build-identifier={info.identifier}
        data-build-platform={info.platform}
        data-build-commit={info.build.commit}
        data-build-dirty={dirty}
        data-build-profile={info.build.profile}
        data-build-built-at={stamp ? stamp.iso : "unknown"}
        data-build-built-at-unix={stamp ? stamp.unix : "unknown"}
        onClick={() => setOpen(true)}
      >
        <span className="wb-status-build-text">
          {t("workbench.statusBuild", {
            commit: `${info.build.commit}${dirtyTag}`,
            profile: info.build.profile,
            time: timeText,
          })}
        </span>
        {/* 窄窗只留最关键的提交号：状态栏还要放 Agent 会话数/磁盘/版本，不挤掉它们。 */}
        <span className="wb-status-build-short">
          {t("workbench.statusBuildShort", { commit: `${info.build.commit}${dirtyTag}` })}
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
        <dl className="wb-build-list">
          {rows.map((row) => (
            <div className="wb-build-row" key={row.label}>
              <dt className="wb-build-label">{row.label}</dt>
              <dd className="wb-build-value">{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="wb-build-note">{t("workbench.buildDialog.ledgerNote")}</p>
        <div className="wb-build-machine-title">{t("workbench.buildMachineTitle")}</div>
        <pre className="wb-build-machine" data-testid="wb-build-machine">
          {machine}
        </pre>
      </Dialog>
    </>
  );
}
