//! 人物档案模块（A1/A3/A4）：新建/编辑/删除人物、人物关系双向可查、章节引用。
//!
//! 约束：不自行反查项目；切项目由壳层换 key 重挂；异步回调做代次校验；
//! 归档态所有写入口置灰并说明原因；失败可见 + 可重试；正文保存机制不受影响。

import { useCallback, useEffect, useRef, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui";
import type { CreativeModuleProps } from "../types";
import {
  novelCharacterDelete,
  novelCharacterList,
  novelCharacterRelationDelete,
  novelCharacterRelationList,
  novelCharacterRelationSave,
  novelCharacterSave,
} from "./ipc";
import {
  CHARACTER_STATUS_LABELS,
  RELATION_TYPE_LABELS,
  type CharacterDraft,
  type CharacterStatus,
  type NovelCharacter,
  type NovelCharacterRelation,
  type RelationType,
} from "./types";
import { ArchivedBanner, errorText, Field, LoadError, TagEditor } from "./shared";
import { RefSection } from "./RefSection";

const EMPTY_DRAFT: CharacterDraft = {
  name: "",
  aliases: "",
  intro: "",
  appearance: "",
  background: "",
  motivation: "",
  faction: "",
  status: "unknown",
  notes: "",
  tags: [],
};

const STATUS_OPTIONS: SelectOption<CharacterStatus>[] = (
  Object.keys(CHARACTER_STATUS_LABELS) as CharacterStatus[]
).map((value) => ({ value, label: CHARACTER_STATUS_LABELS[value] }));

const RELATION_OPTIONS: SelectOption<RelationType>[] = (
  Object.keys(RELATION_TYPE_LABELS) as RelationType[]
).map((value) => ({ value, label: RELATION_TYPE_LABELS[value] }));

export function CharactersPanel({ projectId, archived, onNotice }: CreativeModuleProps) {
  const [characters, setCharacters] = useState<NovelCharacter[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CharacterDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const [relations, setRelations] = useState<NovelCharacterRelation[]>([]);
  const [relationTarget, setRelationTarget] = useState<string | "">("");
  const [relationType, setRelationType] = useState<RelationType>("friend");
  const [relationDesc, setRelationDesc] = useState("");
  const [relationBusy, setRelationBusy] = useState(false);

  const seqRef = useRef(0);

  const loadCharacters = useCallback(
    async (keyword?: string | null) => {
      const token = ++seqRef.current;
      setLoading(true);
      try {
        const result = await novelCharacterList(projectId, keyword ?? null);
        if (token !== seqRef.current) return;
        setCharacters(result.characters ?? []);
        setLoadError(null);
      } catch (error) {
        if (token !== seqRef.current) return;
        setLoadError(errorText(error));
      } finally {
        if (token === seqRef.current) setLoading(false);
      }
    },
    [projectId],
  );

  const loadRelations = useCallback(
    async (characterId: string) => {
      const token = ++seqRef.current;
      try {
        const result = await novelCharacterRelationList(projectId, characterId);
        if (token !== seqRef.current) return;
        setRelations(result.relations ?? []);
      } catch (error) {
        if (token !== seqRef.current) return;
        onNotice("error", `关系读取失败：${errorText(error)}`);
      }
    },
    [projectId, onNotice],
  );

  useEffect(() => {
    void loadCharacters(search.trim() || null);
  }, [loadCharacters, search]);

  function selectCharacter(character: NovelCharacter) {
    setCreating(false);
    setSelectedId(character.id);
    setDraft({
      name: character.name,
      aliases: character.aliases,
      intro: character.intro,
      appearance: character.appearance,
      background: character.background,
      motivation: character.motivation,
      faction: character.faction,
      status: character.status,
      notes: character.notes,
      tags: character.tags,
    });
    setSaveError(null);
    setDeleteArmed(false);
    void loadRelations(character.id);
  }

  function resetDetail(openForCreate: boolean) {
    setSelectedId(null);
    setCreating(openForCreate);
    setDraft(EMPTY_DRAFT);
    setRelations([]);
    setSaveError(null);
    setDeleteArmed(false);
    setRelationTarget("");
    setRelationDesc("");
  }

  function startNew() {
    resetDetail(true);
  }

  const selected = characters.find((character) => character.id === selectedId) ?? null;
  const editorOpen = creating || selected !== null;

  async function saveCharacter() {
    if (archived || saving) return;
    if (!draft.name.trim()) {
      setSaveError("人物姓名不能为空");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await novelCharacterSave(projectId, draft, selectedId);
      onNotice("ok", selectedId ? "人物已更新" : `已新建人物「${result.character.name}」`);
      await loadCharacters();
      selectCharacter(result.character);
    } catch (error) {
      setSaveError(errorText(error));
      onNotice("error", `保存人物失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeCharacter() {
    if (!selectedId || archived || saving) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setSaving(true);
    try {
      await novelCharacterDelete(selectedId);
      onNotice("ok", "人物已删除");
      resetDetail(false);
      await loadCharacters();
    } catch (error) {
      onNotice("error", `删除人物失败：${errorText(error)}`);
    } finally {
      setSaving(false);
      setDeleteArmed(false);
    }
  }

  async function addRelation() {
    if (!selectedId || archived || relationBusy) return;
    if (!relationTarget) {
      onNotice("error", "请选择关系对象");
      return;
    }
    if (relationTarget === selectedId) {
      onNotice("error", "人物不能与自己建立关系");
      return;
    }
    setRelationBusy(true);
    try {
      await novelCharacterRelationSave({
        projectId,
        fromCharacterId: selectedId,
        toCharacterId: relationTarget,
        relationType,
        description: relationDesc.trim(),
      });
      onNotice("ok", "关系已保存");
      setRelationTarget("");
      setRelationDesc("");
      await loadRelations(selectedId);
    } catch (error) {
      onNotice("error", `保存关系失败：${errorText(error)}`);
    } finally {
      setRelationBusy(false);
    }
  }

  async function removeRelation(id: string) {
    if (archived || relationBusy) return;
    setRelationBusy(true);
    try {
      await novelCharacterRelationDelete(id);
      onNotice("ok", "关系已解除");
      if (selectedId) await loadRelations(selectedId);
    } catch (error) {
      onNotice("error", `解除关系失败：${errorText(error)}`);
    } finally {
      setRelationBusy(false);
    }
  }

  const relationTargetOptions: SelectOption<string>[] = characters
    .filter((character) => character.id !== selectedId)
    .map((character) => ({ value: character.id, label: character.name }));

  return (
    <div className="novel-layout">
      <aside className="novel-pane novel-pane-list" aria-label="人物列表">
        <div className="novel-toolbar">
          <input
            type="search"
            className="novel-input"
            placeholder="搜索姓名 / 别名 / 标签"
            aria-label="搜索人物"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="novel-btn"
            disabled={archived}
            onClick={startNew}
          >
            新建人物
          </button>
        </div>

        {loadError && <LoadError message={loadError} onRetry={() => void loadCharacters()} />}
        {loading && !loadError && <p className="novel-empty-hint">加载中…</p>}

        <ul className="novel-list">
          {characters.map((character) => (
            <li key={character.id}>
              <button
                type="button"
                className={`novel-list-row${character.id === selectedId ? " is-active" : ""}`}
                onClick={() => selectCharacter(character)}
              >
                <span className="novel-row-name">{character.name}</span>
                <span className="novel-row-meta">
                  {CHARACTER_STATUS_LABELS[character.status]}
                  {character.tags.length > 0 ? ` · ${character.tags.join("、")}` : ""}
                </span>
              </button>
            </li>
          ))}
          {!loading && characters.length === 0 && !loadError && (
            <li className="novel-empty-hint">暂无人物，点击「新建人物」开始。</li>
          )}
        </ul>
      </aside>

      <div className="novel-pane novel-pane-detail">
        {archived && <ArchivedBanner />}

        {!editorOpen && !loading && (
          <p className="novel-empty-hint">从左侧选择人物，或新建人物档案。</p>
        )}

        {editorOpen && (
          <>
            <div className="novel-form">
              <Field label="姓名" htmlFor="novel-char-name">
                <input
                  id="novel-char-name"
                  type="text"
                  className="novel-input"
                  disabled={archived || saving}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="别名" htmlFor="novel-char-aliases">
                <input
                  id="novel-char-aliases"
                  type="text"
                  className="novel-input"
                  disabled={archived || saving}
                  value={draft.aliases}
                  onChange={(event) => setDraft({ ...draft, aliases: event.target.value })}
                />
              </Field>
              <Field label="人物状态">
                <Select
                  value={draft.status}
                  options={STATUS_OPTIONS}
                  onChange={(value) => setDraft({ ...draft, status: value })}
                  ariaLabel="人物状态"
                  disabled={archived || saving}
                />
              </Field>
              <Field label="阵营 / 身份 / 组织" htmlFor="novel-char-faction">
                <input
                  id="novel-char-faction"
                  type="text"
                  className="novel-input"
                  disabled={archived || saving}
                  value={draft.faction}
                  onChange={(event) => setDraft({ ...draft, faction: event.target.value })}
                />
              </Field>
              <Field label="标签">
                <TagEditor
                  tags={draft.tags}
                  disabled={archived || saving}
                  onChange={(tags) => setDraft({ ...draft, tags })}
                />
              </Field>
              <Field label="简介" htmlFor="novel-char-intro">
                <textarea
                  id="novel-char-intro"
                  className="novel-textarea"
                  disabled={archived || saving}
                  rows={3}
                  value={draft.intro}
                  onChange={(event) => setDraft({ ...draft, intro: event.target.value })}
                />
              </Field>
              <Field label="外貌与性格" htmlFor="novel-char-appearance">
                <textarea
                  id="novel-char-appearance"
                  className="novel-textarea"
                  disabled={archived || saving}
                  rows={3}
                  value={draft.appearance}
                  onChange={(event) => setDraft({ ...draft, appearance: event.target.value })}
                />
              </Field>
              <Field label="背景经历" htmlFor="novel-char-background">
                <textarea
                  id="novel-char-background"
                  className="novel-textarea"
                  disabled={archived || saving}
                  rows={4}
                  value={draft.background}
                  onChange={(event) => setDraft({ ...draft, background: event.target.value })}
                />
              </Field>
              <Field label="目标与动机" htmlFor="novel-char-motivation">
                <textarea
                  id="novel-char-motivation"
                  className="novel-textarea"
                  disabled={archived || saving}
                  rows={3}
                  value={draft.motivation}
                  onChange={(event) => setDraft({ ...draft, motivation: event.target.value })}
                />
              </Field>
              <Field label="备注" htmlFor="novel-char-notes">
                <textarea
                  id="novel-char-notes"
                  className="novel-textarea"
                  disabled={archived || saving}
                  rows={2}
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
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
                  onClick={() => void saveCharacter()}
                >
                  {saving ? "保存中…" : "保存人物"}
                </button>
                <button
                  type="button"
                  className={`novel-btn-ghost${deleteArmed ? " is-danger" : ""}`}
                  disabled={archived || saving || !selectedId}
                  onClick={() => void removeCharacter()}
                >
                  {deleteArmed ? "再次点击确认删除" : "删除人物"}
                </button>
              </div>
            </div>

            {selectedId && (
              <>
                <section className="novel-section" aria-label="人物关系">
              <h3 className="novel-section-title">人物关系</h3>
              {relations.length === 0 ? (
                <p className="novel-empty-hint">暂无关系记录。</p>
              ) : (
                <ul className="novel-ref-list">
                  {relations.map((relation) => (
                    <li key={relation.id} className="novel-ref-row">
                      <span className="novel-ref-title">
                        {relation.fromName}
                        {" → "}
                        {relation.toName}
                      </span>
                      <span className="novel-ref-note">
                        {RELATION_TYPE_LABELS[relation.relationType]}
                        {relation.description ? ` · ${relation.description}` : ""}
                      </span>
                      <button
                        type="button"
                        className="novel-btn-ghost"
                        disabled={archived || relationBusy}
                        onClick={() => void removeRelation(relation.id)}
                        aria-label="解除关系"
                      >
                        解绑
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {!archived && (
                <div className="novel-ref-add">
                  <Select
                    value={relationTarget}
                    options={relationTargetOptions}
                    onChange={setRelationTarget}
                    placeholder="选择人物"
                    ariaLabel="关系对象"
                    disabled={relationBusy || relationTargetOptions.length === 0}
                  />
                  <Select
                    value={relationType}
                    options={RELATION_OPTIONS}
                    onChange={setRelationType}
                    ariaLabel="关系类型"
                    disabled={relationBusy}
                  />
                  <input
                    type="text"
                    className="novel-input"
                    value={relationDesc}
                    disabled={relationBusy}
                    placeholder="关系描述（可选）"
                    aria-label="关系描述"
                    onChange={(event) => setRelationDesc(event.target.value)}
                  />
                  <button
                    type="button"
                    className="novel-btn"
                    disabled={relationBusy || !relationTarget}
                    onClick={() => void addRelation()}
                  >
                    {relationBusy ? "保存中…" : "添加关系"}
                  </button>
                </div>
              )}
                </section>

                <RefSection
                  projectId={projectId}
                  entityType="character"
                  entityId={selectedId}
                  disabled={archived}
                  onNotice={onNotice}
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
