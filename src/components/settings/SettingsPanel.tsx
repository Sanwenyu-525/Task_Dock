//! 设置面板：外观与主题 / 窗口与快捷键 / 通知 / Agent 接入 / 数据与备份 / 开发者选项。
//! 统一控件风格；高级选项（Agent 接入细节、开发者工具）默认折叠。

import { useEffect, useState } from "react";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Palette, AppWindow, Bell, Bot, Database, FlaskConical, Copy, Eye, EyeOff,
  RefreshCw, ChevronDown, ChevronRight,
} from "lucide-react";
import {
  backupNow,
  exportData,
  getAgentInboxDir,
  importData,
  listBackups,
  setAutostart,
  setHotkeysEnabled,
} from "../../lib/bridge";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { copyText } from "../../lib/clipboard";
import MockControls from "../agents/MockControls";

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

  useEffect(() => {
    listBackups().then(setBackups).catch(() => setBackups([]));
  }, []);

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
