//! 快速笔记 store：列表 / 编辑 / 自动保存 / 草稿恢复 / 冲突处理 / 收集箱转笔记。
//!
//! 自动保存契约（四态：编辑中 / 保存中 / 已保存 / 保存失败）：
//! - 输入只改内存草稿，防抖 700ms 后才写库，绝不每字符写库；
//! - 同一笔记的保存串行执行：保存中再输入只标记排队，成功后用最新草稿再存一次，
//!   旧请求不可能覆盖新内容；
//! - 只有后端返回成功才进入「已保存」；失败保留草稿并标记「保存失败」，可重试；
//! - 每次输入同步写 `localStorage` 草稿（仍防抖 300ms），应用退出 / 异常后重开
//!   若与库内内容不同则恢复为未保存草稿并明确提示；
//! - 切换笔记前先冲刷当前草稿；快速连点用代际 token 防止旧响应覆盖新选中项；
//! - 并发编辑用 `revision`：冲突时停止自动保存、保留本地草稿，用户可显式覆盖。
//!
//! IPC 说明：`bridge.ts` 属于并行会话共享文件，本任务不改动；命令封装暂时收敛
//! 在本 store（统一走 `invokeCommand`），集成会话可按 `integration.md` 平移到
//! `src/lib/bridge.ts`，行为不受影响。

import { create } from "zustand";

import { listTasks, workspaceList } from "../lib/bridge";
import { errorMessage, invokeCommand, normalizeError } from "../lib/errors";

export const AUTOSAVE_DELAY_MS = 700;
export const DRAFT_PERSIST_DELAY_MS = 300;
export const SEARCH_DELAY_MS = 250;
export const LIST_LIMIT = 100;

export interface NoteSummary {
  id: string;
  title: string;
  excerpt: string;
  pinned: boolean;
  favorite: boolean;
  task_id: string | null;
  workspace_id: string | null;
  source_capture_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  content_chars: number;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  favorite: boolean;
  task_id: string | null;
  workspace_id: string | null;
  source_capture_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface NoteTemplate {
  id: string;
  name: string;
  content: string;
}

export interface NoteDraft {
  title: string;
  content: string;
}

export interface ConvertResult {
  note: Note;
  duplicate: boolean;
}

export type NotesFilter = "all" | "pinned" | "favorite";
export type SaveState = "editing" | "saving" | "saved" | "failed";

export interface NoteLinkOptions {
  tasks: Array<{ id: string; title: string }>;
  workspaces: Array<{ id: string; name: string }>;
}

interface StoredDraft extends NoteDraft {
  at: string;
}

/** 一次待写入的不可变草稿快照。 */
interface SaveSnapshot extends NoteDraft {
  id: string;
  revision: number;
}

const DRAFT_KEY_PREFIX = "taskdock.notes.draft.";

// ── 模块级运行时：防抖计时器 / 每笔记串行保存 / 排队标记 ───────────

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, Promise<Note | null>>();
/** 待写入快照：切换笔记后旧笔记仍可能在后台保存，不能依赖当前编辑态。 */
const pendingSnapshots = new Map<string, SaveSnapshot>();
/** 已确认的最新 revision，避免排队快照携带过期基线造成误报冲突。 */
const revisionCache = new Map<string, number>();
/** 最近一次已提交内容，用于跳过重复的 Ctrl+S / 冲刷请求。 */
const lastSubmitted = new Map<string, { title: string; content: string }>();
const forced = new Set<string>();
/** 按笔记 id 记录未解决的 revision 冲突；跨选中切换保留，直到覆盖保存或放弃。 */
const conflictNotes = new Map<string, string>();
let listSeq = 0;
let selectSeq = 0;
let queryTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(map: Map<string, ReturnType<typeof setTimeout>>, id: string) {
  const timer = map.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    map.delete(id);
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function draftKey(id: string) {
  return `${DRAFT_KEY_PREFIX}${id}`;
}

function readLocalDraft(id: string): StoredDraft | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(draftKey(id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof parsed.title !== "string" || typeof parsed.content !== "string") return null;
    return { title: parsed.title, content: parsed.content, at: String(parsed.at ?? "") };
  } catch {
    return null;
  }
}

function writeLocalDraft(id: string, draft: NoteDraft) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(draftKey(id), JSON.stringify({ ...draft, at: new Date().toISOString() }));
  } catch {
    // 存储配额不足时静默降级：库内保存仍是权威，不能阻断编辑。
  }
}

function clearLocalDraft(id: string) {
  clearTimer(draftTimers, id);
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(draftKey(id));
  } catch {
    // 忽略清理失败
  }
}

function excerptOf(content: string): string {
  const flat = content.split(/\s+/).filter(Boolean).join(" ");
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

function summaryFromNote(note: Note): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    excerpt: excerptOf(note.content),
    pinned: note.pinned,
    favorite: note.favorite,
    task_id: note.task_id,
    workspace_id: note.workspace_id,
    source_capture_id: note.source_capture_id,
    revision: note.revision,
    created_at: note.created_at,
    updated_at: note.updated_at,
    content_chars: note.content.length,
  };
}

function mergeSummary(previous: NoteSummary, note: Note): NoteSummary {
  return { ...summaryFromNote(note), created_at: previous.created_at };
}

/** 返回删除指定键后的新记录（不修改入参）。 */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export type NotesState = {
  items: NoteSummary[];
  query: string;
  filter: NotesFilter;
  loading: boolean;
  listError: string | null;

  activeId: string | null;
  active: Note | null;
  draft: NoteDraft | null;
  dirty: boolean;
  saveState: SaveState;
  saveError: string | null;
  savedAt: string | null;
  conflict: boolean;
  restored: boolean;
  loadingNote: boolean;
  /** 按笔记 id 记录最近一次自动保存失败/冲突原因；列表据此显示未保存徽标。 */
  saveFailures: Record<string, string>;

  templates: NoteTemplate[];
  templatesLoaded: boolean;
  linkOptions: NoteLinkOptions;
  linkOptionsLoading: boolean;
};

export type NotesActions = {
  load: (opts?: { silent?: boolean }) => Promise<void>;
  setQuery: (query: string) => void;
  setFilter: (filter: NotesFilter) => void;
  create: () => Promise<Note>;
  select: (id: string | null) => Promise<void>;
  updateDraft: (patch: Partial<NoteDraft>) => void;
  flushSave: () => Promise<void>;
  retrySave: (force?: boolean) => Promise<void>;
  /** 冲突时放弃本地草稿，重新读取库内最新内容（不覆盖他人修改）。 */
  reloadFromServer: () => Promise<void>;
  togglePin: () => Promise<void>;
  toggleFavorite: () => Promise<void>;
  linkTask: (taskId: string | null) => Promise<void>;
  linkWorkspace: (workspaceId: string | null) => Promise<void>;
  remove: (id?: string) => Promise<boolean>;
  applyTemplate: (templateId: string) => void;
  loadTemplates: () => Promise<void>;
  loadLinkOptions: () => Promise<void>;
  convertCapture: (captureId: string) => Promise<ConvertResult>;
  /** 同步落盘当前草稿（应用关闭 / 页面隐藏时调用）。 */
  persistLocalDraft: () => void;
};

const initialState: NotesState = {
  items: [],
  query: "",
  filter: "all",
  loading: false,
  listError: null,
  activeId: null,
  active: null,
  draft: null,
  dirty: false,
  saveState: "saved",
  saveError: null,
  savedAt: null,
  conflict: false,
  restored: false,
  loadingNote: false,
  saveFailures: {},
  templates: [],
  templatesLoaded: false,
  linkOptions: { tasks: [], workspaces: [] },
  linkOptionsLoading: false,
};

export const useNotesStore = create<NotesState & NotesActions>((set, get) => {  const captureSnapshot = (id: string): SaveSnapshot | null => {
    const state = get();
    if (state.activeId !== id || !state.active || !state.draft) return null;
    return {
      id,
      title: state.draft.title,
      content: state.draft.content,
      revision: state.active.revision,
    };
  };

  const revisionOf = (snapshot: SaveSnapshot) =>
    Math.max(snapshot.revision, revisionCache.get(snapshot.id) ?? 0);

  const scheduleDraftPersist = (id: string) => {
    clearTimer(draftTimers, id);
    draftTimers.set(
      id,
      setTimeout(() => {
        draftTimers.delete(id);
        const snapshot = captureSnapshot(id);
        if (snapshot) writeLocalDraft(id, snapshot);
      }, DRAFT_PERSIST_DELAY_MS),
    );
  };

  const applySaved = (
    id: string,
    snapshot: { title: string; content: string },
    note: Note,
  ) => {
    revisionCache.set(id, note.revision);
    conflictNotes.delete(id);
    set((state) => {
      const saveFailures = withoutKey(state.saveFailures, id);
      const items = state.items.map((item) =>
        item.id === id ? mergeSummary(item, note) : item,
      );
      if (state.activeId !== id) return { items, saveFailures };
      const draft = state.draft;
      const typedSince = !!draft && (draft.title !== snapshot.title || draft.content !== snapshot.content);
      return {
        items,
        active: state.active
          ? {
              ...state.active,
              title: note.title,
              content: note.content,
              pinned: note.pinned,
              favorite: note.favorite,
              task_id: note.task_id,
              workspace_id: note.workspace_id,
              revision: note.revision,
              updated_at: note.updated_at,
            }
          : state.active,
        dirty: typedSince,
        saveState: typedSince ? "editing" : "saved",
        saveError: null,
        savedAt: typedSince ? state.savedAt : note.updated_at,
        conflict: false,
        restored: typedSince ? state.restored : false,
      };
    });
  };

  const handleSaveFailure = (id: string, error: unknown) => {
    const normalized = normalizeError(error);
    forced.delete(id);
    pendingSnapshots.delete(id);
    const snapshot = captureSnapshot(id);
    if (snapshot) writeLocalDraft(id, snapshot);
    // 冲突要跟随笔记本身，而不是只存在于「当前选中」的临时状态：
    // 切走再切回时若丢掉冲突标记，恢复出的草稿会被自动保存，静默覆盖他人修改。
    if (normalized.code === "CONFLICT") conflictNotes.set(id, normalized.message);
    set((state) => {
      const saveFailures = { ...state.saveFailures, [id]: normalized.message };
      if (state.activeId !== id) return { saveFailures };
      return {
        saveFailures,
        saveState: "failed",
        saveError: normalized.message,
        conflict: normalized.code === "CONFLICT",
      };
    });
  };

  /** 串行写入该笔记的快照队列；排队快照使用已确认的最新 revision 作为基线。 */
  const drainSaves = (id: string, initialForce: boolean): Promise<Note | null> => {
    const run = async (): Promise<Note | null> => {
      let saved: Note | null = null;
      let force = initialForce;
      for (;;) {
        const snapshot = pendingSnapshots.get(id);
        if (!snapshot) break;
        pendingSnapshots.delete(id);
        const useForce = forced.delete(id) || force;
        force = false;
        lastSubmitted.set(id, { title: snapshot.title, content: snapshot.content });
        if (get().activeId === id) {
          set({ saveState: "saving", saveError: null });
        }
        try {
          const note = await invokeCommand<Note>("notes_update", {
            id,
            input: {
              title: snapshot.title,
              content: snapshot.content,
              expectedRevision: useForce ? null : revisionOf(snapshot),
              force: useForce,
            },
          });
          saved = note;
          applySaved(id, snapshot, note);
          // 若还有更晚的快照在队列里，把其基线更新为刚确认的 revision。
          const next = pendingSnapshots.get(id);
          if (next) pendingSnapshots.set(id, { ...next, revision: note.revision });

          // 没有更晚的待写快照、当前编辑态也不比已保存内容新，才清理本地草稿。
          const latest = captureSnapshot(id);
          const newer = pendingSnapshots.has(id) ||
            (!!latest && (latest.title !== snapshot.title || latest.content !== snapshot.content));
          if (!newer) clearLocalDraft(id);
        } catch (error) {
          handleSaveFailure(id, error);
          break;
        }
        if (!pendingSnapshots.has(id)) break;
      }
      return saved;
    };

    if (inflight.has(id)) return inflight.get(id)!;
    const promise = run();
    inflight.set(id, promise);
    void promise.finally(() => {
      if (inflight.get(id) === promise) inflight.delete(id);
    });
    return promise;
  };

  const enqueueSnapshot = (snapshot: SaveSnapshot, force: boolean): Promise<Note | null> => {
    pendingSnapshots.set(snapshot.id, snapshot);
    if (force) forced.add(snapshot.id);
    const current = inflight.get(snapshot.id);
    if (!current) return drainSaves(snapshot.id, force);
    // 已有写入在跑：等它结束后若队列仍有快照（如失败后的显式重试）再续跑，
    // 不能直接复用一个可能已经结束的旧 promise，否则新草稿会被丢弃。
    return current.then(() => {
      if (!pendingSnapshots.has(snapshot.id)) return null;
      const running = inflight.get(snapshot.id);
      if (running) return running;
      return drainSaves(snapshot.id, false);
    });
  };

  /** 冲刷当前笔记（切换 / Ctrl+S）。冲突时不自作主张覆盖。 */
  const flushNote = async (id: string) => {
    clearTimer(saveTimers, id);
    const state = get();
    if (state.activeId !== id || !state.active || !state.draft) return;
    if (state.saveState === "failed" && state.conflict) return;
    const snapshot = captureSnapshot(id);
    if (!snapshot) return;
    const submitted = lastSubmitted.get(id);
    if (!state.dirty && submitted &&
        submitted.title === snapshot.title && submitted.content === snapshot.content) {
      return;
    }
    await enqueueSnapshot(snapshot, false);
  };

  /**
   * 离开当前笔记：同步落盘草稿并后台排队保存，立即切换 UI，
   * 不等待网络/磁盘写入；旧笔记的保存结果只更新列表摘要。
   */
  const detachActive = () => {
    const state = get();
    if (!state.activeId || !state.draft) return;
    clearTimer(saveTimers, state.activeId);
    clearTimer(draftTimers, state.activeId);
    if (!state.dirty) return;
    writeLocalDraft(state.activeId, state.draft);
    if (state.conflict) return;
    const snapshot = captureSnapshot(state.activeId);
    if (snapshot) void enqueueSnapshot(snapshot, false);
  };

  const scheduleSave = (id: string) => {
    clearTimer(saveTimers, id);
    saveTimers.set(
      id,
      setTimeout(() => {
        saveTimers.delete(id);
        const current = get();
        if (current.activeId !== id || !current.dirty || current.conflict) return;
        const snapshot = captureSnapshot(id);
        if (snapshot) void enqueueSnapshot(snapshot, false);
      }, AUTOSAVE_DELAY_MS),
    );
  };

  const fetchList = async () => {
    const token = ++listSeq;
    const state = get();
    if (!state.loading) set({ loading: true, listError: null });
    try {
      const items = await invokeCommand<NoteSummary[]>("notes_list", {
        query: state.query.trim() || null,
        pinnedOnly: state.filter === "pinned",
        favoriteOnly: state.filter === "favorite",
        limit: LIST_LIMIT,
        offset: 0,
      });
      if (token !== listSeq) return;
      set({ items, loading: false, listError: null });
    } catch (error) {
      if (token !== listSeq) return;
      set({ loading: false, listError: errorMessage(error) });
    }
  };

  return {
    ...initialState,

    load: async (opts) => {
      if (!opts?.silent) set({ loading: true, listError: null });
      await fetchList();
    },

    setQuery: (query) => {
      set({ query });
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(() => {
        queryTimer = null;
        void fetchList();
      }, SEARCH_DELAY_MS);
    },

    setFilter: (filter) => {
      set({ filter });
      void fetchList();
    },

    create: async () => {
      const note = await invokeCommand<Note>("notes_create", { input: {} });
      set((state) => {
        const exists = state.items.some((item) => item.id === note.id);
        // 新笔记必然不匹配「置顶/收藏」筛选或非空搜索词：不要塞进当前筛选结果，
        // 否则列表会出现一条本不该匹配的条目（清空筛选后由列表查询自然出现）。
        const visible = state.filter === "all" && !state.query.trim();
        return {
          items: exists || !visible ? state.items : [summaryFromNote(note), ...state.items],
        };
      });
      await get().select(note.id);
      return note;
    },

    select: async (id) => {
      const state = get();
      if (!id) {
        detachActive();
        ++selectSeq;
        set({
          activeId: null,
          active: null,
          draft: null,
          dirty: false,
          saveState: "saved",
          saveError: null,
          savedAt: null,
          conflict: false,
          restored: false,
          loadingNote: false,
        });
        return;
      }
      if (state.activeId === id) return;

      // 先同步落盘并后台排队保存旧笔记，UI 立即切换，不阻塞慢写入。
      detachActive();
      const token = ++selectSeq;

      set({
        activeId: id,
        active: null,
        draft: null,
        dirty: false,
        saveState: "saved",
        saveError: null,
        savedAt: null,
        conflict: false,
        restored: false,
        loadingNote: true,
      });

      // 若该笔记仍有后台保存，等它落库后再读，避免读到旧内容。
      const pending = inflight.get(id);
      if (pending) await pending;
      if (token !== selectSeq) return;

      try {
        const note = await invokeCommand<Note>("notes_get", { id });
        if (token !== selectSeq) return;
        revisionCache.set(id, note.revision);
        const local = readLocalDraft(id);
        const differs = !!local && (local.title !== note.title || local.content !== note.content);
        // 该笔记仍有未解决的冲突：恢复出的本地草稿不得自动保存，
        // 必须重新进入「保存失败 + 冲突」态，让用户显式覆盖或放弃。
        const conflictMessage = conflictNotes.get(id) ?? null;
        set({
          active: note,
          draft: differs
            ? { title: local!.title, content: local!.content }
            : { title: note.title, content: note.content },
          dirty: differs,
          saveState: differs
            ? conflictMessage
              ? "failed"
              : "editing"
            : "saved",
          saveError: conflictMessage,
          savedAt: differs ? null : note.updated_at,
          conflict: !!conflictMessage,
          restored: differs,
          loadingNote: false,
        });
        if (differs) {
          scheduleDraftPersist(id);
          // 无冲突的草稿恢复后自动排一次保存；冲突则等待用户选择。
          if (!conflictMessage) scheduleSave(id);
        } else {
          clearLocalDraft(id);
          conflictNotes.delete(id);
          set((state) => ({
            saveFailures: withoutKey(state.saveFailures, id),
            saveError: null,
          }));
        }
      } catch (error) {
        if (token !== selectSeq) return;
        set({
          activeId: null,
          active: null,
          draft: null,
          loadingNote: false,
          listError: errorMessage(error),
        });
      }
    },

    updateDraft: (patch) => {
      const state = get();
      if (!state.active || !state.draft) return;
      const draft = { ...state.draft, ...patch };
      // 冲突未解决时保持「保存失败」态：否则再输入一次就会把冲突提示与
      // 「覆盖保存 / 放弃本地修改」入口一起藏掉，用户只剩一个不可见的分支。
      set({
        draft,
        dirty: true,
        saveState: state.conflict ? "failed" : "editing",
        saveError: state.conflict ? state.saveError : null,
      });
      scheduleDraftPersist(state.active.id);
      if (!state.conflict) scheduleSave(state.active.id);
    },

    flushSave: async () => {
      const state = get();
      if (!state.activeId) return;
      await flushNote(state.activeId);
    },

    retrySave: async (force) => {
      const state = get();
      if (!state.activeId || !state.active || !state.draft) return;
      if (force) {
        conflictNotes.delete(state.activeId);
        set((s) => ({
          conflict: false,
          saveFailures: withoutKey(s.saveFailures, state.activeId!),
        }));
      }
      clearTimer(saveTimers, state.activeId);
      const snapshot = captureSnapshot(state.activeId);
      if (snapshot) await enqueueSnapshot(snapshot, !!force);
    },

    /**
     * 冲突的安全出口：用户明确放弃本地草稿，读取库内最新内容。
     * 后端冲突文案要求「查看最新内容后再保存」，这里提供该动作；
     * 不写库、不触发 force，避免把他人内容覆盖掉。
     */
    reloadFromServer: async () => {
      const id = get().activeId;
      if (!id) return;
      clearTimer(saveTimers, id);
      clearTimer(draftTimers, id);
      pendingSnapshots.delete(id);
      forced.delete(id);
      lastSubmitted.delete(id);
      conflictNotes.delete(id);
      set((s) => ({ saveFailures: withoutKey(s.saveFailures, id) }));
      const pending = inflight.get(id);
      if (pending) await pending;
      if (get().activeId !== id) return;
      // 本地草稿就是冲突内容：先清掉，避免下次 select 又被当作待恢复草稿。
      clearLocalDraft(id);
      try {
        const note = await invokeCommand<Note>("notes_get", { id });
        if (get().activeId !== id) return;
        revisionCache.set(id, note.revision);
        set({
          active: note,
          draft: { title: note.title, content: note.content },
          dirty: false,
          saveState: "saved",
          saveError: null,
          savedAt: note.updated_at,
          conflict: false,
          restored: false,
        });
      } catch (error) {
        if (get().activeId !== id) return;
        set({ saveState: "failed", saveError: errorMessage(error) });
      }
    },

    togglePin: async () => {
      const state = get();
      if (!state.active) return;
      const note = await invokeCommand<Note>("notes_set_flags", {
        id: state.active.id,
        pinned: !state.active.pinned,
      });
      set((s) => ({
        active: s.active && s.active.id === note.id ? { ...s.active, pinned: note.pinned } : s.active,
        items: s.items.map((item) =>
          item.id === note.id ? { ...item, pinned: note.pinned } : item,
        ),
      }));
      await fetchList();
    },

    toggleFavorite: async () => {
      const state = get();
      if (!state.active) return;
      const note = await invokeCommand<Note>("notes_set_flags", {
        id: state.active.id,
        favorite: !state.active.favorite,
      });
      set((s) => ({
        active:
          s.active && s.active.id === note.id
            ? { ...s.active, favorite: note.favorite }
            : s.active,
        items: s.items.map((item) =>
          item.id === note.id ? { ...item, favorite: note.favorite } : item,
        ),
      }));
      await fetchList();
    },

    linkTask: async (taskId) => {
      const state = get();
      if (!state.active) return;
      const note = await invokeCommand<Note>("notes_set_task", {
        id: state.active.id,
        taskId: taskId || null,
      });
      set((s) => ({
        active: s.active && s.active.id === note.id ? { ...s.active, task_id: note.task_id } : s.active,
        items: s.items.map((item) =>
          item.id === note.id ? { ...item, task_id: note.task_id } : item,
        ),
      }));
    },

    linkWorkspace: async (workspaceId) => {
      const state = get();
      if (!state.active) return;
      const note = await invokeCommand<Note>("notes_set_workspace", {
        id: state.active.id,
        workspaceId: workspaceId || null,
      });
      set((s) => ({
        active:
          s.active && s.active.id === note.id
            ? { ...s.active, workspace_id: note.workspace_id }
            : s.active,
        items: s.items.map((item) =>
          item.id === note.id ? { ...item, workspace_id: note.workspace_id } : item,
        ),
      }));
    },

    remove: async (id) => {
      const target = id ?? get().activeId;
      if (!target) return false;
      clearTimer(saveTimers, target);
      clearTimer(draftTimers, target);
      pendingSnapshots.delete(target);
      const pending = inflight.get(target);
      if (pending) await pending;
      const deleted = await invokeCommand<boolean>("notes_delete", { id: target });
      clearLocalDraft(target);
      pendingSnapshots.delete(target);
      revisionCache.delete(target);
      lastSubmitted.delete(target);
      forced.delete(target);
      conflictNotes.delete(target);
      set((s) => ({ saveFailures: withoutKey(s.saveFailures, target) }));
      const state = get();
      const remaining = state.items.filter((item) => item.id !== target);
      set({ items: remaining });
      if (state.activeId === target) {
        set({
          activeId: null,
          active: null,
          draft: null,
          dirty: false,
          saveState: "saved",
          saveError: null,
          savedAt: null,
          conflict: false,
          restored: false,
        });
        if (remaining.length > 0) await get().select(remaining[0].id);
      }
      return deleted;
    },

    applyTemplate: (templateId) => {
      const state = get();
      const template = state.templates.find((item) => item.id === templateId);
      if (!template || !state.draft) return;
      const base = state.draft.content.replace(/\s+$/, "");
      const content = base ? `${base}\n\n${template.content}` : template.content;
      get().updateDraft({ content });
    },

    loadTemplates: async () => {
      if (get().templatesLoaded) return;
      try {
        const templates = await invokeCommand<NoteTemplate[]>("notes_templates");
        set({ templates, templatesLoaded: true });
      } catch {
        // 模板是辅助功能，加载失败不阻塞笔记主流程。
        set({ templatesLoaded: true });
      }
    },

    loadLinkOptions: async () => {
      if (get().linkOptionsLoading) return;
      set({ linkOptionsLoading: true });
      try {
        const [tasks, workspaces] = await Promise.all([
          listTasks({ view: "all", status: "all", limit: 200 }),
          workspaceList(null),
        ]);
        set({
          linkOptions: {
            tasks: tasks.map((task) => ({ id: task.id, title: task.title })),
            workspaces: workspaces.map((item) => ({ id: item.id, name: item.name })),
          },
          linkOptionsLoading: false,
        });
      } catch {
        set({ linkOptionsLoading: false });
      }
    },

    convertCapture: async (captureId) => {
      const result = await invokeCommand<ConvertResult>("notes_convert_capture", {
        captureId,
      });
      // 转换是跨模块动作，当前搜索词/筛选很可能不包含新笔记：先复位再以后端列表为准，
      // 否则「已打开」的笔记在列表里找不到，用户会以为转换失败。
      set({ query: "", filter: "all" });
      await fetchList();
      await get().select(result.note.id);
      return result;
    },

    persistLocalDraft: () => {
      const state = get();
      if (!state.activeId || !state.draft) return;
      writeLocalDraft(state.activeId, state.draft);
    },
  };
});

export { initialState as initialNotesState };

/** 仅供测试：清空模块级运行时缓存（冲突标记、revision、队列与在途表）。 */
export function __resetNotesRuntimeForTests(): void {
  conflictNotes.clear();
  revisionCache.clear();
  lastSubmitted.clear();
  forced.clear();
  pendingSnapshots.clear();
  inflight.clear();
}
