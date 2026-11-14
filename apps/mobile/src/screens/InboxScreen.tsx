// 收集箱：固定顶部速记区 + 卡片列表。转任务/删除后先淡出再移除，
// 列表不会因为数据刷新整块闪一下；转任务后停留在本页，方便连续整理。
// 页头只表达配对状态（已配对 / 仅本机保存），不把配对元数据说成在线或已同步。
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from "react-native";

import { CaptureCard } from "../components/CaptureCard";
import { BackButton } from "../components/BackButton";
import { EmptyState } from "../components/EmptyState";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import { SearchField } from "../components/SearchField";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { addCapture, deleteCapture, listCaptures, promoteCapture } from "../db/captures";
import { loadConnection } from "../db/syncConnection";
import { isLegacyConnection } from "../lib/sync/connectionState";
import type { Capture } from "../domain/types";
import { describeError } from "../lib/errors";
import { notifyWidgetDataChanged } from "../lib/widgetSnapshot";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

function CardSeparator() {
  return <View style={styles.cardGap} />;
}

export function InboxScreen({
  onPromoted,
  onOpenTasks,
  onBack,
}: {
  /** 数据已变化：通知外层递增版本号，切回任务页时能拿到新数据 */
  onPromoted: () => void;
  /** 用户主动查看任务页（转任务后不再强制跳转，避免打断连续整理） */
  onOpenTasks: () => void;
  /** 作为「工具」二级页打开时的返回；一级栏时代不传，保持原行为 */
  onBack?: () => void;
}) {
  const { tokens } = useTheme();
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [paired, setPaired] = useState(false);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [focused, setFocused] = useState(false);
  const [exiting, setExiting] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);
  const inputRef = useRef<ComponentRef<typeof TextInput> | null>(null);

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text: message, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const refresh = useCallback(async () => {
    try {
      const [nextCaptures, connection] = await Promise.all([
        listCaptures(),
        loadConnection().catch(() => null),
      ]);
      setCaptures(nextCaptures);
      // v1 遗留/缺指纹连接在 TLS-only 桌面端上已不可用，不能显示健康配对态。
      setPaired(Boolean(connection) && !isLegacyConnection(connection));
    } catch (error) {
      showToast(`读取收集箱失败：${describeError(error)}`, "danger");
    } finally {
      setNow(Date.now());
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 相对时间会随停留时长变化，每分钟刷新一次即可（不需要更密的定时器）
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value) return;
    try {
      const result = await addCapture(value);
      notifyWidgetDataChanged();
      setText("");
      showToast(
        result.duplicated ? "重复提交已忽略" : "已收进收集箱",
        result.duplicated ? "warn" : "success",
      );
    } catch (error) {
      showToast(`记录失败：${describeError(error)}`, "danger");
    }
    await refresh();
  }, [refresh, showToast, text]);

  const promote = useCallback(
    async (capture: Capture) => {
      try {
        const taskId = await promoteCapture(capture.id);
        if (taskId) {
          setExiting((previous) => ({ ...previous, [capture.id]: true }));
          onPromoted();
          showToast("已转为任务", "success");
        }
      } catch (error) {
        showToast(`转为任务失败：${describeError(error)}`, "danger");
      }
    },
    [onPromoted, showToast],
  );

  const remove = useCallback(
    async (capture: Capture) => {
      try {
        await deleteCapture(capture.id);
        notifyWidgetDataChanged();
        setExiting((previous) => ({ ...previous, [capture.id]: true }));
      } catch (error) {
        showToast(`删除失败：${describeError(error)}`, "danger");
      }
    },
    [showToast],
  );

  // 淡出结束才从本地列表移除；父级不重查数据库，避免其余卡片跟着重建
  const handleExited = useCallback((id: string) => {
    setCaptures((previous) => previous.filter((capture) => capture.id !== id));
    setExiting((previous) => {
      if (!previous[id]) return previous;
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }, []);

  const renderCapture = useCallback(
    ({ item, index }: ListRenderItemInfo<Capture>) => (
      <CaptureCard
        capture={item}
        now={now}
        exiting={exiting[item.id] === true}
        entranceIndex={index}
        onPromote={promote}
        onDelete={remove}
        onExited={handleExited}
      />
    ),
    [exiting, handleExited, now, promote, remove],
  );

  const canSubmit = text.trim().length > 0;
  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;
  const visible = useMemo(() => {
    if (!searching) return captures;
    const keyword = trimmedQuery.toLowerCase();
    return captures.filter((capture) => capture.content.toLowerCase().includes(keyword));
  }, [captures, searching, trimmedQuery]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          {onBack ? <BackButton onPress={onBack} /> : null}
          <View style={styles.titleBlock}>
            <Text accessibilityRole="header" style={[styles.title, { color: tokens.text }]}>
              收集箱
            </Text>
            <Text style={[styles.subtitle, { color: tokens.muted }]}>
              {searching
                ? `找到 ${visible.length} 条 · 共 ${captures.length} 条速记`
                : `${captures.length} 条速记 · ${paired ? "已配对" : "仅本机保存"}`}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="前往任务页"
            accessibilityHint="查看已整理的任务列表"
            onPress={onOpenTasks}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            style={({ pressed }) => [styles.navLink, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.navLinkText, { color: tokens.accentText }]}>任务页 →</Text>
          </Pressable>
        </View>

        <GlassCard
          style={[styles.inputCard, { borderColor: focused ? tokens.accent : tokens.cardBorder }]}
        >
          {/* 底色放在外层壳上：输入区、「换行可继续写」提示与记录按钮同属一块可写区域，
              不再让提示和按钮落在无色背景上 */}
          <View style={[styles.inputShell, { backgroundColor: tokens.bgAccent }]}>
            <TextInput
              ref={inputRef}
              accessibilityLabel="收集箱输入"
              accessibilityHint="输入内容后点记录按钮，收进收集箱"
              value={text}
              onChangeText={setText}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="随手记一条…"
              placeholderTextColor={tokens.muted}
              multiline
              textAlignVertical="top"
              // EditText 的默认背景在浅色主题下是一块直角白底，必须显式去掉
              underlineColorAndroid="transparent"
              style={[styles.input, { color: tokens.text }]}
            />
            <View style={styles.inputFooter}>
              <Text numberOfLines={1} style={[styles.inputHint, { color: tokens.muted }]}>
                回车换行 · 点「记下」保存
              </Text>
              <PressableScale
                onPress={() => void submit()}
                disabled={!canSubmit}
                accessibilityLabel="记录到收集箱"
                scaleTo={0.94}
                contentStyle={[styles.recordButton, { backgroundColor: tokens.accentFill }]}
              >
                <Text style={[styles.recordText, { color: tokens.onAccent }]}>记下</Text>
              </PressableScale>
            </View>
          </View>
        </GlassCard>

        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索收集箱"
          accessibilityLabel="搜索收集箱"
        />
      </View>

      {loading ? (
        <ActivityIndicator style={styles.loading} color={tokens.accent} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.id}
          renderItem={renderCapture}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={CardSeparator}
          showsVerticalScrollIndicator={false}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          removeClippedSubviews
          ListEmptyComponent={
            searching ? (
              <EmptyState
                title="没有匹配的记录"
                hint={`没有内容包含「${trimmedQuery}」的记录；搜索只在本机收集箱内匹配文字`}
                actionLabel="清除搜索"
                onAction={() => setQuery("")}
              />
            ) : (
              <EmptyState
                title="收集箱是空的"
                hint="想到什么先记下来，不必先想清楚归类和截止时间"
                actionLabel="写第一条"
                onAction={() => inputRef.current?.focus()}
              />
            )
          }
        />
      )}

      <Toast toast={toast} onDismiss={dismissToast} placement="top" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    gap: space.md,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
  },
  titleBlock: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: font.page,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: font.page + 7,
  },
  subtitle: {
    fontSize: font.meta,
    lineHeight: 17,
  },
  navLink: {
    minHeight: 44,
    justifyContent: "center",
  },
  navLinkText: {
    fontSize: font.meta,
    fontWeight: "600",
  },
  inputCard: {
    padding: space.sm,
  },
  // 壳承载底色并同时包住输入区与底部操作行，是整个「可写区域」的视觉边界
  inputShell: {
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    gap: space.xs,
  },
  input: {
    minHeight: 48,
    maxHeight: 132,
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    fontSize: font.title,
    lineHeight: 22,
  },
  inputFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  inputHint: {
    flexShrink: 1,
    fontSize: font.label,
  },
  recordButton: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.lg,
    borderRadius: radius.chip,
  },
  recordText: {
    fontSize: font.title,
    fontWeight: "600",
  },
  loading: { marginTop: space.lg },
  listContent: {
    paddingHorizontal: space.lg,
    paddingBottom: 40,
  },
  cardGap: {
    height: space.sm,
  },
});
