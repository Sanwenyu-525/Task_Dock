// 设备页：配对、同步、文件互传与冲突的统一入口。
//
// 这些是操作而不是偏好，所以从「设置 → 手机与同步」提到一级 Tab：
// - 已配对时先看到连接状态与待发送/冲突数量，再进同步中心或文件互传；
// - 未配对时只留一个明确的「配对新设备」主操作，不把空页堆满不可用入口；
// - 设置页只保留外观/提醒/本地数据/关于，避免同一个功能有两套入口。
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Badge } from "../components/Badge";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import { SettingActionRow } from "../components/SettingActionRow";
import { SettingSection } from "../components/SettingSection";
import { StatusPill } from "../components/StatusPill";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { countSyncConflicts } from "../db/sync";
import {
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

export function DeviceScreen({ nav, version = 0 }: { nav: Nav; version?: number }) {
  const { tokens } = useTheme();
  const [connection, setConnection] = useState<PairedConnection | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [pendingOps, setPendingOps] = useState(0);
  const [conflicts, setConflicts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const mounted = useRef(true);
  const toastSeq = useRef(0);

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

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
      ? "同步已连接"
      : invalid
        ? "需重新配对"
        : "本机模式";
  const statusTone = paired ? "ok" : invalid ? "danger" : "neutral";

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.titleBlock}>
          <Text accessibilityRole="header" style={[styles.title, { color: tokens.text }]}>
            设备
          </Text>
          <Text numberOfLines={1} style={[styles.subtitle, { color: tokens.muted }]}>
            {loading
              ? "正在读取连接状态…"
              : paired
                ? `已连接 ${connection?.serverName ?? "桌面端"}`
                : invalid
                  ? legacy
                    ? "桌面端已升级加密传输，请重新配对"
                    : "配对信息需要重新确认"
                  : "尚未连接桌面端 · 数据只在本机"}
          </Text>
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
              label={paired ? "已连接" : invalid ? "需重新配对" : "未配对"}
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

        <SettingSection title="同步与传输">
          <SettingActionRow
            label="同步中心"
            helper={
              paired
                ? `待发送 ${pendingOps} 条${conflicts > 0 ? ` · 冲突 ${conflicts} 条` : ""}`
                : "配对后查看连接、立即同步与解除配对"
            }
            trailing={
              paired ? (
                <Badge label="已连接" tone="active" />
              ) : invalid ? (
                <Badge label="需重新配对" tone="unimplemented" />
              ) : undefined
            }
            chevron
            accessibilityHint="打开同步中心，测试连接或立即同步"
            onPress={() => nav.push("sync")}
          />
          <SettingActionRow
            label="文件互传"
            helper="与电脑双向传输文件，分块加密，只走局域网"
            chevron
            accessibilityHint="打开文件互传页，上传或下载文件"
            onPress={() => nav.push("files")}
          />
          <SettingActionRow
            label="处理冲突"
            helper="两端都改过同一条记录时，在这里选择保留哪一端"
            trailing={
              conflicts > 0 ? <StatusPill label={`${conflicts} 条`} tone="danger" /> : undefined
            }
            chevron
            accessibilityHint="查看同步冲突并选择保留哪一端"
            onPress={() => nav.push("conflict")}
          />
        </SettingSection>

        <SettingSection title="连接与更多">
          <SettingActionRow
            label="配对新设备"
            helper={
              connection
                ? `已配对：${connection.serverName}`
                : "扫码或输入 6 位码，与桌面端建立连接"
            }
            trailing={
              paired ? (
                <Badge label="已配对" tone="active" />
              ) : invalid ? (
                <Badge label="需重新配对" tone="unimplemented" />
              ) : undefined
            }
            chevron
            accessibilityHint="打开配对页，扫描二维码或手动输入配对码"
            onPress={() => nav.push("pairing")}
          />
          <SettingActionRow
            label="主屏小组件"
            helper="把今天的任务放到桌面"
            trailing={<Badge label="已接入" tone="active" />}
            chevron
            accessibilityHint="桌面小组件配置"
            onPress={() => nav.push("widget")}
          />
          <SettingActionRow
            label="分享接收"
            helper="从其他应用分享文本到收集箱"
            trailing={<Badge label="已接入" tone="active" />}
            chevron
            accessibilityHint="系统分享到 TaskDock"
            onPress={() => nav.push("share")}
          />
        </SettingSection>

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
  titleBlock: {
    gap: 1,
    marginBottom: space.xs,
  },
  title: {
    fontSize: font.display,
    fontWeight: "800",
    letterSpacing: -0.8,
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
  footer: {
    marginTop: space.xs,
    fontSize: font.label,
    lineHeight: 17,
    textAlign: "center",
  },
});
