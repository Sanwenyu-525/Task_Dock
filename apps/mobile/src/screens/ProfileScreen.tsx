// 我的：应用信息 → 设备状态 → 设备入口 → 个人功能 → 设置与偏好。
// 设备状态只表达「配对/需重新配对/本机模式」，不把已配对说成已自动同步。
//
// 第三轮口径：上一版把 6 个设备入口平铺成一张长菜单，页面像功能清单。现在按使用频率分层：
// 4 个高频入口（同步中心 / 文件互传 / 配对新设备 / 设备详情）+ 2 个次要入口收在同一张卡的
// 底部链接行（处理冲突 / 主屏小组件），两者都保持真实可达。
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import appConfig from "../../app.json";
import { EntryRow } from "../components/EntryRow";
import { GlassCard } from "../components/GlassCard";
import { IconTile } from "../components/IconTile";
import { ScreenHeader } from "../components/ScreenHeader";
import { SectionHeader } from "../components/SectionHeader";
import { StatusPill } from "../components/StatusPill";
import { listCaptures } from "../db/captures";
import { listNotes } from "../db/notes";
import { countSyncConflicts } from "../db/sync";
import { loadConnection, readToken, type PairedConnection } from "../db/syncConnection";
import { listTasks } from "../db/tasks";
import { describeError } from "../lib/errors";
import type { AppNav } from "../lib/nav";
import { isLegacyConnection } from "../lib/sync/connectionState";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

const THEME_LABEL = { system: "跟随系统", light: "浅色", dark: "深色" } as const;

export function ProfileScreen({ nav, version }: { nav: AppNav; version: number }) {
  const { tokens, mode } = useTheme();
  const [connection, setConnection] = useState<PairedConnection | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [conflicts, setConflicts] = useState(0);
  const [summary, setSummary] = useState({ tasks: 0, captures: 0, notes: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 版本号连点计数：图标预览是开发验收页，不给正式入口 */
  const versionTaps = useRef(0);
  const lastVersionTap = useRef(0);

  const handleVersionPress = useCallback(() => {
    const at = Date.now();
    versionTaps.current = at - lastVersionTap.current < 1200 ? versionTaps.current + 1 : 1;
    lastVersionTap.current = at;
    if (versionTaps.current >= 5) {
      versionTaps.current = 0;
      nav.push("icon_gallery");
    }
  }, [nav]);
  const requestSeq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestSeq.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestSeq.current;
    try {
      const [meta, token, conflictCount, tasks, captures, notes] = await Promise.all([
        loadConnection().catch(() => null),
        readToken().catch(() => null),
        countSyncConflicts().catch(() => 0),
        listTasks(),
        listCaptures(),
        listNotes(),
      ]);
      if (!mounted.current || request !== requestSeq.current) return;
      setConnection(meta);
      setHasToken(Boolean(token));
      setConflicts(conflictCount);
      setSummary({ tasks: tasks.length, captures: captures.length, notes: notes.length });
      setError(null);
    } catch (reason) {
      if (!mounted.current || request !== requestSeq.current) return;
      setError(describeError(reason));
    } finally {
      if (!mounted.current || request !== requestSeq.current) return;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  const legacy = isLegacyConnection(connection);
  const invalid = Boolean(connection) && (legacy || !hasToken);
  const paired = Boolean(connection && hasToken) && !invalid;
  const statusLabel = loading ? "读取中…" : paired ? "已配对" : invalid ? "需重新配对" : "本机模式";
  const statusTone = paired ? "ok" : invalid ? "danger" : "neutral";

  return (
    <View style={styles.root}>
      <ScreenHeader title="我的" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <GlassCard style={styles.appCard}>
          <IconTile name="project" size={46} tone="brand" iconSize={24} />
          <View style={styles.appText}>
            <Text style={[styles.appName, { color: tokens.text }]}>Task Dock</Text>
            {/* 连点版本号 5 次进入图标预览（开发验收用，不占正式入口） */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`版本 v${appConfig.expo.version}，连点 5 次打开图标预览`}
              onPress={handleVersionPress}
            >
              <Text style={[styles.appMeta, { color: tokens.muted }]}>
                开发效率中枢 · v{appConfig.expo.version}
              </Text>
            </Pressable>
          </View>
        </GlassCard>

        {loading ? (
          <ActivityIndicator color={tokens.accent} />
        ) : error ? (
          <GlassCard style={styles.errorCard}>
            <Text style={[styles.errorTitle, { color: tokens.danger }]}>读取本机状态失败</Text>
            <Text style={[styles.errorHint, { color: tokens.muted }]}>{error}</Text>
          </GlassCard>
        ) : (
          <>
            <View style={styles.group}>
              <SectionHeader icon="smartphone" title="设备与连接" />
              <GlassCard level="primary" style={styles.statusCard}>
                <View style={styles.statusRow}>
                  <StatusPill label={statusLabel} tone={statusTone} />
                  <Text numberOfLines={2} style={[styles.statusNote, { color: tokens.muted }]}>
                    {paired
                      ? `配对设备 ${connection?.serverName ?? "桌面端"} · 同步需手动发起`
                      : invalid
                        ? "桌面端已升级加密传输，请重新配对"
                        : "尚未连接桌面端 · 数据只在本机"}
                  </Text>
                </View>
              </GlassCard>

              <GlassCard style={styles.card}>
                <EntryRow
                  icon="sync"
                  label="同步中心"
                  helper="手动拉取/发送变更，查看待同步数量"
                  onPress={() => nav.push("sync")}
                />
                <EntryRow
                  icon="transfer"
                  label="文件互传"
                  helper="局域网内收发文件（TLS + 指纹固定）"
                  onPress={() => nav.push("files")}
                />
                <EntryRow
                  icon="smartphone"
                  label="配对新设备"
                  helper="扫描桌面端二维码或输入 6 位配对码"
                  onPress={() => nav.push("pairing")}
                />
                <EntryRow
                  icon="desktop"
                  label="设备详情"
                  helper="完整连接信息与解除配对"
                  onPress={() => nav.push("device")}
                />
                {/* 次要入口收成一行链接：仍然真实可达，但不再各占一行 56dp */}
                <View style={[styles.subLinks, { borderTopColor: tokens.separator }]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      conflicts > 0 ? `处理冲突，有 ${conflicts} 条待处理` : "处理冲突"
                    }
                    onPress={() => nav.push("conflict")}
                    hitSlop={{ top: 8, bottom: 8 }}
                    style={({ pressed }) => [styles.subLink, { opacity: pressed ? 0.6 : 1 }]}
                  >
                    <Text style={[styles.subLinkText, { color: tokens.accentText }]}>处理冲突</Text>
                    {conflicts > 0 ? (
                      <View style={[styles.countPill, { backgroundColor: tokens.dangerSoft }]}>
                        <Text style={[styles.countText, { color: tokens.danger }]}>{conflicts}</Text>
                      </View>
                    ) : null}
                  </Pressable>
                  <View style={[styles.subLinkDot, { backgroundColor: tokens.separator }]} />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="主屏小组件"
                    onPress={() => nav.push("widget")}
                    hitSlop={{ top: 8, bottom: 8 }}
                    style={({ pressed }) => [styles.subLink, { opacity: pressed ? 0.6 : 1 }]}
                  >
                    <Text style={[styles.subLinkText, { color: tokens.accentText }]}>
                      主屏小组件
                    </Text>
                  </Pressable>
                </View>
              </GlassCard>
            </View>

            <View style={styles.group}>
              <SectionHeader icon="profile" title="个人功能" />
              <GlassCard style={styles.card}>
                <EntryRow
                  icon="note"
                  label="笔记"
                  onPress={() => nav.push("notes")}
                  trailingText={`${summary.notes} 条`}
                />
                <EntryRow
                  icon="inbox"
                  label="收集箱"
                  onPress={() => nav.push("inbox")}
                  trailingText={`${summary.captures} 条`}
                />
                <EntryRow
                  icon="bell"
                  label="通知"
                  onPress={() => nav.push("notifications")}
                />
              </GlassCard>
            </View>

            <View style={styles.group}>
              <SectionHeader icon="settings" title="设置与偏好" />
              <GlassCard style={styles.card}>
                <EntryRow
                  icon="settings"
                  label="设置"
                  helper={`主题（${THEME_LABEL[mode]}）、通知提醒、本地数据与关于`}
                  onPress={() => nav.push("settings")}
                />
                <View style={[styles.summaryRow, { borderTopColor: tokens.separator }]}>
                  <Text style={[styles.summaryLabel, { color: tokens.muted }]}>本机数据</Text>
                  <Text numberOfLines={1} style={[styles.summaryValue, { color: tokens.textSoft }]}>
                    {summary.tasks} 任务 · {summary.captures} 速记 · {summary.notes} 笔记
                  </Text>
                </View>
              </GlassCard>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxl,
    gap: space.section,
  },
  /** 模块内标题与内容 12dp；模块之间 20dp */
  group: { gap: space.md },
  appCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  appIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  appText: { flex: 1, gap: 1 },
  appName: { fontSize: font.section, fontWeight: "800", letterSpacing: -0.2 },
  appMeta: { fontSize: font.meta },
  errorCard: { padding: space.lg, gap: space.xs },
  errorTitle: { fontSize: font.body, fontWeight: "700" },
  errorHint: { fontSize: font.label, lineHeight: 17 },
  statusCard: { paddingHorizontal: space.md, paddingVertical: space.sm },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 44,
  },
  statusNote: { flex: 1, fontSize: font.label, lineHeight: 17 },
  card: { paddingHorizontal: space.md, paddingVertical: space.xxs },
  subLinks: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  subLink: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 44 },
  subLinkText: { fontSize: font.meta, fontWeight: "600" },
  subLinkDot: { width: 1, height: 12 },
  countPill: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  countText: { fontSize: font.label, fontWeight: "700" },
  summaryRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  summaryLabel: { fontSize: font.label, fontWeight: "600" },
  summaryValue: { fontSize: font.label, flexShrink: 1 },
});
