// 同步中心：已配对连接展示真实状态，可测试连通性、立即同步、配置前台自动同步与附件传送。
// 同步范围：任务、收集箱、笔记（pull + push，加密载荷）；采集附件走独立文件互传通道。
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import { SettingActionRow } from "../components/SettingActionRow";
import { SettingRow } from "../components/SettingRow";
import { SettingSection } from "../components/SettingSection";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { useToast } from "../feedback/ToastProvider";
import type { ToastPlacement } from "../feedback/toastQueue";
import { countAttachmentsForTransfer } from "../db/attachments";
import {
  countPendingSyncOps,
  countSyncConflicts,
  loadSyncResult,
  resetSyncState,
  type SyncLastResult,
} from "../db/sync";
import {
  clearConnection,
  loadConnection,
  readToken,
  touchConnection,
  type PairedConnection,
} from "../db/syncConnection";
import { describeError } from "../lib/errors";
import { useWindowInsets } from "../lib/insets";
import type { Nav } from "../lib/nav";
import {
  loadAutoSyncSettings,
  loadSyncStatus,
  saveAutoSyncSettings,
  subscribeSyncStatus,
  type AutoSyncSettings,
} from "../lib/sync/autoSync";
import { transferPendingAttachments } from "../lib/sync/attachmentTransfer";
import { isLegacyConnection } from "../lib/sync/connectionState";
import { syncNow } from "../lib/sync/engine";
import { PairingRequestError, pingDesktop, pairingErrorMessage } from "../lib/sync/pairClient";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

function formatStamp(iso: string | null): string {
  if (!iso) return "尚未连接";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "尚未连接";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function fingerprintLabel(value: string): string {
  if (value.length === 8) return `${value.slice(0, 4)}-${value.slice(4)}`;
  if (value.length === 64) return `${value.slice(0, 8)}…${value.slice(-8)}`;
  return value;
}

export function SyncScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const [pendingOps, setPendingOps] = useState(0);
  const [connection, setConnection] = useState<PairedConnection | null>(null);
  const [hasToken, setHasToken] = useState(false);
  /** 桌面端已撤销/令牌失效：连接信息还在，但不能再显示「已配对」健康态 */
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<SyncLastResult | null>(null);
  const [conflictCount, setConflictCount] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState(0);
  const [autoSettings, setAutoSettings] = useState<AutoSyncSettings | null>(null);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  const mounted = useRef(true);

  const { showToast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const [ops, meta, token, last, conflicts, attachmentCount, settings, status] =
        await Promise.all([
          countPendingSyncOps(),
          loadConnection(),
          readToken(),
          loadSyncResult(),
          countSyncConflicts(),
          countAttachmentsForTransfer(),
          loadAutoSyncSettings(),
          loadSyncStatus(),
        ]);
      if (!mounted.current) return;
      setPendingOps(ops);
      setConnection(meta);
      setHasToken(Boolean(token));
      setLastResult(last);
      setConflictCount(conflicts);
      setPendingAttachments(attachmentCount);
      setAutoSettings(settings);
      setAutoNote(status.lastAutoNote);
      // v1 遗留连接（http:// 或缺少 SPKI 指纹）：桌面端已硬切 TLS-only，无法再连通。
      setInvalid(isLegacyConnection(meta));
    } catch (error) {
      if (mounted.current) showToast(`读取同步状态失败：${describeError(error)}`, "danger");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // 自动同步/附件传送完成后实时刷新计数，不靠轮询
    const unsubscribe = subscribeSyncStatus((snapshot) => {
      if (!mounted.current) return;
      setPendingOps(snapshot.pendingOps);
      setPendingAttachments(snapshot.pendingAttachments);
      setConflictCount(snapshot.conflictCount);
      setAutoSettings(snapshot.settings);
      setAutoNote(snapshot.lastAutoNote);
      if (snapshot.lastResult) setLastResult(snapshot.lastResult);
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [refresh]);

  const updateAutoSettings = useCallback(
    async (patch: Partial<AutoSyncSettings>) => {
      try {
        const next = await saveAutoSyncSettings(patch);
        if (!mounted.current) return;
        setAutoSettings(next);
        showToast("同步设置已保存", "success", "bottom");
      } catch (error) {
        if (mounted.current) showToast(`保存设置失败：${describeError(error)}`, "danger", "bottom");
      }
    },
    [showToast],
  );

  const paired = Boolean(connection && hasToken) && !invalid;

  const testConnection = useCallback(
    async (placement: ToastPlacement = "top") => {
      if (!connection) return;
      const token = await readToken();
      if (!token) {
        setHasToken(false);
        showToast("本机令牌缺失或已损坏，请重新配对", "danger", placement);
        return;
      }
      // v2 起连接测试也走指纹固定：指纹缺失（v1 旧记录 / 手动配对未观察到）时
      // 不发送令牌，直接提示重新配对，避免以首用信任把 Bearer 令牌交给中间人。
      const pin = (connection.tlsFingerprint ?? "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pin)) {
        showToast("缺少桌面端 TLS 指纹，请重新扫码配对", "danger", placement);
        return;
      }
      setBusy(true);
      try {
        const result = await pingDesktop({
          address: { host: connection.host, port: connection.port, baseUrl: connection.baseUrl },
          token,
          // 已钉住的桌面端 TLS 指纹（上面已强制非空）。
          tlsFingerprint: pin,
        });
        const now = new Date().toISOString();
        await touchConnection(now);
        if (!mounted.current) return;
        setConnection({ ...connection, lastSeenAt: now });
        setInvalid(false);
        showToast(`连接正常：${result.serverName || connection.serverName}`, "success", placement);
      } catch (error) {
        if (!mounted.current) return;
        if (error instanceof PairingRequestError && error.code === "unauthorized") {
          setInvalid(true);
        }
        showToast(pairingErrorMessage(error), "danger", placement);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [connection, showToast],
  );

  const runSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const outcome = await syncNow();
      if (!mounted.current) return;
      setLastResult(outcome);
      showToast(
        outcome.conflicts > 0
          ? `同步完成：接收 ${outcome.applied}，发送 ${outcome.pushed}，${outcome.conflicts} 条冲突待处理`
          : `同步完成：接收 ${outcome.applied}，发送 ${outcome.pushed}`,
        outcome.conflicts > 0 ? "info" : "success",
        "bottom",
      );
      await refresh();
      if (autoSettings?.autoTransferAttachments) {
        const transfer = await transferPendingAttachments().catch(() => null);
        if (transfer && transfer.sent > 0) {
          showToast(`同步顺带发送 ${transfer.sent} 个附件到电脑`, "success", "bottom");
        }
      }
    } catch (error) {
      if (mounted.current) showToast(`同步失败：${describeError(error)}`, "danger", "bottom");
    } finally {
      if (mounted.current) setSyncing(false);
    }
  }, [autoSettings?.autoTransferAttachments, refresh, showToast, syncing]);

  /** 手动发送待传附件：pending/failed 逐条重试，单条失败不影响其他附件 */
  const sendAttachments = useCallback(async () => {
    if (transferring) return;
    setTransferring(true);
    try {
      const outcome = await transferPendingAttachments();
      if (!mounted.current) return;
      if (outcome.unavailable) {
        showToast(outcome.message ?? "尚未配对，无法发送附件", "warn", "bottom");
      } else if (outcome.failed > 0) {
        showToast(
          `已发送 ${outcome.sent} 个，${outcome.failed} 个失败：${outcome.errors[0] ?? "未知原因"}`,
          "danger",
          "bottom",
        );
      } else if (outcome.sent > 0) {
        showToast(`已发送 ${outcome.sent} 个附件到电脑`, "success", "bottom");
      } else {
        showToast("没有待发送的附件", "info", "bottom");
      }
      await refresh();
    } catch (error) {
      if (mounted.current) showToast(`发送附件失败：${describeError(error)}`, "danger", "bottom");
    } finally {
      if (mounted.current) setTransferring(false);
    }
  }, [refresh, showToast, transferring]);

  const unpair = useCallback(() => {
    if (!connection) return;
    Alert.alert(
      "解除配对",
      `将删除本机保存的「${connection.serverName}」令牌。桌面端仍需在左侧导航「手机互传」撤销该设备，否则它会留在桌面端列表里。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "解除",
          style: "destructive",
          onPress: () => {
            setBusy(true);
            clearConnection()
              .then(async () => {
                // 本机不再持有对端同步状态：游标/冲突清空，避免下次配对沿用旧游标。
                await resetSyncState();
                if (!mounted.current) return;
                setConnection(null);
                setHasToken(false);
                setInvalid(false);
                setLastResult(null);
                setConflictCount(0);
                showToast("已解除本机配对", "success", "bottom");
              })
              .catch((error) => {
                if (mounted.current) {
                  showToast(`解除配对失败：${describeError(error)}`, "danger", "bottom");
                }
              })
              .finally(() => {
                if (mounted.current) setBusy(false);
              });
          },
        },
      ],
    );
  }, [connection, showToast]);

  return (
    <View style={styles.container}>
      <AppBar
        title="同步"
        badge={
          paired ? (
            <Badge label="已配对" tone="active" />
          ) : invalid ? (
            <Badge label="需重新配对" tone="unimplemented" />
          ) : undefined
        }
        onBack={nav.back}
      />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 48 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        <GlassCard style={styles.card}>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.dot,
                { backgroundColor: invalid ? tokens.danger : paired ? tokens.ok : tokens.faint },
              ]}
            />
            <Text style={[styles.statusText, { color: tokens.text }]}>
              {loading ? "读取中…" : invalid ? "令牌已失效" : paired ? "已配对" : "未配对"}
            </Text>
          </View>
          {connection && hasToken ? (
            <>
              <Text style={[styles.serverName, { color: tokens.text }]}>
                {connection.serverName}
              </Text>
              <Text style={[styles.cardHint, { color: tokens.textSoft }]}>
                {connection.baseUrl}
              </Text>
              {invalid ? (
                <Text style={[styles.cardHint, { color: tokens.danger }]}>
                  {connection.baseUrl.startsWith("http://")
                    ? "桌面端协议已升级（TLS 加密传输），旧连接不再受支持；请重新扫码配对，本机数据不会被删除。"
                    : "桌面端已撤销该设备或令牌已失效，请重新配对；本机数据不会被删除。"}
                </Text>
              ) : connection.fingerprint ? (
                <Text style={[styles.cardHint, { color: tokens.muted }]}>
                  设备指纹 {fingerprintLabel(connection.fingerprint)} · 上次连接{" "}
                  {formatStamp(connection.lastSeenAt)}
                </Text>
              ) : (
                <Text style={[styles.cardHint, { color: tokens.muted }]}>
                  上次连接 {formatStamp(connection.lastSeenAt)}
                </Text>
              )}
            </>
          ) : (
            <Text style={[styles.cardHint, { color: tokens.textSoft }]}>
              {connection
                ? "连接信息存在，但本机令牌缺失或已损坏；请重新配对。"
                : "与桌面端在同一 Wi-Fi 下完成配对后，这里会显示设备与最近连接时间。"}
            </Text>
          )}
          <SettingActionRow
            label="处理冲突"
            helper="两台设备同时修改同一条数据时，会在这里逐条选择保留哪一版"
            chevron
            onPress={() => nav.push("conflict")}
            trailing={
              conflictCount > 0 ? (
                <Badge label={`${conflictCount} 待处理`} tone="unimplemented" />
              ) : undefined
            }
          />
        </GlassCard>

        <View style={styles.tiles}>
          <View style={[styles.tile, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
            <Text style={[styles.tileLabel, { color: tokens.muted }]}>待发送操作</Text>
            <Text style={[styles.tileValue, { color: tokens.accentText }]}>{pendingOps}</Text>
          </View>
          <View style={[styles.tile, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
            <Text style={[styles.tileLabel, { color: tokens.muted }]}>待传附件</Text>
            <Text style={[styles.tileValue, { color: tokens.textSoft }]}>{pendingAttachments}</Text>
          </View>
          <View style={[styles.tile, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
            <Text style={[styles.tileLabel, { color: tokens.muted }]}>上次接收</Text>
            <Text style={[styles.tileValue, { color: tokens.textSoft }]}>
              {lastResult ? lastResult.applied : "—"}
            </Text>
          </View>
        </View>

        {pendingAttachments > 0 ? (
          <GlassCard style={styles.attachmentCard}>
            <Text style={[styles.cardHint, { color: tokens.textSoft }]}>
              {pendingAttachments} 个采集附件还在本机。照片/录音不会自动上传，除非你手动发送或开启
              「自动传送附件」。文本内容（收集箱正文）仍会正常同步。
            </Text>
            <PressableScale
              onPress={() => void sendAttachments()}
              disabled={transferring || !paired}
              accessibilityLabel="发送待传附件到电脑"
              contentStyle={[
                styles.secondaryButton,
                {
                  borderColor: tokens.cardBorder,
                  opacity: transferring || !paired ? 0.5 : 1,
                },
              ]}
            >
              <Text style={[styles.secondaryText, { color: tokens.accentText }]}>
                {transferring ? "正在发送附件…" : paired ? "发送待传附件" : "配对后可发送"}
              </Text>
            </PressableScale>
          </GlassCard>
        ) : null}

        {lastResult ? (
          <Text style={[styles.lastResult, { color: tokens.muted }]}>
            上次同步 {formatStamp(new Date(lastResult.at).toISOString())} · 接收{" "}
            {lastResult.applied} · 发送 {lastResult.pushed}
            {lastResult.conflicts > 0 ? ` · 冲突 ${lastResult.conflicts}` : ""}
            {lastResult.error ? ` · 失败：${lastResult.error}` : ""}
          </Text>
        ) : null}

        <SettingSection icon="desktop" title="已配对设备">
          {connection && hasToken ? (
            <SettingActionRow
              label={connection.serverName}
              helper={`${connection.baseUrl} · 上次连接 ${formatStamp(connection.lastSeenAt)}`}
              onPress={() => void testConnection()}
              trailing={
                busy ? (
                  <Text style={[styles.busyText, { color: tokens.muted }]}>测试中…</Text>
                ) : invalid ? (
                  <Badge label="需重新配对" tone="unimplemented" />
                ) : (
                  <Badge label="连接测试" tone="active" />
                )
              }
            />
          ) : (
            <EmptyState
              icon="sync"
              title="还没有配对设备"
              hint="先在桌面端发起配对，设备会出现在这里；撤销设备不会清空本机数据"
            />
          )}
        </SettingSection>

        <SettingSection icon="settings" title="同步设置">
          <SettingActionRow
            label="前台自动同步"
            helper="回到应用、或写完一条内容后自动补齐；最短间隔 5 分钟，失败按 30s→5min 退避"
            trailing={
              <ToggleSwitch
                value={autoSettings?.enabled ?? true}
                onChange={(value) => void updateAutoSettings({ enabled: value })}
                accessibilityLabel="前台自动同步"
              />
            }
          />
          <SettingActionRow
            label="仅 Wi-Fi 下同步"
            helper="无法确认网络类型时按计费网络处理，不自动同步"
            trailing={
              <ToggleSwitch
                value={autoSettings?.wifiOnly ?? true}
                onChange={(value) => void updateAutoSettings({ wifiOnly: value })}
                accessibilityLabel="仅 Wi-Fi 下同步"
              />
            }
          />
          <SettingActionRow
            label="自动传送附件"
            helper="照片/录音/文件经已配对的安全连接发到电脑；默认关闭，开启前请确认设备可信"
            trailing={
              <ToggleSwitch
                value={autoSettings?.autoTransferAttachments ?? false}
                onChange={(value) => void updateAutoSettings({ autoTransferAttachments: value })}
                accessibilityLabel="自动传送附件"
              />
            }
          />
          <SettingRow label="后台同步" value="不支持常驻（Android 限制）" valueTone="muted" />
          <SettingRow label="同步冲突时" value="不自动覆盖，写入冲突页" valueTone="muted" />
          <SettingRow label="同步范围" value="任务 / 收集箱 / 笔记" valueTone="muted" />
        </SettingSection>

        {autoNote ? (
          <Text style={[styles.lastResult, { color: tokens.muted }]}>上次自动同步：{autoNote}</Text>
        ) : null}

        {paired ? (
          <>
            <PressableScale
              onPress={() => void runSync()}
              disabled={syncing}
              accessibilityLabel="立即同步"
              accessibilityState={{ disabled: syncing }}
              contentStyle={[
                styles.primary,
                { backgroundColor: syncing ? tokens.track : tokens.accentFill },
              ]}
            >
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>
                {syncing ? "正在同步…" : "立即同步"}
              </Text>
            </PressableScale>
            <PressableScale
              onPress={() => void testConnection("bottom")}
              disabled={busy}
              accessibilityLabel="测试连接"
              accessibilityState={{ disabled: busy }}
              contentStyle={styles.secondary}
            >
              <Text style={[styles.secondaryText, { color: tokens.accentText }]}>
                {busy ? "正在测试连接…" : "测试连接"}
              </Text>
            </PressableScale>
            <PressableScale onPress={unpair} accessibilityLabel="解除本机配对" contentStyle={styles.dangerLink}>
              <Text style={[styles.dangerText, { color: tokens.danger }]}>解除本机配对</Text>
            </PressableScale>
          </>
        ) : (
          <>
            <PressableScale
              onPress={() => nav.push("pairing")}
              accessibilityLabel={invalid ? "重新配对" : "配对新设备"}
              contentStyle={[styles.primary, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>
                {invalid ? "重新配对" : "配对新设备"}
              </Text>
            </PressableScale>
            {invalid ? (
              <PressableScale
                onPress={unpair}
                accessibilityLabel="解除本机配对"
                contentStyle={styles.dangerLink}
              >
                <Text style={[styles.dangerText, { color: tokens.danger }]}>解除本机配对</Text>
              </PressableScale>
            ) : null}
          </>
        )}

        <Text style={[styles.footer, { color: tokens.faint }]}>
          同步任务、收集箱与笔记：pull 应用桌面端变更，push 发送本机修改；载荷已用配对令牌
          派生的密钥加密。自动同步只在前台运行，不承诺 Android 后台常驻；采集附件走独立的
          文件互传通道，失败可在这里重试。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    paddingBottom: 48,
    paddingHorizontal: space.lg,
    gap: space.md,
  },
  card: {
    marginTop: space.md,
    padding: space.md,
    gap: space.sm,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs + 1,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  serverName: {
    fontSize: font.title,
    fontWeight: "700",
  },
  cardHint: {
    fontSize: font.body,
    lineHeight: 19,
  },
  tiles: {
    flexDirection: "row",
    gap: space.sm,
  },
  tile: {
    flex: 1,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    gap: 2,
  },
  attachmentCard: {
    padding: space.md,
    gap: space.sm,
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  tileLabel: {
    fontSize: font.label,
    fontWeight: "600",
  },
  tileValue: {
    fontSize: font.stat,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
  },
  primaryText: {
    fontSize: font.title,
    fontWeight: "600",
  },
  secondary: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  dangerLink: {
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  dangerText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  busyText: {
    fontSize: font.label,
  },
  lastResult: {
    fontSize: font.label,
    lineHeight: 16,
    textAlign: "center",
    paddingHorizontal: space.sm,
  },
  footer: {
    fontSize: font.label,
    lineHeight: 16,
    textAlign: "center",
    paddingHorizontal: space.sm,
  },
});
