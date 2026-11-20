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
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import WorkspaceSplit from "./WorkspaceSplit";
import "./creative/novel/manuscript.css";
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
import { Dialog } from "../components/ui";
import { errorMessage } from "../lib/errors";
import { logEvent } from "../lib/diagnostics";
import { traceWorkbenchClose } from "../lib/closeTrace";

const AUTOSAVE_MS = 900;

/**
 * 诊断用的脱敏章节标识：只保留前 8 位，足以串联同一章的保存链路，
 * 但不含正文、项目名或文件路径。
 */
function traceChapterId(id: string | null): string | null {
  if (!id) return null;
  return id.length <= 8 ? id : id.slice(0, 8);
}

function elapsedMs(startedAt: number): number {
  try {
    return Math.max(0, Math.round(performance.now() - startedAt));
  } catch {
    return 0;
  }
}

/**
 * 正文保存链路诊断：诊断中心（结构化可检索）+ 终端（与 Rust 关闭日志同一时间线）。
 *
 * 隐私边界：只记录章节短 ID、脏稿/在途/归档等状态与耗时，**绝不记录正文**。
 * 这条链路只用于回答「关闭时到底卡在哪个 await」。
 */
function manuscriptTrace(
  event: string,
  fields: {
    chapterId?: string | null;
    dirty?: boolean;
    inflight?: boolean;
    archived?: boolean;
    durationMs?: number;
    result?: string;
  },
): void {
  const metadata: Record<string, string | number | boolean> = {
    chapter: traceChapterId(fields.chapterId ?? null) ?? "none",
    dirty: fields.dirty ?? false,
    inflight: fields.inflight ?? false,
    archived: fields.archived ?? false,
  };
  if (fields.result) metadata.result = fields.result;
  logEvent({
    level: event.endsWith("_FAILED") ? "WARN" : "INFO",
    module: "workbench",
    action: "manuscript-save",
    event: event.toLowerCase().replace(/_/g, "-"),
    duration_ms: fields.durationMs,
    metadata,
  });
  traceWorkbenchClose(event, {
    module: "manuscript",
    detail: `chapter=${traceChapterId(fields.chapterId ?? null) ?? "none"}`,
    durationMs: fields.durationMs,
    result: fields.result ?? null,
  });
}

type NoticeKind = "ok" | "error" | "info";
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
type DeleteTarget =
  | { kind: "chapter"; chapter: NovelChapterSummary }
  | { kind: "volume"; volume: NovelVolume };

export interface NovelManuscriptPanelProps {
  projectId: string;
  archived: boolean;
  onNotice: (kind: NoticeKind, text: string) => void;
  /**
   * 向父级注册「离开前落盘」回调：父级切换模块/项目时必须 await 它，
   * 返回 false 表示保存失败、应取消离开。卸载时注册 null。
   */
  registerFlush?: (flush: (() => Promise<boolean>) | null) => void;
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
  registerFlush,
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
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mountedRef = useRef(true);
  const projectRef = useRef(projectId);
  const projectChangeTokenRef = useRef(0);
  const archivedRef = useRef(archived);
  const selectedRef = useRef<string | null>(null);
  const draftRef = useRef("");
  const savedRef = useRef("");
  /** 当前在途的唯一正文保存请求；同一章节绝不并发写。 */
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<number | null>(null);
  const loadTokenRef = useRef(0);
  const chapterTokenRef = useRef(0);
  const skipRenameBlurRef = useRef(false);
  const deleteBusyRef = useRef(false);
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  // 通知回调只用于提示，不参与正文读取的 effect 依赖；父级重渲染不应触发重新读库。
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;

  selectedRef.current = selectedId;
  draftRef.current = draft;
  archivedRef.current = archived;

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

  // 项目切换：父级 selectProject 必须先 await flush，但这里仍做最后一道异步防线。
  // 在 flush 成功前保留旧项目的唯一草稿与界面状态；失败则保留原稿并提示，绝不先清空。
  useEffect(() => {
    if (projectRef.current === projectId) return;
    const token = projectChangeTokenRef.current + 1;
    projectChangeTokenRef.current = token;
    void (async () => {
      const ok = await flushRef.current();
      if (!mountedRef.current || token !== projectChangeTokenRef.current) return;
      if (!ok) {
        onNoticeRef.current("error", "项目切换已取消：正文尚未保存，已保留当前草稿");
        return;
      }
      projectRef.current = projectId;
      clearTimer();
      savePromiseRef.current = null;
      setVolumes([]);
      setChapters([]);
      setSelectedId(null);
      setChapter(null);
      setDraft("");
      savedRef.current = "";
      setSaveState("idle");
      setRenaming(null);
      setDeleteTarget(null);
      setDeleteError(null);
      void loadTree();
    })();
  }, [projectId, clearTimer, loadTree]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const persistOnce = useCallback(
    async (chapterId: string, targetProject: string, content: string): Promise<boolean> => {
      const startedAt = performance.now();
      // 只记章节短 ID 与状态；content 绝不上送。
      manuscriptTrace("MANUSCRIPT_SAVE_STARTED", {
        chapterId,
        dirty: true,
        archived: archivedRef.current,
      });
      if (mountedRef.current) setSaveState("saving");
      try {
        const result = await novelChapterSaveContent(chapterId, content);
        // 数据已落库：同一项目/同一章内即使组件已卸载，也要更新已保存基线，
        // 否则卸载后的 flush 循环会误判草稿仍脏并无限重复写库。
        if (projectRef.current === targetProject && selectedRef.current === chapterId) {
          savedRef.current = content;
          if (mountedRef.current) {
            setChapters((prev) =>
              prev.map((c) =>
                c.id === chapterId
                  ? { ...c, wordCount: result.chapter.wordCount, updatedAt: result.chapter.updatedAt }
                  : c,
              ),
            );
            setSaveState(draftRef.current === content ? "saved" : "pending");
          }
        }
        manuscriptTrace("MANUSCRIPT_SAVE_COMPLETED", {
          chapterId,
          durationMs: elapsedMs(startedAt),
          result: "ok",
        });
        return true;
      } catch (e) {
        // 保存失败的原始 message 可能含路径：只进诊断中心（Rust 侧会过滤），
        // 终端 trace 只记 result=error。
        manuscriptTrace("MANUSCRIPT_SAVE_FAILED", {
          chapterId,
          durationMs: elapsedMs(startedAt),
          result: "error",
        });
        if (mountedRef.current) setSaveState("error");
        onNotice("error", `正文保存失败：${errorMessage(e)}`);
        return false;
      }
    },
    [onNotice],
  );

  /**
   * 单章节串行落盘：同一时刻只允许一个请求；请求结束后若最新草稿仍未保存，
   * 自动再写一次最新版本。并发调用者共享同一轮在途请求，不会产生乱序写入。
   */
  const flush = useCallback(async (): Promise<boolean> => {
    clearTimer();
    const chapterId = selectedRef.current;
    if (!chapterId) return true;
    const targetProject = projectRef.current;
    const startedAt = performance.now();
    manuscriptTrace("MANUSCRIPT_FLUSH_STARTED", {
      chapterId,
      dirty: draftRef.current !== savedRef.current,
      inflight: savePromiseRef.current !== null,
      archived: archivedRef.current,
    });
    /** 所有出口都留一条完成记录：STARTED 没有配对就是「卡在某个 await」的直接证据。 */
    const done = (ok: boolean, result: string): boolean => {
      manuscriptTrace("MANUSCRIPT_FLUSH_COMPLETED", {
        chapterId,
        dirty: draftRef.current !== savedRef.current,
        inflight: savePromiseRef.current !== null,
        archived: archivedRef.current,
        durationMs: elapsedMs(startedAt),
        result,
      });
      return ok;
    };
    /** 归档只读：脏稿无法写库，必须明确拒绝（不能静默丢弃）。 */
    const archivedBlocked = (): boolean => {
      if (mountedRef.current) setSaveState("error");
      onNotice("error", "项目已归档，未保存的正文无法写入；请先恢复为进行中");
      return done(false, "archived");
    };
    if (archivedRef.current) {
      if (draftRef.current === savedRef.current) {
        manuscriptTrace("MANUSCRIPT_FLUSH_SKIPPED_CLEAN", { chapterId, archived: true });
        return done(true, "clean");
      }
      return archivedBlocked();
    }
    while (true) {
      if (selectedRef.current !== chapterId || projectRef.current !== targetProject) {
        // 已离开该章节/项目，旧请求不再影响新界面。
        return done(true, "left");
      }
      if (archivedRef.current) {
        return archivedBlocked();
      }
      if (draftRef.current === savedRef.current) {
        if (mountedRef.current) {
          setSaveState((s) => (s === "pending" || s === "saving" ? "saved" : s));
        }
        manuscriptTrace("MANUSCRIPT_FLUSH_SKIPPED_CLEAN", { chapterId });
        return done(true, "clean");
      }
      if (savePromiseRef.current) {
        // 复用同一笔在途保存：并发 flush 不产生第二次写入。
        manuscriptTrace("MANUSCRIPT_FLUSH_WAIT_EXISTING_SAVE", {
          chapterId,
          dirty: true,
          inflight: true,
        });
        if (!(await savePromiseRef.current)) return done(false, "inflight-failed");
        continue;
      }
      const content = draftRef.current;
      const promise = persistOnce(chapterId, targetProject, content);
      savePromiseRef.current = promise;
      const ok = await promise;
      if (savePromiseRef.current === promise) savePromiseRef.current = null;
      if (!ok) return done(false, "save-failed");
      // 继续循环：若用户在保存期间又输入，自动提交最新草稿。
    }
  }, [clearTimer, onNotice, persistOnce]);

  flushRef.current = flush;

  // 向父级注册离开前保存协议；父级切模块/切项目必须 await 它。
  useEffect(() => {
    if (!registerFlush) return;
    registerFlush(() => flushRef.current());
    return () => registerFlush(null);
  }, [registerFlush]);

  // 卸载兜底：不复用旧闭包、不再直接发裸 IPC；与在途请求串行并补交最新草稿。
  // 注意：窗口被强杀时无法等待完成，见验收报告的未验证项。
  useEffect(() => {
    return () => {
      void flushRef.current();
    };
  }, []);

  // 防抖自动保存：正文变化立即标记 pending；900ms 后走同一个串行 flush。
  useEffect(() => {
    draftRef.current = draft;
    if (!selectedId || chapterLoading) return;
    if (archived) {
      if (draft !== savedRef.current) setSaveState("error");
      return;
    }
    if (draft === savedRef.current) {
      if (timerRef.current === null) setSaveState((s) => (s === "error" ? s : "idle"));
      return;
    }
    setSaveState((s) => (s === "saving" ? s : "pending"));
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flushRef.current();
    }, AUTOSAVE_MS);
    return clearTimer;
  }, [draft, selectedId, chapterLoading, archived, clearTimer]);

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
        onNoticeRef.current("error", `读取章节失败：${errorMessage(e)}`);
      })
      .finally(() => {
        if (mountedRef.current && token === chapterTokenRef.current) setChapterLoading(false);
      });
    return () => {
      chapterTokenRef.current += 1;
    };
  }, [selectedId]);

  // 归档时立即关闭所有可写交互；已输入的正文草稿保留在 textarea，恢复后可重试保存。
  useEffect(() => {
    if (!archived) return;
    setRenaming(null);
    setDeleteTarget(null);
    setDeleteError(null);
    setNewVolumeTitle("");
    setRenameDraft("");
    skipRenameBlurRef.current = true;
  }, [archived]);

  const selectChapter = useCallback(
    async (id: string) => {
      if (id === selectedRef.current) return;
      // 保存失败时停留在当前章，避免用下一章覆盖未落盘的草稿。
      if (!(await flushRef.current())) return;
      setSelectedId(id);
    },
    [],
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
      // 新建前先把当前章草稿落盘；失败则中止，避免切走后丢正文。
      if (!(await flushRef.current())) return;
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
      setDeleteTarget(null);
    },
    [archived, onNotice],
  );

  const submitRename = useCallback(async () => {
    if (skipRenameBlurRef.current) {
      skipRenameBlurRef.current = false;
      return;
    }
    if (!renaming) return;
    if (archivedRef.current) {
      setRenaming(null);
      return;
    }
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
    [sortedVolumes, projectId, runBusy, onNotice, loadTree, archived],
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
    [chapters, chaptersOf, unfiledChapters, projectId, runBusy, onNotice, loadTree, archived],
  );

  const settleInFlight = useCallback(async () => {
    clearTimer();
    const pending = savePromiseRef.current;
    if (!pending) return;
    // 删除/丢弃也必须等已发出的正文请求彻底结束，不能让旧请求在删除后再写库。
    await pending;
    if (savePromiseRef.current === pending) savePromiseRef.current = null;
  }, [clearTimer]);

  const requestDeleteChapter = useCallback(
    (item: NovelChapterSummary) => {
      if (archived || busy || deleteBusyRef.current || chapterLoading) return;
      setDeleteError(null);
      setDeleteTarget({ kind: "chapter", chapter: item });
    },
    [archived, busy, chapterLoading],
  );

  const requestDeleteVolume = useCallback(
    (volume: NovelVolume) => {
      if (archived || busy || deleteBusyRef.current || chapterLoading) return;
      setDeleteError(null);
      setDeleteTarget({ kind: "volume", volume });
    },
    [archived, busy, chapterLoading],
  );

  const closeDeleteDialog = useCallback(() => {
    if (deleteBusyRef.current || busy) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }, [busy]);

  const confirmDelete = useCallback(
    async (discardDraft: boolean) => {
      if (!deleteTarget || archivedRef.current || deleteBusyRef.current) return;
      deleteBusyRef.current = true;
      setDeleteError(null);
      try {
        await runBusy(async () => {
          const target = deleteTarget;
          const currentSelected = selectedRef.current;
          const currentInTarget =
            target.kind === "chapter"
              ? currentSelected === target.chapter.id
              : chapters.some(
                  (c) => c.id === currentSelected && c.volumeId === target.volume.id,
                );

          if (currentInTarget) {
            if (!discardDraft) {
              // 保存后删除：flush 会先等待在途请求，再补交最新草稿。
              if (!(await flushRef.current())) {
                setDeleteError("正文保存失败，已取消删除；当前草稿仍保留，可重试。");
                return;
              }
            } else {
              // 明确丢弃：不再发起新保存，但必须先等待已经发出的请求结束。
              clearTimer();
              selectedRef.current = null;
              await settleInFlight();
            }
          }

          if (currentInTarget) selectedRef.current = null;
          try {
            if (target.kind === "chapter") {
              await novelChapterDelete(target.chapter.id);
            } else {
              await novelVolumeDelete(target.volume.id);
            }
          } catch (e) {
            if (currentInTarget) selectedRef.current = currentSelected;
            setDeleteError(`删除失败：${errorMessage(e)}`);
            onNotice("error", `删除失败：${errorMessage(e)}`);
            return;
          }

          clearTimer();
          if (target.kind === "chapter") {
            setChapters((prev) => prev.filter((c) => c.id !== target.chapter.id));
            if (currentInTarget) {
              chapterTokenRef.current += 1;
              setSelectedId(null);
              setChapter(null);
              setDraft("");
              savedRef.current = "";
              setSaveState("idle");
            }
            onNotice("ok", `已删除章节「${target.chapter.title}」`);
          } else {
            const removed = chapters.filter((c) => c.volumeId === target.volume.id);
            setVolumes((prev) => prev.filter((v) => v.id !== target.volume.id));
            setChapters((prev) => prev.filter((c) => c.volumeId !== target.volume.id));
            if (currentInTarget) {
              chapterTokenRef.current += 1;
              setSelectedId(null);
              setChapter(null);
              setDraft("");
              savedRef.current = "";
              setSaveState("idle");
            }
            onNotice("ok", `已删除卷「${target.volume.title}」及其 ${removed.length} 章`);
          }
          setDeleteTarget(null);
          setDeleteError(null);
        });
      } finally {
        deleteBusyRef.current = false;
      }
    },
    [
      deleteTarget,
      runBusy,
      chapters,
      clearTimer,
      settleInFlight,
      onNotice,
    ],
  );

  const renderChapterRow = (item: NovelChapterSummary) => {
    const isSelected = selectedId === item.id;
    const isRenaming = renaming === item.id;
    const bucketSize = (item.volumeId === null ? unfiledChapters : chaptersOf(item.volumeId)).length;
    const bucketIndex = (item.volumeId === null ? unfiledChapters : chaptersOf(item.volumeId)).findIndex(
      (c) => c.id === item.id,
    );
    return (
      <div
        key={item.id}
        className={`manuscript-chapter ${isSelected ? "is-active" : ""}`}
      >
        {isRenaming ? (
          <input
            className="ws-input ws-flex manuscript-rename-input"
            value={renameDraft}
            autoFocus
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void submitRename();
                skipRenameBlurRef.current = true;
              }
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
            className="manuscript-chapter-title"
            onClick={() => void selectChapter(item.id)}
            aria-current={isSelected ? "true" : undefined}
          >
            {item.title}
          </button>
        )}
        <span className="manuscript-count">{item.wordCount} 字</span>
        {!isRenaming && (
          <span className="manuscript-row-actions">
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              aria-label={`重命名章节「${item.title}」`}
              disabled={busy || archived}
              onClick={() => startRename(item.id, item.title)}
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              aria-label={`上移章节「${item.title}」`}
              disabled={busy || archived || bucketIndex <= 0}
              onClick={() => void reorderChapters(item.id, -1)}
            >
              <ChevronUp size={11} />
            </button>
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              aria-label={`下移章节「${item.title}」`}
              disabled={busy || archived || bucketIndex < 0 || bucketIndex >= bucketSize - 1}
              onClick={() => void reorderChapters(item.id, 1)}
            >
              <ChevronDown size={11} />
            </button>
            <button
              type="button"
              className="ws-btn ws-btn-quiet"
              aria-label={`删除章节「${item.title}」`}
              disabled={busy || archived || chapterLoading}
              onClick={() => requestDeleteChapter(item)}
            >
              <Trash2 size={11} />
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
    const index = volume ? sortedVolumes.findIndex((v) => v.id === volume.id) : -1;
    return (
      <section className="manuscript-volume" key={key} aria-label={title}>
        <header className="manuscript-volume-head">
          {isRenaming && volume ? (
            <input
              className="ws-input ws-flex manuscript-rename-input"
              value={renameDraft}
              autoFocus
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void submitRename();
                  skipRenameBlurRef.current = true;
                }
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
              className="manuscript-volume-title"
              onClick={() => volume && startRename(volume.id, volume.title)}
              disabled={!volume || archived}
              data-tip={volume ? "点击重命名" : undefined}
            >
              {title}
            </button>
          )}
          <span className="manuscript-count">{words} 字</span>
          {volume && !isRenaming && (
            <span className="manuscript-row-actions">
              <button
                type="button"
                className="ws-btn ws-btn-quiet"
                aria-label={`上移卷「${volume.title}」`}
                disabled={busy || archived || index <= 0}
                onClick={() => void reorderVolumes(volume.id, -1)}
              >
                <ChevronUp size={11} />
              </button>
              <button
                type="button"
                className="ws-btn ws-btn-quiet"
                aria-label={`下移卷「${volume.title}」`}
                disabled={busy || archived || index < 0 || index >= sortedVolumes.length - 1}
                onClick={() => void reorderVolumes(volume.id, 1)}
              >
                <ChevronDown size={11} />
              </button>
              <button
                type="button"
                className="ws-btn ws-btn-quiet"
                aria-label={`删除卷「${volume.title}」及其章节`}
                disabled={busy || archived || chapterLoading}
                onClick={() => requestDeleteVolume(volume)}
              >
                <Trash2 size={11} />
              </button>
            </span>
          )}
        </header>
        {rows.length === 0 && <div className="manuscript-empty-row">本卷还没有章节</div>}
        {rows.map(renderChapterRow)}
        <div className="manuscript-add">
          <button
            type="button"
            className="ws-btn manuscript-add-btn"
            disabled={busy || archived}
            onClick={() => void addChapter(volume ? volume.id : null)}
          >
            <Plus size={11} /> 新建章节
          </button>
        </div>
      </section>
    );
  };

  const deleteInfo = useMemo(() => {
    if (!deleteTarget) return null;
    if (deleteTarget.kind === "chapter") {
      const row = chapters.find((c) => c.id === deleteTarget.chapter.id) ?? deleteTarget.chapter;
      const isCurrent = selectedRef.current === row.id;
      const words = isCurrent && !chapterLoading ? countWords(draft) : row.wordCount;
      const dirty =
        isCurrent && (draft !== savedRef.current || savePromiseRef.current !== null);
      return {
        kind: "chapter" as const,
        title: row.title,
        words,
        chapterCount: 1,
        isCurrent,
        dirty,
      };
    }
    const volume = volumes.find((v) => v.id === deleteTarget.volume.id) ?? deleteTarget.volume;
    const rows = chapters.filter((c) => c.volumeId === volume.id);
    const current = rows.find((c) => c.id === selectedRef.current);
    const isCurrent = Boolean(current);
    const words = rows.reduce((sum, c) => {
      if (isCurrent && current && !chapterLoading && c.id === current.id) {
        return sum - c.wordCount + countWords(draft);
      }
      return sum + c.wordCount;
    }, 0);
    const dirty =
      isCurrent && (draft !== savedRef.current || savePromiseRef.current !== null);
    return {
      kind: "volume" as const,
      title: volume.title,
      words,
      chapterCount: rows.length,
      isCurrent,
      dirty,
    };
  }, [deleteTarget, chapters, volumes, draft, selectedId, chapterLoading, saveState]);

  const saveLabel = (() => {
    if (archived) {
      return draft !== savedRef.current ? "项目已归档，正文未保存" : "项目已归档，只读";
    }
    if (chapterLoading) return "读取正文…";
    if (saveState === "saving") return "保存中…";
    if (saveState === "saved") return "已自动保存";
    if (saveState === "error") return "保存失败，可重试";
    if (saveState === "pending") return "待保存";
    if (selectedId && draft !== savedRef.current) return "待保存";
    return "自动保存已开启";
  })();
  const saveTone = archived && draft !== savedRef.current ? "error" : saveState;

  return (
    <div className="manuscript-root">
      <WorkspaceSplit
        id="novel-manuscript"
        sidebarLabel="卷与章节"
        defaultWidth={300}
        minWidth={240}
        maxWidth={400}
        sidebar={
          <div className="manuscript-tree">
            <div className="manuscript-tree-head">
              <span className="manuscript-eyebrow">正文</span>
              <strong>卷与章节</strong>
              <span className="ws-meta">
                全书 {totalWords} 字 · {chapters.length} 章
              </span>
            </div>
            <div className="manuscript-toolbar">
              <input
                className="ws-input manuscript-volume-input"
                placeholder="新建卷标题"
                aria-label="新建卷标题"
                value={newVolumeTitle}
                disabled={archived || busy}
                onChange={(e) => setNewVolumeTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addVolume();
                }}
              />
              <button
                type="button"
                className="ws-btn ws-btn-primary manuscript-new-volume"
                disabled={archived || busy || !newVolumeTitle.trim()}
                onClick={() => void addVolume()}
              >
                <Plus size={11} /> 新建卷
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
            <div className="manuscript-tree-scroll">
              {loading ? (
                <div className="ws-state" data-tone="muted">
                  <Loader2 size={12} className="ws-spin" /> 正在读取卷与章节…
                </div>
              ) : (
                <>
                  {sortedVolumes.map((volume) => renderVolumeBlock(volume))}
                  {renderVolumeBlock(null)}
                  {sortedVolumes.length === 0 && visibleChapters.length === 0 && (
                    <div className="manuscript-empty-tree">
                      还没有内容。先新建一卷，或直接在「未分卷」下写第一章。
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        }
      >
        {/* 右侧：纯文本写作区 */}
        <section className="manuscript-editor" aria-label="正文编辑器">
          {!selectedId && !chapterLoading && (
            <div className="manuscript-editor-empty">
              <span className="manuscript-empty-icon" aria-hidden="true">
                <BookOpen size={22} />
              </span>
              <h3>还没有选中的章节</h3>
              <p>正文按章保存到本地数据库，不写入外部文件。你可以：</p>
              <ul className="manuscript-empty-list">
                <li>在左侧新建一卷，再在卷下新建章节；</li>
                <li>或直接在「未分卷」下写第一章。</li>
              </ul>
              <div className="manuscript-empty-actions">
                <button
                  type="button"
                  className="ws-btn ws-btn-primary"
                  disabled={archived || busy}
                  onClick={() => void addChapter(null)}
                >
                  <Plus size={12} /> 新建第一章
                </button>
              </div>
              {archived && (
                <p className="ws-meta">项目已归档：恢复为进行中后才能新建或编辑章节。</p>
              )}
            </div>
          )}
          {selectedId && chapterLoading && (
            <div className="ws-state" data-tone="muted">
              <Loader2 size={12} className="ws-spin" /> 正在读取正文…
            </div>
          )}
          {selectedId && !chapterLoading && (
            <>
              <header className="manuscript-editor-head">
                <div className="manuscript-editor-title-group">
                  <strong className="manuscript-editor-title">
                    {chapter?.title ?? "（章节已删除）"}
                  </strong>
                  <div className="manuscript-editor-stats">
                    <span>本章 {currentWordCount} 字</span>
                    <span aria-hidden="true">·</span>
                    <span>全书 {totalWords} 字</span>
                  </div>
                </div>
                <span className="manuscript-save" data-tone={saveTone}>
                  {saveState === "saved" && <CheckCircle2 size={12} />}
                  {(saveState === "error" || saveTone === "error") && <AlertCircle size={12} />}
                  {(saveState === "pending" || saveState === "saving") && (
                    <span className="manuscript-save-dot" aria-hidden="true" />
                  )}
                  {saveLabel}
                </span>
                {saveState === "error" && !archived && (
                  <button
                    type="button"
                    className="ws-btn"
                    onClick={() => void flushRef.current()}
                  >
                    重试保存
                  </button>
                )}
              </header>
              {archived && (
                <div className="ws-notice" data-tone="info">
                  项目已归档：正文可查看，恢复为进行中后才能继续编辑。
                </div>
              )}
              <textarea
                className="manuscript-textarea"
                value={draft}
                readOnly={archived}
                spellCheck={false}
                placeholder="在这里写正文…（纯文本，自动保存）"
                aria-label={`${chapter?.title ?? "章节"}正文`}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  if (!archived) void flushRef.current();
                }}
              />
              <div className="manuscript-editor-hint">
                停止输入约 {AUTOSAVE_MS / 1000} 秒后自动写入本地数据库；失焦、切换章节、切换模块与切换项目时立即保存。
                纯文本保存，不解析 Markdown；单章上限 8 MiB。
              </div>
            </>
          )}
        </section>
      </WorkspaceSplit>

      {deleteTarget && deleteInfo && (
        <Dialog
          open
          title={deleteInfo.kind === "chapter" ? "删除章节" : "删除卷"}
          onClose={closeDeleteDialog}
          dismissOnScrim={false}
          size="sm"
          ariaLabel={deleteInfo.kind === "chapter" ? "确认删除章节" : "确认删除卷"}
          footer={
            <>
              <button type="button" className="ws-btn" disabled={busy} onClick={closeDeleteDialog}>
                取消
              </button>
              {deleteInfo.dirty && (
                <button
                  type="button"
                  className="ws-btn ws-btn-danger"
                  disabled={busy}
                  onClick={() => void confirmDelete(true)}
                >
                  丢弃草稿并删除
                </button>
              )}
              <button
                type="button"
                className="ws-btn ws-btn-danger"
                disabled={busy}
                onClick={() => void confirmDelete(false)}
              >
                {busy ? (
                  <>
                    <Loader2 size={11} className="ws-spin" /> 删除中…
                  </>
                ) : deleteInfo.dirty ? (
                  "保存后删除"
                ) : (
                  "删除"
                )}
              </button>
            </>
          }
        >
          <p>
            确定删除{deleteInfo.kind === "chapter" ? "章节" : "卷"}「{deleteInfo.title}」？
          </p>
          <ul className="ws-novel-delete-facts">
            {deleteInfo.kind === "volume" ? (
              <>
                <li>卷内章节：{deleteInfo.chapterCount} 章</li>
                <li>正文总字数：{deleteInfo.words} 字</li>
                <li>当前正在编辑该卷章节：{deleteInfo.isCurrent ? "是" : "否"}</li>
              </>
            ) : (
              <li>本章字数：{deleteInfo.words} 字</li>
            )}
            <li>未保存草稿：{deleteInfo.dirty ? "有" : "无"}</li>
          </ul>
          {deleteInfo.kind === "volume" ? (
            <p className="ws-novel-delete-warning">
              删除卷会级联删除该卷全部章节和正文，删除后不可通过普通撤销恢复。
            </p>
          ) : (
            <p className="ws-novel-delete-warning">删除后正文不可恢复。</p>
          )}
          {deleteInfo.dirty && (
            <p className="ws-novel-delete-warning">
              「保存后删除」会先落盘最新草稿；「丢弃草稿并删除」会明确放弃未保存修改。
            </p>
          )}
          {deleteError && (
            <div className="ws-notice" data-tone="error" role="alert">
              <AlertCircle size={13} />
              <span>{deleteError}</span>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
