// 设备页：当前这台设备的连接状态与配对上下文。
//
// 归属收口（第九轮 IA）：同步中心归「我的」、文件互传归「工作区」，本页不再重复这两个目录入口；
// - 已配对时先看到连接状态与待发送/冲突数量；未配对状态卡上只留「配对新设备」主操作；
// - 配对是真实 TLS 链路；投屏属于桌面端能力，移动端只做降饱和占位。
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { EntryRow } from "../components/EntryRow";
import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import { SettingSection } from "../components/SettingSection";
import { StatusPill } from "../components/StatusPill";
import { useToast } from "../feedback/ToastProvider";
import { countSyncConflicts, resetSyncState } from "../db/sync";
import {
  clearConnection,
  loadConnection,
  readToken,
  type PairedConnection,
} from "../db/syncConnection";
import { countPendingOutbox } from "../db/tasks";
import { describeError } from "../lib/errors";
import { useWindowInsets } from "../lib/insets";
import type { Nav } from "../lib/nav";
import { isLegacyConnection } from "../lib/sync/connectionState";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

/** 最近连接时间：当年只显示月日，跨年才补年份。 */
function formatStamp(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return sameYear ? `${day} ${time}` : `${date.getFullYear()}年${day} ${time}`;
}

export function DeviceScreen({
  nav,
  version = 0,
  onBack,
}: {
  nav: Nav;
  version?: number;
  /** 从「我的」进入时的返回；一级栏时代不传 */
  onBack?: () => void;
}) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const [connection, setConnection] = useState<PairedConnection | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [pendingOps, setPendingOps] = useState(0);
  const [conflicts, setConflicts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [unpairing, setUnpairing] = useState(false);

  const mounted = useRef(true);

  const { showToast } = useToast();

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
            setUnpairing(true);
            clearConnection()
              .then(async () => {
                // 令牌已删除；先让 UI 进入未配对，避免 resetSyncState 失败时页面仍显示
                // 「已配对」而本机实际已没有令牌。游标/冲突清理失败只降级提示，不回滚配对。
                if (mounted.current) {
                  setConnection(null);
                  setHasToken(false);
                  setPendingOps(0);
                  setConflicts(0);
                }
                try {
                  await resetSyncState();
                  if (mounted.current) showToast("已解除本机配对", "success");
                } catch (error) {
                  if (mounted.current) {
                    showToast(
                      `已解除本机配对，但同步状态清理失败：${describeError(error)}`,
                      "warn",
                    );
                  }
                }
              })
              .catch((error) => {
                if (mounted.current) {
                  showToast(`解除配对失败：${describeError(error)}`, "danger");
                }
              })
              .finally(() => {
                if (mounted.current) setUnpairing(false);
              });
          },
        },
      ],
    );
  }, [connection, showToast]);

  const refresh = useCallback(async () => {
    try {
      const [meta, token, pending, conflictCount] = await Promise.all([
        loadConnection().catch(() => null),
        readToken().catch(() => null),
        countPendingOutbox().catch(() => 0),
        countSyncConflicts().catch(() => 0),
      ]);
      if (!mounted.current) return;
      setConnection(meta);
      setHasToken(Boolean(token));
      setPendingOps(pending);
      setConflicts(conflictCount);
    } catch (error) {
      if (mounted.current) showToast(`读取连接状态失败：${describeError(error)}`, "danger");
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
  }, [refresh, version]);

  const legacy = isLegacyConnection(connection);
  // 连接元数据还在但令牌丢失、或是 v1 遗留/缺指纹记录：都不能显示健康态，
  // 也不能直接当「未配对」把数据说丢。
  const invalid = Boolean(connection) && (legacy || !hasToken);
  const paired = Boolean(connection && hasToken) && !invalid;
  const statusLabel = loading
    ? "读取中…"
    : paired
      ? "已配对"
      : invalid
        ? "需重新配对"
        : "本机模式";
  const statusTone = paired ? "ok" : invalid ? "danger" : "neutral";
  const statusDesc = loading
    ? "正在读取连接状态…"
    : paired
      ? `配对设备 ${connection?.serverName ?? "桌面端"} · 前台自动同步`
      : invalid
        ? legacy
          ? "桌面端已升级加密传输，请重新配对"
          : "配对信息需要重新确认"
        : "尚未连接桌面端 · 数据只在本机";

  return (
    <View style={[styles.container, { backgroundColor: tokens.bg }]}>
      <AppBar title="设备" onBack={onBack ?? nav.back} />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        <GlassCard level="primary" style={styles.statusCard}>
          <View style={styles.statusTop}>
            <View style={styles.statusMain}>
              <Text style={[styles.statusEyebrow, { color: tokens.muted }]}>连接状态</Text>
              <Text numberOfLines={1} style={[styles.statusTitle, { color: tokens.text }]}>
                {statusLabel}
              </Text>
            </View>
            <StatusPill
              label={paired ? "已配对" : invalid ? "需重新配对" : "未配对"}
              tone={statusTone}
            />
          </View>

          <Text numberOfLines={2} style={[styles.statusDesc, { color: tokens.textSoft }]}>
            {statusDesc}
          </Text>

          {connection ? (
            <View style={styles.statusMeta}>
              <Text numberOfLines={1} style={[styles.statusLine, { color: tokens.textSoft }]}>
                {connection.baseUrl}
              </Text>
              <Text style={[styles.statusLine, { color: tokens.muted }]}>
                {connection.lastSeenAt
                  ? `上次连接 ${formatStamp(connection.lastSeenAt)}`
                  : "还没有成功连接记录"}
              </Text>
              {paired ? (
                <Text style={[styles.statusLine, { color: tokens.muted }]}>
                  待发送 {pendingOps} 条{conflicts > 0 ? ` · 冲突 ${conflicts} 条` : ""}
                </Text>
              ) : null}
            </View>
          ) : (
            <Text style={[styles.statusHint, { color: tokens.textSoft }]}>
              与电脑在同一 Wi-Fi 下配对后，任务、笔记、收集箱和文件可以互通。
            </Text>
          )}

          {!paired ? (
            <PressableScale
              onPress={() => nav.push("pairing")}
              accessibilityLabel={invalid ? "重新配对" : "配对新设备"}
              contentStyle={[styles.primary, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>
                {invalid ? "重新配对" : "配对新设备"}
              </Text>
            </PressableScale>
          ) : null}
        </GlassCard>

        {/* 同步中心归属「我的」、文件互传归属「工作区」，本页不再重复这两个目录入口；
            这里只放与当前这台设备直接相关的配对/换设备，以及同步异常上下文的冲突处理。 */}
        {paired || conflicts > 0 ? (
          <SettingSection icon="link" title="配对与设备">
            {paired ? (
              <EntryRow
                icon="qr"
                label="配对新设备"
                helper={`当前：${connection?.serverName ?? "桌面端"} · 扫码或输入 6 位配对码`}
                onPress={() => nav.push("pairing")}
              />
            ) : null}
            {conflicts > 0 ? (
              <EntryRow
                icon="warning"
                label="处理冲突"
                helper={`${conflicts} 条冲突待处理`}
                divider
                onPress={() => nav.push("conflict")}
              />
            ) : null}
          </SettingSection>
        ) : null}

        {/* 投屏是桌面端能力，移动端没有对应链路：只降饱和占位，不可点、不挂箭头与数字 */}
        <GlassCard style={styles.placeholderCard}>
          <FeatureIconPlaceholder
            icon="desktop"
            label="投屏"
            hint="桌面端能力，移动端未接入"
            variant="inline"
          />
        </GlassCard>

        {paired ? (
          <PressableScale
            onPress={unpair}
            accessibilityLabel="解除本机配对"
            accessibilityHint="清除本机保存的配对令牌，桌面端仍需单独撤销设备"
            disabled={unpairing}
            contentStyle={styles.unpair}
          >
            <Text style={[styles.unpairText, { color: tokens.danger }]}>
              {unpairing ? "正在解除…" : "解除配对"}
            </Text>
          </PressableScale>
        ) : null}

        <Text style={[styles.footer, { color: tokens.faint }]}>
          文件与同步只在局域网内传输，不经过云端。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxl,
    gap: space.md,
  },
  statusCard: {
    padding: space.md + 2,
    gap: space.sm,
  },
  statusTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  statusMain: {
    flex: 1,
    gap: 2,
  },
  statusEyebrow: {
    fontSize: font.label,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  statusTitle: {
    fontSize: font.title,
    fontWeight: "700",
  },
  statusDesc: {
    fontSize: font.meta,
    lineHeight: 18,
  },
  statusMeta: {
    gap: 2,
  },
  statusLine: {
    fontSize: font.meta,
    fontVariant: ["tabular-nums"],
  },
  statusHint: {
    fontSize: font.meta,
    lineHeight: 18,
  },
  primary: {
    minHeight: 48,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: {
    fontSize: font.title,
    fontWeight: "700",
  },
  placeholderCard: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  unpair: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  unpairText: {
    fontSize: font.meta,
    fontWeight: "600",
  },
  footer: {
    marginTop: space.xs,
    fontSize: font.label,
    lineHeight: 17,
    textAlign: "center",
  },
});
