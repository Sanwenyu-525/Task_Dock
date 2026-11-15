// 我的：本机身份概览 → 工作概览（真实计数）→ 最近内容 → 通知入口 → 数据同步状态 → 快捷设置。
//
// 数据边界（见 tmp/acceptance/mobile-ui-unified/01-audit.md 第 2 节）：
// - 没有账号体系：不编造用户名、等级、会员、头像；身份行只显示真实连接状态与本机模式；
// - 工作概览数字全部来自本机表（tasks/notes/captures/capture_stash），不推算进度与百分比；
// - 最近内容只取真实最近更新的笔记与任务，不写「最近访问项目」；
// - 同步状态复用既有查询（配对元数据 / 令牌 / 冲突 / 待发操作），不新造数据源；
// - 账户与安全、桌面联动、帮助与反馈在移动端未实现，降饱和占位且不可点。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import appConfig from "../../app.json";
import { BrandMark } from "../components/BrandMark";
import { EntryRow } from "../components/EntryRow";
import { FeatureIconPlaceholder } from "../components/FeatureIconPlaceholder";
import { GlassCard } from "../components/GlassCard";
import { IconEntry } from "../components/IconEntry";
import { IconTile } from "../components/IconTile";
import { MetricTile } from "../components/MetricTile";
import { PressableScale } from "../components/PressableScale";
import { ScreenHeader } from "../components/ScreenHeader";
import { SectionHeader } from "../components/SectionHeader";
import { StatusPill } from "../components/StatusPill";
import { countStashItems } from "../db/captureStash";
import { listCaptures } from "../db/captures";
import { listNotes } from "../db/notes";
import { listReminderSchedules } from "../db/reminderSchedule";
import { countPendingSyncOps, countSyncConflicts } from "../db/sync";
import { loadConnection, readToken, type PairedConnection } from "../db/syncConnection";
import { listTasks } from "../db/tasks";
import { describeError } from "../lib/errors";
import type { AppNav } from "../lib/nav";
import { formatRelative } from "../domain/taskQuery";
import { isLegacyConnection } from "../lib/sync/connectionState";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

type RecentItem =
  | { kind: "note"; id: string; title: string; at: number }
  | { kind: "task"; id: string; title: string; at: number; done: boolean };

interface Overview {
  pending: number;
  notes: number;
  captures: number;
  stash: number;
}

export function ProfileScreen({ nav, version }: { nav: AppNav; version: number }) {
  const { tokens } = useTheme();
  const [connection, setConnection] = useState<PairedConnection | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [conflicts, setConflicts] = useState(0);
  const [pendingOps, setPendingOps] = useState(0);
  const [reminders, setReminders] = useState(0);
  const [overview, setOverview] = useState<Overview>({
    pending: 0,
    notes: 0,
    captures: 0,
    stash: 0,
  });
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 版本号连点计数：图标预览是开发验收页，不给正式入口 */
  const versionTaps = useRef(0);
  const lastVersionTap = useRef(0);
  const requestSeq = useRef(0);
  const mounted = useRef(true);

  const handleVersionPress = useCallback(() => {
    const at = Date.now();
    versionTaps.current = at - lastVersionTap.current < 1200 ? versionTaps.current + 1 : 1;
    lastVersionTap.current = at;
    if (versionTaps.current >= 5) {
      versionTaps.current = 0;
      nav.push("icon_gallery");
    }
  }, [nav]);

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
      const [meta, token, conflictCount, pending, tasks, captures, notes, stash, schedules] =
        await Promise.all([
          loadConnection().catch(() => null),
          readToken().catch(() => null),
          countSyncConflicts().catch(() => 0),
          countPendingSyncOps().catch(() => 0),
          listTasks(),
          listCaptures(),
          listNotes(),
          countStashItems().catch(() => 0),
          listReminderSchedules().catch(() => []),
        ]);
      if (!mounted.current || request !== requestSeq.current) return;

      const pendingTasks = tasks.filter((task) => task.status === "pending").length;
      const upcoming = schedules.filter((entry) => entry.occurrenceAt >= Date.now()).length;

      const recentNotes: RecentItem[] = notes.map((note) => ({
        kind: "note",
        id: note.id,
        title: note.title.trim() || note.body.trim().split("\n")[0]?.slice(0, 24) || "无标题笔记",
        at: note.updatedAt,
      }));
      const recentTasks: RecentItem[] = tasks.map((task) => ({
        kind: "task",
        id: task.id,
        title: task.title,
        at: task.updatedAt,
        done: task.status === "completed",
      }));
      const merged = [...recentNotes, ...recentTasks]
        .sort((a, b) => b.at - a.at)
        .slice(0, 4);

      setConnection(meta);
      setHasToken(Boolean(token));
      setConflicts(conflictCount);
      setPendingOps(pending);
      setReminders(upcoming);
      setOverview({
        pending: pendingTasks,
        notes: notes.length,
        captures: captures.length,
        stash,
      });
      setRecent(merged);
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
  const deviceName = loading
    ? "正在读取连接状态"
    : paired
      ? (connection?.serverName ?? "桌面端")
      : invalid
        ? "需要重新配对"
        : "本机模式";
  const deviceNote = paired
    ? "回到应用会自动补齐同步，附件仍需手动或按设置传送"
    : invalid
      ? "桌面端已升级加密传输，请重新配对"
      : "尚未连接桌面端 · 数据只在本机";

  const openRecent = useCallback(
    (item: RecentItem) => {
      if (item.kind === "note") {
        nav.push("note_editor", item.id);
        return;
      }
      nav.push("task_detail", undefined, undefined, item.id);
    },
    [nav],
  );

  return (
    <View style={styles.root}>
      <ScreenHeader title="我的" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <GlassCard
          style={[
            styles.profileCard,
            {
              backgroundImage: `linear-gradient(118deg, ${tokens.card} 0%, ${tokens.accentWash} 100%)`,
            },
          ]}
        >
          <BrandMark size={56} />
          <View style={styles.profileText}>
            <Text style={[styles.profileName, { color: tokens.text }]}>开发者</Text>
            <Text numberOfLines={1} style={[styles.profileStatus, { color: tokens.textSoft }]}>
              {statusLabel} · {deviceName}
            </Text>
            {/* 连点版本号 5 次进入图标预览（开发验收用，不占正式入口） */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`版本 v${appConfig.expo.version}，连点 5 次打开图标预览`}
              onPress={handleVersionPress}
            >
              <Text style={[styles.profileMeta, { color: tokens.muted }]}>
                v{appConfig.expo.version}
              </Text>
            </Pressable>
          </View>
        </GlassCard>

        {loading ? (
          <ActivityIndicator style={styles.loading} color={tokens.accent} />
        ) : error ? (
          <GlassCard style={styles.errorCard}>
            <Text style={[styles.errorTitle, { color: tokens.danger }]}>读取本机状态失败</Text>
            <Text style={[styles.errorHint, { color: tokens.muted }]}>{error}</Text>
          </GlassCard>
        ) : (
          <>
            <View style={styles.group}>
              <SectionHeader icon="stats" title="工作概览" />
              <GlassCard style={styles.tilesCard}>
                <View style={styles.tilesRow}>
                  <MetricTile
                    variant="column"
                    icon="tasks"
                    label="待办任务"
                    value={overview.pending}
                    tone="accent"
                  />
                  <View style={[styles.tileDivider, { backgroundColor: tokens.separator }]} />
                  <MetricTile variant="column" icon="note" label="笔记" value={overview.notes} />
                  <View style={[styles.tileDivider, { backgroundColor: tokens.separator }]} />
                  <MetricTile
                    variant="column"
                    icon="inbox"
                    label="收集箱"
                    value={overview.captures}
                  />
                  <View style={[styles.tileDivider, { backgroundColor: tokens.separator }]} />
                  <MetricTile
                    variant="column"
                    icon="fileStack"
                    label="本机素材"
                    value={overview.stash}
                  />
                </View>
              </GlassCard>
            </View>

            <View style={styles.group}>
              <SectionHeader icon="note" title="最近内容" />
              {recent.length === 0 ? (
                <Text style={[styles.emptyText, { color: tokens.muted }]}>
                  还没有笔记或任务。写下第一条后，这里会显示最近更新的内容。
                </Text>
              ) : (
                <GlassCard style={styles.recentCard}>
                  {recent.map((item, index) => (
                    <View key={`${item.kind}-${item.id}`}>
                      {index > 0 ? (
                        <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
                      ) : null}
                      <PressableScale
                        onPress={() => openRecent(item)}
                        accessibilityLabel={`${item.kind === "note" ? "笔记" : "任务"}：${item.title}`}
                        accessibilityHint={item.kind === "note" ? "打开笔记" : "打开任务详情"}
                        contentStyle={styles.recentRow}
                      >
                        <IconTile
                          name={item.kind === "note" ? "note" : "tasks"}
                          size={36}
                          iconSize={18}
                        />
                        <View style={styles.recentBody}>
                          <Text numberOfLines={1} style={[styles.recentTitle, { color: tokens.text }]}>
                            {item.title}
                          </Text>
                          {item.kind === "task" && item.done ? (
                            <Text style={[styles.recentHint, { color: tokens.muted }]}>已完成</Text>
                          ) : null}
                        </View>
                        <Text style={[styles.recentTime, { color: tokens.muted }]}>
                          {formatRelative(item.at, Date.now())}
                        </Text>
                      </PressableScale>
                    </View>
                  ))}
                </GlassCard>
              )}
            </View>

            <View style={styles.group}>
              <SectionHeader icon="bell" title="通知中心" />
              <GlassCard style={styles.card}>
                <EntryRow
                  icon="bell"
                  label="通知"
                  helper={
                    reminders > 0 ? `${reminders} 条待排提醒` : "提醒权限、提醒动作与后台限制"
                  }
                  onPress={() => nav.push("notifications")}
                />
              </GlassCard>
            </View>

            <View style={styles.group}>
              <SectionHeader icon="sync" title="数据同步" />
              <GlassCard level="primary" style={styles.statusCard}>
                <View style={styles.statusTop}>
                  <StatusPill label={statusLabel} tone={statusTone} />
                  <Text numberOfLines={1} style={[styles.statusDevice, { color: tokens.text }]}>
                    {deviceName}
                  </Text>
                </View>
                <Text numberOfLines={2} style={[styles.statusNote, { color: tokens.muted }]}>
                  {deviceNote}
                </Text>
              </GlassCard>

              <GlassCard style={styles.card}>
                <EntryRow
                  icon="sync"
                  label="同步中心"
                  helper="手动同步、查看待发送数量与解除配对"
                  onPress={() => nav.push("sync")}
                />
                <EntryRow
                  icon="smartphone"
                  label="配对新设备"
                  helper="扫描桌面端二维码或输入 6 位配对码"
                  divider
                  onPress={() => nav.push("pairing")}
                />
                <EntryRow
                  icon="desktop"
                  label="设备详情"
                  helper="连接地址、上次连接时间与当前动作"
                  divider
                  onPress={() => nav.push("device")}
                />
                <View style={[styles.summaryRow, { borderTopColor: tokens.separator }]}>
                  <Text style={[styles.summaryLabel, { color: tokens.muted }]}>本机待发</Text>
                  <Text numberOfLines={1} style={[styles.summaryValue, { color: tokens.textSoft }]}>
                    {pendingOps} 条待发 · {conflicts} 条冲突
                  </Text>
                </View>
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
              <SectionHeader icon="settings" title="快捷设置" />
              <GlassCard style={styles.gridCard}>
                <View style={styles.grid}>
                  <IconEntry
                    icon="settings"
                    label="偏好设置"
                    onPress={() => nav.push("settings")}
                  />
                  <IconEntry
                    icon="bell"
                    label="通知管理"
                    onPress={() => nav.push("notifications")}
                  />
                  <IconEntry icon="sync" label="数据同步" onPress={() => nav.push("sync")} />
                  <IconEntry
                    icon="smartphone"
                    label="设备管理"
                    onPress={() => nav.push("device")}
                  />
                  <View style={styles.cell}>
                    <FeatureIconPlaceholder icon="shield" label="账户与安全" variant="compact" />
                  </View>
                  <View style={styles.cell}>
                    <FeatureIconPlaceholder icon="desktop" label="桌面联动" variant="compact" />
                  </View>
                </View>
              </GlassCard>
            </View>

            <View style={styles.group}>
              <GlassCard style={styles.card}>
                <EntryRow icon="info" label="帮助与反馈" helper="移动端暂未接入" />
                <View style={[styles.aboutRow, { borderTopColor: tokens.separator }]}>
                  <IconTile name="info" size={36} tone="neutral" />
                  <View style={styles.aboutText}>
                    <Text numberOfLines={1} style={[styles.aboutLabel, { color: tokens.text }]}>
                      关于 TaskDock
                    </Text>
                    <Text numberOfLines={1} style={[styles.aboutHint, { color: tokens.muted }]}>
                      版本与本地数据信息
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`版本 v${appConfig.expo.version}，连点 5 次打开图标预览`}
                    onPress={handleVersionPress}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={[styles.aboutVersion, { color: tokens.faint }]}>
                      v{appConfig.expo.version}
                    </Text>
                  </Pressable>
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
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md + 2,
  },
  profileText: { flex: 1, gap: 2 },
  profileName: { fontSize: font.section + 2, fontWeight: "800", letterSpacing: -0.2 },
  profileStatus: { fontSize: font.meta },
  profileMeta: { fontSize: font.meta },
  loading: { marginTop: space.xl },
  errorCard: { padding: space.lg, gap: space.xs },
  errorTitle: { fontSize: font.title, fontWeight: "700" },
  errorHint: { fontSize: font.meta, lineHeight: 19 },
  tilesCard: { paddingVertical: space.xs },
  tilesRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  tileDivider: {
    width: StyleSheet.hairlineWidth,
    marginVertical: space.sm,
  },
  emptyText: {
    fontSize: font.meta,
    lineHeight: 20,
    paddingVertical: space.xs,
  },
  recentCard: { paddingHorizontal: space.md, paddingVertical: space.xxs },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 56,
    paddingVertical: space.sm + 2,
  },
  recentBody: { flex: 1, gap: 1 },
  recentTitle: { fontSize: font.body, fontWeight: "600" },
  recentHint: { fontSize: font.label },
  recentTime: { fontSize: font.label, flexShrink: 0 },
  divider: { height: StyleSheet.hairlineWidth },
  statusCard: { paddingHorizontal: space.md + 2, paddingVertical: space.md, gap: 6 },
  statusTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  statusDevice: { flex: 1, fontSize: font.body + 1, fontWeight: "700" },
  statusNote: { fontSize: font.label, lineHeight: 17 },
  card: { paddingHorizontal: space.md, paddingVertical: space.xxs },
  summaryRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  summaryLabel: { fontSize: font.label, fontWeight: "600" },
  summaryValue: { fontSize: font.label, flexShrink: 1 },
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
  gridCard: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.xs,
  },
  cell: {
    flexBasis: "25%",
    flexGrow: 0,
    flexShrink: 1,
  },
  aboutRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  aboutText: { flex: 1, gap: 1 },
  aboutLabel: { fontSize: font.body, fontWeight: "600" },
  aboutHint: { fontSize: font.label, lineHeight: 16 },
  aboutVersion: { fontSize: font.meta, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
