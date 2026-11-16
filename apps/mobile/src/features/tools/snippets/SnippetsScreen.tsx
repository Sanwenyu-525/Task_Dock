// 代码片段：列表（搜索 / 语言筛选 / 收藏筛选 / 回收站）+ 详情编辑。
//
// 产品取舍（手机优先）：
// - 列表行右侧直接「复制」，长代码也只需一次点击；进入详情才做编辑；
// - 搜索同时匹配标题 / 正文 / 标签（多关键词 AND），语言与收藏是独立筛选；
// - 删除是软删除，回收站可恢复；确认弹层不依赖原生 Alert；
// - 跨设备只提供两条真实路径：导出文本文件（系统下载目录 / 系统分享）与发送到电脑
//   （文件互传 TLS 通道）。界面明确写「本机保存」，不会把本机保存说成已同步。
import { useCallback, useEffect, useMemo, useState } from "react";
import { BackHandler, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ActionSheet, type SheetAction } from "../../../components/ActionSheet";
import { AppBar } from "../../../components/AppBar";
import { Chip } from "../../../components/Chip";
import { AppIcon } from "../../../components/icons/AppIcon";
import { SearchField } from "../../../components/SearchField";
import { useToast } from "../../../feedback/ToastProvider";
import {
  createSnippet,
  deleteSnippet,
  listDeletedSnippets,
  listSnippetLanguages,
  listSnippets,
  purgeSnippet,
  restoreSnippet,
  touchSnippetUse,
  updateSnippet,
} from "../../../db/snippets";
import { recordToolUse } from "../../../db/toolUsage";
import {
  SNIPPET_LANGUAGES,
  canSaveSnippet,
  draftTitle,
  emptySnippetDraft,
  filterSnippets,
  formatTags,
  languageLabel,
  normalizeTags,
  snippetFileName,
  snippetSummary,
  snippetToPlainText,
  type Snippet,
  type SnippetDraft,
} from "../../../domain/tools/snippetModel";
import { describeError } from "../../../lib/errors";
import { formatDateTime } from "../../../lib/format";
import { useWindowInsets } from "../../../lib/insets";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, radius, space } from "../../../theme/tokens";
import {
  readClipboard,
  shareOutText,
  writeClipboard,
  writeToolTextFile,
} from "../shared/nativeTools";
import { saveTextFileToDownloads } from "../shared/saveOutput";
import { sendToolFileToDesktop } from "../shared/sendToDesktop";
import { takeSnippetDraft } from "../shareIntake";
import { ToolButton, ToolField, ToolNote, ToolScreen, ToolSection, ToolTextArea } from "../shared/ToolUI";

const TOOL_ID = "tool.snippet";

type EditorState =
  | { kind: "closed" }
  | { kind: "edit"; snippet: Snippet | null; draft: SnippetDraft; baseline: SnippetDraft };

export function SnippetsScreen({ onBack }: { onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();
  const insets = useWindowInsets();

  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [deleted, setDeleted] = useState<Snippet[]>([]);
  const [languages, setLanguages] = useState<{ language: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<string | null>(null);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [saving, setSaving] = useState(false);
  const [rowAction, setRowAction] = useState<Snippet | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Snippet | null>(null);
  const [discardRequest, setDiscardRequest] = useState(false);
  const [sendState, setSendState] = useState<{ label: string; value: number } | null>(null);

  useEffect(() => {
    void recordToolUse(TOOL_ID);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [list, removed, langs] = await Promise.all([
        listSnippets(),
        listDeletedSnippets(),
        listSnippetLanguages(),
      ]);
      setSnippets(list);
      setDeleted(removed);
      setLanguages(langs);
      setLoadError("");
    } catch (error) {
      setLoadError(`读取本图片段失败：${describeError(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 系统分享「保存为代码片段」：进入页面时取走草稿并直接打开编辑器。
  useEffect(() => {
    const draft = takeSnippetDraft();
    if (!draft) return;
    const base = { ...emptySnippetDraft(), content: draft };
    setEditor({ kind: "edit", snippet: null, draft: base, baseline: base });
  }, []);

  const filtered = useMemo(
    () => filterSnippets(snippets, { query, language, favoriteOnly }),
    [favoriteOnly, language, query, snippets],
  );

  const isDirty = useMemo(() => {
    if (editor.kind !== "edit") return false;
    const base = editor.baseline;
    const draft = editor.draft;
    return (
      base.title !== draft.title ||
      base.language !== draft.language ||
      base.content !== draft.content ||
      formatTags(base.tags) !== formatTags(draft.tags) ||
      base.favorite !== draft.favorite ||
      base.pinned !== draft.pinned
    );
  }, [editor]);

  const closeEditor = useCallback(() => {
    setEditor({ kind: "closed" });
    setDiscardRequest(false);
  }, []);

  const requestCloseEditor = useCallback(() => {
    if (isDirty) {
      setDiscardRequest(true);
      return;
    }
    closeEditor();
  }, [closeEditor, isDirty]);

  // 编辑态拦截硬件返回：先处理未保存修改，避免直接丢内容。
  useEffect(() => {
    if (editor.kind !== "edit") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      requestCloseEditor();
      return true;
    });
    return () => sub.remove();
  }, [editor.kind, requestCloseEditor]);

  const openCreate = () => {
    const base = emptySnippetDraft();
    setEditor({ kind: "edit", snippet: null, draft: base, baseline: base });
  };

  const openEdit = (snippet: Snippet) => {
    const base: SnippetDraft = {
      title: snippet.title,
      language: snippet.language,
      content: snippet.content,
      tags: [...snippet.tags],
      note: snippet.note,
      favorite: snippet.favorite,
      pinned: snippet.pinned,
    };
    setEditor({ kind: "edit", snippet, draft: base, baseline: { ...base, tags: [...base.tags] } });
  };

  const patchDraft = (patch: Partial<SnippetDraft>) => {
    setEditor((current) =>
      current.kind === "edit" ? { ...current, draft: { ...current.draft, ...patch } } : current,
    );
  };

  const copyText = async (content: string, snippetId?: string) => {
    try {
      await writeClipboard(content);
      if (snippetId) await touchSnippetUse(snippetId);
      showToast("代码已复制到剪贴板", "success");
      if (snippetId) void reload();
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const pasteIntoEditor = async () => {
    if (editor.kind !== "edit") return;
    try {
      const text = await readClipboard();
      if (!text) {
        showToast("剪贴板为空，或系统不允许后台读取", "info");
        return;
      }
      const current = editor.draft.content;
      patchDraft({ content: current ? `${current}\n${text}` : text });
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const saveEditor = async () => {
    if (editor.kind !== "edit" || saving) return;
    const draft = editor.draft;
    if (!canSaveSnippet(draft)) {
      showToast("正文不能为空", "danger");
      return;
    }
    setSaving(true);
    try {
      const payload: SnippetDraft = { ...draft, title: draftTitle(draft) };
      if (editor.snippet) {
        const updated = await updateSnippet(editor.snippet.id, {
          title: payload.title,
          language: payload.language,
          content: payload.content,
          tags: payload.tags,
          note: payload.note,
          favorite: payload.favorite,
          pinned: payload.pinned,
        });
        if (!updated) throw new Error("片段已不存在，可能已在回收站被清理");
      } else {
        await createSnippet(payload);
      }
      showToast(editor.snippet ? "片段已保存" : "片段已创建", "success");
      closeEditor();
      await reload();
    } catch (error) {
      showToast(`保存失败：${describeError(error)}`, "danger");
    } finally {
      setSaving(false);
    }
  };

  const removeSnippet = async (snippet: Snippet) => {
    try {
      await deleteSnippet(snippet.id);
      setDeleteTarget(null);
      setRowAction(null);
      if (editor.kind === "edit" && editor.snippet?.id === snippet.id) closeEditor();
      showToast("已删除，可在回收站恢复", "success");
      await reload();
    } catch (error) {
      showToast(`删除失败：${describeError(error)}`, "danger");
    }
  };

  const exportSnippet = async (snippet: Snippet) => {
    try {
      const name = snippetFileName(snippet);
      const file = writeToolTextFile(name, snippetToPlainText(snippet));
      const saved = await saveTextFileToDownloads(file.uri, name);
      showToast(`已导出到系统下载目录：${saved.displayName}`, "success");
    } catch (error) {
      showToast(`导出失败：${describeError(error)}`, "danger");
    }
  };

  const shareSnippet = async (snippet: Snippet) => {
    try {
      await shareOutText(snippet.content, snippet.title || "代码片段");
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const sendSnippet = async (snippet: Snippet) => {
    setSendState({ label: "准备发送", value: 0 });
    try {
      const name = snippetFileName(snippet);
      const file = writeToolTextFile(name, snippetToPlainText(snippet));
      const result = await sendToolFileToDesktop({
        uri: file.uri,
        fileName: name,
        mime: "text/plain",
        onProgress: (done, total) =>
          setSendState({ label: "发送中", value: total > 0 ? done / total : 0 }),
      });
      showToast(result.message, result.ok ? "success" : "info");
    } catch (error) {
      showToast(`发送失败：${describeError(error)}`, "danger");
    } finally {
      setSendState(null);
    }
  };

  const toggleField = async (snippet: Snippet, key: "favorite" | "pinned") => {
    try {
      await updateSnippet(snippet.id, { [key]: !snippet[key] });
      await reload();
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  // ── 编辑页 ────────────────────────────────────────────────
  if (editor.kind === "edit") {
    const draft = editor.draft;
    return (
      <ToolScreen
        title={editor.snippet ? "编辑片段" : "新建片段"}
        subtitle="等宽显示 · 仅保存在本机（不参与笔记同步）"
        onBack={requestCloseEditor}
        footer={
          <View style={styles.footerRow}>
            <ToolButton
              label={saving ? "保存中…" : "保存"}
              tone="primary"
              icon="check"
              disabled={saving || !canSaveSnippet(draft)}
              onPress={() => void saveEditor()}
              style={styles.footerPrimary}
            />
            <ToolButton
              label="复制"
              icon="copy"
              disabled={!draft.content}
              onPress={() => void copyText(draft.content, editor.snippet?.id)}
            />
          </View>
        }
      >
        <ToolSection title="基本信息">
          <ToolField
            label="标题"
            value={draft.title}
            onChangeText={(title) => patchDraft({ title })}
            placeholder="留空时用正文首行生成"
            maxLength={80}
          />
          <View style={styles.block}>
            <Text style={[styles.blockLabel, { color: tokens.textSoft }]}>语言</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {SNIPPET_LANGUAGES.map((item) => (
                <Chip
                  key={item.id}
                  label={item.label}
                  active={draft.language === item.id}
                  onPress={() => patchDraft({ language: item.id })}
                  variant="soft"
                />
              ))}
            </ScrollView>
          </View>
          <ToolField
            label="标签"
            value={formatTags(draft.tags)}
            onChangeText={(text) => patchDraft({ tags: normalizeTags(text) })}
            placeholder="用逗号分隔，例如 android, sql"
            hint="最多 12 个标签；搜索会同时匹配标题、正文与标签"
          />
          <ToolField
            label="备注（可选）"
            value={draft.note}
            onChangeText={(note) => patchDraft({ note })}
            placeholder="例如 来源、使用场景、注意事项"
            multiline
            minHeight={64}
            maxLength={300}
          />
        </ToolSection>

        <ToolSection>
          <ToolTextArea
            label="代码 / 命令"
            value={draft.content}
            onChangeText={(content) => patchDraft({ content })}
            placeholder="在此粘贴或输入代码…"
            height={340}
            mono
            actions={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="从剪贴板粘贴"
                onPress={() => void pasteIntoEditor()}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
              >
                <AppIcon name="clipboard" size={16} color={tokens.textSoft} />
                <Text style={[styles.inlineActionText, { color: tokens.textSoft }]}>粘贴</Text>
              </Pressable>
            }
          />
          <View style={styles.toggleRow}>
            <ToolButton
              label={draft.favorite ? "已收藏" : "收藏"}
              tone={draft.favorite ? "primary" : "secondary"}
              icon="star"
              compact
              onPress={() => patchDraft({ favorite: !draft.favorite })}
            />
            <ToolButton
              label={draft.pinned ? "已置顶" : "置顶"}
              tone={draft.pinned ? "primary" : "secondary"}
              icon="pin"
              compact
              onPress={() => patchDraft({ pinned: !draft.pinned })}
            />
          </View>
        </ToolSection>

        {editor.snippet ? (
          <ToolSection title="跨设备">
            <ToolNote text="这个片段只保存在本机。导出会写入系统下载目录；发送到电脑走文件互传的加密通道，不经过笔记同步。" />
            <View style={styles.actionRow}>
              <ToolButton
                label="导出文本"
                icon="download"
                onPress={() => void exportSnippet(editor.snippet!)}
              />
              <ToolButton label="分享" icon="share" onPress={() => void shareSnippet(editor.snippet!)} />
            </View>
            <View style={styles.actionRow}>
              <ToolButton
                label={sendState ? "发送中…" : "发送到电脑"}
                icon="send"
                disabled={sendState !== null}
                onPress={() => void sendSnippet(editor.snippet!)}
              />
              <ToolButton
                label="删除片段"
                tone="danger"
                icon="delete"
                onPress={() => setDeleteTarget(editor.snippet)}
              />
            </View>
            {sendState ? (
              <Text style={[styles.progressText, { color: tokens.textSoft }]}>
                {sendState.label} · {Math.round(sendState.value * 100)}%
              </Text>
            ) : null}
          </ToolSection>
        ) : (
          <ToolNote text="保存后可在详情里导出、分享或发送到电脑。" />
        )}

        <ActionSheet
          visible={discardRequest}
          title="放弃未保存的修改？"
          subtitle="返回列表后，本次编辑不会保留"
          entityLabel="片段编辑"
          actions={[
            { key: "keep", label: "继续编辑", tone: "primary" },
            { key: "discard", label: "放弃修改", tone: "danger" },
          ]}
          onAction={(key) => {
            if (key === "discard") closeEditor();
            else setDiscardRequest(false);
          }}
          onRequestClose={() => setDiscardRequest(false)}
        />
        <ActionSheet
          visible={deleteTarget !== null}
          title={deleteTarget ? `删除「${deleteTarget.title || "未命名片段"}」？` : "删除片段？"}
          subtitle="删除后可在回收站恢复"
          entityLabel="片段删除"
          actions={[
            { key: "cancel", label: "取消" },
            { key: "delete", label: "移到回收站", tone: "danger", icon: "delete" },
          ]}
          onAction={(key) => {
            if (key === "delete" && deleteTarget) void removeSnippet(deleteTarget);
            else setDeleteTarget(null);
          }}
          onRequestClose={() => setDeleteTarget(null)}
        />
      </ToolScreen>
    );
  }

  // ── 列表页 ────────────────────────────────────────────────
  const rowActions: SheetAction[] = rowAction
    ? [
        { key: "copy", label: "复制代码", icon: "copy" },
        { key: "edit", label: "编辑", icon: "edit" },
        { key: "share", label: "系统分享", icon: "share" },
        { key: "export", label: "导出文本文件", icon: "download" },
        { key: "send", label: "发送到电脑", icon: "send" },
        { key: "favorite", label: rowAction.favorite ? "取消收藏" : "收藏", icon: "star" },
        { key: "pin", label: rowAction.pinned ? "取消置顶" : "置顶", icon: "pin" },
        { key: "delete", label: "移到回收站", tone: "danger", icon: "delete" },
      ]
    : [];

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <AppBar
        title="代码片段"
        onBack={onBack}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="新建代码片段"
            onPress={openCreate}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
            style={({ pressed }) => [styles.headerAction, { opacity: pressed ? 0.6 : 1 }]}
          >
            <AppIcon name="add" size={22} color={tokens.text} />
          </Pressable>
        }
      />

      <View style={styles.searchWrap}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索标题、正文、语言或标签"
          accessibilityLabel="搜索代码片段"
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        style={styles.filterBar}
      >
        <Chip
          label="全部"
          active={!language && !favoriteOnly && !trashOpen}
          onPress={() => {
            setLanguage(null);
            setFavoriteOnly(false);
            setTrashOpen(false);
          }}
          variant="soft"
        />
        <Chip
          label="收藏"
          active={favoriteOnly}
          onPress={() => {
            setFavoriteOnly((value) => !value);
            setTrashOpen(false);
          }}
          variant="soft"
        />
        {languages.map((item) => (
          <Chip
            key={item.language}
            label={`${languageLabel(item.language)} ${item.count}`}
            active={language === item.language}
            onPress={() => {
              setLanguage((current) => (current === item.language ? null : item.language));
              setTrashOpen(false);
            }}
            variant="soft"
          />
        ))}
        {deleted.length > 0 ? (
          <Chip
            label={`回收站 ${deleted.length}`}
            active={trashOpen}
            onPress={() => setTrashOpen((value) => !value)}
            variant="soft"
          />
        ) : null}
      </ScrollView>

      {loading ? (
        <Text style={[styles.hint, { color: tokens.muted }]}>正在读取本图片段…</Text>
      ) : loadError ? (
        <View style={styles.errorWrap}>
          <ToolNote text={loadError} tone="warn" />
        </View>
      ) : trashOpen ? (
        <FlatList
          data={deleted}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
          ListEmptyComponent={<ToolNote text="回收站是空的。" />}
          renderItem={({ item }) => (
            <View style={[styles.row, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
              <View style={styles.rowBody}>
                <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>
                  {item.title || "未命名片段"}
                </Text>
                <Text style={[styles.rowMeta, { color: tokens.muted }]} numberOfLines={1}>
                  {languageLabel(item.language)} · {formatDateTime(item.updatedAt)}
                </Text>
              </View>
              <ToolButton
                compact
                label="恢复"
                tone="ok"
                onPress={() => {
                  void (async () => {
                    try {
                      await restoreSnippet(item.id);
                      showToast("已恢复到片段列表", "success");
                      await reload();
                    } catch (error) {
                      showToast(describeError(error), "danger");
                    }
                  })();
                }}
              />
              <ToolButton
                compact
                label="彻底删除"
                tone="danger"
                onPress={() => {
                  void (async () => {
                    try {
                      await purgeSnippet(item.id);
                      showToast("已彻底删除", "info");
                      await reload();
                    } catch (error) {
                      showToast(describeError(error), "danger");
                    }
                  })();
                }}
              />
            </View>
          )}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <ToolNote
              text={
                snippets.length === 0
                  ? "还没有片段。点右上角 + 新建，或从系统分享里选择「保存为代码片段」。"
                  : "没有匹配的片段，换个关键词或清除筛选。"
              }
            />
          }
          renderItem={({ item }) => (
            <View style={[styles.row, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`打开片段 ${item.title || "未命名片段"}`}
                accessibilityHint="长按可复制、分享、导出、发送或删除"
                onPress={() => openEdit(item)}
                onLongPress={() => setRowAction(item)}
                delayLongPress={350}
                style={({ pressed }) => [styles.rowBody, { opacity: pressed ? 0.75 : 1 }]}
              >
                <View style={styles.rowTitleLine}>
                  {item.pinned ? <AppIcon name="pin" size={14} color={tokens.accent} /> : null}
                  {item.favorite ? <AppIcon name="star" size={14} color={tokens.accent} /> : null}
                  <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>
                    {item.title || "未命名片段"}
                  </Text>
                </View>
                <Text style={[styles.rowMeta, { color: tokens.muted }]} numberOfLines={1}>
                  {languageLabel(item.language)}
                  {item.tags.length > 0 ? ` · #${item.tags.join(" #")}` : ""} · {formatDateTime(item.updatedAt)}
                </Text>
                <Text style={[styles.rowPreview, { color: tokens.textSoft }]} numberOfLines={2}>
                  {snippetSummary(item)}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="复制代码"
                onPress={() => void copyText(item.content, item.id)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={({ pressed }) => [styles.copyButton, { opacity: pressed ? 0.6 : 1 }]}
              >
                <AppIcon name="copy" size={20} color={tokens.textSoft} />
              </Pressable>
            </View>
          )}
        />
      )}

      <ActionSheet
        visible={rowAction !== null}
        title={rowAction ? rowAction.title || "未命名片段" : "片段操作"}
        subtitle={
          rowAction
            ? `${languageLabel(rowAction.language)} · ${formatDateTime(rowAction.updatedAt)}`
            : undefined
        }
        entityLabel="片段操作"
        actions={rowActions}
        onAction={(key) => {
          const target = rowAction;
          setRowAction(null);
          if (!target) return;
          if (key === "copy") void copyText(target.content, target.id);
          if (key === "edit") openEdit(target);
          if (key === "share") void shareSnippet(target);
          if (key === "export") void exportSnippet(target);
          if (key === "send") void sendSnippet(target);
          if (key === "favorite") void toggleField(target, "favorite");
          if (key === "pin") void toggleField(target, "pinned");
          if (key === "delete") setDeleteTarget(target);
        }}
        onRequestClose={() => setRowAction(null)}
      />

      <ActionSheet
        visible={deleteTarget !== null}
        title={deleteTarget ? `删除「${deleteTarget.title || "未命名片段"}」？` : "删除片段？"}
        subtitle="删除后可在回收站恢复"
        entityLabel="片段删除"
        actions={[
          { key: "cancel", label: "取消" },
          { key: "delete", label: "移到回收站", tone: "danger", icon: "delete" },
        ]}
        onAction={(key) => {
          if (key === "delete" && deleteTarget) void removeSnippet(deleteTarget);
          else setDeleteTarget(null);
        }}
        onRequestClose={() => setDeleteTarget(null)}
      />

      {sendState ? (
        <Text style={[styles.progressText, { color: tokens.textSoft }]}>
          发送到电脑 · {Math.round(sendState.value * 100)}%
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  searchWrap: { paddingHorizontal: space.lg, paddingBottom: space.xs },
  filterBar: { flexGrow: 0, paddingVertical: space.xs },
  chipRow: { gap: space.sm, paddingHorizontal: space.lg },
  listContent: { paddingHorizontal: space.lg, paddingTop: space.xs, gap: space.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowBody: { flex: 1, gap: 3 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: space.xs },
  rowTitle: { fontSize: font.title, fontWeight: "600", flexShrink: 1 },
  rowMeta: { fontSize: font.label },
  rowPreview: { fontSize: font.meta, lineHeight: 18 },
  copyButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  hint: { padding: space.section, fontSize: font.body, textAlign: "center" },
  errorWrap: { paddingHorizontal: space.lg, paddingTop: space.md },
  footerRow: { flexDirection: "row", gap: space.sm },
  footerPrimary: { flex: 1 },
  block: { gap: space.xs },
  blockLabel: { fontSize: font.label, fontWeight: "600" },
  toggleRow: { flexDirection: "row", gap: space.sm },
  actionRow: { flexDirection: "row", gap: space.sm },
  inlineAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    minHeight: 32,
    paddingHorizontal: space.xs,
  },
  inlineActionText: { fontSize: font.label, fontWeight: "600" },
  progressText: { fontSize: font.label, paddingHorizontal: space.lg },
});
