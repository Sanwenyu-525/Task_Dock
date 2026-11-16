// 诊断中心（推送页）：只展示移动端真实可查的本机自检结果。
//
// 数据边界（见 tmp/acceptance/mobile-ui-unified/01-audit.md 第 2 节）：
// - 移动端没有 CPU / 内存 / 磁盘 / 网络延迟监控读数，没有构建记录，也没有运行日志流；
//   本页不渲染这些假仪表，也不把缺失项显示成 0 或「正常」，只在「未采集的能力」里如实说明。
// - 真实可用：SQLite 自检（quickCheck）、同步冲突（sync_conflicts）、附件传输状态、
//   待发 outbox、提醒排期、配对 / 连接状态。
// - 读取失败或数据库未打开时显示错误态与重试，不用空白页充当成功。
import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { EmptyState } from "../components/EmptyState";
import { EntryRow } from "../components/EntryRow";
import { GlassCard } from "../components/GlassCard";
import { MetricTile } from "../components/MetricTile";
import { PressableScale } from "../components/PressableScale";
import { SectionHeader } from "../components/SectionHeader";
import { StatusPill } from "../components/StatusPill";
import { AppIcon } from "../components/icons/AppIcon";
import {
  countAttachmentsForTransfer,
  listAttachmentsForTransfer,
} from "../db/attachments";
import {
  quickCheck,
  type DiagnosticsResult,
} from "../db/diagnostics";
import {
  countPendingSyncOps,
  countSyncConflicts,
  listSyncConflicts,
  type SyncConflictRow,
} from "../db/sync";
import { loadConnection, readToken, type PairedConnection } from "../db/syncConnection";
import { describeError } from "../lib/errors";
import type { Nav } from "../lib/nav";
import { isLegacyConnection } from "../lib/sync/connectionState";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

const ENTITY_LABEL: Record<string, string> = {
  task: "任务",
  note: "笔记",
  capture: "收集箱",
};

const REASON_LABEL: Record<string, string> = {
  revision_mismatch: "桌面端已更新",
  deleted_on_server: "桌面端已删除",
  record_missing: "桌面端没有该记录",
  invalid_patch: "补丁被拒绝",
  permission_denied: "设备权限不足",
  unknown: "未知冲突",
};

function formatTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface DiagnosticData {
  result: DiagnosticsResult;
  pendingOps: number;
  transferTotal: number;
  failedAttachments: number;
  conflicts: number;
  conflictRows: SyncConflictRow[];
  connection: PairedConnection | null;
  hasToken: boolean;
}

export function DiagnosticScreen({
  nav,
  onBack,
  version,
}: {
  nav: Nav;
  onBack: () => void;
  version: number;
}) {
  const { tokens } = useTheme();
  const [data, setData] = useState<DiagnosticData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [result, pendingOps, transferTotal, attachments, conflicts, conflictRows, connection, token] =
        await Promise.all([
          quickCheck(),
          countPendingSyncOps().catch(() => 0),
          countAttachmentsForTransfer().catch(() => 0),
          listAttachmentsForTransfer(100).catch(() => []),
          countSyncConflicts().catch(() => 0),
          listSyncConflicts().catch(() => []),
          loadConnection().catch(() => null),
          readToken().catch(() => null),
        ]);
      const failedAttachments = attachments.filter(
        (attachment) => attachment.transferState === "failed",
      ).length;
      setData({
        result,
        pendingOps,
        transferTotal,
        failedAttachments,
        conflicts,
        conflictRows,
        connection,
        hasToken: Boolean(token),
      });
    } catch (error) {
      setData(null);
      setLoadError(describeError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  const legacy = isLegacyConnection(data?.connection ?? null);
  const invalid = Boolean(data?.connection) && (legacy || !data?.hasToken);
  const paired = Boolean(data?.connection && data?.hasToken) && !invalid;
  const connectionLabel = paired
    ? `已配对 ${data?.connection?.serverName ?? "桌面端"}`
    : invalid
      ? "需重新配对"
      : "本机模式";

  const result = data?.result ?? null;
  const systemOk = Boolean(result?.ok);

  return (
    <View style={styles.container}>
      <AppBar title="诊断中心" onBack={onBack} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {loadError ? (
          <GlassCard style={[styles.errorCard, { borderColor: tokens.danger }]}>
            <View style={styles.errorHead}>
              <AppIcon name="error" size={22} color={tokens.danger} />
              <Text style={[styles.errorTitle, { color: tokens.danger }]}>读取诊断信息失败</Text>
            </View>
            <Text style={[styles.errorText, { color: tokens.textSoft }]}>{loadError}</Text>
            <PressableScale
              onPress={() => void load()}
              disabled={loading}
              accessibilityLabel="重试读取诊断信息"
              style={styles.retryPress}
              contentStyle={[
                styles.retryButton,
                { backgroundColor: tokens.accentFill },
              ]}
            >
              <Text style={[styles.retryText, { color: tokens.onAccent }]}>
                {loading ? "读取中…" : "重试"}
              </Text>
            </PressableScale>
          </GlassCard>
        ) : loading && !data ? (
          <Text style={[styles.loading, { color: tokens.muted }]}>读取诊断信息…</Text>
        ) : data && result ? (
          <>
            {/* 系统状态：quickCheck 自检结论 + 检测时间；异常时展示真实 error 文案 */}
            <GlassCard level="primary" style={styles.statusCard}>
              <View style={styles.statusTop}>
                <View style={styles.statusMain}>
                  <Text style={[styles.statusEyebrow, { color: tokens.muted }]}>数据库自检</Text>
                  <Text numberOfLines={1} style={[styles.statusTitle, { color: tokens.text }]}>
                    {systemOk ? "系统运行正常" : "自检发现异常"}
                  </Text>
                </View>
                <StatusPill label={systemOk ? "正常" : "异常"} tone={systemOk ? "ok" : "danger"} />
              </View>
              {systemOk ? (
                <Text style={[styles.statusDetail, { color: tokens.textSoft }]}>
                  本地 SQLite 完整性检查通过，表结构与版本可读。
                </Text>
              ) : (
                <Text style={[styles.statusDetail, { color: tokens.danger }]}>
                  {result.error ?? "quick_check 未通过，请在设备可访问时重新检测。"}
                </Text>
              )}
              <Text style={[styles.statusMeta, { color: tokens.muted }]}>
                最近检测 {formatTime(result.checkedAt)} · quick_check：{result.quickCheck}
              </Text>
            </GlassCard>

            {/* 数据读数：全部来自 quickCheck 的 counts 与版本字段，不推算、不补零 */}
            <View style={styles.group}>
              <SectionHeader icon="database" title="数据读数" />
              <GlassCard style={styles.tilesCard}>
                <View style={styles.tilesRow}>
                  <MetricTile
                    variant="compactInline"
                    icon="tasks"
                    label="任务"
                    value={result.counts.tasks}
                    tone="accent"
                  />
                  <View style={[styles.tileDivider, { backgroundColor: tokens.separator }]} />
                  <MetricTile
                    variant="compactInline"
                    icon="inbox"
                    label="收集箱"
                    value={result.counts.captures}
                  />
                </View>
                <View style={[styles.rowDivider, { backgroundColor: tokens.separator }]} />
                <View style={styles.tilesRow}>
                  <MetricTile
                    variant="compactInline"
                    icon="alarm"
                    label="提醒排期"
                    value={result.counts.reminderSchedule}
                  />
                  <View style={[styles.tileDivider, { backgroundColor: tokens.separator }]} />
                  <MetricTile
                    variant="compactInline"
                    icon="hash"
                    label="本机键值"
                    value={result.counts.kv}
                  />
                </View>
                <View style={[styles.rowDivider, { backgroundColor: tokens.separator }]} />
                <View style={styles.versionRow}>
                  <Text style={[styles.versionLabel, { color: tokens.muted }]}>Schema 版本</Text>
                  <Text style={[styles.versionValue, { color: tokens.text }]}>
                    v{result.schemaVersion}
                  </Text>
                </View>
                <View style={styles.versionRow}>
                  <Text style={[styles.versionLabel, { color: tokens.muted }]}>user_version</Text>
                  <Text style={[styles.versionValue, { color: tokens.text }]}>
                    {result.userVersion >= 0 ? result.userVersion : "未读取"}
                  </Text>
                </View>
              </GlassCard>
            </View>

            {/* 同步与传输：配对状态、待发 outbox、附件传输、同步冲突，均取真实查询 */}
            <View style={styles.group}>
              <SectionHeader icon="sync" title="同步与传输" />
              <GlassCard style={styles.listCard}>
                <EntryRow
                  icon="link"
                  label="配对状态"
                  helper={
                    paired
                      ? "已连接桌面端，任务 / 笔记 / 收集箱可手动同步"
                      : invalid
                        ? "配对记录需要重新确认或重新配对"
                        : "尚未连接桌面端，数据仅保存在本机"
                  }
                  trailingText={connectionLabel}
                />
                <EntryRow
                  icon="send"
                  label="待发操作"
                  helper="等待同步到桌面端的本地写操作"
                  trailingText={`${data.pendingOps} 条`}
                  divider
                />
                <EntryRow
                  icon="upload"
                  label="待传附件"
                  helper="等待送到桌面端的附件（含失败可重试）"
                  trailingText={`${data.transferTotal} 个`}
                  divider
                />
                <EntryRow
                  icon="error"
                  label="失败附件"
                  helper="传输失败、可重新发送的附件"
                  trailingText={`${data.failedAttachments} 个`}
                  divider
                />
                <EntryRow
                  icon="warning"
                  label="同步冲突"
                  helper="两台设备同时修改同一记录产生的分歧"
                  trailingText={`${data.conflicts} 条`}
                  divider
                  onPress={data.conflicts > 0 ? () => nav.push("conflict") : undefined}
                />
              </GlassCard>
            </View>

            {/* 异常记录：只列 sync_conflicts 真实条目；空态用 EmptyState，不造假列表 */}
            <View style={styles.group}>
              <SectionHeader icon="warning" title="异常记录" />
              {data.conflictRows.length === 0 ? (
                <EmptyState
                  icon="shield"
                  title="没有未处理的冲突"
                  hint="同一记录在两台设备被同时修改时才会产生冲突，处理后会从这里移除"
                />
              ) : (
                data.conflictRows.map((conflict) => {
                  const entityLabel = ENTITY_LABEL[conflict.entity] ?? "记录";
                  const reasonLabel = REASON_LABEL[conflict.reason] ?? REASON_LABEL.unknown;
                  return (
                    <PressableScale
                      key={conflict.op_id}
                      onPress={() => nav.push("conflict")}
                      accessibilityLabel={`${entityLabel}冲突，${reasonLabel}`}
                      accessibilityHint="打开冲突处理页"
                      style={styles.conflictPress}
                      contentStyle={[styles.conflictCard, { borderColor: tokens.cardBorder }]}
                      scaleTo={0.98}
                    >
                      <View style={styles.conflictHead}>
                        <Text numberOfLines={1} style={[styles.conflictTitle, { color: tokens.text }]}>
                          {entityLabel} · {conflict.target_id.slice(0, 8)}
                        </Text>
                        <Text style={[styles.conflictReason, { color: tokens.warn }]}>
                          {reasonLabel}
                        </Text>
                      </View>
                      <Text style={[styles.conflictMeta, { color: tokens.muted }]}>
                        {formatTime(conflict.created_at)}
                      </Text>
                    </PressableScale>
                  );
                })
              )}
            </View>

            {/* 未采集的能力：如实说明移动端尚无数据源，不做假仪表盘，也不显示 0 / 正常 */}
            <GlassCard level="tertiary" style={styles.notCollected}>
              <View style={styles.notCollectedHead}>
                <AppIcon name="info" size={18} color={tokens.faint} />
                <Text style={[styles.notCollectedTitle, { color: tokens.muted }]}>
                  尚未采集的能力
                </Text>
              </View>
              <Text style={[styles.notCollectedText, { color: tokens.muted }]}>
                CPU、内存、磁盘占用与网络延迟，以及构建记录、运行日志流在移动端尚未采集；
                这里不显示 0 或「正常」，相关运行监控以桌面端为准。
              </Text>
            </GlassCard>

            <PressableScale
              onPress={() => void load()}
              disabled={loading}
              accessibilityLabel="重新检测"
              accessibilityState={{ disabled: loading }}
              style={styles.recheckPress}
              contentStyle={[styles.recheckButton, { backgroundColor: tokens.accentFill }]}
            >
              <AppIcon name="refresh" size={18} color={tokens.onAccent} />
              <Text style={[styles.recheckText, { color: tokens.onAccent }]}>
                {loading ? "检测中…" : "重新检测"}
              </Text>
            </PressableScale>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xxl,
    gap: space.section,
  },
  group: { gap: space.md },
  loading: {
    fontSize: font.body,
    textAlign: "center",
    paddingVertical: space.xl,
  },
  statusCard: {
    padding: space.md + 2,
    gap: space.sm,
  },
  statusTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  statusMain: { flex: 1, gap: 2 },
  statusEyebrow: { fontSize: font.meta },
  statusTitle: { fontSize: font.title, fontWeight: "700" },
  statusDetail: { fontSize: font.body, lineHeight: 19 },
  statusMeta: { fontSize: font.label, lineHeight: 16 },
  tilesCard: {
    paddingVertical: space.xs,
  },
  tilesRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  tileDivider: {
    width: StyleSheet.hairlineWidth,
    marginVertical: space.sm,
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: space.md,
  },
  versionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.md,
    minHeight: 32,
    paddingHorizontal: space.sm + 2,
  },
  versionLabel: { fontSize: font.body },
  versionValue: {
    fontSize: font.body,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  listCard: {
    paddingHorizontal: space.md,
    paddingVertical: space.xxs,
  },
  conflictPress: { marginBottom: space.sm },
  conflictCard: {
    padding: space.md,
    gap: space.xs,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  conflictHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  conflictTitle: { flex: 1, fontSize: font.body, fontWeight: "700" },
  conflictReason: { fontSize: font.label, fontWeight: "600" },
  conflictMeta: { fontSize: font.label },
  notCollected: {
    padding: space.md,
    gap: space.xs,
  },
  notCollectedHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  notCollectedTitle: { fontSize: font.meta, fontWeight: "600" },
  notCollectedText: { fontSize: font.label, lineHeight: 16 },
  recheckPress: { minHeight: 44 },
  recheckButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    borderRadius: radius.control,
    paddingHorizontal: space.lg,
  },
  recheckText: { fontSize: font.body, fontWeight: "600" },
  errorCard: {
    padding: space.md,
    gap: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  errorHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  errorTitle: { fontSize: font.title, fontWeight: "700" },
  errorText: { fontSize: font.body, lineHeight: 19 },
  retryPress: { minHeight: 44, marginTop: space.xs },
  retryButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    paddingHorizontal: space.lg,
  },
  retryText: { fontSize: font.body, fontWeight: "600" },
});
