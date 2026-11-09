// 笔记列表：搜索 → 筛选 → 置顶/全部笔记两组（同一 FlatList 内用分组头切分）。
// 笔记已接入同步：页头按是否配对显示「同步已连接 / 仅本机」。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";

import { Chip } from "../components/Chip";
import { EmptyState } from "../components/EmptyState";
import { NoteCard } from "../components/NoteCard";
import { PressableScale } from "../components/PressableScale";
import { SearchField } from "../components/SearchField";
import { TaskGroupHeader } from "../components/TaskGroupHeader";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { listNotes } from "../db/notes";
import { loadConnection } from "../db/syncConnection";
import type { Note } from "../domain/types";
import { describeError } from "../lib/errors";
import type { Nav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { floatingShadow } from "../theme/shadows";
import { font, space } from "../theme/tokens";

type NoteFilter = "all" | "pinned" | "favorited";

const FILTERS: { key: NoteFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pinned", label: "置顶" },
  { key: "favorited", label: "收藏" },
];

/** 与任务页同一套扁平行模型：分组头与卡片交替，单 FlatList 渲染 */
type NoteListRow =
  | { type: "section"; key: string; title: string; count: number; tone: "accent" | "muted" }
  | { type: "note"; key: string; note: Note };

function matchesQuery(note: Note, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  return note.title.toLowerCase().includes(query) || note.body.toLowerCase().includes(query);
}

export function NotesScreen({ version = 0, nav }: { version?: number; nav: Nav }) {
  const { tokens, scheme } = useTheme();
  const [notes, setNotes] = useState<Note[]>([]);
  const [paired, setPaired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<NoteFilter>("all");
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const refresh = useCallback(async () => {
    try {
      const [nextNotes, connection] = await Promise.all([
        listNotes(),
        loadConnection().catch(() => null),
      ]);
      setNotes(nextNotes);
      setPaired(Boolean(connection));
    } catch (error) {
      showToast(`读取笔记失败：${describeError(error)}`, "danger");
    } finally {
      setNow(Date.now());
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  const searching = query.trim().length > 0;

  const visible = useMemo(
    () => notes.filter((note) => matchesQuery(note, query)),
    [notes, query],
  );
  const pinnedNotes = useMemo(() => visible.filter((note) => note.pinned), [visible]);
  const restNotes = useMemo(() => visible.filter((note) => !note.pinned), [visible]);
  const favoritedNotes = useMemo(() => visible.filter((note) => note.favorited), [visible]);

  /** 各筛选下的分组行：置顶组只在有置顶时出现；收藏筛选用独立的 favorited 集合 */
  const rows = useMemo<NoteListRow[]>(() => {
    const pushSection = (key: string, title: string, tone: "accent" | "muted", list: Note[]) => {
      if (list.length === 0) return;
      next.push({ type: "section", key, title, count: list.length, tone });
      for (const note of list) next.push({ type: "note", key: `note-${note.id}`, note });
    };
    const next: NoteListRow[] = [];
    if (filter === "all") {
      pushSection("section-pinned", "置顶", "accent", pinnedNotes);
      pushSection("section-all", "全部笔记", "muted", restNotes);
    } else if (filter === "pinned") {
      pushSection("section-pinned", "置顶", "accent", pinnedNotes);
    } else {
      pushSection("section-favorited", "已收藏", "muted", favoritedNotes);
    }
    return next;
  }, [favoritedNotes, filter, pinnedNotes, restNotes]);

  const openEditor = useCallback(
    (note: Note | null) => {
      nav.push("note_editor", note?.id);
    },
    [nav],
  );

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<NoteListRow>) => {
      if (item.type === "section") {
        return (
          <TaskGroupHeader title={item.title} count={item.count} tone={item.tone} />
        );
      }
      return <NoteCard note={item.note} now={now} onPress={openEditor} />;
    },
    [now, openEditor],
  );

  const keyExtractor = useCallback((row: NoteListRow) => row.key, []);

  const emptyCopy = searching
    ? { title: "没有匹配的笔记", hint: `没有标题或正文包含「${query.trim()}」的笔记` }
    : filter === "favorited"
      ? { title: "还没有收藏的笔记", hint: "在笔记编辑页点「收藏」，收藏的笔记会出现在这里" }
      : filter === "pinned"
        ? { title: "还没有置顶笔记", hint: "在笔记编辑页点右上角图钉，置顶的笔记会排在最前" }
        : { title: "还没有笔记", hint: "点右下角 + 写下第一篇；也可以先在收集箱速记，稍后整理" };

  return (
    <View style={styles.container}>
      {loading ? (
        <ActivityIndicator style={styles.loading} color={tokens.accent} />
      ) : (
        <FlatList
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderRow}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={styles.titleBlock}>
                <Text accessibilityRole="header" style={[styles.screenTitle, { color: tokens.text }]}>
                  笔记
                </Text>
                <Text style={[styles.subtitle, { color: tokens.muted }]}>
                  {searching
                    ? `找到 ${visible.length} 篇 · 共 ${notes.length} 篇`
                    : `${notes.length} 篇 · ${paired ? "同步已连接" : "仅本机"}`}
                </Text>
              </View>
            </View>

            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder="搜索笔记"
              accessibilityLabel="搜索笔记"
            />

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              accessibilityLabel="笔记筛选"
              style={styles.filterScroll}
              contentContainerStyle={styles.filterRow}
            >
              {FILTERS.map((item) => (
                <Chip
                  key={item.key}
                  label={item.label}
                  active={filter === item.key}
                  accessibilityLabel={`筛选 ${item.label}`}
                  onPress={() => setFilter(item.key)}
                />
              ))}
            </ScrollView>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title={emptyCopy.title}
            hint={emptyCopy.hint}
            actionLabel={searching ? "清除搜索" : "新建笔记"}
            onAction={searching ? () => setQuery("") : () => openEditor(null)}
          />
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={7}
        />
      )}

      <PressableScale
        onPress={() => openEditor(null)}
        accessibilityLabel="新建笔记"
        accessibilityHint="打开笔记编辑页"
        style={styles.fab}
        contentStyle={[
          styles.fabInner,
          { backgroundColor: tokens.accentFill },
          floatingShadow(scheme),
        ]}
      >
        <View style={styles.fabGlyph}>
          <View style={[styles.fabBar, styles.fabBarH, { backgroundColor: tokens.onAccent }]} />
          <View style={[styles.fabBar, styles.fabBarV, { backgroundColor: tokens.onAccent }]} />
        </View>
      </PressableScale>

      <Toast toast={toast} onDismiss={dismissToast} placement="top" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { marginTop: space.xl },
  header: {
    paddingTop: space.sm,
    gap: space.md,
    paddingBottom: space.xs,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.sm,
  },
  titleBlock: { flex: 1, gap: 1 },
  screenTitle: {
    fontSize: font.display,
    fontWeight: "800",
    letterSpacing: -0.8,
    lineHeight: font.display + 8,
  },
  subtitle: { fontSize: font.meta },
  filterScroll: {
    marginHorizontal: -space.lg,
  },
  filterRow: {
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.xxs,
  },
  listContent: {
    paddingHorizontal: space.lg,
    paddingBottom: 96,
  },
  fab: {
    position: "absolute",
    right: space.lg,
    bottom: space.lg,
  },
  fabInner: {
    width: 58,
    height: 58,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  fabGlyph: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  fabBar: {
    position: "absolute",
    borderRadius: 1.2,
  },
  fabBarH: {
    left: 1,
    top: 10.9,
    width: 22,
    height: 2.2,
  },
  fabBarV: {
    left: 10.9,
    top: 1,
    width: 2.2,
    height: 22,
  },
});
