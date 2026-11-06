//! 场景工作区的 UI 状态（zustand）。
//!
//! 为什么放在 store 而不是面板里：
//! - 「进入场景」会启动多个程序并等待导航层校验，可能持续十几秒；面板会因切页、
//!   收起或解除吸附而卸载，逐项结果必须活过组件生命周期；
//! - 进入结果按场景 id 保存，重开面板仍能看到「哪一项失败了、为什么」。
//!
//! 约束：
//! - 不做轮询：列表只在面板打开与写操作后刷新，`load` 用代次丢弃过期快照；
//! - 进入全局单飞：一次只允许进入一个场景。现场恢复与工作流各自还受后端全局单实例
//!   约束，两个场景同时进入会互相抢占前台，因此这里直接拒绝而不是排队堆积；
//! - 清单是整体覆盖语义（后端 `scenario_save`），store 不做本地乐观改写：
//!   写成功后用后端返回值落状态，失败保持原样并给出错误文案。

import { create } from "zustand";
import {
  scenarioDelete,
  scenarioDuplicate,
  scenarioEnter,
  scenarioGet,
  scenarioList,
  scenarioSave,
  type ScenarioDetail,
  type ScenarioEnterResult,
  type ScenarioSaveInput,
  type ScenarioSummary,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";

interface ScenarioState {
  summaries: ScenarioSummary[];
  loading: boolean;
  /** 是否完成过一次成功加载（决定空态文案） */
  loaded: boolean;
  error: string | null;
  /** 正在进入的场景 id；null 表示当前没有在途的进入 */
  enteringId: string | null;
  /** 编辑器打开的场景详情（新建草稿由面板自己持有） */
  editing: ScenarioDetail | null;
  /** 每个场景最近一次进入结果（卸载后仍可查看） */
  results: Record<string, ScenarioEnterResult>;

  load: (opts?: { force?: boolean }) => Promise<void>;
  openEditor: (id: string) => Promise<ScenarioDetail>;
  closeEditor: () => void;
  save: (input: ScenarioSaveInput) => Promise<string>;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<string>;
  /** 进入场景；已有在途进入时返回 null（不排队、不并发）。 */
  enter: (id: string) => Promise<ScenarioEnterResult | null>;
  clearResult: (id: string) => void;
}

/** 请求代次：只接受最新一次 `load` 的响应。 */
let loadSeq = 0;
/**
 * 写操作代次：`save/remove/duplicate` 落地后 +1。
 * 与 `useDropTargetsStore` 同一理由：写操作之前发出的 load 带的是旧快照，
 * 直接应用会回滚刚完成的新增/编辑/删除。
 */
let mutationSeq = 0;

const sortByUpdated = (items: ScenarioSummary[]): ScenarioSummary[] =>
  [...items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

export const useScenarioStore = create<ScenarioState>((set, get) => {
  const runLoad = async (force: boolean, attempt: number): Promise<void> => {
    if (attempt === 0) {
      const { loading, loaded } = get();
      if (loaded && !force) return;
      if (loading && !force) return;
    }
    const seq = ++loadSeq;
    const epoch = mutationSeq;
    set({ loading: true });
    try {
      const summaries = await scenarioList();
      if (seq !== loadSeq) return;
      if (epoch !== mutationSeq) {
        if (attempt < 1) return runLoad(force, attempt + 1);
        return;
      }
      set({
        summaries: sortByUpdated(Array.isArray(summaries) ? summaries : []),
        loaded: true,
        error: null,
      });
    } catch (e) {
      if (seq !== loadSeq) return;
      // 读取失败保留旧列表并明确置错，不伪装成「还没有场景」
      set({ error: errorMessage(e) });
    } finally {
      if (seq === loadSeq) set({ loading: false });
    }
  };

  const reloadAfterWrite = async (): Promise<void> => {
    // 写成功后一律以列表接口的权威结果为准：摘要里的条目计数由后端从 JSON 计算，
    // 前端不自己拼一份，避免两处口径分叉。
    await runLoad(true, 0);
  };

  return {
    summaries: [],
    loading: false,
    loaded: false,
    error: null,
    enteringId: null,
    editing: null,
    results: {},

    load: (opts) => runLoad(opts?.force === true, 0),

    openEditor: async (id) => {
      const detail = await scenarioGet(id);
      set({ editing: detail, error: null });
      return detail;
    },

    closeEditor: () => set({ editing: null }),

    save: async (input) => {
      const { id } = await scenarioSave(input);
      mutationSeq += 1;
      set((s) => ({
        error: null,
        editing: s.editing?.id === id || input.id == null ? null : s.editing,
      }));
      await reloadAfterWrite();
      return id;
    },

    remove: async (id) => {
      await scenarioDelete(id);
      mutationSeq += 1;
      set((s) => {
        const results = { ...s.results };
        delete results[id];
        return {
          results,
          editing: s.editing?.id === id ? null : s.editing,
          error: null,
        };
      });
      await reloadAfterWrite();
    },

    duplicate: async (id) => {
      const { id: newId } = await scenarioDuplicate(id);
      mutationSeq += 1;
      set({ error: null });
      await reloadAfterWrite();
      return newId;
    },

    enter: async (id) => {
      // 全局单飞：不排队，避免两个场景互相抢前台、也让用户看清「正在进入哪一个」
      if (get().enteringId !== null) return null;
      set({ enteringId: id, error: null });
      try {
        const result = await scenarioEnter(id);
        set((s) => ({
          enteringId: null,
          results: { ...s.results, [id]: result },
        }));
        // 进入会刷新 last_entered_at：重取一次保证摘要与后端一致
        mutationSeq += 1;
        await reloadAfterWrite();
        return result;
      } catch (e) {
        set({ enteringId: null, error: errorMessage(e) });
        throw e;
      }
    },

    clearResult: (id) =>
      set((s) => {
        const results = { ...s.results };
        delete results[id];
        return { results };
      }),
  };
});
