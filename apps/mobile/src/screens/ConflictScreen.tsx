// 冲突处理：同步 push 遇到 base_rev 不一致时，这里逐条让用户选择保留哪一端。
// 本页只做结算，不自动合并；选择后写回本地/重新入队，下一次同步会带上结果。
import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import { Toast, TOAST_TOP_PUSH, type ToastMessage, type ToastTone } from "../components/Toast";
import {
  listSyncConflicts,
  resolveConflictWithLocal,
  resolveConflictWithServer,
  type SyncConflictRow,
} from "../db/sync";
import { describeError } from "../lib/errors";
import type { Nav } from "../lib/nav";
import { syncNow } from "../lib/sync/engine";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

const REASON_LABEL: Record<string, string> = {
  revision_mismatch: "桌面端已更新",
  deleted_on_server: "桌面端已删除",
  record_missing: "桌面端没有该记录",
  invalid_patch: "补丁被拒绝",
  permission_denied: "设备权限不足",
  unknown: "未知冲突",
};

const ENTITY_LABEL: Record<string, string> = {
  task: "任务",
  note: "笔记",
  capture: "收集箱",
};

interface ServerRecordPreview {
  title: string | null;
  deleted: boolean;
  rev: number | null;
}

function parseServerRecord(raw: string | null): ServerRecordPreview {
  if (!raw) return { title: null, deleted: false, rev: null };
  try {
    const value = JSON.parse(raw) as {
      fields?: Record<string, unknown>;
      deleted?: boolean;
      rev?: number;
    };
    const rawTitle = value.fields?.title;
    const rawContent = value.fields?.content;
    const title =
      typeof rawTitle === "string" && rawTitle.trim()
        ? rawTitle
        : typeof rawContent === "string" && rawContent.trim()
          ? rawContent
          : null;
    return {
      title,
      deleted: value.deleted === true,
      rev: typeof value.rev === "number" ? value.rev : null,
    };
  } catch {
    return { title: null, deleted: false, rev: null };
  }
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ConflictScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const [conflicts, setConflicts] = useState<SyncConflictRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    setToast({ id: Date.now(), text, tone });
  }, []);
  // 稳定的 dismiss 引用：内联函数会让 Toast 的 effect 每次重渲染都重置 2.4s 计时
  const dismissToast = useCallback(() => setToast(null), []);

  const load = useCallback(async () => {
    try {
      setConflicts(await listSyncConflicts());
    } catch (error) {
      showToast(`读取冲突失败：${describeError(error)}`, "danger");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (conflict: SyncConflictRow, mode: "server" | "local") => {
      if (busyId) return;
      setBusyId(conflict.op_id);
      try {
        if (mode === "server") {
          await resolveConflictWithServer(conflict);
          showToast("已采用桌面端版本", "success");
        } else {
          await resolveConflictWithLocal(conflict);
          await syncNow();
          showToast("已保留本机版本并重新发送", "success");
        }
        await load();
      } catch (error) {
        showToast(`处理失败：${describeError(error)}`, "danger");
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load, showToast],
  );

  return (
    <View style={styles.container}>
      <AppBar
        title="处理冲突"
        badge={
          conflicts.length > 0 ? (
            <Badge label={`${conflicts.length} 待处理`} tone="unimplemented" />
          ) : undefined
        }
        onBack={nav.back}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.explainer, { backgroundColor: tokens.accentSoft }]}>
          <Text style={[styles.explainerText, { color: tokens.text }]}>
            同一任务、笔记或收集箱条目在两台设备被修改时，同步不会自动覆盖任何一端。
            这里并列展示冲突，选择后写回本地并重新同步；截止时间、提醒、重复规则永不使用
            「最后写入者覆盖」。
          </Text>
        </View>

        {loading ? (
          <Text style={[styles.loading, { color: tokens.muted }]}>读取冲突…</Text>
        ) : conflicts.length === 0 ? (
          <EmptyState
            title="暂无需要处理的冲突"
            hint="冲突只在两台设备同时修改同一条数据时出现；同步完成后会自动出现在这里"
          />
        ) : (
          conflicts.map((conflict) => {
            const server = parseServerRecord(conflict.server_json);
            const entityLabel = ENTITY_LABEL[conflict.entity] ?? "记录";
            const title =
              server.title?.trim() ||
              `${entityLabel} ${conflict.target_id.slice(0, 8)}`;
            const busy = busyId === conflict.op_id;
            return (
              <GlassCard key={conflict.op_id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={[styles.cardTitle, { color: tokens.text }]} numberOfLines={1}>
                    {title}
                  </Text>
                  <Badge
                    label={REASON_LABEL[conflict.reason] ?? REASON_LABEL.unknown}
                    tone="unimplemented"
                  />
                </View>
                <Text style={[styles.cardMeta, { color: tokens.muted }]}>
                  {entityLabel} · {formatTime(conflict.created_at)}
                  {server.rev != null ? ` · 桌面端版本 ${server.rev}` : ""}
                  {server.deleted ? " · 桌面端已删除" : ""}
                </Text>
                <View style={styles.actions}>
                  {conflict.server_json ? (
                    <PressableScale
                      onPress={() => void resolve(conflict, "server")}
                      disabled={busy}
                      accessibilityLabel="采用桌面端版本"
                      style={styles.actionSlot}
                      contentStyle={[styles.actionBtn, { borderColor: tokens.cardBorder }]}
                    >
                      <Text style={[styles.actionText, { color: tokens.text }]}>采用桌面端</Text>
                    </PressableScale>
                  ) : null}
                  <PressableScale
                    onPress={() => void resolve(conflict, "local")}
                    disabled={busy}
                    accessibilityLabel="保留本机版本并重新发送"
                    style={styles.actionSlot}
                    contentStyle={[
                      styles.actionBtn,
                      styles.actionPrimary,
                      { backgroundColor: busy ? tokens.track : tokens.accentFill },
                    ]}
                  >
                    <Text style={[styles.actionText, { color: tokens.onAccent }]}>
                      {busy ? "处理中…" : "保留本机"}
                    </Text>
                  </PressableScale>
                </View>
              </GlassCard>
            );
          })
        )}

        <GlassCard style={styles.ruleCard}>
          <Text style={[styles.ruleTitle, { color: tokens.text }]}>冲突判定规则</Text>
          <Text style={[styles.ruleText, { color: tokens.textSoft }]}>
            以修改前的服务端版本（base_rev）判定：本地提交时桌面端已经变化，就返回冲突而不落库。
            「保留本机」会把本地版本对齐到桌面端版本后重新提交；若期间桌面端又改过，会再次产生冲突。
          </Text>
        </GlassCard>
      </ScrollView>

      <Toast toast={toast} onDismiss={dismissToast} placement="top" topOffset={TOAST_TOP_PUSH} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: 48,
    gap: space.md,
  },
  explainer: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: 16,
  },
  explainerText: {
    fontSize: font.body,
    lineHeight: 19,
  },
  loading: {
    fontSize: font.body,
    textAlign: "center",
    paddingVertical: space.lg,
  },
  card: {
    padding: space.md,
    gap: space.sm,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  cardTitle: {
    flex: 1,
    fontSize: font.title,
    fontWeight: "700",
  },
  cardMeta: {
    fontSize: font.label,
  },
  actions: {
    flexDirection: "row",
    gap: space.sm,
  },
  actionSlot: {
    flex: 1,
  },
  actionBtn: {
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionPrimary: {
    borderWidth: 0,
  },
  actionText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  ruleCard: {
    padding: space.md,
    gap: space.xs,
  },
  ruleTitle: {
    fontSize: font.body,
    fontWeight: "600",
  },
  ruleText: {
    fontSize: font.body,
    lineHeight: 19,
  },
});
