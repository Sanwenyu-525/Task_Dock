import { create } from "zustand";
import { agentSnapshot, type AgentSnapshot } from "../lib/bridge";

export const useAgentsStore = create<{
  snapshot: AgentSnapshot | null;
  load: () => Promise<void>;
}>((set) => ({
  snapshot: null,
  load: async () => {
    try {
      const s = await agentSnapshot();
      set({ snapshot: s });
    } catch {
      // 保持旧快照
    }
  },
}));
