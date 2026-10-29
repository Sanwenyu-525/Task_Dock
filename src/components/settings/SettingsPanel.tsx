//! 设置面板：外观与主题 / 窗口与快捷键 / 通知 / Agent 接入 / 数据与备份 / 开发者选项。
//! 统一控件风格；高级选项（Agent 接入细节、开发者工具）默认折叠。

import { useEffect, useState } from "react";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Palette, AppWindow, Bell, Bot, Database, FlaskConical, Copy, Eye, EyeOff,
  RefreshCw, ChevronDown, ChevronRight, Navigation, Clipboard, Trash2, Gauge,
} from "lucide-react";
import {
  backupNow,
  clipboardCleanup,
  clipboardProbe,
  clipboardStats,
  exportData,
  getAgentInboxDir,
  importData,
  listBackups,
  setAutostart,
  setHotkeysEnabled,
  performanceDiagnostics,
  agentRetentionRun,
  agentInboxRetry,
  type ClipboardStats,
  type PerformanceDiagnostics,
} from "../../lib/bridge";
import { getAgentRefreshMetrics } from "../../store/useAgentsStore";
import { formatBytes, kindLabel } from "../../lib/clipboardUi";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { copyText } from "../../lib/clipboard";
import MockControls from "../agents/MockControls";
import AppManagement from "./AppManagement";

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
  const [backups, setBackups] = useState<{ name: string; size: number; modified: string }[]>([]);
  const [inboxDir, setInboxDir] = useState("");
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [clipStats, setClipStats] = useState<ClipboardStats | null>(null);
  const [excludeApps, setExcludeApps] = useState("");
  const [diag, setDiag] = useState<PerformanceDiagnostics | null>(null);

  useEffect(() => {
    listBackups().then(setBackups).catch(() => setBackups([]));
    clipboardStats().then(setClipStats).catch(() => setClipStats(null));
  }, []);

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
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path || Array.isArray(path)) return;
      await importData(path);
      showToast("导入完成（导入前已自动备份）", { kind: "success" });
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
        <label className="setting-row">
          <span>配色</span>
          <select value={settings.theme} onChange={(e) => update({ theme: e.target.value as never })}>
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label className="setting-row">
          <span>窗口材质</span>
          <select value={settings.material} onChange={(e) => update({ material: e.target.value as never })}>
            <option value="glass">毛玻璃（Mica / Acrylic）</option>
            <option value="solid">不透明</option>
          </select>
        </label>
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
        <label className="setting-row">
          <span>贴边吸附 / 自动隐藏</span>
          <input
            type="checkbox"
            checked={settings.snap_enabled}
            onChange={(e) => update({ snap_enabled: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>开机自启动</span>
          <input
            type="checkbox"
            checked={settings.autostart}
            disabled={busyKey === "autostart"}
            onChange={(e) => withBusy("autostart", async () => {
              await setAutostart(e.target.checked);
              await useSettingsStore.getState().load();
            })}
          />
        </label>
        <label className="setting-row">
          <span>全局快捷键（Ctrl+Alt+T 显示 · Ctrl+Shift+Space 快速添加）</span>
          <input
            type="checkbox"
            checked={settings.hotkey_enabled}
            disabled={busyKey === "hotkey"}
            onChange={(e) => withBusy("hotkey", async () => {
              await setHotkeysEnabled(e.target.checked);
              await useSettingsStore.getState().load();
            })}
          />
        </label>
        <div className="setting-row">
          <span>应用内快捷键（Ctrl+1…5 切换标签 · Ctrl+K 快速添加 · Ctrl+Shift+C 剪贴板）</span>
          <span className="setting-value">窗口聚焦时生效</span>
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
        <label className="setting-row">
          <span>启用剪贴板记录（关闭后不再采集新内容）</span>
          <input
            type="checkbox"
            checked={settings.clipboard_enabled}
            onChange={(e) => update({ clipboard_enabled: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>暂停记录（保留历史，恢复后继续）</span>
          <input
            type="checkbox"
            checked={settings.clipboard_paused}
            onChange={(e) => update({ clipboard_paused: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>记录图片（截图 / 位图）</span>
          <input
            type="checkbox"
            checked={settings.clipboard_capture_images}
            onChange={(e) => update({ clipboard_capture_images: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>记录文件列表</span>
          <input
            type="checkbox"
            checked={settings.clipboard_capture_files}
            onChange={(e) => update({ clipboard_capture_files: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>记录富文本 HTML（关闭后退回纯文本）</span>
          <input
            type="checkbox"
            checked={settings.clipboard_capture_html}
            onChange={(e) => update({ clipboard_capture_html: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>连续截图自动分组</span>
          <input
            type="checkbox"
            checked={settings.clipboard_auto_group}
            onChange={(e) => update({ clipboard_auto_group: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>自动分组窗口（秒，5–600）</span>
          <input
            type="number"
            min={5}
            max={600}
            value={settings.clipboard_group_window_secs}
            onChange={(e) => update({ clipboard_group_window_secs: Number(e.target.value) })}
          />
        </label>
        <label className="setting-row">
          <span>非收藏条目保留天数</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={settings.clipboard_retention_days}
            onChange={(e) => update({ clipboard_retention_days: Number(e.target.value) })}
          />
        </label>
        <label className="setting-row">
          <span>最大条目数（非收藏 / 非置顶）</span>
          <input
            type="number"
            min={20}
            max={50000}
            value={settings.clipboard_max_items}
            onChange={(e) => update({ clipboard_max_items: Number(e.target.value) })}
          />
        </label>
        <label className="setting-row">
          <span>图片缓存上限（MB）</span>
          <input
            type="number"
            min={16}
            max={102400}
            value={settings.clipboard_max_storage_mb}
            onChange={(e) => update({ clipboard_max_storage_mb: Number(e.target.value) })}
          />
        </label>
        <label className="setting-row">
          <span>文本 / 链接粘贴间隔（毫秒，100–5000）</span>
          <input
            type="number"
            min={100}
            max={5000}
            step={50}
            value={settings.clipboard_paste_interval_ms}
            onChange={(e) => update({ clipboard_paste_interval_ms: Number(e.target.value) })}
          />
        </label>
        <label className="setting-row">
          <span>富文本粘贴间隔（毫秒）</span>
          <input
            type="number"
            min={100}
            max={5000}
            step={50}
            value={settings.clipboard_paste_interval_html_ms}
            onChange={(e) => update({ clipboard_paste_interval_html_ms: Number(e.target.value) })}
          />
        </label>
        <label className="setting-row">
          <span>图片粘贴间隔（毫秒，建议 ≥ 1000）</span>
          <input
            type="number"
            min={100}
            max={5000}
            step={50}
            value={settings.clipboard_paste_interval_image_ms}
            onChange={(e) => update({ clipboard_paste_interval_image_ms: Number(e.target.value) })}
          />
        </label>
        <label className="setting-row">
          <span>文件粘贴间隔（毫秒）</span>
          <input
            type="number"
            min={100}
            max={5000}
            step={50}
            value={settings.clipboard_paste_interval_files_ms}
            onChange={(e) => update({ clipboard_paste_interval_files_ms: Number(e.target.value) })}
          />
        </label>
        <label className="setting-row">
          <span>高置信敏感内容过滤（如 PEM 私钥）</span>
          <input
            type="checkbox"
            checked={settings.clipboard_sensitive_filter}
            onChange={(e) => update({ clipboard_sensitive_filter: e.target.checked })}
          />
        </label>
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
        <label className="setting-row">
          <span>任务提醒通知</span>
          <input
            type="checkbox"
            checked={settings.notify_reminder}
            onChange={(e) => update({ notify_reminder: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>Agent 状态通知（等待 / 完成 / 失败）</span>
          <input
            type="checkbox"
            checked={settings.notify_agent}
            onChange={(e) => update({ notify_agent: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>全部静音（仍记录到收件箱）</span>
          <input
            type="checkbox"
            checked={settings.notify_muted}
            onChange={(e) => update({ notify_muted: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>过期提醒补偿窗口（小时）</span>
          <input
            type="number"
            min={1}
            max={168}
            value={settings.overdue_grace_hours}
            onChange={(e) => update({ overdue_grace_hours: Number(e.target.value) })}
          />
        </label>
      </Section>

      <Section icon={Bot} title="Agent 接入" defaultOpen={false} description="HTTP 端口、令牌与健康判定">
        <label className="setting-row">
          <span>本地 HTTP 接入（仅回环）</span>
          <input
            type="checkbox"
            checked={settings.http_enabled}
            onChange={(e) => update({ http_enabled: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>端口</span>
          <input
            type="number"
            min={1024}
            max={65535}
            value={settings.http_port}
            onChange={(e) => update({ http_port: Number(e.target.value) })}
          />
        </label>
        <div className="setting-row">
          <span>接入令牌</span>
          <div className="token-row">
            <code className="token-box">
              {tokenRevealed ? settings.http_token : `${settings.http_token.slice(0, 4)}${"•".repeat(16)}`}
            </code>
            <button
              className="icon-btn sm"
              title={tokenRevealed ? "隐藏" : "显示"}
              aria-label={tokenRevealed ? "隐藏令牌" : "显示令牌"}
              onClick={() => setTokenRevealed((v) => !v)}
            >
              {tokenRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button className="icon-btn sm" title="复制令牌" aria-label="复制令牌" onClick={onCopyToken}>
              <Copy size={12} />
            </button>
          </div>
        </div>
        <label className="setting-row">
          <span>状态过期判定（分钟无更新 → 断开，不推断成败）</span>
          <input
            type="number"
            min={1}
            max={120}
            value={settings.stale_run_minutes}
            onChange={(e) => update({ stale_run_minutes: Number(e.target.value) })}
          />
        </label>
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
        <label className="setting-row">
          <span>每日自动备份</span>
          <input
            type="checkbox"
            checked={settings.auto_backup}
            onChange={(e) => update({ auto_backup: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>备份保留天数</span>
          <input
            type="number"
            min={1}
            max={90}
            value={settings.backup_retain_days}
            onChange={(e) => update({ backup_retain_days: Number(e.target.value) })}
          />
        </label>
        <div className="setting-row">
          <span>数据操作</span>
          <div className="btn-row">
            <button
              className="btn sm"
              disabled={busyKey === "backup"}
              onClick={() => withBusy("backup", async () => {
                const p = await backupNow();
                setBackups(await listBackups());
                showToast(`已备份：${p}`, { kind: "success" });
              })}
            >
              {busyKey === "backup" ? <RefreshCw size={12} className="spin" /> : null} 立即备份
            </button>
            <button className="btn sm" onClick={onExport} disabled={busyKey === "export"}>导出 JSON</button>
            <button className="btn sm" onClick={onImport} disabled={busyKey === "import"}>导入 JSON</button>
          </div>
        </div>
        {backups.length > 0 && (
          <div className="backup-list">
            {backups.slice(0, 8).map((b) => (
              <div key={b.name} className="backup-item">
                <span>{b.name}</span>
                <span>{(b.size / 1024).toFixed(1)} KB</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        icon={Gauge}
        title="性能诊断"
        defaultOpen={false}
        description="接入队列、延迟分位、SQLite 与事件保留（只读）"
      >
        <label className="setting-row">
          <span>采集性能诊断（关闭后仅保留最小计数）</span>
          <input
            type="checkbox"
            checked={settings.perf_diagnostics_enabled}
            onChange={(e) => update({ perf_diagnostics_enabled: e.target.checked })}
          />
        </label>
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
        <label className="setting-row">
          <span>running/idle 事件保留天数（0 = 不限）</span>
          <input
            type="number"
            min={0}
            max={365}
            value={settings.agent_event_retention_days}
            onChange={(e) => update({ agent_event_retention_days: Number(e.target.value) })}
          />
        </label>
        <label className="setting-row">
          <span>running/idle 事件行数上限（0 = 不限）</span>
          <input
            type="number"
            min={0}
            step={10000}
            value={settings.agent_event_max_rows}
            onChange={(e) => update({ agent_event_max_rows: Number(e.target.value) })}
          />
        </label>
        <label className="setting-row">
          <span>清理前归档 JSONL</span>
          <input
            type="checkbox"
            checked={settings.agent_event_archive}
            onChange={(e) => update({ agent_event_archive: e.target.checked })}
          />
        </label>
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
        <label className="setting-row">
          <span>启用 Mock 模拟适配器（重启应用后完全生效）</span>
          <input
            type="checkbox"
            checked={settings.mock_enabled}
            onChange={(e) => update({ mock_enabled: e.target.checked })}
          />
        </label>
        <div className="setting-note">模拟控制台仅用于无真实 Agent 环境下验证 UI / 通知 / 托盘链路，事件明确标注「模拟」，不作为真实接入证据。</div>
        <MockControls />
      </Section>
    </div>
  );
}
