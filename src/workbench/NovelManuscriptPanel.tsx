//! 小说「正文」模块（B1，v58）：卷 → 章两级树 + 纯文本编辑器。
//!
//! 设计边界（与项目规范一致）：
//! - 复用 Project Workspace 项目上下文，不新建第二套项目/任务/窗口系统；
//! - 正文按章存 SQLite（`novel_chapters.content`），不写外部文件；
//! - 纯文本 textarea，无 Markdown/富文本/生成入口；自动保存为防抖写库，
//!   失焦、切换章节与组件卸载时立即落盘；
//! - 所有异步结果都校验「仍是当前项目」，切换项目后不把旧项目结果写进新项目。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import {
  novelChapterDelete,
  novelChapterGet,
  novelChapterList,
  novelChapterSave,
  novelChapterSaveContent,
  novelVolumeDelete,
  novelVolumeList,
  novelVolumeSave,
  type NovelChapter,
  type NovelChapterSummary,
  type NovelVolume,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";

const AUTOSAVE_MS = 900;

type NoticeKind = "ok" | "error" | "info";
type SaveState = "idle" | "saving" | "saved" | "error";

export interface NovelManuscriptPanelProps {
  projectId: string;
  archived: boolean;
  onNotice: (kind: NoticeKind, text: string) => void;
}

function byOrder<T extends { sortOrder: number; createdAt: string; id: string }>(a: T, b: T) {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
  return a.id.localeCompare(b.id);
}

/** 与 Rust 侧字数口径一致：非空白字符数。 */
function countWords(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) count += 1;
  }
  return count;
}

function trimTitle(title: string): string {
  return title.trim();
}

export default function NovelManuscriptPanel({
  projectId,
  archived,
  onNotice,
}: NovelManuscriptPanelProps) {
  const [volumes, setVolumes] = useState<NovelVolume[]>([]);
  const [chapters, setChapters] = useState<NovelChapterSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chapter, setChapter] = useState<NovelChapter | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [newVolumeTitle, setNewVolumeTitle] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mountedRef = useRef(true);
  const projectRef = useRef(projectId);
  const selectedRef = useRef<string | null>(null);
  const draftRef = useRef("");
  const savedRef = useRef("");
  const timerRef = useRef<number | null>(null);
  const loadTokenRef = useRef(0);
  const chapterTokenRef = useRef(0);
  const skipRenameBlurRef = useRef(false);

  selectedRef.current = selectedId;
  draftRef.current = draft;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const loadTree = useCallback(async () => {
    const token = loadTokenRef.current + 1;
    loadTokenRef.current = token;
    setLoading(true);
    setError(null);
    try {
      const [volumeResult, chapterResult] = await Promise.all([
        novelVolumeList(projectId),
        novelChapterList(projectId),
      ]);
      if (!mountedRef.current || token !== loadTokenRef.current || projectRef.current !== projectId) {
        return;
      }
      setVolumes(volumeResult.volumes);
      setChapters(chapterResult.chapters);
      setSelectedId((current) => {
        if (current && chapterResult.chapters.some((c) => c.id === current)) return current;
        return chapterResult.chapters[0]?.id ?? null;
      });
    } catch (e) {
      if (mountedRef.current && token === loadTokenRef.current) {
        setError(errorMessage(e));
      }
    } finally {
      if (mountedRef.current && token === loadTokenRef.current) setLoading(false);
    }
  }, [projectId]);

  // 项目切换：先把上一个项目未落盘的正文写回，再刷新树（旧结果不得进入新项目）。
  useEffect(() => {
    if (projectRef.current === projectId) return;
    const previousChapter = selectedRef.current;
    const previousContent = draftRef.current;
    if (previousChapter && previousContent !== savedRef.current) {
      void novelChapterSaveContent(previousChapter, previousContent).catch(() => {
        // 项目已切换，失败只影响旧项目草稿；新项目不读取旧结果。
      });
    }
    projectRef.current = projectId;
    clearTimer();
    setVolumes([]);
    setChapters([]);
    setSelectedId(null);
    setChapter(null);
    setDraft("");
    savedRef.current = "";
    setSaveState("idle");
    setRenaming(null);
    setConfirmDelete(null);
  }, [projectId, clearTimer]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const saveNow = useCallback(async () => {
    const id = selectedRef.current;
    const content = draftRef.current;
    if (!id || archived || content === savedRef.current) return;
    clearTimer();
    setSaveState("saving");
    const targetProject = projectRef.current;
    try {
      const result = await novelChapterSaveContent(id, content);
      if (!mountedRef.current || projectRef.current !== targetProject) return;
      savedRef.current = content;
      setChapters((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, wordCount: result.chapter.wordCount, updatedAt: result.chapter.updatedAt }
            : c,
        ),
      );
      setSaveState(draftRef.current === content ? "saved" : "idle");
    } catch (e) {
      if (!mountedRef.current || projectRef.current !== targetProject) return;
      setSaveState("error");
      onNotice("error", `正文保存失败：${errorMessage(e)}`);
    }
  }, [archived, clearTimer, onNotice]);

  // 卸载时兜底落盘（仅一次；不依赖 React 状态，避免旧闭包）。
  useEffect(() => {
    return () => {
      const id = selectedRef.current;
      const content = draftRef.current;
      if (id && content !== savedRef.current) {
        void novelChapterSaveContent(id, content).catch(() => {});
      }
    };
  }, []);

  // 防抖自动保存：只在正文变化且与已保存内容不同时排程。
  useEffect(() => {
    draftRef.current = draft;
    if (!selectedId || chapterLoading || archived) return;
    if (draft === savedRef.current) {
      if (timerRef.current === null) setSaveState((s) => (s === "error" ? s : "idle"));
      return;
    }
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void saveNow();
    }, AUTOSAVE_MS);
    return clearTimer;
  }, [draft, selectedId, chapterLoading, archived, clearTimer, saveNow]);

  // 读取选中章节正文：只接受最新一次请求的结果。
  useEffect(() => {
    if (!selectedId) {
      setChapter(null);
      setDraft("");
      savedRef.current = "";
      setChapterLoading(false);
      return;
    }
    const token = chapterTokenRef.current + 1;
    chapterTokenRef.current = token;
    setChapterLoading(true);
    setSaveState("idle");
    novelChapterGet(selectedId)
      .then((result) => {
        if (!mountedRef.current || token !== chapterTokenRef.current) return;
        setChapter(result.chapter);
        setDraft(result.chapter.content);
        savedRef.current = result.chapter.content;
      })
      .catch((e) => {
        if (!mountedRef.current || token !== chapterTokenRef.current) return;
        setChapter(null);
        setDraft("");
        setSaveState("error");
        onNotice("error", `读取章节失败：${errorMessage(e)}`);
      })
      .finally(() => {
        if (mountedRef.current && token === chapterTokenRef.current) setChapterLoading(false);
      });
    return () => {
      chapterTokenRef.current += 1;
    };
  }, [selectedId, onNotice]);

  const selectChapter = useCallback(
    async (id: string) => {
      if (id === selectedRef.current) return;
      await saveNow();
      setSelectedId(id);
    },
    [saveNow],
  );

  const sortedVolumes = useMemo(() => [...volumes].sort(byOrder), [volumes]);
  const unfiledChapters = useMemo(
    () => chapters.filter((c) => !c.volumeId).sort(byOrder),
    [chapters],
  );
  const chaptersOf = useCallback(
    (volumeId: string) => chapters.filter((c) => c.volumeId === volumeId).sort(byOrder),
    [chapters],
  );
  const totalWords = useMemo(
    () => chapters.reduce((sum, c) => sum + c.wordCount, 0),
    [chapters],
  );
  const visibleChapters = chapters.filter((c) => c.volumeId === null || volumes.some((v) => v.id === c.volumeId));
  const currentWordCount = chapterLoading ? (chapter?.wordCount ?? 0) : countWords(draft);

  const runBusy = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  const addVolume = useCallback(async () => {
    if (archived) {
      onNotice("info", "项目已归档，只读");
      return;
    }
    const title = trimTitle(newVolumeTitle);
    if (!title) {
      onNotice("error", "卷标题不能为空");
      return;
    }
    await runBusy(async () => {
      try {
        const result = await novelVolumeSave({ projectId, title });
        setVolumes((prev) => [...prev, result.volume]);
        setNewVolumeTitle("");
        onNotice("ok", `已新建卷「${result.volume.title}」`);
      } catch (e) {
        onNotice("error", `新建卷失败：${errorMessage(e)}`);
      }
    });
  }, [newVolumeTitle, projectId, runBusy, onNotice, archived]);

  const addChapter = useCallback(
    async (volumeId: string | null) => {
      if (archived) {
        onNotice("info", "项目已归档，只读");
        return;
      }
      await runBusy(async () => {
        try {
          const result = await novelChapterSave({
            projectId,
            volumeId,
            title: "新章节",
            sortOrder: null,
          });
          setChapters((prev) => [...prev, result.chapter]);
          setSelectedId(result.chapter.id);
          setRenaming(result.chapter.id);
          setRenameDraft(result.chapter.title);
          onNotice("ok", "已新建章节；可直接改标题后开始写作");
        } catch (e) {
          onNotice("error", `新建章节失败：${errorMessage(e)}`);
        }
      });
    },
    [projectId, runBusy, onNotice, archived],
  );

  const startRename = useCallback(
    (id: string, title: string) => {
      if (archived) {
        onNotice("info", "项目已归档，只读");
        return;
      }
      skipRenameBlurRef.current = false;
      setRenaming(id);
      setRenameDraft(title);
      setConfirmDelete(null);
    },
    [archived, onNotice],
  );

  const submitRename = useCallback(async () => {
    if (skipRenameBlurRef.current) {
      skipRenameBlurRef.current = false;
      return;
    }
    if (!renaming) return;
    const title = trimTitle(renameDraft);
    if (!title) {
      onNotice("error", "标题不能为空");
      return;
    }
    const targetId = renaming;
    const volume = volumes.find((v) => v.id === targetId);
    const chapterItem = chapters.find((c) => c.id === targetId);
    await runBusy(async () => {
      try {
        if (volume) {
          const result = await novelVolumeSave({
            id: volume.id,
            projectId,
            title,
            sortOrder: volume.sortOrder,
          });
          setVolumes((prev) => prev.map((v) => (v.id === volume.id ? result.volume : v)));
        } else if (chapterItem) {
          const result = await novelChapterSave({
            id: chapterItem.id,
            projectId,
            volumeId: chapterItem.volumeId,
            title,
            sortOrder: chapterItem.sortOrder,
          });
          setChapters((prev) =>
            prev.map((c) => (c.id === chapterItem.id ? { ...c, title: result.chapter.title } : c)),
          );
          setChapter((prev) => (prev && prev.id === chapterItem.id ? { ...prev, title } : prev));
        } else {
          throw new Error("目标已不存在，请刷新后重试");
        }
        setRenaming(null);
        onNotice("ok", "标题已保存");
      } catch (e) {
        onNotice("error", `重命名失败：${errorMessage(e)}`);
      }
    });
  }, [renaming, renameDraft, volumes, chapters, projectId, runBusy, onNotice]);

  const reorderVolumes = useCallback(
    async (volumeId: string, delta: number) => {
      if (archived) return;
      const list = [...sortedVolumes];
      const index = list.findIndex((v) => v.id === volumeId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= list.length) return;
      const [moved] = list.splice(index, 1);
      list.splice(target, 0, moved);
      await runBusy(async () => {
        try {
          const updated: NovelVolume[] = [];
          for (let i = 0; i < list.length; i += 1) {
            const item = list[i];
            if (item.sortOrder === i) {
              updated.push(item);
            } else {
              const result = await novelVolumeSave({
                id: item.id,
                projectId,
                title: item.title,
                sortOrder: i,
              });
              updated.push(result.volume);
            }
          }
          if (mountedRef.current) setVolumes(updated);
        } catch (e) {
          onNotice("error", `调整卷顺序失败：${errorMessage(e)}`);
          await loadTree();
        }
      });
    },
    [sortedVolumes, projectId, runBusy, onNotice, loadTree],
  );

  const reorderChapters = useCallback(
    async (chapterId: string, delta: number) => {
      if (archived) return;
      const item = chapters.find((c) => c.id === chapterId);
      if (!item) return;
      // 只调整同一卷（或未分卷桶）内顺序，跨卷移动不在 B1 范围。
      const bucket = item.volumeId === null ? unfiledChapters : chaptersOf(item.volumeId);
      const index = bucket.findIndex((c) => c.id === chapterId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= bucket.length) return;
      const rows = [...bucket];
      const [moved] = rows.splice(index, 1);
      rows.splice(target, 0, moved);
      await runBusy(async () => {
        try {
          const updated: NovelChapterSummary[] = [];
          for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            if (row.sortOrder === i) {
              updated.push(row);
            } else {
              const result = await novelChapterSave({
                id: row.id,
                projectId,
                volumeId: row.volumeId,
                title: row.title,
                sortOrder: i,
              });
              updated.push({ ...row, sortOrder: result.chapter.sortOrder });
            }
          }
          if (mountedRef.current) {
            setChapters((prev) => {
              const byId = new Map(updated.map((row) => [row.id, row]));
              return prev.map((row) => byId.get(row.id) ?? row);
            });
          }
        } catch (e) {
          onNotice("error", `调整章节顺序失败：${errorMessage(e)}`);
          await loadTree();
        }
      });
    },
    [chapters, chaptersOf, unfiledChapters, projectId, runBusy, onNotice, loadTree],
  );

  const removeVolume = useCallback(
    async (volume: NovelVolume) => {
      if (archived) return;
      const key = `volume:${volume.id}`;
      if (confirmDelete !== key) {
        setConfirmDelete(key);
        return;
      }
      setConfirmDelete(null);
      await runBusy(async () => {
        try {
          await novelVolumeDelete(volume.id);
          setVolumes((prev) => prev.filter((v) => v.id !== volume.id));
          setChapters((prev) => {
            const removed = prev.filter((c) => c.volumeId === volume.id);
            if (selectedRef.current && removed.some((c) => c.id === selectedRef.current)) {
              setSelectedId(null);
            }
            return prev.filter((c) => c.volumeId !== volume.id);
          });
          onNotice("ok", `已删除卷「${volume.title}」及其章节`);
        } catch (e) {
          onNotice("error", `删除卷失败：${errorMessage(e)}`);
        }
      });
    },
    [confirmDelete, runBusy, onNotice],
  );

  const removeChapter = useCallback(
    async (item: NovelChapterSummary) => {
      if (archived) return;
      const key = `chapter:${item.id}`;
      if (confirmDelete !== key) {
        setConfirmDelete(key);
        return;
      }
      setConfirmDelete(null);
      await runBusy(async () => {
        try {
          await novelChapterDelete(item.id);
          setChapters((prev) => prev.filter((c) => c.id !== item.id));
          if (selectedRef.current === item.id) {
            savedRef.current = draftRef.current;
            setSelectedId(null);
          }
          onNotice("ok", `已删除章节「${item.title}」`);
        } catch (e) {
          onNotice("error", `删除章节失败：${errorMessage(e)}`);
        }
      });
    },
    [confirmDelete, runBusy, onNotice],
  );

  const renderChapterRow = (item: NovelChapterSummary) => {
    const isSelected = selectedId === item.id;
    const isRenaming = renaming === item.id;
    const deleteKey = `chapter:${item.id}`;
    const bucketSize = (item.volumeId === null ? unfiledChapters : chaptersOf(item.volumeId)).length;
    const bucketIndex = (item.volumeId === null ? unfiledChapters : chaptersOf(item.volumeId)).findIndex(
      (c) => c.id === item.id,
    );
    return (
      <div
        key={item.id}
        className={`ws-novel-chapter ${isSelected ? "is-active" : ""}`}
      >
        {isRenaming ? (
          <input
            className="ws-input ws-flex"
            value={renameDraft}
            autoFocus
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
              if (e.key === "Escape") {
                skipRenameBlurRef.current = true;
                setRenaming(null);
              }
            }}
            onBlur={() => void submitRename()}
            aria-label="章节标题"
          />
        ) : (
          <button
            type="button"
            className="ws-novel-chapter-title"
            onClick={() => void selectChapter(item.id)}
            aria-current={isSelected ? "true" : undefined}
          >
            {item.title}
          </button>
        )}
        <span className="ws-novel-count">{item.wordCount} 字</span>
        {!isRenaming && (
          <span className="ws-novel-actions">
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              aria-label={`重命名章节「${item.title}」`}
              onClick={() => startRename(item.id, item.title)}
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              aria-label={`上移章节「${item.title}」`}
              disabled={busy || bucketIndex <= 0}
              onClick={() => void reorderChapters(item.id, -1)}
            >
              <ChevronUp size={11} />
            </button>
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              aria-label={`下移章节「${item.title}」`}
              disabled={busy || bucketIndex < 0 || bucketIndex >= bucketSize - 1}
              onClick={() => void reorderChapters(item.id, 1)}
            >
              <ChevronDown size={11} />
            </button>
            <button
              type="button"
              className={`ws-btn ws-btn-quiet ${confirmDelete === deleteKey ? "ws-btn-danger" : ""}`}
              aria-label={`删除章节「${item.title}」`}
              disabled={busy}
              onClick={() => void removeChapter(item)}
            >
              <Trash2 size={11} /> {confirmDelete === deleteKey ? "确认" : ""}
            </button>
          </span>
        )}
      </div>
    );
  };

  const renderVolumeBlock = (volume: NovelVolume | null) => {
    const key = volume ? volume.id : "unfiled";
    const title = volume ? volume.title : "未分卷";
    const rows = volume ? chaptersOf(volume.id) : unfiledChapters;
    const words = rows.reduce((sum, c) => sum + c.wordCount, 0);
    const isRenaming = volume ? renaming === volume.id : false;
    const deleteKey = volume ? `volume:${volume.id}` : "";
    const index = volume ? sortedVolumes.findIndex((v) => v.id === volume.id) : -1;
    return (
      <section className="ws-novel-volume" key={key} aria-label={title}>
        <header className="ws-novel-volume-head">
          {isRenaming && volume ? (
            <input
              className="ws-input ws-flex"
              value={renameDraft}
              autoFocus
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
                if (e.key === "Escape") {
                  skipRenameBlurRef.current = true;
                  setRenaming(null);
                }
              }}
              onBlur={() => void submitRename()}
              aria-label="卷标题"
            />
          ) : (
            <button
              type="button"
              className="ws-novel-volume-title"
              onClick={() => volume && startRename(volume.id, volume.title)}
              disabled={!volume}
              data-tip={volume ? "点击重命名" : undefined}
            >
              {title}
            </button>
          )}
          <span className="ws-novel-count">{words} 字</span>
          {volume && !isRenaming && (
            <span className="ws-novel-actions">
              <button
                type="button"
                className="ws-btn ws-btn-quiet"
                aria-label={`上移卷「${volume.title}」`}
                disabled={busy || index <= 0}
                onClick={() => void reorderVolumes(volume.id, -1)}
              >
                <ChevronUp size={11} />
              </button>
              <button
                type="button"
                className="ws-btn ws-btn-quiet"
                aria-label={`下移卷「${volume.title}」`}
                disabled={busy || index < 0 || index >= sortedVolumes.length - 1}
                onClick={() => void reorderVolumes(volume.id, 1)}
              >
                <ChevronDown size={11} />
              </button>
              <button
                type="button"
                className={`ws-btn ws-btn-quiet ${confirmDelete === deleteKey ? "ws-btn-danger" : ""}`}
                aria-label={`删除卷「${volume.title}」及其章节`}
                disabled={busy}
                onClick={() => void removeVolume(volume)}
              >
                <Trash2 size={11} /> {confirmDelete === deleteKey ? "确认" : ""}
              </button>
            </span>
          )}
        </header>
        {rows.length === 0 && <div className="ws-novel-empty">本卷还没有章节</div>}
        {rows.map(renderChapterRow)}
        <div className="ws-novel-add">
          <button
            type="button"
            className="ws-btn"
            disabled={busy || archived}
            onClick={() => void addChapter(volume ? volume.id : null)}
          >
            <Plus size={11} /> 新建章节
          </button>
        </div>
      </section>
    );
  };

  const saveLabel = (() => {
    if (archived) return "项目已归档，只读";
    if (chapterLoading) return "读取正文…";
    if (saveState === "saving") return "保存中…";
    if (saveState === "saved") return "已自动保存";
    if (saveState === "error") return "保存失败";
    if (selectedId && draft !== savedRef.current) return "待保存";
    return "自动保存已开启";
  })();

  return (
    <div className="ws-novel">
      {/* 左栏：卷 → 章树 */}
      <aside className="ws-novel-tree" aria-label="章节树">
        <div className="ws-novel-toolbar">
          <input
            className="ws-input ws-flex"
            placeholder="新建卷标题"
            value={newVolumeTitle}
            disabled={archived || busy}
            onChange={(e) => setNewVolumeTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addVolume();
            }}
          />
          <button
            type="button"
            className="ws-btn ws-btn-primary"
            disabled={archived || busy || !newVolumeTitle.trim()}
            onClick={() => void addVolume()}
          >
            <Plus size={11} /> 卷
          </button>
        </div>
        {error && (
          <div className="ws-notice" data-tone="error" role="alert">
            <AlertCircle size={13} />
            <span>读取章节树失败：{error}</span>
            <button type="button" className="ws-btn" onClick={() => void loadTree()}>
              重试
            </button>
          </div>
        )}
        {loading ? (
          <div className="ws-state" data-tone="muted">
            <Loader2 size={12} className="ws-spin" /> 正在读取卷与章节…
          </div>
        ) : (
          <>
            {sortedVolumes.map((volume) => renderVolumeBlock(volume))}
            {renderVolumeBlock(null)}
            {sortedVolumes.length === 0 && visibleChapters.length === 0 && (
              <div className="ws-novel-empty">
                还没有内容：先新建一卷，或在「未分卷」下写第一章。
              </div>
            )}
          </>
        )}
        <div className="ws-meta">全书 {totalWords} 字 · {chapters.length} 章</div>
      </aside>

      {/* 右栏：纯文本编辑器 */}
      <section className="ws-novel-editor" aria-label="正文编辑器">
        {!selectedId && (
          <div className="ws-novel-editor-empty">
            <h3>还没有选中的章节</h3>
            <p>在左侧选择一章，或点「新建章节」开始写作。正文按章保存，不写入外部文件。</p>
          </div>
        )}
        {selectedId && chapterLoading && (
          <div className="ws-state" data-tone="muted">
            <Loader2 size={12} className="ws-spin" /> 正在读取正文…
          </div>
        )}
        {selectedId && !chapterLoading && (
          <>
            <header className="ws-novel-editor-head">
              <div className="ws-flex">
                <strong className="ws-novel-editor-title">{chapter?.title ?? "（章节已删除）"}</strong>
                <div className="ws-meta">
                  本章 {currentWordCount} 字 · 全书 {totalWords} 字
                </div>
              </div>
              <span className="ws-novel-save" data-tone={saveState}>
                {saveState === "saved" && <CheckCircle2 size={12} />}
                {saveState === "error" && <AlertCircle size={12} />}
                {saveLabel}
              </span>
            </header>
            {archived && (
              <div className="ws-notice" data-tone="info">
                项目已归档：正文可查看，恢复为进行中后才能继续编辑。
              </div>
            )}
            <textarea
              className="ws-novel-textarea"
              value={draft}
              readOnly={archived}
              spellCheck={false}
              placeholder="在这里写正文…（纯文本，自动保存）"
              aria-label={`${chapter?.title ?? "章节"}正文`}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void saveNow()}
            />
            <div className="ws-meta">
              停止输入约 {AUTOSAVE_MS / 1000} 秒后自动写入本地数据库；失焦、切换章节与切换项目时立即保存。
              纯文本保存，不解析 Markdown；单章上限 8 MiB。
            </div>
          </>
        )}
      </section>
    </div>
  );
}
