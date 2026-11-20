//! 章节引用区块：人物 / 设定 关联到真实章节，可查看、可解绑；
//! 解绑只删除引用行，不删除人物、设定或章节（后端事务保证，前端不得提供删除实体入口）。

import { useCallback, useEffect, useRef, useState } from "react";
import { Select, type SelectOption } from "../../../components/ui";
import {
  novelChapterList,
  novelEntityRefAdd,
  novelEntityRefDelete,
  novelEntityRefList,
} from "./ipc";
import type { NovelChapterSummary, NovelEntityRef } from "./types";
import { errorText, LoadError } from "./shared";
import type { CreativeNoticeKind } from "../types";

interface RefSectionProps {
  projectId: string;
  entityType: "character" | "worldview";
  entityId: string | null;
  disabled: boolean;
  onNotice: (kind: CreativeNoticeKind, text: string) => void;
}

export function RefSection({ projectId, entityType, entityId, disabled, onNotice }: RefSectionProps) {
  const [refs, setRefs] = useState<NovelEntityRef[]>([]);
  const [chapters, setChapters] = useState<NovelChapterSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chapterError, setChapterError] = useState<string | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);

  const loadChapters = useCallback(async () => {
    const token = ++seqRef.current;
    try {
      const result = await novelChapterList(projectId);
      if (token !== seqRef.current) return;
      setChapters(result.chapters ?? []);
      setChapterError(null);
    } catch (error) {
      if (token !== seqRef.current) return;
      setChapterError(errorText(error));
    }
  }, [projectId]);

  const loadRefs = useCallback(async () => {
    if (!entityId) {
      setRefs([]);
      setLoadError(null);
      return;
    }
    const token = ++seqRef.current;
    try {
      const result = await novelEntityRefList(projectId, entityType, entityId);
      if (token !== seqRef.current) return;
      setRefs(result.refs ?? []);
      setLoadError(null);
    } catch (error) {
      if (token !== seqRef.current) return;
      setLoadError(errorText(error));
    }
  }, [projectId, entityType, entityId]);

  useEffect(() => {
    void loadChapters();
  }, [loadChapters]);

  useEffect(() => {
    void loadRefs();
    setSelectedChapterId("");
    setNote("");
  }, [loadRefs]);

  const chapterOptions: SelectOption<string>[] = chapters.map((chapter) => ({
    value: chapter.id,
    label: chapter.title || "未命名章节",
  }));

  async function addRef() {
    if (!entityId || disabled) return;
    if (!selectedChapterId) {
      onNotice("error", "请先选择要关联的章节");
      return;
    }
    setBusy(true);
    try {
      await novelEntityRefAdd({
        projectId,
        entityType,
        entityId,
        chapterId: selectedChapterId,
        note: note.trim() || null,
      });
      onNotice("ok", "已关联章节");
      setSelectedChapterId("");
      setNote("");
      await loadRefs();
    } catch (error) {
      onNotice("error", `关联失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeRef(id: string) {
    if (disabled) return;
    setBusy(true);
    try {
      await novelEntityRefDelete(id);
      onNotice("ok", "已解除章节关联");
      await loadRefs();
    } catch (error) {
      onNotice("error", `解绑失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="novel-section" aria-label="章节引用">
      <header className="novel-section-head">
        <h3 className="novel-section-title">章节引用</h3>
        <span className="novel-count">{refs.length} 章</span>
      </header>

      {loadError && <LoadError message={loadError} onRetry={() => void loadRefs()} />}

      {!entityId && (
        <p className="novel-empty-hint">先保存当前条目后，再把它关联到章节。</p>
      )}

      {entityId && !disabled && (
        <div className="novel-ref-add">
          <Select
            value={selectedChapterId}
            options={chapterOptions}
            onChange={(value) => setSelectedChapterId(value)}
            placeholder="选择章节"
            ariaLabel="关联章节"
            disabled={disabled || chapters.length === 0}
          />
          <input
            type="text"
            className="novel-input"
            value={note}
            disabled={disabled}
            placeholder="备注（可选）"
            aria-label="引用备注"
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="button"
            className="novel-btn"
            disabled={disabled || busy || !selectedChapterId}
            onClick={() => void addRef()}
          >
            关联章节
          </button>
        </div>
      )}

      {chapterError && <p className="novel-inline-error">章节列表读取失败：{chapterError}</p>}

      {refs.length === 0 ? (
        <p className="novel-empty-hint">
          还没有关联章节。把当前条目关联到真实章节后，写作时可按章节回查出场位置。
        </p>
      ) : (
        <ul className="novel-ref-list">
          {refs.map((ref) => (
            <li key={ref.id} className="novel-ref-row">
              <span className="novel-ref-title">{ref.chapterTitle || "未命名章节"}</span>
              {ref.note ? <span className="novel-ref-note">{ref.note}</span> : null}
              <button
                type="button"
                className="novel-btn-ghost"
                disabled={disabled || busy}
                onClick={() => void removeRef(ref.id)}
                aria-label={`解除与「${ref.chapterTitle || "章节"}」的关联`}
              >
                解绑
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
