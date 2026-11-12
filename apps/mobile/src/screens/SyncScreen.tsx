// 同步中心：已配对连接展示真实状态，可测试连通性、立即同步与解除本机配对。
// 同步范围：任务、收集箱、笔记（pull + push，加密载荷）；后台同步仍在下一轮。
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
import {
  Toast,
  TOAST_TOP_PUSH,
  type ToastMessage,
  type ToastPlacement,
  type ToastTone,
} from "../components/Toast";
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
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);
  const mounted = useRef(true);

  const showToast = useCallback(
    (text: string, tone: ToastTone = "info", placement?: ToastPlacement) => {
      toastSeq.current += 1;
      setToast({ id: toastSeq.current, text, tone, placement });
    },
    [],
  );
  const dismissToast = useCallback(() => setToast(null), []);

  const refresh = useCallback(async () => {
    try {
      const [ops, meta, token, last, conflicts] = await Promise.all([
        countPendingSyncOps(),
        loadConnection(),
        readToken(),
        loadSyncResult(),
        countSyncConflicts(),
      ]);
      if (!mounted.current) return;
      setPendingOps(ops);
      setConnection(meta);
      setHasToken(Boolean(token));
      setLastResult(last);
      setConflictCount(conflicts);
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
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

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
    } catch (error) {
      if (mounted.current) showToast(`同步失败：${describeError(error)}`, "danger", "bottom");
    } finally {
      if (mounted.current) setSyncing(false);
    }
  }, [refresh, showToast, syncing]);

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
            <Text style={[styles.tileValue, { color: tokens.accent }]}>{pendingOps}</Text>
          </View>
          <View style={[styles.tile, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
            <Text style={[styles.tileLabel, { color: tokens.muted }]}>上次接收</Text>
            <Text style={[styles.tileValue, { color: tokens.textSoft }]}>
              {lastResult ? lastResult.applied : "—"}
            </Text>
          </View>
        </View>

        {lastResult ? (
          <Text style={[styles.lastResult, { color: tokens.muted }]}>
            上次同步 {formatStamp(new Date(lastResult.at).toISOString())} · 接收{" "}
            {lastResult.applied} · 发送 {lastResult.pushed}
            {lastResult.conflicts > 0 ? ` · 冲突 ${lastResult.conflicts}` : ""}
            {lastResult.error ? ` · 失败：${lastResult.error}` : ""}
          </Text>
        ) : null}

        <SettingSection title="已配对设备">
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
              title="还没有配对设备"
              hint="先在桌面端发起配对，设备会出现在这里；撤销设备不会清空本机数据"
            />
          )}
        </SettingSection>

        <SettingSection title="同步设置" trailing={<Badge label="后台待接入" />}>
          <SettingActionRow
            label="仅 Wi-Fi 下同步"
            trailing={
              <ToggleSwitch
                value={false}
                onChange={() => undefined}
                disabled
                accessibilityLabel="仅 Wi-Fi 下同步（规划中）"
              />
            }
          />
          <SettingActionRow
            label="后台同步"
            helper="有待同步内容时运行，不做常驻轮询"
            trailing={
              <ToggleSwitch
                value={false}
                onChange={() => undefined}
                disabled
                accessibilityLabel="后台同步（规划中）"
              />
            }
          />
          <SettingRow label="同步冲突时" value="不自动覆盖，写入冲突页" valueTone="muted" />
          <SettingRow label="同步范围" value="任务 / 收集箱 / 笔记" valueTone="muted" />
        </SettingSection>

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
              <Text style={[styles.secondaryText, { color: tokens.accent }]}>
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
          派生的密钥加密。后台同步仍在下一轮。
        </Text>
      </ScrollView>

      <Toast
        toast={toast}
        onDismiss={dismissToast}
        placement="top"
        topOffset={TOAST_TOP_PUSH}
        bottomOffset={space.lg + insets.bottom}
      />
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
