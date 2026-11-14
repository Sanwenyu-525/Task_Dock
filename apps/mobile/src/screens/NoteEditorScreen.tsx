// 笔记编辑：AppBar（返回/pin/更多）+ 标题 + 正文 + 文本操作行 + 底部格式工具栏。
// 保存时机：返回即保存（新建时若标题正文均为空则直接丢弃，不产生空行）；
// 硬件返回键与本屏返回按钮走同一条「先保存再关」路径。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  Clipboard,
  Keyboard,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ActionSheet, type SheetAction } from "../components/ActionSheet";
import { AppBar } from "../components/AppBar";
import { AppIcon, type IconName } from "../components/icons/AppIcon";
import {
  Toast,
  TOAST_TOP_PUSH,
  type ToastMessage,
  type ToastPlacement,
  type ToastTone,
} from "../components/Toast";
import { createNote, deleteNote, getNote, updateNote } from "../db/notes";
import { countChars, insertSnippet, wrapSelection } from "../domain/noteText";
import type { Note } from "../domain/types";
import { describeError } from "../lib/errors";
import { useWindowInsets } from "../lib/insets";
import { useKeyboardHeight } from "../lib/keyboard";
import type { Nav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

/** 底部工具栏高度：paddingTop 4 + 按钮 44 + paddingBottom 8（安全区另加） */
const TOOLBAR_HEIGHT = space.xs + 44 + space.sm;

interface Selection {
  start: number;
  end: number;
}

export function NoteEditorScreen({
  noteId,
  nav,
  onDataChanged,
}: {
  noteId?: string;
  nav: Nav;
  onDataChanged: () => void;
}) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  /** 键盘高度自己让位：edge-to-edge 下系统不再收缩窗口（见 lib/keyboard.ts） */
  const keyboardHeight = useKeyboardHeight();
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  /** 程序化改文后把光标放回计算位置：只在下一帧前生效，避免干扰手动输入 */
  const [forcedSelection, setForcedSelection] = useState<Selection | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);
  /** 保存去重：返回/硬件返回/再按返回可能连发，同一次编辑只落一次库 */
  const savingRef = useRef(false);

  const showToast = useCallback(
    (text: string, tone: ToastTone = "info", placement?: ToastPlacement) => {
      toastSeq.current += 1;
      setToast({ id: toastSeq.current, text, tone, placement });
    },
    [],
  );
  const dismissToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!noteId) return;
      try {
        const loaded = await getNote(noteId);
        if (cancelled || !loaded) return;
        setNote(loaded);
        setTitle(loaded.title);
        setBody(loaded.body);
        setPinned(loaded.pinned);
        setFavorited(loaded.favorited);
        setRevision(loaded.rev);
      } catch (error) {
        showToast(`读取笔记失败：${describeError(error)}`, "danger");
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在进入屏幕时读一次；编辑中的状态以本地 state 为准
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  /** 把当前编辑内容落库；返回是否发生了写入（供提示用） */
  const persist = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    try {
      const nextTitle = title.trim();
      if (note) {
        const changed = nextTitle !== note.title || body !== note.body;
        if (!changed) return false;
        const updated = await updateNote(note.id, { title: nextTitle, body });
        if (!updated) {
          showToast("笔记已不存在", "danger");
          return false;
        }
        setNote(updated);
        setRevision(updated.rev);
        onDataChanged();
        return true;
      }
      if (!nextTitle && !body.trim()) return false;
      const created = await createNote({ title: nextTitle, body, pinned, favorited });
      setNote(created);
      setRevision(created.rev);
      onDataChanged();
      return true;
    } catch (error) {
      showToast(`保存失败：${describeError(error)}`, "danger");
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [body, favorited, note, onDataChanged, pinned, showToast, title]);

  const close = useCallback(() => {
    Keyboard.dismiss();
    nav.back();
  }, [nav]);

  // 返回 = 先保存再关。这里注册的监听晚于 Shell 的全局返回处理，
  // React Native 会先调用后注册者：本屏吞掉返回事件，Shell 不会再 pop 一次。
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      void (async () => {
        await persist();
        close();
      })();
      return true;
    });
    return () => sub.remove();
  }, [close, persist]);

  const handleBack = useCallback(() => {
    void (async () => {
      await persist();
      close();
    })();
  }, [close, persist]);

  /** 程序化文本变换：算好新文本与光标，下一帧把光标放回去 */
  const applyEdit = useCallback(
    (edit: { text: string; start: number; end: number }) => {
      setBody(edit.text);
      setSelection({ start: edit.start, end: edit.end });
      setForcedSelection({ start: edit.start, end: edit.end });
    },
    [],
  );

  const wrapBold = useCallback(() => {
    applyEdit(wrapSelection(body, selection.start, selection.end, "**", "**"));
  }, [applyEdit, body, selection.end, selection.start]);

  const insertList = useCallback(() => {
    applyEdit(insertSnippet(body, selection.start, selection.end, "\n- "));
  }, [applyEdit, body, selection.end, selection.start]);

  const insertTodo = useCallback(() => {
    applyEdit(insertSnippet(body, selection.start, selection.end, "\n- [ ] "));
  }, [applyEdit, body, selection.end, selection.start]);

  const insertTag = useCallback(() => {
    applyEdit(insertSnippet(body, selection.start, selection.end, "#"));
  }, [applyEdit, body, selection.end, selection.start]);

  const handleCopy = useCallback(async () => {
    const full = title.trim() ? `${title.trim()}\n\n${body}` : body;
    try {
      // RN 核心 Clipboard（deprecated 但仍可用）；失败时回退到分享面板
      Clipboard.setString(full);
      showToast("已复制全文", "success", "bottom");
    } catch {
      try {
        await Share.share({ message: full });
      } catch {
        showToast("复制失败", "danger", "bottom");
      }
    }
  }, [body, showToast, title]);

  const handleShare = useCallback(async () => {
    try {
      await Share.share({
        message: title.trim() ? `${title.trim()}\n\n${body}` : body,
      });
    } catch {
      // 用户取消分享面板不算错误
    }
  }, [body, title]);

  const togglePinned = useCallback(async () => {
    const next = !pinned;
    setPinned(next);
    if (!note) return;
    try {
      const updated = await updateNote(note.id, { pinned: next });
      if (updated) {
        setNote(updated);
        setRevision(updated.rev);
        onDataChanged();
      }
    } catch (error) {
      setPinned(!next);
      showToast(`置顶失败：${describeError(error)}`, "danger");
    }
  }, [note, onDataChanged, pinned, showToast]);

  const toggleFavorited = useCallback(async () => {
    const next = !favorited;
    setFavorited(next);
    if (!note) return;
    try {
      const updated = await updateNote(note.id, { favorited: next });
      if (updated) {
        setNote(updated);
        setRevision(updated.rev);
        onDataChanged();
      }
    } catch (error) {
      setFavorited(!next);
      showToast(`收藏失败：${describeError(error)}`, "danger", "bottom");
    }
  }, [favorited, note, onDataChanged, showToast]);

  const handleDelete = useCallback(async () => {
    if (!note) {
      close();
      return;
    }
    try {
      await deleteNote(note.id);
      onDataChanged();
      showToast("笔记已删除");
      close();
    } catch (error) {
      showToast(`删除失败：${describeError(error)}`, "danger");
    }
  }, [close, note, onDataChanged, showToast]);

  const sheetActions = useMemo<SheetAction[]>(
    () => [
      { key: "copy", label: "复制全文", icon: "copy", hint: "标题与正文一起复制" },
      { key: "share", label: "分享笔记", icon: "share", hint: "调起系统分享面板" },
      { key: "delete", label: "删除笔记", tone: "danger", icon: "delete", hint: "删除后不再出现在笔记列表" },
    ],
    [],
  );

  const handleSheetAction = useCallback(
    (key: string) => {
      setActionOpen(false);
      if (key === "copy") void handleCopy();
      if (key === "share") void handleShare();
      if (key === "delete") void handleDelete();
    },
    [handleCopy, handleDelete, handleShare],
  );

  const metaText =
    revision == null ? "未保存 · 本机" : `已保存 · revision ${revision} · 本机`;

  return (
    <View style={[styles.container, { paddingBottom: keyboardHeight }]}>
      <AppBar
        title="编辑笔记"
        onBack={handleBack}
        right={
          <>
            <PinGlyph
              color={pinned ? tokens.accent : tokens.muted}
              active={pinned}
              onPress={() => void togglePinned()}
            />
            <MoreButton onPress={() => setActionOpen(true)} />
          </>
        }
      />

      <View style={styles.body}>
        <TextInput
          accessibilityLabel="笔记标题"
          value={title}
          onChangeText={setTitle}
          placeholder="标题"
          placeholderTextColor={tokens.faint}
          returnKeyType="next"
          underlineColorAndroid="transparent"
          style={[styles.titleInput, { color: tokens.text, borderColor: tokens.separator }]}
        />

        <View style={styles.metaRow}>
          <Text style={[styles.meta, { color: tokens.faint }]}>{metaText}</Text>
          <View style={[styles.syncChip, { backgroundColor: tokens.warnSoft }]}>
            <Text numberOfLines={1} style={[styles.syncChipText, { color: tokens.warn }]}>
              同步后冲突会提示
            </Text>
          </View>
        </View>

        <TextInput
          accessibilityLabel="笔记正文"
          value={body}
          onChangeText={setBody}
          onSelectionChange={(
            event: { nativeEvent: { selection: { start: number; end: number } } },
          ) => {
            const next = event.nativeEvent.selection;
            setSelection({ start: next.start, end: next.end });
            if (forcedSelection) setForcedSelection(null);
          }}
          selection={forcedSelection ?? undefined}
          placeholder="正文…"
          placeholderTextColor={tokens.faint}
          multiline
          textAlignVertical="top"
          underlineColorAndroid="transparent"
          style={[styles.bodyInput, { color: tokens.text }]}
        />

        <View style={[styles.actionRow, { borderTopColor: tokens.separator }]}>
          <ActionText
            label={favorited ? "已收藏" : "收藏"}
            active={favorited}
            onPress={() => void toggleFavorited()}
          />
          <ActionText label="插入待办" onPress={insertTodo} />
          <ActionText label="复制全文" onPress={() => void handleCopy()} />
          <Text style={[styles.charCount, { color: tokens.faint }]}>{countChars(body)} 字</Text>
        </View>
      </View>

      {/* 底部工具栏：键盘收起时让开手势条（insets.bottom），键盘弹出时由容器 padding 顶上去 */}
      <View
        style={[
          styles.toolbar,
          {
            borderTopColor: tokens.separator,
            paddingBottom: keyboardHeight > 0 ? 8 : 8 + insets.bottom,
          },
        ]}
      >
        <ToolButton icon="bold" accessibilityLabel="加粗标记" onPress={wrapBold} />
        <ToolButton icon="list" accessibilityLabel="插入列表项" onPress={insertList} />
        <ToolButton icon="hash" accessibilityLabel="插入标签" onPress={insertTag} />
        <ToolButton icon="share" accessibilityLabel="分享笔记" onPress={() => void handleShare()} />
      </View>

      <Toast
        toast={toast}
        onDismiss={dismissToast}
        placement="top"
        topOffset={TOAST_TOP_PUSH}
        // 工具行触发的提示落在工具栏上方；键盘弹起时工具栏被容器顶到键盘上沿
        bottomOffset={
          keyboardHeight > 0
            ? keyboardHeight + TOOLBAR_HEIGHT + space.sm
            : TOOLBAR_HEIGHT + insets.bottom + space.sm
        }
      />

      <ActionSheet
        visible={actionOpen}
        title={title.trim() || "无标题笔记"}
        actions={sheetActions}
        entityLabel="笔记操作"
        onAction={handleSheetAction}
        onRequestClose={() => setActionOpen(false)}
      />
    </View>
  );
}

/** AppBar 右侧图钉按钮：激活时用 accent 颜色表达「已置顶」 */
function PinGlyph({
  color,
  onPress,
  active,
}: {
  color: string;
  onPress: () => void;
  active: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? "取消置顶" : "置顶笔记"}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}
    >
      <AppIcon name="pin" color={color} size={21} />
    </Pressable>
  );
}

function MoreButton({ onPress }: { onPress: () => void }) {
  const { tokens } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="更多操作"
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.6 : 1 }]}
    >
      <AppIcon name="more" color={tokens.muted} size={21} />
    </Pressable>
  );
}

function ActionText({
  label,
  onPress,
  active = false,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  const { tokens } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      style={({ pressed }) => [styles.actionText, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={{ color: tokens.accentText, fontSize: font.body, fontWeight: active ? "700" : "500" }}>
        {label}
      </Text>
    </Pressable>
  );
}

function ToolButton({
  icon,
  onPress,
  accessibilityLabel,
}: {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const { tokens } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.toolButton, { opacity: pressed ? 0.6 : 1 }]}
    >
      <AppIcon name={icon} color={tokens.textSoft} size={22} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  body: {
    flex: 1,
    paddingHorizontal: space.lg,
  },
  titleInput: {
    marginTop: space.md,
    minHeight: 48,
    fontSize: 22,
    fontWeight: "700",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: space.sm,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    marginTop: space.sm,
  },
  meta: {
    flexShrink: 1,
    fontSize: font.label,
    fontVariant: ["tabular-nums"],
  },
  syncChip: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: 999,
    flexShrink: 1,
  },
  syncChipText: {
    fontSize: font.label,
    fontWeight: "600",
  },
  bodyInput: {
    flex: 1,
    fontSize: font.reading,
    lineHeight: 23,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: space.sm,
  },
  actionText: {
    minHeight: 44,
    justifyContent: "center",
  },
  charCount: {
    marginLeft: "auto",
    fontSize: font.label,
    fontVariant: ["tabular-nums"],
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.xs,
  },
  toolButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
