import { describe, expect, it } from "vitest";
import type { AgentInstance, AgentRun, AgentSession, AgentSnapshot, AgentSource } from "./bridge";
import { buildTree, liveRuns, liveSummary, worstAgentState } from "./agentTree";

const NOW = new Date("2026-10-25T12:00:00Z").getTime();

function source(id: string): AgentSource {
  return {
    id, display_name: id, kind: "transport", enabled: true, verified: true,
    homepage: "", note: "", config: null as never,
  };
}
function instance(id: string, key: string, src: string): AgentInstance {
  return { id, source_id: src, instance_key: key, display_name: "", exe_path: "", first_seen_at: "", last_seen_at: "" };
}
function session(id: string, src: string, ext: string, over: Partial<AgentSession> = {}): AgentSession {
  return { id, source_id: src, external_id: ext, title: "", status: "idle", first_seen_at: "", last_seen_at: "", last_run_id: null, instance_id: null, ...over };
}
function run(id: string, sess: string, src: string, status: string, over: Partial<AgentRun> = {}): AgentRun {
  return {
    id, session_id: sess, source_id: src, external_run_id: id, task_title: "",
    status, started_at: "2026-10-25T10:00:00Z", updated_at: "2026-10-25T11:00:00Z",
    ended_at: null, pending_items: [], instance_id: null, ...over,
  };
}
function snap(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { sources: [], instances: [], sessions: [], runs: [], ...over };
}

describe("liveRuns / worstAgentState 语义", () => {
  it("completed 历史轮次不算实时运行状态", () => {
    const s = snap({ runs: [run("r1", "s", "codex", "completed")] });
    expect(worstAgentState(s, NOW)).toBe("idle");
  });
  it("waiting 优先于 running", () => {
    const s = snap({
      runs: [run("r1", "a", "codex", "running"), run("r2", "b", "codex", "waiting")],
    });
    expect(worstAgentState(s, NOW)).toBe("waiting");
  });
  it("failed 优先级最高", () => {
    const s = snap({
      runs: [run("r1", "a", "codex", "running"), run("r2", "b", "codex", "failed"), run("r3", "c", "codex", "waiting")],
    });
    expect(worstAgentState(s, NOW)).toBe("failed");
  });
  it("disconnected 不等于失败，且优先级最低", () => {
    const s = snap({
      runs: [run("r1", "a", "codex", "disconnected"), run("r2", "b", "codex", "running")],
    });
    expect(worstAgentState(s, NOW)).toBe("running");
    const only = snap({ runs: [run("r1", "a", "codex", "disconnected")] });
    expect(worstAgentState(only, NOW)).toBe("disconnected");
  });
  it("超过窗口的 failed 不再计入实时状态", () => {
    const old = run("r1", "a", "codex", "failed", { updated_at: "2026-10-24T10:00:00Z" });
    expect(liveRuns([old], NOW)).toHaveLength(0);
    expect(worstAgentState(snap({ runs: [old] }), NOW)).toBe("idle");
  });
  it("liveSummary 计数正确", () => {
    const s = snap({
      runs: [
        run("r1", "a", "codex", "running"),
        run("r2", "b", "codex", "running"),
        run("r3", "c", "codex", "waiting"),
        run("r4", "d", "codex", "failed"),
        run("r5", "e", "codex", "completed"),
      ],
    });
    const sum = liveSummary(s, NOW);
    expect(sum.running).toBe(2);
    expect(sum.waiting).toBe(1);
    expect(sum.failed).toBe(1);
    expect(sum.worst).toBe("failed");
  });
});

describe("buildTree 实例层级", () => {
  const inst1 = instance("i1", "proc-111", "codex");
  const inst2 = instance("i2", "proc-222", "codex");

  it("会话按真实 instance_id 分组，不再全部归入 default", () => {
    const s = snap({
      sources: [source("codex")],
      instances: [inst1, inst2],
      sessions: [
        session("s1", "codex", "ext-1", { instance_id: "i1" }),
        session("s2", "codex", "ext-2", { instance_id: "i2" }),
      ],
      runs: [],
    });
    const tree = buildTree(s, NOW);
    expect(tree).toHaveLength(1);
    const agent = tree[0];
    expect(agent.instances.map((i) => i.key)).toEqual(["proc-111", "proc-222"]);
    expect(agent.unassignedSessions).toHaveLength(0);
  });

  it("未知 instance_id 不伪造实例，落入 unassigned", () => {
    const s = snap({
      sources: [source("codex")],
      instances: [inst1],
      sessions: [
        session("s1", "codex", "ext-1", { instance_id: "i1" }),
        session("s9", "codex", "ext-9", { instance_id: "ghost" }), // 悬空引用
        session("s2", "codex", "ext-2", { instance_id: null }),
      ],
      runs: [],
    });
    const agent = buildTree(s, NOW)[0];
    expect(agent.instances).toHaveLength(1);
    expect(agent.instances[0].key).toBe("proc-111");
    expect(agent.unassignedSessions).toHaveLength(2);
  });

  it("等待介入的会话排在最前", () => {
    const s = snap({
      sources: [source("codex")],
      instances: [inst1],
      sessions: [
        session("s1", "codex", "idle-sess", { instance_id: "i1", last_seen_at: "2026-10-25T11:59:00Z" }),
        session("s2", "codex", "wait-sess", { instance_id: "i1", last_seen_at: "2026-10-25T10:00:00Z" }),
      ],
      runs: [
        run("r2", "s2", "codex", "waiting"),
        run("r1", "s1", "codex", "completed"),
      ],
    });
    const agent = buildTree(s, NOW)[0];
    expect(agent.instances[0].sessions[0].externalId).toBe("wait-sess");
    expect(agent.instances[0].sessions[0].liveState).toBe("waiting");
  });

  it("Agent 层级按关注优先级排序并聚合 worst", () => {
    const s = snap({
      sources: [source("idle-agent"), source("busy-agent")],
      instances: [],
      sessions: [
        session("s1", "busy-agent", "b1"),
        session("s2", "idle-agent", "i1"),
      ],
      runs: [run("r1", "s1", "busy-agent", "running")],
    });
    const tree = buildTree(s, NOW);
    expect(tree[0].id).toBe("busy-agent");
    expect(tree[0].liveState).toBe("running");
    expect(tree[1].liveState).toBe("idle");
  });
});
