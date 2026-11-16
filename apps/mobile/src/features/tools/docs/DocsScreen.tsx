// 项目资料速览：保存常用文档链接与本地文件，收藏、最近查阅、分类搜索与简易预览。
//
// 真实性边界：
// - 在线链接只保存地址，点击用系统浏览器/系统应用打开（不镜像内容、不声称已同步）；
// - 本机文件的 storage=local 且 url 是 file://，Markdown/TXT 在应用内预览，
//   PDF/Office 交给系统「用其他应用打开」（分享面板即系统 Intent，不伪造阅读器）；
// - 桌面端项目资料没有可靠的移动端同步通道，本页不会显示「已同步」。
import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ActionSheet, type SheetAction } from "../../../components/ActionSheet";
import { AppBar } from "../../../components/AppBar";
import { BottomSheet } from "../../../components/BottomSheet";
import { Chip } from "../../../components/Chip";
import { AppIcon } from "../../../components/icons/AppIcon";
import { SearchField } from "../../../components/SearchField";
import { useToast } from "../../../feedback/ToastProvider";
import {
  createResource,
  deleteResource,
  listResourceCategories,
  listResources,
  touchResourceOpen,
  updateResource,
  type ResourceStorage,
  type ToolResource,
} from "../../../db/toolResources";
import { listTasks } from "../../../db/tasks";
import { listNotes } from "../../../db/notes";
import { recordToolUse } from "../../../db/toolUsage";
import { describeError } from "../../../lib/errors";
import { pickLocalFiles } from "../../../lib/sync/fileIo";
import { formatDateTime } from "../../../lib/format";
import { useWindowInsets } from "../../../lib/insets";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, radius, space } from "../../../theme/tokens";
import {
  readTextFile,
  shareOutFile,
  shareOutText,
  writeClipboard,
} from "../shared/nativeTools";
import { takeLinkDraft } from "../shareIntake";
import { ToolButton, ToolField, ToolNote } from "../shared/ToolUI";

const TOOL_ID = "tool.docs";

export function DocsScreen({ onBack }: { onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();
  const insets = useWindowInsets();

  const [items, setItems] = useState<ToolResource[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [actionTarget, setActionTarget] = useState<ToolResource | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ToolResource | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ToolResource | null>(null);
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null);

  const [form, setForm] = useState({
    title: "",
    url: "",
    category: "",
    note: "",
    storage: "online" as ResourceStorage,
    linkedKind: null as "task" | "note" | null,
    linkedId: null as string | null,
  });
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  /** 已有关联对象的标题：只用于详情展示，不写进资源表 */
  const [linkTitles, setLinkTitles] = useState<Record<string, string>>({});
  const [linkOptions, setLinkOptions] = useState<{
    tasks: { id: string; title: string }[];
    notes: { id: string; title: string }[];
  }>({ tasks: [], notes: [] });

  useEffect(() => {
    void recordToolUse(TOOL_ID);
    void reload();
    void loadLinkOptions();
  }, []);

  async function loadLinkOptions() {
    try {
      const [tasks, notes] = await Promise.all([listTasks(), listNotes()]);
      const taskOptions = tasks
        .filter((task) => task.status !== "completed")
        .slice(0, 40)
        .map((task) => ({ id: task.id, title: task.title || "未命名任务" }));
      const noteOptions = notes
        .slice(0, 40)
        .map((note) => ({ id: note.id, title: note.title || "未命名笔记" }));
      setLinkOptions({ tasks: taskOptions, notes: noteOptions });
      setLinkTitles(
        Object.fromEntries([
          ...taskOptions.map((item) => [`task:${item.id}`, item.title] as const),
          ...noteOptions.map((item) => [`note:${item.id}`, item.title] as const),
        ]),
      );
    } catch {
      // 关联是可选信息：读取任务/笔记失败不阻塞资料页本身
    }
  }

  useEffect(() => {
    const draft = takeLinkDraft();
    if (!draft) return;
    setEditing(null);
    setForm({ title: draft.title ?? "", url: draft.url, category: "", note: "", storage: "online", linkedKind: null, linkedId: null });
    setEditOpen(true);
  }, []);

  async function reload() {
    try {
      const [list, cats] = await Promise.all([listResources("doc"), listResourceCategories("doc")]);
      setItems(list);
      setCategories(cats);
    } catch (error) {
      showToast(`读取资料失败：${describeError(error)}`, "danger");
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (favoriteOnly && !item.favorite) return false;
      if (category && item.category !== category) return false;
      if (!keyword) return true;
      return `${item.title} ${item.category} ${item.note} ${item.url}`.toLowerCase().includes(keyword);
    });
  }, [category, favoriteOnly, items, query]);

  const openForm = (resource?: ToolResource) => {
    setEditing(resource ?? null);
    setFormError("");
    setForm(
      resource
        ? {
            title: resource.title,
            url: resource.url,
            category: resource.category,
            note: resource.note,
            storage: resource.storage,
            linkedKind: (resource.linkedKind === "task" || resource.linkedKind === "note" ? resource.linkedKind : null),
            linkedId: resource.linkedId,
          }
        : {
            title: "",
            url: "",
            category: "",
            note: "",
            storage: "online",
            linkedKind: null,
            linkedId: null,
          },
    );
    setEditOpen(true);
  };

  const pickLocal = async () => {
    try {
      const files = await pickLocalFiles();
      const file = files[0];
      if (!file) return;
      setForm((current) => ({
        ...current,
        title: current.title || (file.name ?? "本机文档"),
        url: file.uri,
        storage: "local",
      }));
      setFormError("");
    } catch (error) {
      showToast(`选择文件失败：${describeError(error)}`, "danger");
    }
  };

  const submit = async () => {
    if (saving) return;
    const title = form.title.trim();
    if (!title) {
      setFormError("请填写标题");
      return;
    }
    if (!form.url.trim()) {
      setFormError("请填写链接或选择本机文件");
      return;
    }
    if (form.storage === "online" && !/^https?:\/\//i.test(form.url)) {
      setFormError("在线资料只接受 http/https 链接；本机文件请切换为「本机」");
      return;
    }
    if (form.storage === "local" && !form.url.startsWith("file://")) {
      setFormError("本机资料需要选择应用可读的文件");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateResource(editing.id, {
          title,
          url: form.url.trim(),
          category: form.category.trim(),
          note: form.note.trim(),
          storage: form.storage,
          linkedKind: form.linkedKind,
          linkedId: form.linkedId,
        });
      } else {
        await createResource({
          kind: "doc",
          title,
          url: form.url.trim(),
          category: form.category.trim(),
          note: form.note.trim(),
          storage: form.storage,
          linkedKind: form.linkedKind,
          linkedId: form.linkedId,
        });
      }
      setEditOpen(false);
      await reload();
      showToast(editing ? "资料已更新" : "资料已保存", "success");
    } catch (error) {
      setFormError(`保存失败：${describeError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const openResource = async (resource: ToolResource) => {
    try {
      if (resource.storage === "online") {
        await Linking.openURL(resource.url);
      } else if (isTextFile(resource.url)) {
        const text = await readTextFile(resource.url, 2_000_000);
        setPreview({ title: resource.title, text });
      } else {
        await shareOutFile(resource.url, guessMime(resource.url), resource.title);
      }
      await touchResourceOpen(resource.id);
      await reload();
    } catch (error) {
      showToast(`打开失败：${describeError(error)}`, "danger");
    }
  };

  const toggleFavorite = async (resource: ToolResource) => {
    try {
      await updateResource(resource.id, { favorite: !resource.favorite });
      await reload();
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const copyLink = async (resource: ToolResource) => {
    try {
      await writeClipboard(resource.url);
      showToast("链接已复制", "success");
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const remove = async (resource: ToolResource) => {
    try {
      await deleteResource(resource.id);
      setDeleteTarget(null);
      await reload();
      showToast("已删除", "success");
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const actions: SheetAction[] = actionTarget
    ? [
        { key: "open", label: "打开", icon: "external" },
        { key: "favorite", label: actionTarget.favorite ? "取消收藏" : "收藏", icon: "star" },
        { key: "copy", label: "复制链接", icon: "copy" },
        { key: "share", label: "系统分享", icon: "share" },
        { key: "edit", label: "编辑", icon: "edit" },
        { key: "delete", label: "删除", tone: "danger", icon: "delete" },
      ]
    : [];

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <AppBar
        title="项目资料"
        onBack={onBack}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="新增资料"
            onPress={() => openForm()}
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
          placeholder="搜索标题、分类、备注或链接"
          accessibilityLabel="搜索项目资料"
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow} style={styles.filterBar}>
        <Chip label="全部" active={!category && !favoriteOnly} onPress={() => { setCategory(null); setFavoriteOnly(false); }} variant="soft" />
        <Chip label="收藏" active={favoriteOnly} onPress={() => setFavoriteOnly((value) => !value)} variant="soft" />
        {categories.map((item) => (
          <Chip
            key={item}
            label={item}
            active={category === item}
            onPress={() => setCategory((current) => (current === item ? null : item))}
            variant="soft"
          />
        ))}
      </ScrollView>

      <ScrollView contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        {loading ? (
          <Text style={[styles.hint, { color: tokens.muted }]}>正在读取本机资料…</Text>
        ) : filtered.length === 0 ? (
          <ToolNote
            text={
              items.length === 0
                ? "还没有资料。点右上角 + 添加链接或本机文件；也可以从系统分享「保存为项目资料」进入。"
                : "没有匹配的资料，换个关键词或清除筛选。"
            }
          />
        ) : (
          filtered.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`打开 ${item.title}`}
              accessibilityHint="长按可收藏、复制链接、编辑或删除"
              onPress={() => void openResource(item)}
              onLongPress={() => setActionTarget(item)}
              delayLongPress={350}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: tokens.card, borderColor: tokens.cardBorder, opacity: pressed ? 0.75 : 1 },
              ]}
            >
              <View style={[styles.rowIcon, { backgroundColor: tokens.tileBase, borderColor: tokens.tileBorder }]}>
                <AppIcon name={item.storage === "local" ? "fileDoc" : "link"} size={20} color={tokens.accent} />
              </View>
              <View style={styles.rowBody}>
                <View style={styles.rowTitleLine}>
                  {item.favorite ? <AppIcon name="star" size={14} color={tokens.accent} /> : null}
                  <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>
                    {item.title}
                  </Text>
                </View>
                <Text style={[styles.rowMeta, { color: tokens.muted }]} numberOfLines={1}>
                  {item.storage === "local" ? "本机文件" : "在线链接"}
                  {item.category ? ` · ${item.category}` : ""}
                  {item.lastOpenedAt ? ` · 最近 ${formatDateTime(item.lastOpenedAt)}` : ""}
                </Text>
                {item.note ? (
                  <Text style={[styles.rowNote, { color: tokens.textSoft }]} numberOfLines={2}>
                    {item.note}
                  </Text>
                ) : null}
                {item.linkedKind && item.linkedId ? (
                  <Text style={[styles.rowLink, { color: tokens.accentText }]} numberOfLines={1}>
                    关联{item.linkedKind === "task" ? "任务" : "笔记"}：
                    {linkTitles[`${item.linkedKind}:${item.linkedId}`] ?? item.linkedId}
                  </Text>
                ) : null}
              </View>
              <AppIcon name="chevronRight" size={18} color={tokens.muted} />
            </Pressable>
          ))
        )}
        <ToolNote text="在线资料只保存链接；本机文件只保存在手机。桌面端项目资料尚未接入移动端同步，本页不会显示「已同步」。" />
      </ScrollView>

      <ActionSheet
        visible={actionTarget !== null}
        title={actionTarget?.title ?? "资料"}
        subtitle={actionTarget?.url}
        entityLabel="资料操作"
        actions={actions}
        onAction={(key) => {
          const target = actionTarget;
          setActionTarget(null);
          if (!target) return;
          if (key === "open") void openResource(target);
          if (key === "favorite") void toggleFavorite(target);
          if (key === "copy") void copyLink(target);
          if (key === "share") void shareOutText(`${target.title}\n${target.url}`, target.title);
          if (key === "edit") openForm(target);
          if (key === "delete") setDeleteTarget(target);
        }}
        onRequestClose={() => setActionTarget(null)}
      />

      <ActionSheet
        visible={deleteTarget !== null}
        title={deleteTarget ? `删除「${deleteTarget.title}」？` : "删除资料？"}
        subtitle="只删除本机记录，不会删除磁盘上的原文件"
        entityLabel="资料删除"
        actions={[
          { key: "cancel", label: "取消" },
          { key: "delete", label: "删除", tone: "danger", icon: "delete" },
        ]}
        onAction={(key) => {
          if (key === "delete" && deleteTarget) void remove(deleteTarget);
          else setDeleteTarget(null);
        }}
        onRequestClose={() => setDeleteTarget(null)}
      />

      <BottomSheet visible={editOpen} onRequestClose={() => setEditOpen(false)} accessibilityLabel="编辑资料" keyboardAware maxHeightRatio={0.9}>
        <View style={styles.sheetBody}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>{editing ? "编辑资料" : "新增资料"}</Text>
          <ToolField label="标题" value={form.title} onChangeText={(title) => setForm((current) => ({ ...current, title }))} placeholder="例如 接口设计文档" maxLength={100} />
          <ToolField label="链接 / 文件" value={form.url} onChangeText={(url) => setForm((current) => ({ ...current, url }))} placeholder="https://… 或选择本机文件" autoCapitalize="none" />
          <View style={styles.storageRow}>
            <Chip label="在线链接" active={form.storage === "online"} onPress={() => setForm((current) => ({ ...current, storage: "online" }))} variant="soft" />
            <Chip label="本机文件" active={form.storage === "local"} onPress={() => setForm((current) => ({ ...current, storage: "local" }))} variant="soft" />
            <ToolButton compact label="选择文件" icon="folderOpen" onPress={() => void pickLocal()} />
          </View>
          <ToolField label="分类" value={form.category} onChangeText={(category) => setForm((current) => ({ ...current, category }))} placeholder="例如 接口 / 设计 / 部署" maxLength={40} />
          <ToolField label="备注" value={form.note} onChangeText={(note) => setForm((current) => ({ ...current, note }))} placeholder="可选" multiline minHeight={72} maxLength={500} />
          <View style={styles.linkRow}>
            <View style={styles.linkText}>
              <Text style={[styles.linkLabel, { color: tokens.textSoft }]}>关联任务 / 笔记</Text>
              <Text style={[styles.linkValue, { color: tokens.muted }]} numberOfLines={1}>
                {form.linkedKind && form.linkedId
                  ? `${form.linkedKind === "task" ? "任务" : "笔记"}：${linkTitles[`${form.linkedKind}:${form.linkedId}`] ?? form.linkedId}`
                  : "未关联（可选）"}
              </Text>
            </View>
            <ToolButton compact label="选择" icon="link" onPress={() => setLinkOpen(true)} />
          </View>
          {formError ? <ToolNote text={formError} tone="warn" /> : null}
          <View style={styles.actionRow}>
            <ToolButton label={saving ? "保存中…" : "保存"} tone="primary" icon="check" disabled={saving} onPress={() => void submit()} />
            <ToolButton label="取消" onPress={() => setEditOpen(false)} />
          </View>
        </View>
      </BottomSheet>

      <BottomSheet visible={linkOpen} onRequestClose={() => setLinkOpen(false)} accessibilityLabel="关联任务或笔记" maxHeightRatio={0.85}>
        <View style={styles.sheetBody}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>关联任务或笔记</Text>
          <Text style={[styles.sheetHint, { color: tokens.muted }]}>
            只保存本地 id，不复制任务/笔记内容，也不参与同步。
          </Text>
          <ToolButton
            compact
            label="不关联"
            icon="unlink"
            onPress={() => {
              setForm((current) => ({ ...current, linkedKind: null, linkedId: null }));
              setLinkOpen(false);
            }}
          />
          {linkOptions.tasks.length === 0 && linkOptions.notes.length === 0 ? (
            <ToolNote text="本机还没有未完成任务或笔记，可先去创建。" />
          ) : (
            <ScrollView style={styles.linkList} keyboardShouldPersistTaps="handled">
              {linkOptions.tasks.length > 0 ? (
                <Text style={[styles.linkGroup, { color: tokens.muted }]}>未完成任务</Text>
              ) : null}
              {linkOptions.tasks.map((task) => (
                <Pressable
                  key={`task:${task.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`关联任务 ${task.title}`}
                  onPress={() => {
                    setForm((current) => ({ ...current, linkedKind: "task", linkedId: task.id }));
                    setLinkOpen(false);
                  }}
                  style={({ pressed }) => [styles.linkOption, { borderColor: tokens.separator, opacity: pressed ? 0.65 : 1 }]}
                >
                  <AppIcon name="tasks" size={16} color={tokens.accent} />
                  <Text style={[styles.linkOptionText, { color: tokens.text }]} numberOfLines={1}>
                    {task.title}
                  </Text>
                </Pressable>
              ))}
              {linkOptions.notes.length > 0 ? (
                <Text style={[styles.linkGroup, { color: tokens.muted }]}>笔记</Text>
              ) : null}
              {linkOptions.notes.map((note) => (
                <Pressable
                  key={`note:${note.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`关联笔记 ${note.title}`}
                  onPress={() => {
                    setForm((current) => ({ ...current, linkedKind: "note", linkedId: note.id }));
                    setLinkOpen(false);
                  }}
                  style={({ pressed }) => [styles.linkOption, { borderColor: tokens.separator, opacity: pressed ? 0.65 : 1 }]}
                >
                  <AppIcon name="note" size={16} color={tokens.accent} />
                  <Text style={[styles.linkOptionText, { color: tokens.text }]} numberOfLines={1}>
                    {note.title}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          <ToolButton label="关闭" onPress={() => setLinkOpen(false)} />
        </View>
      </BottomSheet>

      <BottomSheet visible={preview !== null} onRequestClose={() => setPreview(null)} accessibilityLabel="文档预览" maxHeightRatio={0.9}>        <View style={styles.sheetBody}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]} numberOfLines={2}>
            {preview?.title}
          </Text>
          <ScrollView style={[styles.previewBox, { borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}>
            {(preview?.text ?? "").split(/\r\n|\r|\n/).map((line, index) => {
              const heading = /^(#{1,6})\s/.exec(line);
              return (
                <Text
                  key={index}
                  selectable
                  style={[
                    styles.previewLine,
                    { color: tokens.text },
                    heading ? { fontWeight: "700", fontSize: heading[1].length <= 2 ? font.section : font.body } : null,
                  ]}
                >
                  {heading ? line.replace(/^#{1,6}\s/, "") : line || " "}
                </Text>
              );
            })}
          </ScrollView>
          <Text style={[styles.sheetHint, { color: tokens.muted }]}>
            简易预览：仅按行显示标题与正文；完整排版请用系统应用打开。
          </Text>
          <View style={styles.actionRow}>
            <ToolButton label="复制全文" icon="copy" onPress={() => void writeClipboard(preview?.text ?? "")} />
            <ToolButton label="关闭" onPress={() => setPreview(null)} />
          </View>
        </View>
      </BottomSheet>
    </View>
  );
}

function isTextFile(uri: string): boolean {
  return /\.(md|markdown|txt|log|json)$/i.test(uri.split("?")[0]);
}

function guessMime(uri: string): string {
  const ext = uri.split("?")[0].toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "doc" || ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "xls" || ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === "ppt" || ext === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  searchWrap: { paddingHorizontal: space.lg, paddingBottom: space.xs },
  filterBar: { flexGrow: 0, paddingVertical: space.xs },
  chipRow: { gap: space.sm, paddingHorizontal: space.lg },
  list: { paddingHorizontal: space.lg, paddingTop: space.xs, gap: space.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.tile,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1, gap: 2, minWidth: 0 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: space.xs },
  rowTitle: { fontSize: font.meta, fontWeight: "600", flexShrink: 1 },
  rowMeta: { fontSize: font.label },
  rowNote: { fontSize: font.label, lineHeight: 17 },
  rowLink: { fontSize: font.label, lineHeight: 17 },
  hint: { fontSize: font.meta, textAlign: "center", paddingVertical: space.xl },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  storageRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  sheetBody: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm },
  sheetTitle: { fontSize: font.section, fontWeight: "700" },
  sheetHint: { fontSize: font.label, lineHeight: 18 },
  previewBox: { maxHeight: 360, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, padding: space.md },
  previewLine: { fontSize: font.meta, lineHeight: 21 },
  linkRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  linkText: { flex: 1, gap: 2, minWidth: 0 },
  linkLabel: { fontSize: font.label, fontWeight: "600" },
  linkValue: { fontSize: font.label },
  linkList: { maxHeight: 320 },
  linkGroup: { fontSize: font.label, fontWeight: "700", paddingTop: space.sm, paddingBottom: space.xs },
  linkOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  linkOptionText: { flex: 1, fontSize: font.meta },
});
