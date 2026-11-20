//! Agent 接入页（2026-11-20 第二阶段：按职责分组）。
//!
//! 本页只负责「本地 HTTP 接入」；MCP 访问管理 / Agent 身份 / 审计记录由
//! `McpAccessSection` 的三个分组承担。原有命令、校验与安全逻辑完全不变。

import { useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { NumberInput, Switch } from "../../ui";
import SettingsPageLayout from "../SettingsPageLayout";
import SettingsGroup from "../SettingsGroup";
import McpAccessSection from "../McpAccessSection";
import AgentIcon from "../../ui/AgentIcon";
import { getAgentInboxDir } from "../../../lib/bridge";
import { copyText } from "../../../lib/clipboard";
import { useSettingsStore } from "../../../store/useSettingsStore";
import { useUiStore } from "../../../store/useUiStore";
import { useLocale } from "../../../hooks/useLocale";

export default function AgentSettingsPage() {
  const { t } = useLocale();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const showToast = useUiStore((s) => s.showToast);
  const [inboxDir, setInboxDir] = useState("");
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (!settings) return null;

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusyKey(key);
    try {
      await fn();
    } catch (e) {
      showToast(t("settings.opFailed", { error: String(e) }), { kind: "error" });
    } finally {
      setBusyKey(null);
    }
  }

  async function onCopyInbox() {
    await withBusy("inbox", async () => {
      const dir = await getAgentInboxDir();
      setInboxDir(dir);
      const ok = await copyText(dir);
      showToast(
        ok
          ? t("settings.agent.copied", { value: dir })
          : t("settings.agent.dir", { value: dir }),
        { kind: ok ? "success" : "info" },
      );
    });
  }

  async function onCopyToken() {
    await withBusy("token", async () => {
      const token = useSettingsStore.getState().settings?.http_token ?? "";
      const ok = await copyText(token);
      showToast(
        ok ? t("settings.agent.tokenCopied") : t("settings.agent.copyFailed"),
        { kind: ok ? "success" : "error" },
      );
    });
  }

  return (
    <SettingsPageLayout
      icon={AgentIcon}
      title={t("settings.section.agent")}
      description={t("settings.section.agentDesc")}
    >
      {/* ① 本地 HTTP 接入：开关 / 端口 / 令牌 / 超时 / 投递目录 */}
      <SettingsGroup
        title={t("settings.agent.http")}
        description={t("settings.agent.httpDesc")}
      >
        <div className="setting-row">
          <span>{t("settings.agent.httpEnable")}</span>
          <Switch
            checked={settings.http_enabled}
            ariaLabel={t("settings.agent.httpEnable")}
            onChange={(v) => update({ http_enabled: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.agent.port")}</span>
          <NumberInput
            value={settings.http_port}
            min={1024}
            max={65535}
            ariaLabel={t("settings.agent.port")}
            onChange={(v) => update({ http_port: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.agent.token")}</span>
          <div className="token-row">
            <code className="token-box" dir="ltr">
              {tokenRevealed
                ? settings.http_token
                : `${settings.http_token.slice(0, 4)}${"•".repeat(16)}`}
            </code>
            <button
              className="icon-btn sm"
              data-tip={tokenRevealed ? t("settings.agent.hide") : t("settings.agent.show")}
              aria-label={
                tokenRevealed ? t("settings.agent.hideToken") : t("settings.agent.showToken")
              }
              onClick={() => setTokenRevealed((v) => !v)}
            >
              {tokenRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button
              className="icon-btn sm"
              data-tip={t("settings.agent.copyToken")}
              aria-label={t("settings.agent.copyToken")}
              onClick={onCopyToken}
            >
              <Copy size={12} />
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span>{t("settings.agent.stale")}</span>
          <NumberInput
            value={settings.stale_run_minutes}
            min={1}
            max={120}
            ariaLabel={t("settings.agent.stale")}
            onChange={(v) => update({ stale_run_minutes: v })}
          />
        </div>
        <div className="setting-row">
          <span>{t("settings.agent.inboxDir")}</span>
          <div className="btn-row">
            {inboxDir && (
              <code className="token-box" dir="ltr">
                {inboxDir}
              </code>
            )}
            <button className="btn sm" onClick={onCopyInbox} disabled={busyKey === "inbox"}>
              {busyKey === "inbox" ? t("settings.agent.fetching") : t("settings.agent.fetchCopy")}
            </button>
          </div>
        </div>
        <div className="setting-note">{t("settings.agent.inboxNote")}</div>
      </SettingsGroup>

      {/* ② MCP 访问管理 / ③ Agent 身份 / ④ 审计记录 */}
      <McpAccessSection />
    </SettingsPageLayout>
  );
}
