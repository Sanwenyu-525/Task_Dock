// 设备页：连接状态、配对与同步的唯一设备上下文。
//
// 这些是操作而不是偏好，所以从「设置 → 手机与同步」提到一级 Tab：
// - 已配对时先看到连接状态与待发送/冲突数量，再进同步中心；
// - 未配对时只留一个明确的「配对新设备」主操作，不把空页堆满不可用入口；
// - 设置页只保留外观/提醒/本地数据/关于，避免同一个功能有两套入口。
//
// 第九轮：设备页不再做成第二个功能目录——
// 文件互传（工作区文件集合）、处理冲突（我的 → 处理冲突 / 同步页内）、
// 主屏小组件（我的 → 主屏小组件）、分享接收（采集中心）都已从本页移除；
// 只保留与「当前这台设备」直接相关的状态、同步与配对。
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Badge } from "../components/Badge";
import { BackButton } from "../components/BackButton";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import { SettingActionRow } from "../components/SettingActionRow";
import { SettingSection } from "../components/SettingSection";
import { StatusPill } from "../components/StatusPill";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { countSyncConflicts, resetSyncState } from "../db/sync";
import {
  clearConnection,
  loadConnection,
  readToken,
  type PairedConnection,
} from "../db/syncConnection";
import { countPendingOutbox } from "../db/tasks";
import { describeError } from "../lib/errors";
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
  const [connection, setConnection] = useState<PairedConnection | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [pendingOps, setPendingOps] = useState(0);
  const [conflicts, setConflicts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [unpairing, setUnpairing] = useState(false);

  const mounted = useRef(true);
  const toastSeq = useRef(0);

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

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
                // 与同步页同一套状态：清掉游标/冲突，避免下次配对沿用旧游标。
                await resetSyncState();
                if (!mounted.current) return;
                setConnection(null);
                setHasToken(false);
                setPendingOps(0);
                setConflicts(0);
                showToast("已解除本机配对", "success");
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

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          {onBack ? <BackButton onPress={onBack} /> : null}
          <View style={styles.titleBlock}>
            <Text accessibilityRole="header" style={[styles.title, { color: tokens.text }]}>
              设备
            </Text>
            <Text numberOfLines={1} style={[styles.subtitle, { color: tokens.muted }]}>
              {loading
                ? "正在读取连接状态…"
                : paired
                  ? `配对设备 ${connection?.serverName ?? "桌面端"} · 前台自动同步`
                  : invalid
                    ? legacy
                      ? "桌面端已升级加密传输，请重新配对"
                      : "配对信息需要重新确认"
                    : "尚未连接桌面端 · 数据只在本机"}
            </Text>
          </View>
        </View>

        <GlassCard style={styles.statusCard}>
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

        {/* 未配对时上面已有主操作按钮，这里再放一行同样的「配对新设备」就是页内重复；
            因此整段只在已配对时渲染（换设备/重新配对），避免留下一个只有标题的空分组。 */}
        {paired ? (
          <SettingSection icon="link" title="连接与更多">
            <SettingActionRow
              label="配对新设备"
              helper={`当前：${connection?.serverName ?? "桌面端"}`}
              trailing={<Badge label="已配对" tone="active" />}
              chevron
              accessibilityHint="打开配对页，扫描二维码或手动输入配对码"
              onPress={() => nav.push("pairing")}
            />
          </SettingSection>
        ) : null}

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

      <Toast toast={toast} onDismiss={dismissToast} placement="top" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: 44,
    gap: space.md,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
  },
  titleBlock: {
    flex: 1,
    gap: 1,
    marginBottom: space.xs,
  },
  title: {
    fontSize: font.page,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: font.page + 7,
  },
  subtitle: {
    fontSize: font.meta,
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
