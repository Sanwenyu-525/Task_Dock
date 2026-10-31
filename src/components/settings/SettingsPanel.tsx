//! 设置面板：外观与主题 / 窗口与快捷键 / 通知 / Agent 接入 / 数据与备份 / 开发者选项。
//! 统一控件风格；高级选项（Agent 接入细节、开发者工具）默认折叠。

import { useEffect, useState } from "react";
import { save, open as openDialog, confirm } from "@tauri-apps/plugin-dialog";
import {
  Palette, AppWindow, Bell, Bot, Database, FlaskConical, Copy, Eye, EyeOff,
  RefreshCw, ChevronDown, ChevronRight, Navigation, Clipboard, Trash2, Gauge, Layers,
} from "lucide-react";
import {
  auditTestData,
  backupNow,
  clipboardCleanup,
  clipboardProbe,
  clipboardRepairConfig,
  clipboardStats,
  clipboardStatus,
  exportData,
  getAgentInboxDir,
  importData,
  inspectBackup,
  listBackups,
  setAutostart,
  setHotkeysEnabled,
  performanceDiagnostics,
  agentRetentionRun,
  agentInboxRetry,
  type AuditTableCounts,
  type BackupEntry,
  type ClipboardConfigError,
  type ClipboardStats,
  type PerformanceDiagnostics,
  type TestDataAudit,
} from "../../lib/bridge";
import { getAgentRefreshMetrics } from "../../store/useAgentsStore";
import { formatBytes, kindLabel } from "../../lib/clipboardUi";
import { useSettingsStore } from "../../store/useSettingsStore";
import {
  PRESET_LABELS,
  VISUAL_PRESETS,
  resolveVisualPreset,
} from "../../lib/theme";
import { useUiStore } from "../../store/useUiStore";
import { copyText } from "../../lib/clipboard";
import MockControls from "../agents/MockControls";
import AppManagement from "./AppManagement";
import { NumberInput, Select, Switch } from "../ui";

function sumAuditCounts(c: AuditTableCounts): number {
  return c.events + c.sessions + c.runs + c.instances + c.notifications;
}

/** 可折叠设置分组。 */
function Section({
  icon: Icon,
  title,
  description,
  defaultOpen = true,
  children,
}: {
  icon: typeof Palette;
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="settings-section">
      <button className="settings-section-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="settings-section-title">
          <Icon size={13} /> {title}
          {open ? <ChevronDown size={12} className="settings-chevron" /> : <ChevronRight size={12} className="settings-chevron" />}
        </span>
        {description && <span className="settings-section-desc">{description}</span>}
      </button>
      {open && <div className="settings-section-body">{children}</div>}
    </section>
  );
}

export default function SettingsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const materialInfo = useSettingsStore((s) => s.materialInfo);
  const showToast = useUiStore((s) => s.showToast);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [inboxDir, setInboxDir] = useState("");
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [clipStats, setClipStats] = useState<ClipboardStats | null>(null);
  const [clipConfigError, setClipConfigError] = useState<ClipboardConfigError | null>(null);
  const [clipConfigOrigin, setClipConfigOrigin] = useState<string | null>(null);
  const [excludeApps, setExcludeApps] = useState("");
  const [diag, setDiag] = useState<PerformanceDiagnostics | null>(null);
  const [testAudit, setTestAudit] = useState<TestDataAudit | null>(null);

  useEffect(() => {
    listBackups().then(setBackups).catch(() => setBackups([]));
    clipboardStats().then(setClipStats).catch(() => setClipStats(null));
    clipboardStatus()
      .then((s) => {
        setClipConfigError(s.configError ?? null);
        setClipConfigOrigin(s.configOrigin ?? null);
      })
      .catch(() => {});
  }, []);

  async function onRepairClipboard(resume: boolean) {
    setBusyKey("clip-repair");
    try {
      await clipboardRepairConfig(resume);
      await useSettingsStore.getState().load();
      const status = await clipboardStatus();
      setClipConfigError(status.configError ?? null);
      setClipConfigOrigin(status.configOrigin ?? null);
      setClipStats(await clipboardStats());
      showToast(
        resume ? "剪贴板配置已修复，自动记录已恢复" : "剪贴板配置已修复，自动记录保持暂停",
        { kind: "success" },
      );
    } catch (e) {
      showToast(`修复剪贴板配置失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  useEffect(() => {
    if (settings) setExcludeApps(settings.clipboard_exclude_apps);
  }, [settings?.clipboard_exclude_apps]);

  async function refreshDiag() {
    setBusyKey("diag");
    try {
      setDiag(await performanceDiagnostics());
    } catch (e) {
      showToast(`诊断读取失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  async function onRetentionRun() {
    await withBusy("retention", async () => {
      const r = await agentRetentionRun();
      showToast(
        `清理完成：删除 ${r.deleted} 条 running/idle 事件，归档 ${r.archived} 条` +
          (r.archive_error ? `（归档异常：${r.archive_error}）` : ""),
        { kind: r.archive_error ? "error" : "success" },
      );
      await refreshDiag();
    });
  }

  async function onInboxRetry() {
    await withBusy("inbox-retry", async () => {
      const n = await agentInboxRetry();
      showToast(`已移回 ${n} 个失败投递文件`, { kind: "success" });
    });
  }

  async function onAuditPreview() {
    await withBusy("audit-preview", async () => {
      const r = await auditTestData(false);
      setTestAudit(r);
      const n = sumAuditCounts(r.provable_total);
      showToast(
        n > 0
          ? `发现 ${n} 条可证明的测试/压测数据（dry-run，未修改任何数据）`
          : "没有可证明的测试/压测数据",
        { kind: "success" },
      );
    });
  }

  async function onAuditApply() {
    await withBusy("audit-apply", async () => {
      const preview = testAudit ?? (await auditTestData(false));
      setTestAudit(preview);
      const n = sumAuditCounts(preview.provable_total);
      if (n === 0) {
        showToast("没有可证明的测试数据，无需清理", { kind: "success" });
        return;
      }
      const ok = await confirm(
        `将删除 ${n} 条可证明的测试/压测数据（事件、会话、轮次、实例与通知）。\n\n` +
          "清理前会自动生成数据库快照（VACUUM INTO），失败即中止；\n" +
          "无法证明来源的数据保持不动，并列入待人工确认。\n\n继续清理？",
        { title: "清理测试/压测数据", kind: "warning" },
      );
      if (!ok) return;
      const r = await auditTestData(true);
      setTestAudit(r);
      const deleted = r.deleted ? sumAuditCounts(r.deleted) : 0;
      showToast(
        r.backup_path
          ? `已清理 ${deleted} 条；清理前快照：${r.backup_path}`
          : r.notes[0] ?? "未删除任何数据",
        { kind: r.fk_violations > 0 ? "error" : "success" },
      );
    });
  }

  async function refreshClipStats() {
    try {
      setClipStats(await clipboardStats());
    } catch {
      // 统计失败不影响设置读写
    }
  }

  async function onClipCleanup() {
    setBusyKey("clip-cleanup");
    try {
      const r = await clipboardCleanup();
      await refreshClipStats();
      showToast(
        `清理完成：删除 ${r.items_deleted} 条，关闭 ${r.groups_closed} 个分组，释放 ${formatBytes(r.bytes_freed)}`,
        { kind: "success" },
      );
    } catch (e) {
      showToast(`清理失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  async function onClipProbe() {
    setBusyKey("clip-probe");
    try {
      const r = await clipboardProbe();
      if (r.readable) {
        showToast(
          `当前剪贴板可读取：${kindLabel(r.kind ?? "")}，${formatBytes(r.bytes ?? 0)}${
            r.fileCount ? `，${r.fileCount} 个文件` : ""
          }（探测不返回正文）`,
          { kind: "success" },
        );
      } else {
        showToast(`当前剪贴板不可记录：${r.reason ?? "格式不支持"}`, { kind: "info" });
      }
    } catch (e) {
      showToast(`探测失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  if (!settings) return <div className="empty-hint">加载中…</div>;

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusyKey(key);
    try {
      await fn();
    } catch (e) {
      showToast(`操作失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  async function onExport() {
    await withBusy("export", async () => {
      const path = await save({
        defaultPath: `task-dock-export-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await exportData(path);
      showToast(`已导出：${path}`, { kind: "success" });
    });
  }

  async function onImport() {
    await withBusy("import", async () => {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "Task Dock 备份", extensions: ["jsonl", "json"] }],
      });
      if (!path || Array.isArray(path)) return;
      const meta = await inspectBackup(path);
      const truncated = meta.truncated_tables ?? [];
      const lines = [
        meta.partial
          ? "这是快速/部分备份：事件、通知、导航日志与剪贴板历史按上限截断，恢复后超出部分不会回来。"
          : meta.format === "legacy-json"
            ? "这是旧版 JSON 导出：仅恢复任务/Agent/导航，库内剪贴板、工作现场与行动中心数据会保留。"
            : "完整备份：将替换任务、Agent、导航、剪贴板与工作现场等全部数据。",
        truncated.length ? `截断的表：${truncated.join("、")}（这些表只保留备份内的部分行）。` : "",
        "恢复前会自动创建完整恢复点；任一环节失败将自动回滚到恢复前状态。",
        "继续恢复？",
      ].filter(Boolean);
      const ok = await confirm(lines.join("\n\n"), {
        title: meta.partial ? "恢复部分备份" : "恢复备份",
        kind: "warning",
      });
      if (!ok) return;
      const outcome = await importData(path, meta.partial);
      setBackups(await listBackups());
      showToast(
        `恢复完成：${outcome.message}${
          outcome.assets || outcome.archives ? `（资产 ${outcome.assets}，归档 ${outcome.archives}）` : ""
        }`,
        { kind: "success" },
      );
    });
  }

  async function onCopyInbox() {
    await withBusy("inbox", async () => {
      const dir = await getAgentInboxDir();
      setInboxDir(dir);
      const ok = await copyText(dir);
      showToast(ok ? `已复制：${dir}` : `目录：${dir}`, { kind: ok ? "success" : "info" });
    });
  }

  async function onCopyToken() {
    await withBusy("token", async () => {
      const token = useSettingsStore.getState().settings?.http_token ?? "";
      const ok = await copyText(token);
      showToast(ok ? "令牌已复制" : "复制失败，请展开后手动选择", { kind: ok ? "success" : "error" });
    });
  }

  const glassDowngraded =
    settings.material === "glass" && materialInfo?.resolved === "solid";
  const pipe = diag?.pipeline;
  const inboxStats = diag?.file_drop;
  const retention = diag?.retention;
  const frontendMetrics = getAgentRefreshMetrics();

  return (
    <div className="settings-panel">
      <Section icon={Palette} title="外观与主题">
        {/* v0.6：视觉预设（设计语言）与明暗/材质正交，切换即时生效且不影响业务状态 */}
        <div className="setting-row column">
          <span>视觉主题</span>
          <div className="preset-picker" role="radiogroup" aria-label="视觉主题">
            {VISUAL_PRESETS.map((id) => {
              const active = resolveVisualPreset(settings.visual_preset) === id;
              return (
                <button
                  key={id}
                  role="radio"
                  aria-checked={active}
                  className={`preset-card preset-${id} ${active ? "active" : ""}`}
                  onClick={() => update({ visual_preset: id })}
                  title={PRESET_LABELS[id].tagline}
                >
                  <span className="preset-preview" aria-hidden="true">
                    <span className="pp-rail" />
                    <span className="pp-body">
                      <span className="pp-card c1" />
                      <span className="pp-card c2" />
                      <span className="pp-card c3" />
                      <span className="pp-row" />
                    </span>
                  </span>
                  <span className="preset-meta">
                    <strong>{PRESET_LABELS[id].name}</strong>
                    <em>{PRESET_LABELS[id].tagline}</em>
                  </span>
                  <span className="preset-radio" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
        <div className="setting-row">
          <span>配色</span>
          <Select
            ariaLabel="配色"
            size="sm"
            value={settings.theme}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            onChange={(v) => update({ theme: v as never })}
          />
        </div>
        <div className="setting-row">
          <span>窗口材质</span>
          <Select
            ariaLabel="窗口材质"
            size="sm"
            value={settings.material}
            options={[
              { value: "glass", label: "毛玻璃（Mica）" },
              { value: "solid", label: "不透明" },
            ]}
            onChange={(v) => update({ material: v as never })}
          />
        </div>
        <div className="setting-note">
          {settings.material === "glass" ? (
            glassDowngraded ? (
              <>已自动回退为不透明：当前系统不支持（{materialInfo?.osVersion || "版本未知"}）
                或开启了高对比度 / 减少透明效果</>
            ) : materialInfo?.applied ? (
              <>原生效果已生效（{materialInfo.effect}），桌面背景将透出窗口</>
            ) : (
              <>正在探测系统材质支持…</>
            )
          ) : (
            <>普通不透明主题，兼容性最佳</>
          )}
        </div>
      </Section>

      <Section icon={AppWindow} title="窗口与快捷键">
        <div className="setting-row">
          <span>贴边吸附 / 自动隐藏</span>
          <Switch
            checked={settings.snap_enabled}
            ariaLabel="贴边吸附 / 自动隐藏"
            onChange={(v) => update({ snap_enabled: v })}
          />
        </div>
        <div className="setting-note">
          把窗口拖近屏幕边缘（约 28px 内）会显示「松开吸附」提示，松开即停靠并自动隐藏；
          之后把鼠标移到屏幕边缘的状态胶囊上稍作停留（或点击）即可唤出，移开后再次隐藏。
          胶囊上会显示待办数量与 Agent 运行状态。向屏幕中间拖离边缘，或点击标题栏的
          磁铁图标即可解除吸附；关闭此开关时若窗口已隐藏，会先自动展开。
        </div>
        <div className="setting-row">
          <span>开机自启动</span>
          <Switch
            checked={settings.autostart}
            disabled={busyKey === "autostart"}
            ariaLabel="开机自启动"
            onChange={(v) => withBusy("autostart", async () => {
              await setAutostart(v);
              await useSettingsStore.getState().load();
            })}
          />
        </div>
        <div className="setting-row">
          <span>全局快捷键（Ctrl+Alt+T 显示 · Ctrl+Shift+Space 快速添加）</span>
          <Switch
            checked={settings.hotkey_enabled}
            disabled={busyKey === "hotkey"}
            ariaLabel="全局快捷键（Ctrl+Alt+T 显示 · Ctrl+Shift+Space 快速添加）"
            onChange={(v) => withBusy("hotkey", async () => {
              await setHotkeysEnabled(v);
              await useSettingsStore.getState().load();
            })}
          />
        </div>
        <div className="setting-row">
          <span>应用内快捷键（Ctrl+1…6 切换标签 · Ctrl+K 快速添加 · Ctrl+Shift+C 剪贴板）</span>
          <span className="setting-value">窗口聚焦时生效</span>
        </div>
        <div className="setting-note">
          Ctrl+1…6 仅完整模式有效，顺序与左侧导航一致；Ctrl+Shift+C 在完整模式切到剪贴板页，
          紧凑/极简模式开关临时剪贴板抽屉。
        </div>
      </Section>

      <Section
        icon={Layers}
        title="功能模块"
        description="独立启停；关闭不会删除已有数据，Agent 核心接入始终保留"
      >
        <div className="setting-row">
          <span>工作现场（捕获窗口组合并恢复）</span>
          <Switch
            checked={settings.workspace_enabled}
            ariaLabel="工作现场（捕获窗口组合并恢复）"
            onChange={(v) => update({ workspace_enabled: v })}
          />
        </div>
        <div className="setting-note">
          关闭后停止捕获与后台恢复，正在进行的恢复会被取消；已有现场保留，重新开启即可继续使用。
        </div>
        <div className="setting-row">
          <span>行动中心（聚合 Agent 事件与提醒）</span>
          <Switch
            checked={settings.actions_enabled}
            ariaLabel="行动中心（聚合 Agent 事件与提醒）"
            onChange={(v) => update({ actions_enabled: v })}
          />
        </div>
        <div className="setting-note">
          关闭后停止聚合刷新与徽标；Agent 事件仍照常入库，历史、会话跳转与任务联动不受影响。
        </div>
        <div className="setting-note">
          智能剪贴板的启停在下方「智能剪贴板」分组中管理；关闭后不再采集新内容，历史仍可查看。
        </div>
      </Section>

      <Section icon={Navigation} title="应用与快捷方式" description="软件发现、导航偏好与跳转记录">
        <AppManagement />
      </Section>

      <Section
        icon={Clipboard}
        title="智能剪贴板"
        defaultOpen={false}
        description="监听、自动分组、容量与隐私（标题栏剪贴板图标打开历史抽屉）"
      >
        {clipConfigError && (
          <div className="setting-row setting-row-block clip-config-error" role="alert">
            <strong>剪贴板配置异常，自动记录已暂停</strong>
            <span>{clipConfigError.message}</span>
            <span>
              损坏的原始值已保留在本地备份中；修复只会重写无法解析的键。修复前不会读取或记录任何新内容。
            </span>
            <div className="clip-config-actions">
              <button
                className="btn sm"
                disabled={busyKey === "clip-repair"}
                onClick={() => void onRepairClipboard(true)}
              >
                修复并恢复记录
              </button>
              <button
                className="btn sm"
                disabled={busyKey === "clip-repair"}
                onClick={() => void onRepairClipboard(false)}
              >
                仅修复（保持暂停）
              </button>
            </div>
          </div>
        )}
        {!clipConfigError && clipConfigOrigin === "legacy_upgrade_paused" && (
          <div className="setting-row setting-row-block" role="status">
            <strong>从旧版本升级：剪贴板记录保持暂停</strong>
            <span>
              旧版本没有剪贴板配置，无法确认此前的记录授权，因此不会自动开始采集。确认需要后，取消下方“暂停记录”即可。
            </span>
          </div>
        )}
        <div className="setting-row">
          <span>启用剪贴板记录（关闭后不再采集新内容）</span>
          <Switch
            checked={settings.clipboard_enabled}
            ariaLabel="启用剪贴板记录（关闭后不再采集新内容）"
            onChange={(v) => update({ clipboard_enabled: v })}
          />
        </div>
        <div className="setting-row">
          <span>暂停记录（保留历史，恢复后继续）</span>
          <Switch
            checked={settings.clipboard_paused}
            ariaLabel="暂停记录（保留历史，恢复后继续）"
            onChange={(v) => update({ clipboard_paused: v })}
          />
        </div>
        <div className="setting-row">
          <span>记录图片（截图 / 位图）</span>
          <Switch
            checked={settings.clipboard_capture_images}
            ariaLabel="记录图片（截图 / 位图）"
            onChange={(v) => update({ clipboard_capture_images: v })}
          />
        </div>
        <div className="setting-row">
          <span>记录文件列表</span>
          <Switch
            checked={settings.clipboard_capture_files}
            ariaLabel="记录文件列表"
            onChange={(v) => update({ clipboard_capture_files: v })}
          />
        </div>
        <div className="setting-row">
          <span>记录富文本 HTML（关闭后退回纯文本）</span>
          <Switch
            checked={settings.clipboard_capture_html}
            ariaLabel="记录富文本 HTML（关闭后退回纯文本）"
            onChange={(v) => update({ clipboard_capture_html: v })}
          />
        </div>
        <div className="setting-row">
          <span>连续截图自动分组</span>
          <Switch
            checked={settings.clipboard_auto_group}
            ariaLabel="连续截图自动分组"
            onChange={(v) => update({ clipboard_auto_group: v })}
          />
        </div>
        <div className="setting-row">
          <span>自动分组窗口（秒，5–600）</span>
          <NumberInput
            value={settings.clipboard_group_window_secs}
            min={5}
            max={600}
            ariaLabel="自动分组窗口（秒，5–600）"
            onChange={(v) => update({ clipboard_group_window_secs: v })}
          />
        </div>
        <div className="setting-row">
          <span>非收藏条目保留天数</span>
          <NumberInput
            value={settings.clipboard_retention_days}
            min={1}
            max={3650}
            ariaLabel="非收藏条目保留天数"
            onChange={(v) => update({ clipboard_retention_days: v })}
          />
        </div>
        <div className="setting-row">
          <span>最大条目数（非收藏 / 非置顶）</span>
          <NumberInput
            value={settings.clipboard_max_items}
            min={20}
            max={50000}
            ariaLabel="最大条目数（非收藏 / 非置顶）"
            onChange={(v) => update({ clipboard_max_items: v })}
          />
        </div>
        <div className="setting-row">
          <span>图片缓存上限（MB）</span>
          <NumberInput
            value={settings.clipboard_max_storage_mb}
            min={16}
            max={102400}
            ariaLabel="图片缓存上限（MB）"
            onChange={(v) => update({ clipboard_max_storage_mb: v })}
          />
        </div>
        <div className="setting-row">
          <span>文本 / 链接粘贴间隔（毫秒，100–5000）</span>
          <NumberInput
            value={settings.clipboard_paste_interval_ms}
            min={100}
            max={5000}
            step={50}
            ariaLabel="文本 / 链接粘贴间隔（毫秒，100–5000）"
            onChange={(v) => update({ clipboard_paste_interval_ms: v })}
          />
        </div>
        <div className="setting-row">
          <span>富文本粘贴间隔（毫秒）</span>
          <NumberInput
            value={settings.clipboard_paste_interval_html_ms}
            min={100}
            max={5000}
            step={50}
            ariaLabel="富文本粘贴间隔（毫秒）"
            onChange={(v) => update({ clipboard_paste_interval_html_ms: v })}
          />
        </div>
        <div className="setting-row">
          <span>图片粘贴间隔（毫秒，建议 ≥ 1000）</span>
          <NumberInput
            value={settings.clipboard_paste_interval_image_ms}
            min={100}
            max={5000}
            step={50}
            ariaLabel="图片粘贴间隔（毫秒，建议 ≥ 1000）"
            onChange={(v) => update({ clipboard_paste_interval_image_ms: v })}
          />
        </div>
        <div className="setting-row">
          <span>文件粘贴间隔（毫秒）</span>
          <NumberInput
            value={settings.clipboard_paste_interval_files_ms}
            min={100}
            max={5000}
            step={50}
            ariaLabel="文件粘贴间隔（毫秒）"
            onChange={(v) => update({ clipboard_paste_interval_files_ms: v })}
          />
        </div>
        <div className="setting-row">
          <span>高置信敏感内容过滤（如 PEM 私钥）</span>
          <Switch
            checked={settings.clipboard_sensitive_filter}
            ariaLabel="高置信敏感内容过滤（如 PEM 私钥）"
            onChange={(v) => update({ clipboard_sensitive_filter: v })}
          />
        </div>
        <div className="setting-note">
          敏感过滤只覆盖明确的高置信模式，不宣称能识别全部密码 / 令牌；日志只记录类型、大小与计数，
          绝不记录剪贴板正文或图片内容。来源应用由前台窗口推断，无法确认时会标记为「未知来源」，
          此时排除名单无法证明生效，并会启用更保守的凭据字段过滤。建议把密码管理器加入下方排除名单。
          暂停记录后不会读取也不会上传任何内容；发送给 Agent 必须由你在界面中手动触发。
        </div>
        <div className="setting-row setting-row-block">
          <span>应用排除名单（exe 名或路径，逗号 / 换行分隔）</span>
          <textarea
            className="setting-textarea"
            rows={2}
            value={excludeApps}
            placeholder="keepass.exe, 1password.exe"
            aria-label="剪贴板排除的应用名单"
            onChange={(e) => setExcludeApps(e.target.value)}
            onBlur={() => {
              if (excludeApps !== settings.clipboard_exclude_apps) {
                update({ clipboard_exclude_apps: excludeApps }).catch((e) =>
                  showToast(`保存排除名单失败：${String(e)}`, { kind: "error" }),
                );
              }
            }}
          />
        </div>
        <div className="setting-row">
          <span>当前占用</span>
          <span className="setting-value">
            {clipStats
              ? `${clipStats.items} 条 · ${clipStats.groups} 组 · 图片缓存 ${formatBytes(clipStats.asset_bytes)} / ${formatBytes(clipStats.max_storage_bytes)}`
              : "读取中…"}
          </span>
        </div>
        <div className="setting-row">
          <span>诊断与维护</span>
          <div className="btn-row">
            <button className="btn sm" onClick={refreshClipStats} disabled={busyKey !== null}>
              <RefreshCw size={11} /> 刷新统计
            </button>
            <button className="btn sm" onClick={onClipProbe} disabled={busyKey !== null}>
              探测当前剪贴板
            </button>
            <button className="btn sm" onClick={onClipCleanup} disabled={busyKey !== null}>
              {busyKey === "clip-cleanup" ? <RefreshCw size={11} className="spin" /> : <Trash2 size={11} />} 立即清理
            </button>
          </div>
        </div>
        <div className="setting-note">
          「立即清理」按保留天数与容量上限删除非收藏条目，并回收孤儿图片文件；置顶与收藏不受自动清理影响。
        </div>
      </Section>

      <Section icon={Bell} title="通知">
        <div className="setting-row">
          <span>任务提醒通知</span>
          <Switch
            checked={settings.notify_reminder}
            ariaLabel="任务提醒通知"
            onChange={(v) => update({ notify_reminder: v })}
          />
        </div>
        <div className="setting-row">
          <span>Agent 状态通知（等待 / 完成 / 失败）</span>
          <Switch
            checked={settings.notify_agent}
            ariaLabel="Agent 状态通知（等待 / 完成 / 失败）"
            onChange={(v) => update({ notify_agent: v })}
          />
        </div>
        <div className="setting-row">
          <span>全部静音（仍记录到收件箱）</span>
          <Switch
            checked={settings.notify_muted}
            ariaLabel="全部静音（仍记录到收件箱）"
            onChange={(v) => update({ notify_muted: v })}
          />
        </div>
        <div className="setting-row">
          <span>高频完成合并为一条摘要</span>
          <Switch
            checked={settings.notify_done_aggregate}
            ariaLabel="高频完成合并为一条摘要"
            onChange={(v) => update({ notify_done_aggregate: v })}
          />
        </div>
        <div className="setting-row">
          <span>通知限流窗口（秒 / 最多独立弹窗）</span>
          <div className="btn-row">
            <NumberInput
              size="sm"
              min={10}
              max={3600}
              value={settings.notify_rate_window_secs}
              ariaLabel="通知限流窗口（秒）"
              onChange={(v) => update({ notify_rate_window_secs: v })}
            />
            <NumberInput
              size="sm"
              min={1}
              max={20}
              value={settings.notify_burst_max}
              ariaLabel="最多独立弹窗数"
              onChange={(v) => update({ notify_burst_max: v })}
            />
          </div>
        </div>
        <div className="setting-note">
          等待/失败会优先弹出；同一窗口内超出的状态变化合并为一条摘要并照常写入收件箱，不丢历史。
        </div>
        <div className="setting-row">
          <span>过期提醒补偿窗口（小时）</span>
          <NumberInput
            value={settings.overdue_grace_hours}
            min={1}
            max={168}
            ariaLabel="过期提醒补偿窗口（小时）"
            onChange={(v) => update({ overdue_grace_hours: v })}
          />
        </div>
      </Section>

      <Section icon={Bot} title="Agent 接入" defaultOpen={false} description="HTTP 端口、令牌与健康判定">
        <div className="setting-row">
          <span>本地 HTTP 接入（仅回环）</span>
          <Switch
            checked={settings.http_enabled}
            ariaLabel="本地 HTTP 接入（仅回环）"
            onChange={(v) => update({ http_enabled: v })}
          />
        </div>
        <div className="setting-row">
          <span>端口</span>
          <NumberInput
            value={settings.http_port}
            min={1024}
            max={65535}
            ariaLabel="端口"
            onChange={(v) => update({ http_port: v })}
          />
        </div>
        <div className="setting-row">
          <span>接入令牌</span>
          <div className="token-row">
            <code className="token-box">
              {tokenRevealed ? settings.http_token : `${settings.http_token.slice(0, 4)}${"•".repeat(16)}`}
            </code>
            <button
              className="icon-btn sm"
              data-tip={tokenRevealed ? "隐藏" : "显示"}
              aria-label={tokenRevealed ? "隐藏令牌" : "显示令牌"}
              onClick={() => setTokenRevealed((v) => !v)}
            >
              {tokenRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button className="icon-btn sm" data-tip="复制令牌" aria-label="复制令牌" onClick={onCopyToken}>
              <Copy size={12} />
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span>状态过期判定（分钟无更新 → 断开，不推断成败）</span>
          <NumberInput
            value={settings.stale_run_minutes}
            min={1}
            max={120}
            ariaLabel="状态过期判定（分钟无更新 → 断开，不推断成败）"
            onChange={(v) => update({ stale_run_minutes: v })}
          />
        </div>
        <div className="setting-row">
          <span>文件投递目录</span>
          <div className="btn-row">
            {inboxDir && <code className="token-box">{inboxDir}</code>}
            <button className="btn sm" onClick={onCopyInbox} disabled={busyKey === "inbox"}>
              {busyKey === "inbox" ? "获取中…" : "获取并复制"}
            </button>
          </div>
        </div>
      </Section>

      <Section icon={Database} title="数据与备份">
        <div className="setting-row">
          <span>每日自动备份</span>
          <Switch
            checked={settings.auto_backup}
            ariaLabel="每日自动备份"
            onChange={(v) => update({ auto_backup: v })}
          />
        </div>
        <div className="setting-row">
          <span>备份保留天数</span>
          <NumberInput
            value={settings.backup_retain_days}
            min={1}
            max={90}
            ariaLabel="备份保留天数"
            onChange={(v) => update({ backup_retain_days: v })}
          />
        </div>
        <div className="setting-row">
          <span>数据操作</span>
          <div className="btn-row">
            <button
              className="btn sm"
              disabled={busyKey === "backup"}
              onClick={() => withBusy("backup", async () => {
                const p = await backupNow(false);
                setBackups(await listBackups());
                showToast(`快速备份完成（标记为部分数据）：${p}`, { kind: "success" });
              })}
            >
              {busyKey === "backup" ? <RefreshCw size={12} className="spin" /> : null} 快速备份
            </button>
            <button
              className="btn sm"
              disabled={busyKey === "backup-full"}
              onClick={() => withBusy("backup-full", async () => {
                const p = await backupNow(true);
                setBackups(await listBackups());
                showToast(`完整备份完成（全部事件与归档）：${p}`, { kind: "success" });
              })}
            >
              {busyKey === "backup-full" ? <RefreshCw size={12} className="spin" /> : null} 完整备份
            </button>
            <button className="btn sm" onClick={onExport} disabled={busyKey === "export"}>导出 JSON</button>
            <button className="btn sm" onClick={onImport} disabled={busyKey === "import"}>恢复备份…</button>
          </div>
        </div>
        {backups.length > 0 && (
          <div className="backup-list">
            {backups.slice(0, 8).map((b) => (
              <div key={b.name} className="backup-item">
                <span title={b.truncated_tables?.length ? `截断：${b.truncated_tables.join("、")}` : undefined}>
                  {b.name}
                  {b.partial ? "（部分）" : b.kind === "full" ? "（完整）" : ""}
                  {b.partial && b.truncated_tables?.length
                    ? ` · 截断 ${b.truncated_tables.length} 表`
                    : ""}
                </span>
                <span>
                  {b.extended_modules ? "含资产 " : ""}
                  {(b.size / 1024).toFixed(1)} KB
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="setting-row">
          <span>测试/压测数据审计</span>
          <div className="btn-row">
            <button className="btn sm" onClick={onAuditPreview} disabled={busyKey === "audit-preview"}>
              {busyKey === "audit-preview" ? <RefreshCw size={12} className="spin" /> : null} 预览
            </button>
            <button className="btn sm" onClick={onAuditApply} disabled={busyKey === "audit-apply"}>
              {busyKey === "audit-apply" ? <RefreshCw size={12} className="spin" /> : null} 清理可证明数据…
            </button>
          </div>
        </div>
        {testAudit && (
          <div className="backup-list">
            <div className="backup-item">
              <span>可证明测试数据</span>
              <span>
                {sumAuditCounts(testAudit.provable_total)} 条（
                {testAudit.provable.map((p) => `${p.origin} ${sumAuditCounts(p.counts)}`).join(" / ") ||
                  "无"}
                ）
              </span>
            </div>
            <div className="backup-item">
              <span>真实数据（保留）</span>
              <span>
                事件 {testAudit.real.events} · 会话 {testAudit.real.sessions} · 轮次 {testAudit.real.runs} ·
                通知 {testAudit.real.notifications}
              </span>
            </div>
            {testAudit.deleted && (
              <div className="backup-item">
                <span>本次已删除</span>
                <span>
                  事件 {testAudit.deleted.events} · 会话 {testAudit.deleted.sessions} · 轮次{" "}
                  {testAudit.deleted.runs} · 通知 {testAudit.deleted.notifications}
                </span>
              </div>
            )}
            {testAudit.backup_path && (
              <div className="backup-item">
                <span>清理前快照</span>
                <span style={{ wordBreak: "break-all" }}>{testAudit.backup_path}</span>
              </div>
            )}
            {testAudit.uncertain.length > 0 && (
              <div className="backup-item">
                <span>待人工确认</span>
                <span>{testAudit.uncertain.map((u) => `${u.kind} ${u.count}`).join(" · ")}</span>
              </div>
            )}
            {testAudit.notes.map((n) => (
              <div className="setting-note" key={n}>{n}</div>
            ))}
          </div>
        )}
        <div className="setting-note">
          只清理由服务端判定为 selftest / benchmark / mock 的数据；预览为 dry-run，不修改任何内容。
          清理前自动生成库快照，无法证明来源的记录保留并列入待人工确认。
        </div>
      </Section>

      <Section
        icon={Gauge}
        title="性能诊断"
        defaultOpen={false}
        description="接入队列、延迟分位、SQLite 与事件保留（只读）"
      >
        <div className="setting-row">
          <span>采集性能诊断（关闭后仅保留最小计数）</span>
          <Switch
            checked={settings.perf_diagnostics_enabled}
            ariaLabel="采集性能诊断（关闭后仅保留最小计数）"
            onChange={(v) => update({ perf_diagnostics_enabled: v })}
          />
        </div>
        <div className="setting-row">
          <span>运行快照</span>
          <div className="btn-row">
            <button className="btn sm" onClick={refreshDiag} disabled={busyKey === "diag"}>
              {busyKey === "diag" ? <RefreshCw size={12} className="spin" /> : null} 刷新
            </button>
            <button className="btn sm" onClick={onRetentionRun} disabled={busyKey === "retention"}>
              {busyKey === "retention" ? "清理中…" : "清理旧事件"}
            </button>
            <button className="btn sm" onClick={onInboxRetry} disabled={busyKey === "inbox-retry"}>
              重试失败投递
            </button>
          </div>
        </div>
        {diag?.enabled && pipe && (
          <div className="backup-list">
            <div className="backup-item">
              <span>接入队列</span>
              <span>
                {pipe.queue_depth_events}/{pipe.queue_capacity} · 合并 {pipe.events_merged} · 采样{" "}
                {pipe.events_sampled} · 拒绝 {pipe.overload_rejects}
              </span>
            </div>
            <div className="backup-item">
              <span>处理 / 批次</span>
              <span>
                {pipe.events_processed}/{pipe.events_received} · {pipe.batches} 批 · 在途合并{" "}
                {pipe.merge_buffer}
              </span>
            </div>
            <div className="backup-item">
              <span>接入延迟</span>
              <span>
                p50 {pipe.ingest_latency.p50_ms}ms · p95 {pipe.ingest_latency.p95_ms}ms · p99{" "}
                {pipe.ingest_latency.p99_ms}ms
              </span>
            </div>
            <div className="backup-item">
              <span>写库延迟</span>
              <span>
                p50 {pipe.db_write_latency.p50_ms}ms · p95 {pipe.db_write_latency.p95_ms}ms · 失败{" "}
                {pipe.commit_failures}
              </span>
            </div>
            <div className="backup-item">
              <span>SQLite 读</span>
              <span>
                平均 {diag.sqlite?.avg_ms ?? "-"}ms · {diag.sqlite?.calls ?? 0} 次 · 慢查询{" "}
                {diag.sqlite?.slow_queries_100ms ?? 0}
              </span>
            </div>
            <div className="backup-item">
              <span>文件投递</span>
              <span>
                待处理 {inboxStats?.pending_files ?? 0} 个 / {inboxStats?.pending_bytes ?? 0} B · 失败{" "}
                {inboxStats?.failed_files ?? 0} · 最老 {inboxStats?.oldest_age_secs ?? 0}s
              </span>
            </div>
            <div className="backup-item">
              <span>事件表</span>
              <span>
                共 {retention?.total_rows ?? 0} · 可清理 {retention?.prunable_rows ?? 0} · 受保护{" "}
                {retention?.protected_rows ?? 0}
              </span>
            </div>
            <div className="backup-item">
              <span>前端刷新</span>
              <span>
                快照 {frontendMetrics.snapshotRequests} 次 · 峰值并发 {frontendMetrics.maxConcurrent} ·
                合并 {frontendMetrics.coalesced} · 隐藏跳过 {frontendMetrics.skippedHidden}
              </span>
            </div>
          </div>
        )}
        {diag && !diag.enabled && (
          <div className="setting-note">诊断采集已关闭；不会采样延迟分位，队列与计数仍正常工作。</div>
        )}
        <div className="setting-row">
          <span>running/idle 事件保留天数（0 = 不限）</span>
          <NumberInput
            value={settings.agent_event_retention_days}
            min={0}
            max={365}
            ariaLabel="running/idle 事件保留天数（0 = 不限）"
            onChange={(v) => update({ agent_event_retention_days: v })}
          />
        </div>
        <div className="setting-row">
          <span>running/idle 事件行数上限（0 = 不限）</span>
          <NumberInput
            value={settings.agent_event_max_rows}
            min={0}
            step={10000}
            ariaLabel="running/idle 事件行数上限（0 = 不限）"
            onChange={(v) => update({ agent_event_max_rows: v })}
          />
        </div>
        <div className="setting-row">
          <span>清理前归档 JSONL</span>
          <Switch
            checked={settings.agent_event_archive}
            ariaLabel="清理前归档 JSONL"
            onChange={(v) => update({ agent_event_archive: v })}
          />
        </div>
        <div className="setting-note">
          只自动清理 running / idle 进度事件；waiting / failed / completed / disconnected
          永不自动删除。清理前先写 JSONL 归档，归档失败则本次不删除。
        </div>
      </Section>

      <Section
        icon={FlaskConical}
        title="开发者选项"
        defaultOpen={false}
        description="Mock 模拟适配器与调试工具（普通用户无需展开）"
      >
        <div className="setting-row">
          <span>启用 Mock 模拟适配器（重启应用后完全生效）</span>
          <Switch
            checked={settings.mock_enabled}
            ariaLabel="启用 Mock 模拟适配器（重启应用后完全生效）"
            onChange={(v) => update({ mock_enabled: v })}
          />
        </div>
        <div className="setting-note">模拟控制台仅用于无真实 Agent 环境下验证 UI / 通知 / 托盘链路，事件明确标注「模拟」，不作为真实接入证据。</div>
        <MockControls />
      </Section>
    </div>
  );
}
