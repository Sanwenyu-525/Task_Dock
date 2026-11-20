//! 世界观设定模块（A2/A3/A4）：地点 / 势力 / 事件 / 道具 / 能力规则 / 自定义，
//! 类型、名称、标签可查询筛选；设定可关联章节，解绑不删设定或章节。

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Select, type SelectOption } from "../../../components/ui";
import WorkspaceSplit from "../../WorkspaceSplit";
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
import { ArchivedBanner, errorText, Field, FormSection, LoadError, TagEditor } from "./shared";
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
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<WorldviewDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const seqRef = useRef(0);
  const detailRef = useRef<HTMLDivElement>(null);

  // 切换设定或新建时回到表单顶部，避免继承上一条的滚动位置。
  useEffect(() => {
    detailRef.current?.scrollTo?.({ top: 0 });
  }, [selectedId, creating]);

  const loadEntries = useCallback(async () => {
    const token = ++seqRef.current;
    setLoading(true);
    try {
      const result = await novelWorldviewList(
        projectId,
        kindFilter || null,
        search.trim() || null,
      );
      if (token !== seqRef.current) return;
      setEntries(result.entries ?? []);
      setLoadError(null);
    } catch (error) {
      if (token !== seqRef.current) return;
      setLoadError(errorText(error));
    } finally {
      if (token === seqRef.current) setLoading(false);
    }
  }, [projectId, kindFilter, search]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  function selectEntry(entry: NovelWorldviewEntry) {
    setCreating(false);
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

  function resetDetail(openForCreate: boolean) {
    setSelectedId(null);
    setCreating(openForCreate);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setDeleteArmed(false);
  }

  function startNew() {
    resetDetail(true);
  }

  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const editorOpen = creating || selected !== null;

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
      resetDetail(false);
      await loadEntries();
    } catch (error) {
      onNotice("error", `删除设定失败：${errorText(error)}`);
    } finally {
      setSaving(false);
      setDeleteArmed(false);
    }
  }

  return (
    <div className="novel-split-root">
      <WorkspaceSplit
        id="novel-worldview"
        sidebarLabel="世界观列表"
        defaultWidth={280}
        minWidth={220}
        maxWidth={360}
        sidebar={
          <div className="novel-sidebar">
            <div className="novel-sidebar-head">
              <span className="novel-eyebrow">设定</span>
              <strong>世界观</strong>
              <span className="novel-count">{entries.length} 条</span>
            </div>
            <div className="novel-toolbar">
              <input
                type="search"
                className="novel-input novel-search"
                placeholder="搜索名称 / 描述 / 标签"
                aria-label="搜索设定"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button
                type="button"
                className="novel-btn novel-new-btn"
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
            {loading && !loadError && <p className="novel-muted">加载中…</p>}

            {entries.length > 0 && (
            <ul className="novel-list">
          {entries.map((entry) => (
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
            </ul>
            )}
            {!loading && !loadError && entries.length === 0 && (
              <EmptyState
                className="novel-empty-panel"
                framed
                title={search.trim() || kindFilter ? "没有匹配的设定" : "还没有世界观设定"}
                hint={
                  search.trim() || kindFilter
                    ? "换个关键词或切换类型；也会同时应用搜索与类型筛选。"
                    : "设定库用于集中记录地点、势力、历史事件、物品与规则；创建后可关联到具体章节。"
                }
                action={
                  search.trim() || kindFilter ? (
                    <button
                      type="button"
                      className="novel-btn-ghost"
                      onClick={() => {
                        setSearch("");
                        setKindFilter("");
                      }}
                    >
                      清空筛选
                    </button>
                  ) : (
                    <button type="button" className="novel-btn" disabled={archived} onClick={startNew}>
                      创建第一条设定
                    </button>
                  )
                }
              />
            )}
          </div>
        }
      >
        <div className="novel-detail" ref={detailRef}>
        {archived && <ArchivedBanner />}

        {!editorOpen && !loading && (
          <EmptyState
            className="novel-empty-detail"
            framed
            title="选择一条设定"
            hint="从左侧选择地点、势力或规则条目查看详情；也可以新建一条设定并关联章节。"
            action={
              <button type="button" className="novel-btn" disabled={archived} onClick={startNew}>
                新建设定条目
              </button>
            }
          />
        )}

        {editorOpen && (
          <>
            <div className="novel-detail-head">
              <div className="novel-detail-title-group">
                <span className="novel-eyebrow">{creating ? "新建设定" : "设定条目"}</span>
                <strong className="novel-detail-title">{draft.name.trim() || "未命名设定"}</strong>
              </div>
              <span className="novel-chip">{WORLDVIEW_KIND_LABELS[draft.kind]}</span>
            </div>
            <div className="novel-form">
              <FormSection
                title="设定内容"
                description="类型与名称用于筛选与检索；描述区按写作需要自由组织。"
              >
                <div className="novel-field-grid">
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
                  <div className="novel-field-span">
                    <Field label="标签">
                      <TagEditor
                        tags={draft.tags}
                        disabled={archived || saving}
                        onChange={(tags) => setDraft({ ...draft, tags })}
                      />
                    </Field>
                  </div>
                </div>
                <Field label="描述" htmlFor="novel-world-desc">
                  <textarea
                    id="novel-world-desc"
                    className="novel-textarea novel-textarea-lg"
                    disabled={archived || saving}
                    rows={8}
                    value={draft.description}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                </Field>
              </FormSection>

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
                  disabled={archived || saving || !selectedId}
                  onClick={() => void removeEntry()}
                >
                  {deleteArmed ? "再次点击确认删除" : "删除设定"}
                </button>
              </div>
            </div>

            {selectedId && (
              <RefSection
                projectId={projectId}
                entityType="worldview"
                entityId={selectedId}
                disabled={archived}
                onNotice={onNotice}
              />
            )}
          </>
        )}
        </div>
      </WorkspaceSplit>
    </div>
  );
}
