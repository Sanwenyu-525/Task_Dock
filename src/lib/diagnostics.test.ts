//! 前端诊断上报单元测试：命令归类、有界队列、批量发送、级别过滤、
//! 传输失败静默与操作生命周期。测试通过注入假传输层捕获批次，不使用真实 IPC。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticInput } from "./diagnostics";

const bridgeMocks = vi.hoisted(() => ({
  diagnosticsStatus: vi.fn(),
}));

// `syncDiagnosticMode` 通过动态 import 调用 `./bridge`；单测注入固定状态，
// 不发真实 IPC。
vi.mock("./bridge", () => ({
  diagnosticsStatus: bridgeMocks.diagnosticsStatus,
}));

type DiagnosticsModule = typeof import("./diagnostics");
type Batch = DiagnosticInput[];

let diag: DiagnosticsModule;
/** 假传输层收到的批次（按发送顺序）。 */
let batches: Batch[];

async function importDiagnostics(): Promise<DiagnosticsModule> {
  vi.resetModules();
  return import("./diagnostics");
}

/** 把当前模块实例的队列全部刷出（每次 flush 只发一批）。 */
async function flushAll(): Promise<void> {
  for (let guard = 0; guard < 100; guard += 1) {
    if (diag.clientDiagnosticsStats().queued === 0) return;
    await diag.flushDiagnostics();
  }
  throw new Error("flushAll 未能清空诊断队列");
}

function allEvents(): DiagnosticInput[] {
  return batches.flat();
}

function makeEvent(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  return {
    level: "INFO",
    module: "task",
    action: "test_action",
    event: "test_event",
    ...overrides,
  };
}

beforeEach(async () => {
  // 假定时器：禁止 500ms 自动刷新干扰断言；只允许显式 flushDiagnostics()。
  vi.useFakeTimers();
  batches = [];
  bridgeMocks.diagnosticsStatus.mockReset();
  diag = await importDiagnostics();
  diag.setDiagnosticTransport(async (events) => {
    batches.push([...events]);
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("moduleForCommand", () => {
  it("按命令归类到稳定模块，未知命令归入 ipc", () => {
    const cases: Array<[string, string]> = [
      ["list_tasks", "task"],
      ["create_task", "task"],
      ["agent_snapshot", "agent"],
      ["list_agent_events", "agent"],
      ["clipboard_copy", "clipboard"],
      ["shelf_export", "file"],
      ["inbox_pick", "file"],
      ["workflow_run", "workflow"],
      ["tts_speak", "voice"],
      ["audio_play", "voice"],
      ["backup_now", "backup"],
      ["widget_window_info", "widget"],
      ["nav_toggle", "navigation"],
      ["get_settings", "settings"],
      ["update_settings", "settings"],
      ["something_unknown", "ipc"],
    ];
    for (const [command, expected] of cases) {
      expect(diag.moduleForCommand(command), command).toBe(expected);
    }
  });
});

describe("logEvent 与批量发送", () => {
  it("单次 flush 最多发送 20 条，剩余留在队列", async () => {
    for (let i = 0; i < 25; i += 1) {
      diag.logEvent(makeEvent({ action: `burst_${i}` }));
    }

    await diag.flushDiagnostics();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(20);
    expect(diag.clientDiagnosticsStats().queued).toBe(5);
  });

  it("45 条突发按 20/20/5 分三批送达，window_id 自动填充", async () => {
    const windowId = diag.currentWindowId();
    for (let i = 0; i < 45; i += 1) {
      diag.logEvent(makeEvent({ action: `burst_${i}`, event: `burst_${i}` }));
    }

    await flushAll();

    expect(batches.map((batch) => batch.length)).toEqual([20, 20, 5]);
    expect(diag.clientDiagnosticsStats()).toMatchObject({ queued: 0, sent: 45 });

    const events = allEvents();
    expect(events).toHaveLength(45);
    for (const event of events) {
      expect(event.window_id).toBe(windowId);
    }
    expect(windowId).toBeTruthy();
  });
});

describe("详细模式过滤", () => {
  it("verbose 关闭时 DEBUG/TRACE 直接丢弃，INFO 保留", async () => {
    diag.setClientVerboseMode(false);

    diag.logEvent(makeEvent({ level: "DEBUG", action: "debug_off" }));
    diag.logEvent(makeEvent({ level: "TRACE", action: "trace_off" }));
    diag.logEvent(makeEvent({ level: "INFO", action: "info_kept" }));

    expect(diag.clientDiagnosticsStats().queued).toBe(1);
    await flushAll();
    expect(allEvents().map((event) => event.action)).toEqual(["info_kept"]);
  });

  it("verbose 开启时 DEBUG/TRACE 正常入队并送达", async () => {
    diag.setClientVerboseMode(true);

    diag.logEvent(makeEvent({ level: "DEBUG", action: "debug_on" }));
    diag.logEvent(makeEvent({ level: "TRACE", action: "trace_on" }));

    await flushAll();
    expect(allEvents().map((event) => [event.level, event.action])).toEqual([
      ["DEBUG", "debug_on"],
      ["TRACE", "trace_on"],
    ]);
  });
});

describe("队列上限", () => {
  it("超过 128 条后丢弃低级别事件并计数", async () => {
    diag.setClientVerboseMode(true);
    for (let i = 0; i < 300; i += 1) {
      diag.logEvent(makeEvent({ level: "INFO", action: `flood_${i}` }));
    }

    const stats = diag.clientDiagnosticsStats();
    expect(stats.queued).toBeLessThanOrEqual(128);
    expect(stats.queued).toBe(128);
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.dropped).toBe(172);

    // 保留的 128 条仍可正常刷出。
    await flushAll();
    expect(diag.clientDiagnosticsStats().sent).toBe(128);
  });
});

describe("传输失败", () => {
  it("拒绝的传输层不上抛，只累加 dropped", async () => {
    diag.setDiagnosticTransport(() => Promise.reject(new Error("transport down")));
    diag.logEvent(makeEvent({ level: "WARN", action: "warn_event" }));
    diag.logEvent(makeEvent({ level: "ERROR", action: "error_event" }));
    diag.logEvent(makeEvent({ level: "CRITICAL", action: "critical_event" }));

    await expect(diag.flushDiagnostics()).resolves.toBeUndefined();

    expect(diag.clientDiagnosticsStats()).toMatchObject({
      queued: 0,
      sent: 0,
      dropped: 3,
    });
    expect(batches).toHaveLength(0);
  });
});

describe("markLogged / isLogged", () => {
  it("只把已标记的对象视为已记录", () => {
    const marked = new Error("已记录");
    const unmarked = new Error("未记录");
    const plain = { code: "IO_ERROR" };

    expect(diag.isLogged(marked)).toBe(false);
    diag.markLogged(marked);
    expect(diag.isLogged(marked)).toBe(true);
    expect(diag.isLogged(unmarked)).toBe(false);

    diag.markLogged(plain);
    expect(diag.isLogged(plain)).toBe(true);
  });
});

describe("startOperation 生命周期", () => {
  beforeEach(() => {
    diag.setClientVerboseMode(true);
  });

  it("started → stage → success，终态之后不再发事件", async () => {
    const op = diag.startOperation("task", "create_task");
    expect(op.id.length).toBeGreaterThan(0);

    op.stage("validating", { step: 1 });
    op.success({ message: "done", metadata: { rows: 2 } });
    // finished-once：终态后再调用 success/fail 都不得产生新事件。
    op.success();
    op.fail({ code: "IO_ERROR" });

    await flushAll();

    const events = allEvents().filter((event) => event.operation_id === op.id);
    expect(events.map((event) => event.status)).toEqual(["started", undefined, "success"]);

    const [started, stage, success] = events;
    expect(started).toMatchObject({
      level: "INFO",
      module: "task",
      action: "create_task",
      event: "started",
      status: "started",
    });
    expect(started.window_id).toBe(diag.currentWindowId());

    expect(stage.level).toBe("DEBUG");
    expect(stage.event).toBe("stage");
    expect(stage.stage).toBe("validating");
    expect(stage.status).toBeUndefined();
    expect(stage.metadata).toEqual({ step: 1 });

    expect(success.level).toBe("INFO");
    // 终态 event 必须与 status 一致，而不是继承 started。
    expect(success.event).toBe("success");
    expect(success.status).toBe("success");
    expect(success.message).toBe("done");
    expect(success.metadata).toEqual({ rows: 2 });
    expect(typeof success.duration_ms).toBe("number");
    expect(Number.isFinite(success.duration_ms)).toBe(true);
    expect(success.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("fail(DATA_INTEGRITY_ERROR) 记为 CRITICAL/failed，且只发一次终态", async () => {
    const op = diag.startOperation("task", "delete_task");

    op.fail({ code: "DATA_INTEGRITY_ERROR" });
    op.success();
    op.fail({ code: "IO_ERROR" });

    await flushAll();

    const events = allEvents().filter((event) => event.operation_id === op.id);
    expect(events).toHaveLength(2);

    const failed = events[1];
    expect(failed).toMatchObject({
      level: "CRITICAL",
      module: "task",
      action: "delete_task",
      event: "failed",
      status: "failed",
      error_code: "DATA_INTEGRITY_ERROR",
      message: "操作失败",
    });
    expect(typeof failed.duration_ms).toBe("number");
    expect(failed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("cancel / recovered 的终态 event 与 status 一致", async () => {
    const cancelled = diag.startOperation("task", "cancel_task");
    cancelled.cancel("用户取消");
    const recovered = diag.startOperation("task", "recover_task");
    recovered.recovered("已恢复");
    const failed = diag.startOperation("task", "fail_task");
    failed.fail({ code: "IO_ERROR", message: "写库失败" });

    await flushAll();

    const terminal = (id: string) => {
      const events = allEvents().filter((event) => event.operation_id === id);
      return events[events.length - 1];
    };
    expect(terminal(cancelled.id)).toMatchObject({
      event: "cancelled",
      status: "cancelled",
      message: "用户取消",
    });
    expect(terminal(recovered.id)).toMatchObject({
      event: "recovered",
      status: "recovered",
      message: "已恢复",
    });
    expect(terminal(failed.id)).toMatchObject({ event: "failed", status: "failed" });
  });
});

describe("logIpcFailure", () => {
  it("按严重度映射级别，并携带 duration_ms 与 command/operation", async () => {
    expect(
      diag.logIpcFailure("clipboard_copy", { severity: "warning", message: "剪贴板忙" }, 12, "复制内容"),
    ).toBe(true);
    expect(diag.logIpcFailure("save_window_rect", { severity: "critical" }, 7)).toBe(true);
    expect(diag.logIpcFailure("create_task", { code: "IO_ERROR", message: "写库失败" }, 3)).toBe(
      true,
    );
    expect(diag.logIpcFailure("agent_snapshot", { code: "DATA_INTEGRITY_ERROR" }, 1)).toBe(true);

    await flushAll();

    const [warning, critical, fallback, integrity] = allEvents();
    expect(warning).toMatchObject({
      level: "WARN",
      module: "clipboard",
      action: "clipboard_copy",
      event: "failed",
      status: "failed",
      duration_ms: 12,
      message: "剪贴板忙",
    });
    expect(warning.metadata).toEqual({
      command: "clipboard_copy",
      stage: "ipc",
      operation: "复制内容",
    });

    expect(critical).toMatchObject({
      level: "CRITICAL",
      module: "settings",
      action: "save_window_rect",
      duration_ms: 7,
    });
    expect(critical.metadata).toEqual({ command: "save_window_rect", stage: "ipc" });
    expect(critical.metadata).not.toHaveProperty("operation");

    expect(fallback.level).toBe("ERROR");
    expect(fallback.duration_ms).toBe(3);
    expect(fallback.metadata).toMatchObject({ command: "create_task", stage: "ipc" });
    expect(fallback.metadata).not.toHaveProperty("operation");

    // 错误码 DATA_INTEGRITY_ERROR 即使未声明 severity 也升级为 CRITICAL。
    expect(integrity.level).toBe("CRITICAL");
  });
});

describe("logIpcSuccess", () => {
  it("verbose 关闭时不产生任何事件", async () => {
    diag.setClientVerboseMode(false);
    diag.logIpcSuccess("create_task", 5);

    expect(diag.clientDiagnosticsStats().queued).toBe(0);
    await flushAll();
    expect(batches).toHaveLength(0);
  });

  it("verbose 开启时只记录非静默命令", async () => {
    diag.setClientVerboseMode(true);
    expect(diag.isQuietCommand("diagnostics_status")).toBe(true);
    expect(diag.isQuietCommand("agent_snapshot")).toBe(true);
    expect(diag.isQuietCommand("create_task")).toBe(false);

    diag.logIpcSuccess("create_task", 9);
    diag.logIpcSuccess("diagnostics_status", 1);
    diag.logIpcSuccess("agent_snapshot", 2);

    await flushAll();

    const events = allEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "DEBUG",
      module: "task",
      action: "create_task",
      event: "ipc_ok",
      status: "success",
      duration_ms: 9,
    });
    expect(events[0].metadata).toEqual({ command: "create_task", stage: "ipc" });
  });
});

describe("详细模式本地截止时间", () => {
  it("verboseRemainingMs 到期后自动退出，不再产生 DEBUG（无 IPC）", async () => {
    diag.applyModeFromStatus({ mode: "verbose", verboseRemainingMs: 5_000 });
    expect(diag.isClientVerboseMode()).toBe(true);

    diag.logEvent(makeEvent({ level: "DEBUG", action: "before_expiry" }));
    expect(diag.clientDiagnosticsStats().queued).toBe(1);

    vi.advanceTimersByTime(5_001);
    expect(diag.isClientVerboseMode()).toBe(false);

    // 到期后的 DEBUG 在入队前就被过滤，不需要任何 IPC/轮询。
    // （推进假定时器时 500ms 自动 flush 可能已把前面的 DEBUG 送出队列。）
    const queuedBefore = diag.clientDiagnosticsStats().queued;
    diag.logEvent(makeEvent({ level: "DEBUG", action: "after_expiry" }));
    expect(diag.clientDiagnosticsStats().queued).toBe(queuedBefore);

    await flushAll();
    expect(allEvents().map((event) => event.action)).toEqual(["before_expiry"]);
    expect(bridgeMocks.diagnosticsStatus).not.toHaveBeenCalled();
  });

  it("setClientVerboseMode 保持向后兼容：只传布尔值时无期限", () => {
    diag.setClientVerboseMode(true);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(diag.isClientVerboseMode()).toBe(true);
  });
});

describe("syncDiagnosticMode", () => {
  it("只调用一次 diagnostics_status，并应用模式与剩余时间", async () => {
    bridgeMocks.diagnosticsStatus.mockResolvedValue({
      mode: "verbose",
      verboseRemainingMs: 1_000,
    });

    await diag.syncDiagnosticMode();

    expect(bridgeMocks.diagnosticsStatus).toHaveBeenCalledTimes(1);
    expect(diag.clientDiagnosticsStats().verbose).toBe(true);

    vi.advanceTimersByTime(1_001);
    expect(diag.isClientVerboseMode()).toBe(false);
  });

  it("同步失败被吞掉，不影响本地模式", async () => {
    bridgeMocks.diagnosticsStatus.mockRejectedValue(new Error("offline"));

    await expect(diag.syncDiagnosticMode()).resolves.toBeUndefined();
    expect(diag.isClientVerboseMode()).toBe(false);
  });

  it("installDiagnosticsFlushHooks 安装时只同步一次（重复安装不重复调用）", async () => {
    bridgeMocks.diagnosticsStatus.mockResolvedValue({ mode: "normal", verboseRemainingMs: 0 });
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener });
    try {
      diag.installDiagnosticsFlushHooks();
      diag.installDiagnosticsFlushHooks();
      // 动态 import 与状态应用需要若干微任务；假定时器环境下手动放行。
      for (let i = 0; i < 20; i += 1) await Promise.resolve();

      expect(bridgeMocks.diagnosticsStatus).toHaveBeenCalledTimes(1);
      expect(addEventListener).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("report 去重与抑制计数", () => {
  it("主要 IPC 失败不参与去重：3 次相同失败产生 3 条事件", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(
        diag.logIpcFailure("create_task", { code: "IO_ERROR", message: "写入失败" }, 1),
      ).toBe(true);
    }

    await flushAll();

    expect(allEvents().filter((event) => event.action === "create_task")).toHaveLength(3);
  });

  it("次级观察在 250ms 窗口内只抑制事件，计数随下一次实际写入返回", () => {
    expect(diag.reserveReport("IO_ERROR", "写入失败")).toEqual({ emit: true, suppressed: 0 });
    expect(diag.reserveReport("IO_ERROR", "写入失败")).toEqual({ emit: false, suppressed: 0 });
    expect(diag.reserveReport("IO_ERROR", "写入失败")).toEqual({ emit: false, suppressed: 0 });

    vi.advanceTimersByTime(300);
    expect(diag.reserveReport("IO_ERROR", "写入失败")).toEqual({ emit: true, suppressed: 2 });
  });

  it("主要归属事件携带 suppressed_since_last", async () => {
    diag.reserveReport("IO_ERROR", "写入失败");
    diag.reserveReport("IO_ERROR", "写入失败");
    diag.reserveReport("IO_ERROR", "写入失败");

    diag.logIpcFailure("create_task", { code: "IO_ERROR", message: "写入失败" }, 1);

    await flushAll();

    const event = allEvents().find((item) => item.action === "create_task");
    expect(event?.metadata?.suppressed_since_last).toBe(2);
  });
});

describe("stage 与失败定位", () => {
  it("普通模式下失败终态仍携带最后阶段，DEBUG stage 事件被过滤", async () => {
    diag.setClientVerboseMode(false);
    const op = diag.startOperation("task", "create_task");
    op.stage("validate");
    op.stage("persist");
    op.fail({ code: "IO_ERROR", message: "写入失败" });

    await flushAll();

    const events = allEvents().filter((event) => event.operation_id === op.id);
    expect(events.map((event) => event.status)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({
      level: "ERROR",
      status: "failed",
      stage: "persist",
      error_code: "IO_ERROR",
    });
  });

  it("同一阶段的连续重复不产生重复 stage 事件", async () => {
    diag.setClientVerboseMode(true);
    const op = diag.startOperation("task", "create_task");
    op.stage("persist");
    op.stage("persist");
    op.stage("validate");
    op.stage("validate");
    op.success();

    await flushAll();

    const stages = allEvents()
      .filter((event) => event.operation_id === op.id && event.event === "stage")
      .map((event) => event.stage);
    expect(stages).toEqual(["persist", "validate"]);
  });

  it("success 不携带 stage 字段", async () => {
    diag.setClientVerboseMode(false);
    const op = diag.startOperation("task", "create_task");
    op.stage("persist");
    op.success();

    await flushAll();

    const success = allEvents().find(
      (event) => event.operation_id === op.id && event.status === "success",
    );
    expect(success?.stage).toBeUndefined();
  });
});
