//! 世界观设定模块（A2/A3/A4）：地点 / 势力 / 事件 / 道具 / 能力规则 / 自定义，
//! 类型、名称、标签可查询筛选；设定可关联章节，解绑不删设定或章节。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui";
import type { CreativeModuleProps } from "../types";
import {
  novelWorldviewDelete,
  novelWorldviewList,
  novelWorldviewSave,
} from "./ipc";
import {
  WORLDVIEW_KIND_LABELS,
  type NovelWorldviewEntry,
  type WorldviewDraft,
  type WorldviewKind,
} from "./types";
import { ArchivedBanner, errorText, Field, LoadError, TagEditor } from "./shared";
import { RefSection } from "./RefSection";

const EMPTY_DRAFT: WorldviewDraft = {
  kind: "location",
  name: "",
  description: "",
  tags: [],
};

const KIND_OPTIONS: SelectOption<WorldviewKind>[] = (
  Object.keys(WORLDVIEW_KIND_LABELS) as WorldviewKind[]
).map((value) => ({ value, label: WORLDVIEW_KIND_LABELS[value] }));

const KIND_FILTERS: Array<{ value: WorldviewKind | ""; label: string }> = [
  { value: "", label: "全部" },
  ...KIND_OPTIONS.map((option) => ({ value: option.value as WorldviewKind | "", label: option.label })),
];

export function WorldviewPanel({ projectId, archived, onNotice }: CreativeModuleProps) {
  const [entries, setEntries] = useState<NovelWorldviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<WorldviewKind | "">("");
  const [search, setSearch] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorldviewDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const seqRef = useRef(0);

  const loadEntries = useCallback(async () => {
    const token = ++seqRef.current;
    setLoading(true);
    try {
      const result = await novelWorldviewList(projectId, kindFilter || null);
      if (token !== seqRef.current) return;
      setEntries(result.entries ?? []);
      setLoadError(null);
    } catch (error) {
      if (token !== seqRef.current) return;
      setLoadError(errorText(error));
    } finally {
      if (token === seqRef.current) setLoading(false);
    }
  }, [projectId, kindFilter]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  function selectEntry(entry: NovelWorldviewEntry) {
    setSelectedId(entry.id);
    setDraft({
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
      tags: entry.tags,
    });
    setSaveError(null);
    setDeleteArmed(false);
  }

  function startNew() {
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDeleteArmed(false);
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(query)),
    );
  }, [entries, search]);

  async function saveEntry() {
    if (archived || saving) return;
    if (!draft.name.trim()) {
      setSaveError("设定名称不能为空");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await novelWorldviewSave(projectId, draft, selectedId);
      onNotice("ok", selectedId ? "设定已更新" : `已新建设定「${result.entry.name}」`);
      await loadEntries();
      selectEntry(result.entry);
    } catch (error) {
      setSaveError(errorText(error));
      onNotice("error", `保存设定失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeEntry() {
    if (!selectedId || archived || saving) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setSaving(true);
    try {
      await novelWorldviewDelete(selectedId);
      onNotice("ok", "设定已删除");
      startNew();
      await loadEntries();
    } catch (error) {
      onNotice("error", `删除设定失败：${errorText(error)}`);
    } finally {
      setSaving(false);
      setDeleteArmed(false);
    }
  }

  const selected = entries.find((entry) => entry.id === selectedId) ?? null;

  return (
    <div className="novel-layout">
      <aside className="novel-pane novel-pane-list" aria-label="世界观列表">
        <div className="novel-toolbar">
          <input
            type="search"
            className="novel-input"
            placeholder="搜索名称 / 描述 / 标签"
            aria-label="搜索设定"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="novel-btn"
            disabled={archived}
            onClick={startNew}
          >
            新建设定
          </button>
        </div>
        <div className="novel-kind-filters" role="tablist" aria-label="按类型筛选">
          {KIND_FILTERS.map((filter) => (
            <button
              key={filter.value || "all"}
              type="button"
              role="tab"
              aria-selected={kindFilter === filter.value}
              className={`novel-kind-chip${kindFilter === filter.value ? " is-active" : ""}`}
              onClick={() => setKindFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {loadError && <LoadError message={loadError} onRetry={() => void loadEntries()} />}
        {loading && !loadError && <p className="novel-empty-hint">加载中…</p>}

        <ul className="novel-list">
          {filtered.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={`novel-list-row${entry.id === selectedId ? " is-active" : ""}`}
                onClick={() => selectEntry(entry)}
              >
                <span className="novel-row-name">{entry.name}</span>
                <span className="novel-row-meta">
                  {WORLDVIEW_KIND_LABELS[entry.kind]}
                  {entry.tags.length > 0 ? ` · ${entry.tags.join("、")}` : ""}
                </span>
              </button>
            </li>
          ))}
          {!loading && filtered.length === 0 && !loadError && (
            <li className="novel-empty-hint">暂无设定，点击「新建设定」开始。</li>
          )}
        </ul>
      </aside>

      <div className="novel-pane novel-pane-detail">
        {archived && <ArchivedBanner />}

        {!selected && !loading && (
          <p className="novel-empty-hint">从左侧选择设定，或新建设定。</p>
        )}

        {selected && (
          <>
            <div className="novel-form">
              <Field label="类型">
                <Select
                  value={draft.kind}
                  options={KIND_OPTIONS}
                  onChange={(value) => setDraft({ ...draft, kind: value })}
                  ariaLabel="设定类型"
                  disabled={archived || saving}
                />
              </Field>
              <Field label="名称" htmlFor="novel-world-name">
                <input
                  id="novel-world-name"
                  type="text"
                  className="novel-input"
                  disabled={archived || saving}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="描述" htmlFor="novel-world-desc">
                <textarea
                  id="novel-world-desc"
                  className="novel-textarea"
                  disabled={archived || saving}
                  rows={6}
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </Field>
              <Field label="标签">
                <TagEditor
                  tags={draft.tags}
                  disabled={archived || saving}
                  onChange={(tags) => setDraft({ ...draft, tags })}
                />
              </Field>

              {saveError && (
                <p className="novel-inline-error" role="alert">
                  {saveError}
                </p>
              )}

              <div className="novel-form-actions">
                <button
                  type="button"
                  className="novel-btn"
                  disabled={archived || saving}
                  onClick={() => void saveEntry()}
                >
                  {saving ? "保存中…" : "保存设定"}
                </button>
                <button
                  type="button"
                  className={`novel-btn-ghost${deleteArmed ? " is-danger" : ""}`}
                  disabled={archived || saving}
                  onClick={() => void removeEntry()}
                >
                  {deleteArmed ? "再次点击确认删除" : "删除设定"}
                </button>
              </div>
            </div>

            <RefSection
              projectId={projectId}
              entityType="worldview"
              entityId={selectedId}
              disabled={archived}
              onNotice={onNotice}
            />
          </>
        )}
      </div>
    </div>
  );
}
