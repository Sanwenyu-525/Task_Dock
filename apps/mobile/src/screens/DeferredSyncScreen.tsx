// 生活同步待处理：把 life_sync_deferred 从“一个计数”变成可查看、可单条重试、
// 可批量恢复的界面。只处理同步队列，不删除任何商品、购买记录或票据数据。
import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import { useToast } from "../feedback/ToastProvider";
import {
  dismissDeferredLifeChange,
  findExistingLifeLinkForDeferred,
  listDeferredLifeChanges,
  retryDeferredLifeChange,
  retryDeferredLifeChanges,
  type DeferredLifeChange,
} from "../db/lifeSync";
import { describeError } from "../lib/errors";
import type { Nav } from "../lib/nav";
import {
  ENTITY_LABEL,
  deferredStatusLabel,
  deferredTitle,
  formatDeferredTime,
  isAutoRetryable,
  isManualRetryable,
  reasonMeta,
  shortTargetId,
} from "../lib/lifeSyncStatus";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export function DeferredSyncScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();
  const [rows, setRows] = useState<DeferredLifeChange[]>([]);
  const [duplicates, setDuplicates] = useState<Record<number, string | null>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await listDeferredLifeChanges();
      setRows(next);
      const duplicated = next.filter((row) => row.reason === "duplicate_link");
      if (duplicated.length > 0) {
        const pairs = await Promise.all(
          duplicated.map(async (row) => {
            const existing = await findExistingLifeLinkForDeferred(row).catch(() => null);
            return [row.id, existing?.id ?? null] as const;
          }),
        );
        setDuplicates(Object.fromEntries(pairs));
      } else {
        setDuplicates({});
      }
    } catch (error) {
      showToast(`读取待处理记录失败：${describeError(error)}`, "danger");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const retryOne = useCallback(
    async (row: DeferredLifeChange) => {
      if (busyId !== null) return;
      setBusyId(row.id);
      try {
        const result = await retryDeferredLifeChange(row.id);
        if (result.status === "applied") {
          showToast("已应用这条变更", "success");
        } else if (result.status === "deleted") {
          showToast("已应用删除", "success");
        } else if (result.status === "stale") {
          showToast("数据已过期，待处理记录已清理", "info");
        } else if (result.status === "deferred") {
          showToast(
            `仍无法应用：${reasonMeta(result.reason ?? row.reason).label}，记录已保留`,
            "warn",
          );
        } else if (result.status === "rejected") {
          showToast("重新校验仍未通过，原始记录与诊断信息已保留", "danger");
        } else {
          showToast("记录已不存在，可能已在其他页面处理", "info");
        }
        await load();
      } catch (error) {
        showToast(`重试失败：${describeError(error)}`, "danger");
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load, showToast],
  );

  const retryBatch = useCallback(async () => {
    if (batchBusy) return;
    setBatchBusy(true);
    try {
      const result = await retryDeferredLifeChanges();
      const total = result.applied + result.deleted + result.stale;
      if (total === 0) {
        showToast("没有可自动恢复的记录；其余记录仍需按提示处理", "info");
      } else {
        showToast(
          `已恢复 ${total} 条：应用 ${result.applied} · 删除 ${result.deleted} · 过期清理 ${result.stale}`,
          "success",
        );
      }
      await load();
    } catch (error) {
      showToast(`批量重试失败：${describeError(error)}`, "danger");
    } finally {
      setBatchBusy(false);
    }
  }, [batchBusy, load, showToast]);

  const dismissDuplicate = useCallback(
    (row: DeferredLifeChange) => {
      const existing = duplicates[row.id];
      Alert.alert(
        "保留已有票据关联",
        existing
          ? `本机已有等价关联（${shortTargetId(existing)}），不会再创建第二条。清除后仅移除这条待处理提示，不删除任何票据。`
          : "需要先确认本机存在等价关联；当前未找到，请先重试或重新同步。",
        [
          { text: "取消", style: "cancel" },
          {
            text: "保留已有",
            style: "destructive",
            onPress: () => {
              void (async () => {
                try {
                  await dismissDeferredLifeChange(row.id, "duplicate_link");
                  showToast("已保留已有票据关联，待处理提示已清除", "success");
                  await load();
                } catch (error) {
                  showToast(`清除失败：${describeError(error)}`, "danger");
                  await load();
                }
              })();
            },
          },
        ],
      );
    },
    [duplicates, load, showToast],
  );

  const dismissInvalid = useCallback(
    (row: DeferredLifeChange) => {
      Alert.alert(
        "忽略这条无效变更",
        "这不会删除本机的商品、购买记录或票据，只是不再提示这条无法应用的同步变更。建议先查看诊断信息；若桌面端数据已修正，可在桌面端重新保存后再同步。",
        [
          { text: "取消", style: "cancel" },
          {
            text: "仍然忽略",
            style: "destructive",
            onPress: () => {
              void (async () => {
                try {
                  await dismissDeferredLifeChange(row.id, "invalid");
                  showToast("已忽略无效变更，本机业务数据未改动", "success");
                  await load();
                } catch (error) {
                  showToast(`忽略失败：${describeError(error)}`, "danger");
                  await load();
                }
              })();
            },
          },
        ],
      );
    },
    [load, showToast],
  );

  const autoCount = rows.filter(isAutoRetryable).length;
  const manualCount = rows.filter(
    (row) => !isAutoRetryable(row) && isManualRetryable(row),
  ).length;

  return (
    <View style={styles.container}>
      <AppBar
        title="生活同步待处理"
        badge={rows.length > 0 ? <Badge label={`${rows.length} 条`} tone="unimplemented" /> : undefined}
        onBack={nav.back}
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={[styles.explainer, { backgroundColor: tokens.accentSoft }]}>
          <Text style={[styles.explainerText, { color: tokens.text }]}>
            这些是暂时没能写入本机的同步变更。等待类（依赖未到 / 本机修改未发送）会自动恢复；
            冲突与无效数据需要你确认。所有操作都不会删除本机商品、购买记录或票据。
          </Text>
          <Text style={[styles.explainerMeta, { color: tokens.textSoft }]}>
            可自动恢复 {autoCount} 条 · 需确认/处理 {rows.length - autoCount} 条
            {manualCount > 0 ? `（可手动重新校验 ${manualCount} 条）` : ""}
          </Text>
        </View>

        <View style={styles.toolbar}>
          <PressableScale
            onPress={() => void load()}
            disabled={loading}
            accessibilityLabel="刷新待处理记录"
            style={styles.toolbarSlot}
            contentStyle={[styles.toolbarBtn, { borderColor: tokens.cardBorder }]}
          >
            <Text style={[styles.toolbarText, { color: tokens.text }]}>
              {loading ? "刷新中…" : "刷新"}
            </Text>
          </PressableScale>
          <PressableScale
            onPress={() => void retryBatch()}
            disabled={batchBusy || autoCount === 0}
            accessibilityLabel="批量重试可自动恢复的记录"
            style={styles.toolbarSlot}
            contentStyle={[
              styles.toolbarBtn,
              styles.toolbarPrimary,
              { backgroundColor: batchBusy || autoCount === 0 ? tokens.track : tokens.accentFill },
            ]}
          >
            <Text
              style={[
                styles.toolbarText,
                { color: batchBusy || autoCount === 0 ? tokens.muted : tokens.onAccent },
              ]}
            >
              {batchBusy ? "重试中…" : `批量重试 ${autoCount} 条`}
            </Text>
          </PressableScale>
        </View>

        {loading && rows.length === 0 ? (
          <Text style={[styles.loading, { color: tokens.muted }]}>读取待处理记录…</Text>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="shield"
            title="没有待处理的同步变更"
            hint="同步结果里的延后/拒绝会在这里逐条展示；依赖到达或冲突解决后自动清除"
          />
        ) : (
          rows.map((row) => {
            const meta = reasonMeta(row.reason);
            const isExpanded = expanded === row.id;
            const busy = busyId === row.id;
            const duplicateId = duplicates[row.id];
            return (
              <GlassCard key={row.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={[styles.cardTitle, { color: tokens.text }]} numberOfLines={1}>
                    {deferredTitle(row)}
                  </Text>
                  <Badge
                    label={deferredStatusLabel(row)}
                    tone={meta.tone === "wait" ? "active" : meta.tone === "conflict" ? "planned" : "unimplemented"}
                  />
                </View>
                <Text style={[styles.cardMeta, { color: tokens.muted }]}>
                  {ENTITY_LABEL[row.entity]} · {shortTargetId(row.targetId)} · 变更时间{" "}
                  {formatDeferredTime(row.updatedAt)}
                </Text>
                <Text style={[styles.reason, { color: tokens.text }]}>{meta.label}</Text>
                <Text style={[styles.explanation, { color: tokens.textSoft }]}>{meta.explanation}</Text>
                <Text style={[styles.suggestion, { color: tokens.muted }]}>{meta.suggestion}</Text>

                {isExpanded ? (
                  <View style={[styles.detailBox, { borderColor: tokens.separator }]}>
                    <DetailLine label="记录 ID" value={row.targetId} />
                    <DetailLine label="服务端版本" value={`rev ${row.serverRev}${row.deleted ? " · 删除" : ""}`} />
                    <DetailLine label="首次进入待处理" value={formatDeferredTime(row.firstSeenAt)} />
                    <DetailLine
                      label="重试情况"
                      value={`${row.retryCount} 次${row.lastAttemptAt ? ` · 最近 ${formatDeferredTime(row.lastAttemptAt)}` : ""}`}
                    />
                    <DetailLine label="技术原因码" value={row.reason} />
                    <DetailLine label="业务字段" value={summarizeFields(row)} />
                  </View>
                ) : null}

                <View style={styles.actions}>
                  <PressableScale
                    onPress={() => setExpanded(isExpanded ? null : row.id)}
                    accessibilityLabel={isExpanded ? "收起异常详情" : "查看异常详情"}
                    style={styles.actionSlot}
                    contentStyle={[styles.actionBtn, { borderColor: tokens.cardBorder }]}
                  >
                    <Text style={[styles.actionText, { color: tokens.text }]}>
                      {isExpanded ? "收起详情" : "查看详情"}
                    </Text>
                  </PressableScale>

                  {row.reason === "name_conflict" ? (
                    <PressableScale
                      onPress={() => nav.push("conflict")}
                      accessibilityLabel="去冲突页关联同名商品"
                      style={styles.actionSlot}
                      contentStyle={[styles.actionBtn, styles.actionPrimary, { backgroundColor: tokens.accentFill }]}
                    >
                      <Text style={[styles.actionText, { color: tokens.onAccent }]}>去处理冲突</Text>
                    </PressableScale>
                  ) : row.reason === "duplicate_link" ? (
                    duplicateId ? (
                      <PressableScale
                        onPress={() => dismissDuplicate(row)}
                        accessibilityLabel="保留已有票据关联并清除提示"
                        style={styles.actionSlot}
                        contentStyle={[styles.actionBtn, styles.actionPrimary, { backgroundColor: tokens.accentFill }]}
                      >
                        <Text style={[styles.actionText, { color: tokens.onAccent }]}>保留已有</Text>
                      </PressableScale>
                    ) : (
                      <PressableScale
                        onPress={() => void retryOne(row)}
                        disabled={busy}
                        accessibilityLabel="重新校验票据关联"
                        style={styles.actionSlot}
                        contentStyle={[styles.actionBtn, styles.actionPrimary, { backgroundColor: busy ? tokens.track : tokens.accentFill }]}
                      >
                        <Text style={[styles.actionText, { color: tokens.onAccent }]}>
                          {busy ? "校验中…" : "重新校验"}
                        </Text>
                      </PressableScale>
                    )
                  ) : row.reason === "invalid" ? (
                    <>
                      <PressableScale
                        onPress={() => void retryOne(row)}
                        disabled={busy}
                        accessibilityLabel="重新校验这条数据"
                        style={styles.actionSlot}
                        contentStyle={[styles.actionBtn, { borderColor: tokens.cardBorder }]}
                      >
                        <Text style={[styles.actionText, { color: tokens.text }]}>
                          {busy ? "校验中…" : "重新校验"}
                        </Text>
                      </PressableScale>
                      <PressableScale
                        onPress={() => dismissInvalid(row)}
                        accessibilityLabel="忽略这条无效变更"
                        style={styles.actionSlot}
                        contentStyle={[styles.actionBtn, { borderColor: tokens.cardBorder }]}
                      >
                        <Text style={[styles.actionText, { color: tokens.danger }]}>忽略</Text>
                      </PressableScale>
                    </>
                  ) : (
                    <PressableScale
                      onPress={() => void retryOne(row)}
                      disabled={busy}
                      accessibilityLabel="重试这条待处理记录"
                      style={styles.actionSlot}
                      contentStyle={[styles.actionBtn, styles.actionPrimary, { backgroundColor: busy ? tokens.track : tokens.accentFill }]}
                    >
                      <Text style={[styles.actionText, { color: tokens.onAccent }]}>
                        {busy ? "重试中…" : "重试"}
                      </Text>
                    </PressableScale>
                  )}
                </View>
              </GlassCard>
            );
          })
        )}

        <GlassCard style={styles.ruleCard}>
          <Text style={[styles.ruleTitle, { color: tokens.text }]}>处理规则</Text>
          <Text style={[styles.ruleText, { color: tokens.textSoft }]}>
            依赖未到与本机未发送的变更会自动重放；同名商品必须先在冲突页关联；重复票据关联只清理提示、不重复创建；
            无效数据不会自动无限重试，也不会在没有确认的情况下删除任何业务数据。
          </Text>
        </GlassCard>
      </ScrollView>
    </View>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.detailLine}>
      <Text style={[styles.detailLabel, { color: tokens.muted }]}>{label}</Text>
      <Text style={[styles.detailValue, { color: tokens.text }]} selectable>
        {value}
      </Text>
    </View>
  );
}

/** 只展示可定位问题的业务字段，不回显 note/description 等长文本，更不展示原始 JSON。 */
function summarizeFields(row: DeferredLifeChange): string {
  const keys = [
    "name",
    "title",
    "itemNameSnapshot",
    "documentName",
    "currency",
    "totalPriceMinor",
    "amountScale",
    "quantityValue",
  ];
  const parts = keys
    .map((key) => {
      const value = row.fields[key];
      if (value === null || value === undefined || value === "") return "";
      return `${key}=${String(value)}`;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "（无展示字段）";
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: 48,
    gap: space.md,
  },
  explainer: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: 16,
    gap: space.xs,
  },
  explainerText: { fontSize: font.body, lineHeight: 19 },
  explainerMeta: { fontSize: font.label, lineHeight: 16 },
  toolbar: { flexDirection: "row", gap: space.sm },
  toolbarSlot: { flex: 1 },
  toolbarBtn: {
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.sm,
  },
  toolbarPrimary: { borderWidth: 0 },
  toolbarText: { fontSize: font.body, fontWeight: "600" },
  loading: { fontSize: font.body, textAlign: "center", paddingVertical: space.lg },
  card: { padding: space.md, gap: space.sm },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  cardTitle: { flex: 1, fontSize: font.title, fontWeight: "700" },
  cardMeta: { fontSize: font.label },
  reason: { fontSize: font.body, fontWeight: "600" },
  explanation: { fontSize: font.body, lineHeight: 19 },
  suggestion: { fontSize: font.label, lineHeight: 17 },
  detailBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    padding: space.sm,
    gap: 6,
  },
  detailLine: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  detailLabel: { width: 76, fontSize: font.label },
  detailValue: { flex: 1, fontSize: font.label, lineHeight: 16 },
  actions: { flexDirection: "row", gap: space.sm, flexWrap: "wrap" },
  actionSlot: { flexGrow: 1, flexBasis: 90 },
  actionBtn: {
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.sm,
  },
  actionPrimary: { borderWidth: 0 },
  actionText: { fontSize: font.body, fontWeight: "600" },
  ruleCard: { padding: space.md, gap: space.xs },
  ruleTitle: { fontSize: font.body, fontWeight: "600" },
  ruleText: { fontSize: font.body, lineHeight: 19 },
});
