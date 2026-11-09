// 笔记卡片：标题（空标题回退摘要/无标题）+ 两行摘要 + revision·时间 + 置顶图标。
// 纯展示 + onPress；置顶/收藏/删除入口在编辑器内，保持列表交互面最小。
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { formatRelative } from "../domain/taskQuery";
import { excerpt, noteDisplayTitle } from "../domain/noteText";
import type { Note } from "../domain/types";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { GlassCard } from "./GlassCard";

function NoteCardBase({
  note,
  now,
  onPress,
}: {
  note: Note;
  now: number;
  onPress: (note: Note) => void;
}) {
  const { tokens } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开笔记「${noteDisplayTitle(note.title, note.body)}」`}
      accessibilityHint="进入笔记编辑"
      onPress={() => onPress(note)}
      style={({ pressed }) => [{ opacity: pressed ? 0.75 : 1 }]}
    >
      <GlassCard style={styles.card}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.title, { color: tokens.text }]}>
            {noteDisplayTitle(note.title, note.body)}
          </Text>
          {note.pinned ? (
            <View style={styles.pin} accessibilityLabel="已置顶">
              {/* 置顶图钉：斜置的针头方块 + 针杆，同 1.5dp 笔触 */}
              <View style={[styles.pinHead, { backgroundColor: tokens.accent }]} />
              <View style={[styles.pinStem, { backgroundColor: tokens.accent }]} />
            </View>
          ) : null}
        </View>
        {note.body.trim() ? (
          <Text numberOfLines={2} style={[styles.excerpt, { color: tokens.muted }]}>
            {excerpt(note.body, 96)}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <Text style={[styles.meta, { color: tokens.faint }]}>
            revision {note.rev} · {formatRelative(note.updatedAt, now)}
          </Text>
        </View>
      </GlassCard>
    </Pressable>
  );
}

export const NoteCard = memo(NoteCardBase);

const styles = StyleSheet.create({
  card: {
    padding: space.md,
    gap: space.sm - 2,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  title: {
    flexShrink: 1,
    fontSize: font.title,
    fontWeight: "600",
  },
  pin: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  pinHead: {
    width: 7,
    height: 7,
    borderRadius: 2,
    transform: [{ rotate: "45deg" }],
    marginTop: 3,
  },
  pinStem: {
    width: 1.5,
    height: 6,
    borderRadius: 1,
    marginTop: -1,
  },
  excerpt: {
    fontSize: font.body,
    lineHeight: 19,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
  },
  meta: {
    flexShrink: 1,
    fontSize: font.meta,
    fontVariant: ["tabular-nums"],
  },
});
