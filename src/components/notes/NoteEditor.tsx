//! 单条笔记编辑器：标题 / 正文 / 保存状态 / 置顶收藏 / 模板 / 关联 / 删除。
//!
//! 保存状态四态（编辑中 / 保存中 / 已保存 / 保存失败）由 store 驱动；
//! 本组件只负责展示与触发，不直接调用 IPC。
//! 所有可见文案走 `notes.*` 词条，数字与时间用本地化格式化，不硬编码中文。

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AlertCircle,
  Check,
  Link2,
  Loader2,
  Monitor,
  Pin,
  RefreshCw,
  Save,
  Star,
  Trash2,
  Undo2,
} from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import { formatLocalizedNumber, formatLocalizedRelative } from "../../i18n/format";
import { Select, type SelectOption } from "../ui";
import {
  useNotesStore,
  type SaveState,
} from "../../store/useNotesStore";

const MAX_TITLE = 200;
const MAX_CONTENT = 200_000;

function SaveIndicator({ state, text }: { state: SaveState; text: string }) {
  const icon =
    state === "saving" ? (
      <Loader2 size={12} className="notes-spin" aria-hidden="true" />
    ) : state === "saved" ? (
      <Check size={12} aria-hidden="true" />
    ) : state === "failed" ? (
      <AlertCircle size={12} aria-hidden="true" />
    ) : (
      <Save size={12} aria-hidden="true" />
    );
  return (
    <span className={`notes-save-state is-${state}`} role="status" aria-live="polite">
      {icon}
      {text}
    </span>
  );
}

export default function NoteEditor() {
  const { t } = useLocale();
  const active = useNotesStore((s) => s.active);
  const draft = useNotesStore((s) => s.draft);
  const saveState = useNotesStore((s) => s.saveState);
  const saveError = useNotesStore((s) => s.saveError);
  const savedAt = useNotesStore((s) => s.savedAt);
  const conflict = useNotesStore((s) => s.conflict);
  const restored = useNotesStore((s) => s.restored);
  const templates = useNotesStore((s) => s.templates);
  const linkOptions = useNotesStore((s) => s.linkOptions);
  const linkOptionsLoading = useNotesStore((s) => s.linkOptionsLoading);

  const updateDraft = useNotesStore((s) => s.updateDraft);
  const flushSave = useNotesStore((s) => s.flushSave);
  const retrySave = useNotesStore((s) => s.retrySave);
  const reloadFromServer = useNotesStore((s) => s.reloadFromServer);
  const togglePin = useNotesStore((s) => s.togglePin);
  const toggleFavorite = useNotesStore((s) => s.toggleFavorite);
  const linkTask = useNotesStore((s) => s.linkTask);
  const linkWorkspace = useNotesStore((s) => s.linkWorkspace);
  const applyTemplate = useNotesStore((s) => s.applyTemplate);
  const remove = useNotesStore((s) => s.remove);

  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setConfirmDelete(false);
  }, [active?.id]);

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  if (!active || !draft) return null;

  const savedLabel = savedAt ? formatLocalizedRelative(savedAt) : "";
  const statusText =
    saveState === "saving"
      ? t("notes.save.saving")
      : saveState === "failed"
        ? conflict
          ? t("notes.save.failedConflict")
          : t("notes.save.failed", { error: saveError ?? t("notes.unknownError") })
        : saveState === "editing"
          ? t("notes.save.editing")
          : savedLabel
            ? t("notes.save.savedWithTime", { time: savedLabel })
            : t("notes.save.saved");

  const contentChars = draft.content.length;
  const contentTooLong = contentChars > MAX_CONTENT;
  const localizeCount = (value: number) => formatLocalizedNumber(value);

  const taskOptions: SelectOption<string>[] = [
    { value: "", label: t("notes.link.noneTask") },
    ...linkOptions.tasks.map((task) => ({
      value: task.id,
      label: task.title || t("notes.link.unnamedTask"),
    })),
  ];
  const workspaceOptions: SelectOption<string>[] = [
    { value: "", label: t("notes.link.noneWorkspace") },
    ...linkOptions.workspaces.map((item) => ({
      value: item.id,
      label: item.name || t("notes.link.unnamedWorkspace"),
    })),
  ];
  const templateOptions: SelectOption<string>[] = templates.map((item) => ({
    value: item.id,
    label: item.name,
  }));

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void flushSave();
    }
  };

  const onDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    try {
      await remove(active.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useNotesStore.setState({ saveError: message, saveState: "failed" });
    }
  };

  return (
    <div className="notes-editor" onKeyDown={onKeyDown}>
      <header className="notes-editor-head">
        <input
          className="notes-title-input"
          value={draft.title}
          maxLength={MAX_TITLE}
          placeholder={t("notes.untitled")}
          aria-label={t("notes.editor.titleAria")}
          onChange={(e) => updateDraft({ title: e.target.value })}
        />
        <div className="notes-editor-actions">
          <button
            type="button"
            className={`icon-btn sm ${active.pinned ? "active" : ""}`}
            data-tip={active.pinned ? t("notes.editor.unpin") : t("notes.editor.pin")}
            aria-label={active.pinned ? t("notes.editor.unpin") : t("notes.editor.pin")}
            aria-pressed={active.pinned}
            onClick={() => void togglePin().catch(() => undefined)}
          >
            <Pin size={14} />
          </button>
          <button
            type="button"
            className={`icon-btn sm ${active.favorite ? "active" : ""}`}
            data-tip={
              active.favorite ? t("notes.editor.unfavorite") : t("notes.editor.favorite")
            }
            aria-label={
              active.favorite ? t("notes.editor.unfavorite") : t("notes.editor.favorite")
            }
            aria-pressed={active.favorite}
            onClick={() => void toggleFavorite().catch(() => undefined)}
          >
            <Star size={14} />
          </button>
          <Select
            value=""
            options={templateOptions}
            onChange={(id) => applyTemplate(id)}
            placeholder={t("notes.editor.templatePlaceholder")}
            ariaLabel={t("notes.editor.templateAria")}
            size="sm"
            disabled={templateOptions.length === 0}
            triggerClassName="notes-template-select"
          />
          <button
            type="button"
            className={`icon-btn sm notes-danger ${confirmDelete ? "is-confirming" : ""}`}
            data-tip={confirmDelete ? t("notes.editor.deleteAgain") : t("notes.editor.delete")}
            aria-label={
              confirmDelete ? t("notes.editor.confirmDelete") : t("notes.editor.delete")
            }
            onClick={() => void onDelete()}
          >
            {confirmDelete ? (
              <span className="notes-confirm-text">{t("notes.editor.confirm")}</span>
            ) : (
              <Trash2 size={14} />
            )}
          </button>
        </div>
      </header>

      <div className="notes-meta-row">
        <SaveIndicator state={saveState} text={statusText} />
        {saveState === "failed" &&
          (conflict ? (
            <>
              <button
                type="button"
                className="btn sm notes-retry-btn"
                data-tip={t("notes.save.discardLocalTip")}
                onClick={() => void reloadFromServer()}
              >
                <RefreshCw size={12} /> {t("notes.save.discardLocal")}
              </button>
              <button
                type="button"
                className="btn sm notes-retry-btn notes-danger"
                data-tip={t("notes.save.overwriteTip")}
                onClick={() => void retrySave(true)}
              >
                <Undo2 size={12} /> {t("notes.save.overwrite")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn sm notes-retry-btn"
              onClick={() => void retrySave(false)}
            >
              {t("notes.save.retry")}
            </button>
          ))}
        <span className="notes-char-count" aria-hidden="true">
          {t("notes.save.charCount", {
            count: localizeCount(contentChars),
            max: localizeCount(MAX_CONTENT),
          })}
        </span>
      </div>

      {restored && (
        <div className="notes-restored" role="status">
          {t("notes.restored")}
        </div>
      )}

      {contentTooLong && (
        <div className="notes-error" role="alert">
          {t("notes.save.tooLong", { max: localizeCount(MAX_CONTENT) })}
        </div>
      )}

      <div className="notes-link-row">
        <label className="notes-link-field">
          <span>
            <Link2 size={12} aria-hidden="true" /> {t("notes.link.task")}
          </span>
          <Select
            value={active.task_id ?? ""}
            options={taskOptions}
            onChange={(id) => void linkTask(id || null).catch(() => undefined)}
            placeholder={
              linkOptionsLoading ? t("notes.loading") : t("notes.link.noneTask")
            }
            ariaLabel={t("notes.link.task")}
            size="sm"
            disabled={linkOptionsLoading}
            block
          />
        </label>
        <label className="notes-link-field">
          <span>
            <Monitor size={12} aria-hidden="true" /> {t("notes.link.workspace")}
          </span>
          <Select
            value={active.workspace_id ?? ""}
            options={workspaceOptions}
            onChange={(id) => void linkWorkspace(id || null).catch(() => undefined)}
            placeholder={
              linkOptionsLoading ? t("notes.loading") : t("notes.link.noneWorkspace")
            }
            ariaLabel={t("notes.link.workspaceAria")}
            size="sm"
            disabled={linkOptionsLoading}
            block
          />
        </label>
      </div>

      <textarea
        className="notes-content-input"
        value={draft.content}
        placeholder={t("notes.contentPlaceholder")}
        aria-label={t("notes.contentAria")}
        spellCheck={false}
        onChange={(e) => updateDraft({ content: e.target.value })}
      />
    </div>
  );
}
