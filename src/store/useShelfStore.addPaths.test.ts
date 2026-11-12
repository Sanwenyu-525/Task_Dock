//! useShelfStore.addPaths 预检下沉契约测试（mock bridge，不发真实 IPC）。
//!
//! 预检（空白/相对路径拦截）从 ShelfWorkspace UI 层下沉到 store 后的统一契约：
//! - 原始路径进（调用方不做预过滤），{ added, failed } 出；
//!   failed = [预检失败..., 后端失败...]（预检失败在前，顺序钉死）；
//! - 一次投递 = 一个 operation_id + 一个终态（无 success/failed 并存）；
//! - 诊断 metadata 与 UI 返回值数量一致（total=原始总数、failed=全部失败数）；
//! - stage 归因：空数组/全部无效 → validate（不调后端）；失败全部来自预检 →
//!   validate；存在后端失败 → persist；后端 0/0（SHELF_ADD_NO_INPUT）→ persist；
//! - 隐私红线：metadata 白名单只有 count/total/added/failed/mode/source/failure_codes，
//!   绝不写路径/文件名。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { makeItem, mockShelf } = vi.hoisted(() => {
  const makeItem = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "file",
    display_name: `条目${id}`,
    source_kind: "picker",
    storage_mode: "reference",
    original_path: `D:\\tmp\\${id}.txt`,
    managed_path: null,
    content: null,
    byte_size: 10,
    file_ext: "txt",
    favorite: false,
    pinned: false,
    exists_state: "ok",
    group_id: "shelf-default",
    scene_id: null,
    note: "",
    expire_at: null,
    created_at: `2026-01-0${id.length}T00:00:00.000Z`,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  } as ShelfItem);
  /** 模拟服务端状态：添加动作真实写入，load 返回它（与现有 useShelfStore.test 同模式）。 */
  const mockShelf = { server: [] as ReturnType<typeof makeItem>[] };
  return { makeItem, mockShelf };
});

vi.mock("../lib/bridge", () => {
  return {
    /** 默认整批成功：把传入路径逐一变成 added 条目（服务端权威语义）。 */
    shelfAddPaths: vi.fn(async (paths: string[]) => {
      const added = paths.map((p) => makeItem(p, { display_name: p }));
      mockShelf.server = [...added, ...mockShelf.server];
      return { added, failed: [] };
    }),
    shelfList: vi.fn(async () => ({
      items: [...mockShelf.server],
      total: mockShelf.server.length,
    })),
    shelfStats: vi.fn(async () => ({
      total: 0,
      file_count: 0,
      image_count: 0,
      folder_count: 0,
      link_count: 0,
      text_count: 0,
      managed_bytes: 0,
      disk_bytes: 0,
      quota_mb: 2048,
    })),
    shelfGroups: vi.fn(async () => []),
    shelfAddLink: vi.fn(),
    shelfAddText: vi.fn(),
    shelfAddFromClipboard: vi.fn(),
    shelfCheckExists: vi.fn(async () => []),
    shelfUpdate: vi.fn(),
    shelfDelete: vi.fn(),
    shelfClear: vi.fn(),
    shelfCleanup: vi.fn(),
    shelfCopyTo: vi.fn(),
    shelfMoveItems: vi.fn(),
    shelfRelocateItem: vi.fn(),
    shelfUnlinkTask: vi.fn(),
    shelfGroupCreate: vi.fn(),
    shelfGroupRename: vi.fn(),
    shelfGroupDelete: vi.fn(),
  };
});

import { useShelfStore, __resetShelfRecentCache } from "./useShelfStore";
import {
  clientDiagnosticsStats,
  flushDiagnostics,
  setDiagnosticTransport,
  type DiagnosticInput,
} from "../lib/diagnostics";
import {
  shelfAddPaths,
  shelfList,
  shelfStats,
  type ShelfFailedEntry,
  type ShelfItem,
} from "../lib/bridge";

/** 捕获一次操作产生的 `shelf_add_paths` 诊断事件（先清掉旧队列）。 */
async function captureShelfAddEvents(
  run: () => Promise<unknown>,
): Promise<DiagnosticInput[]> {
  // 先清空此前用例可能残留的队列，确保只断言本用例产生的事件。
  setDiagnosticTransport(async () => {});
  while (clientDiagnosticsStats().queued > 0) await flushDiagnostics();

  const events: DiagnosticInput[] = [];
  setDiagnosticTransport(async (batch) => {
    events.push(...batch);
  });
  try {
    await run();
    while (clientDiagnosticsStats().queued > 0) await flushDiagnostics();
  } finally {
    setDiagnosticTransport(null);
  }
  return events.filter((event) => event.action === "shelf_add_paths");
}

describe("useShelfStore.addPaths 预检下沉与诊断一致性", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShelf.server = [];
    __resetShelfRecentCache();
    useShelfStore.setState({
      items: [],
      total: 0,
      groups: [],
      stats: null,
      filter: { search: "", kind: "all", group_id: "all", favorite_only: false },
      loading: false,
      error: null,
      mutationSyncError: null,
      deletionBusy: false,
      cleanupBusy: false,
      recent: [],
      recentLoading: false,
      recentLoaded: false,
      recentError: null,
      selectedIds: [],
      detailId: null,
      lastCleanup: null,
    });
  });

  it("1. 全部输入合法并成功：后端收到原始路径，success 终态，store 合并新增", async () => {
    const events = await captureShelfAddEvents(async () => {
      const result = await useShelfStore
        .getState()
        .addPaths(["D:\\a.txt", "D:\\b.txt"], "reference", "drag");
      expect(result).toEqual({ added: 2, failed: [] });
    });

    // 后端收到的就是原始路径（UI 不再预过滤，也不做 trim 后的二次拆分）。
    expect(shelfAddPaths).toHaveBeenCalledWith(
      ["D:\\a.txt", "D:\\b.txt"],
      "reference",
      "drag",
      null,
    );
    // store 合并新增条目并刷新元数据。
    expect(useShelfStore.getState().items).toHaveLength(2);
    const terminal = events.find((e) => e.status === "success");
    expect(terminal).toMatchObject({
      level: "INFO",
      status: "success",
      metadata: { count: 2, total: 2, added: 2, failed: 0, mode: "reference", source: "drag" },
    });
    expect(events.find((e) => e.status === "failed")).toBeUndefined();
  });

  it("2. 混合输入后端全成功：诊断 total=原始总数，failed 含预检项，stage=validate", async () => {
    const events = await captureShelfAddEvents(async () => {
      const result = await useShelfStore
        .getState()
        .addPaths(["D:\\ok.txt", "", "relative.txt"], "reference", "drag");
      // 返回值含预检失败（后端只收到 1 个有效路径）。
      expect(result.added).toBe(1);
      expect(result.failed.map((f) => f.code)).toEqual(["empty_path", "relative_path"]);
    });

    expect(shelfAddPaths).toHaveBeenCalledTimes(1);
    expect((shelfAddPaths as Mock).mock.calls[0][0]).toEqual(["D:\\ok.txt"]);

    const terminal = events.find((e) => e.status === "failed");
    expect(terminal).toMatchObject({
      level: "WARN",
      status: "failed",
      error_code: "SHELF_ADD_PARTIAL_FAILED",
      error_category: "validation",
      // 失败全部来自预检：stage 归 validate（后端没有失败条目）。
      stage: "validate",
      metadata: {
        count: 3,
        total: 3,
        added: 1,
        failed: 2,
        mode: "reference",
        source: "drag",
        failure_codes: "empty_path,relative_path",
      },
    });
  });

  it("3. 混合输入后端部分失败：failed=[预检失败..., 后端失败...]，stage=persist", async () => {
    (shelfAddPaths as Mock).mockResolvedValueOnce({
      added: [makeItem("ok")],
      failed: [
        {
          path: "D:\\backend-fail.txt",
          reason: "读写失败",
          code: "IO_ERROR",
          category: "io",
        },
      ],
    });

    const events = await captureShelfAddEvents(async () => {
      const result = await useShelfStore
        .getState()
        .addPaths(["D:\\ok.txt", "D:\\backend-fail.txt", "", "rel"], "reference", "drag");
      // 顺序钉死：预检失败在前（按输入顺序），后端失败在后。
      expect(result.failed.map((f) => f.code)).toEqual([
        "empty_path",
        "relative_path",
        "IO_ERROR",
      ]);
      expect(result.added).toBe(1);
    });

    const terminal = events.find((e) => e.status === "failed");
    expect(terminal).toMatchObject({
      // io 属于非预期故障：级别由 WARN（预检）升级为 ERROR。
      level: "ERROR",
      status: "failed",
      error_code: "SHELF_ADD_PARTIAL_FAILED",
      error_category: "io",
      // 存在后端失败条目：persist 是更晚、更严重的失败阶段。
      stage: "persist",
      metadata: {
        count: 4,
        total: 4,
        added: 1,
        failed: 3,
        failure_codes: "empty_path,relative_path,IO_ERROR",
      },
    });
  });

  it("4. 全部输入无效：validate 终态 + SHELF_ADD_ALL_INVALID，不调后端、store 数据不变", async () => {
    const keep = makeItem("keep");
    useShelfStore.setState({ items: [keep], recent: [keep] });

    const events = await captureShelfAddEvents(async () => {
      const result = await useShelfStore
        .getState()
        .addPaths(["", "   ", "relative.txt"], "reference", "drag");
      // 全部无效也返回预检失败列表（不是 0/0 形态）。
      expect(result.added).toBe(0);
      expect(result.failed.map((f) => f.code)).toEqual([
        "empty_path",
        "empty_path",
        "relative_path",
      ]);
    });

    // 不调后端、不做收尾刷新。
    expect(shelfAddPaths).not.toHaveBeenCalled();
    expect(shelfList).not.toHaveBeenCalled();
    expect(shelfStats).not.toHaveBeenCalled();
    // store 数据不变。
    expect(useShelfStore.getState().items.map((i) => i.id)).toEqual(["keep"]);
    expect(useShelfStore.getState().recent.map((i) => i.id)).toEqual(["keep"]);

    const terminal = events.find((e) => e.status === "failed");
    expect(terminal).toMatchObject({
      level: "WARN",
      status: "failed",
      stage: "validate",
      error_code: "SHELF_ADD_ALL_INVALID",
      error_category: "validation",
      metadata: {
        count: 3,
        total: 3,
        added: 0,
        failed: 3,
        failure_codes: "empty_path,relative_path",
      },
    });
    // 一个批次只有一个 operation_id，且只有一个终态。
    expect(new Set(events.map((e) => e.operation_id)).size).toBe(1);
    expect(events.filter((e) => e.status === "failed")).toHaveLength(1);
    expect(events.filter((e) => e.status === "success")).toHaveLength(0);
  });

  it("5. 后端全部失败：复用一致的稳定后端错误码，stage=persist，全量失败计数", async () => {
    (shelfAddPaths as Mock).mockResolvedValueOnce({
      added: [],
      failed: [
        { path: "D:\\x.txt", reason: "r1", code: "IO_ERROR", category: "io" },
        { path: "D:\\y.txt", reason: "r2", code: "IO_ERROR", category: "io" },
      ],
    });

    const events = await captureShelfAddEvents(async () => {
      const result = await useShelfStore
        .getState()
        .addPaths(["D:\\x.txt", "D:\\y.txt"], "reference", "drag");
      expect(result.added).toBe(0);
      expect(result.failed).toHaveLength(2);
    });

    const terminal = events.find((e) => e.status === "failed");
    expect(terminal).toMatchObject({
      level: "ERROR",
      status: "failed",
      stage: "persist",
      error_code: "IO_ERROR",
      error_category: "io",
      metadata: { count: 2, total: 2, added: 0, failed: 2, failure_codes: "IO_ERROR" },
    });
    // 全部后端失败不触发收尾刷新。
    expect(shelfList).not.toHaveBeenCalled();
  });

  it("6. 后端返回 0/0：SHELF_ADD_NO_INPUT、stage=persist（既有契约保持）", async () => {
    (shelfAddPaths as Mock).mockResolvedValueOnce({ added: [], failed: [] });

    const events = await captureShelfAddEvents(async () => {
      const result = await useShelfStore
        .getState()
        .addPaths(["D:\\ignored.txt"], "reference", "drag");
      expect(result).toEqual({ added: 0, failed: [] });
    });

    const terminal = events.find((e) => e.status === "failed");
    expect(terminal).toMatchObject({
      level: "WARN",
      status: "failed",
      stage: "persist",
      error_code: "SHELF_ADD_NO_INPUT",
      error_category: "validation",
      metadata: { count: 1, total: 1, added: 0, failed: 0 },
    });
  });

  it("7. 空数组输入：SHELF_ADD_NO_INPUT、stage=validate、不调后端", async () => {
    const events = await captureShelfAddEvents(async () => {
      const result = await useShelfStore.getState().addPaths([], "reference", "drag");
      // 空数组没有失败条目：0/0 形态，但终态在 validate 阶段（后端从未被调用）。
      expect(result).toEqual({ added: 0, failed: [] });
    });

    expect(shelfAddPaths).not.toHaveBeenCalled();
    const terminal = events.find((e) => e.status === "failed");
    expect(terminal).toMatchObject({
      level: "WARN",
      status: "failed",
      stage: "validate",
      error_code: "SHELF_ADD_NO_INPUT",
      error_category: "validation",
      metadata: { count: 0, total: 0, added: 0, failed: 0 },
    });
  });

  it("8. 同一次操作只产生一个 operation_id（贯穿 started/stage/终态）", async () => {
    (shelfAddPaths as Mock).mockResolvedValueOnce({
      added: [makeItem("ok")],
      failed: [{ path: "x", reason: "r", code: "IO_ERROR", category: "io" }],
    });

    const events = await captureShelfAddEvents(() =>
      useShelfStore
        .getState()
        .addPaths(["D:\\ok.txt", "D:\\bad.txt"], "reference", "drag"),
    );

    expect(events.length).toBeGreaterThan(1);
    expect(new Set(events.map((e) => e.operation_id)).size).toBe(1);
    // started 与终态共用同一个 operation_id。
    const started = events.find((e) => e.status === "started");
    const terminal = events.find((e) => e.status === "failed");
    expect(terminal?.operation_id).toBe(started?.operation_id);
  });

  it("9. 同一次操作只有一个终态：各场景下 success 与 failed 不并存", async () => {
    const scenarios = [
      "mixed-all-backend-ok",
      "mixed-partial-fail",
      "all-invalid",
      "backend-all-fail",
      "backend-zero",
    ] as const;
    for (const scenario of scenarios) {
      const events = await runScenario(scenario);
      const successCount = events.filter((e) => e.status === "success").length;
      const failedCount = events.filter((e) => e.status === "failed").length;
      // 终态恰好一个：要么 success 要么 failed，绝不并存。
      expect([scenario, successCount + failedCount]).toEqual([scenario, 1]);
    }
  });

  /** 用例 9 的辅助：按场景执行一次 addPaths 并返回诊断事件。 */
  async function runScenario(
    scenario:
      | "mixed-all-backend-ok"
      | "mixed-partial-fail"
      | "all-invalid"
      | "backend-all-fail"
      | "backend-zero",
  ): Promise<DiagnosticInput[]> {
    (shelfAddPaths as Mock).mockReset();
    (shelfAddPaths as Mock).mockImplementation(async (paths: string[]) => {
      const added = paths.map((p) => makeItem(p, { display_name: p }));
      return { added, failed: [] };
    });
    if (scenario === "mixed-partial-fail") {
      (shelfAddPaths as Mock).mockResolvedValueOnce({
        added: [makeItem("ok")],
        failed: [{ path: "x", reason: "r", code: "IO_ERROR", category: "io" }],
      });
    } else if (scenario === "backend-all-fail") {
      (shelfAddPaths as Mock).mockResolvedValueOnce({
        added: [],
        failed: [{ path: "x", reason: "r", code: "IO_ERROR", category: "io" }],
      });
    } else if (scenario === "backend-zero") {
      (shelfAddPaths as Mock).mockResolvedValueOnce({ added: [], failed: [] });
    }
    return captureShelfAddEvents(() => {
      if (scenario === "all-invalid") {
        return useShelfStore.getState().addPaths(["", "rel"], "reference", "drag");
      }
      if (scenario === "mixed-all-backend-ok" || scenario === "mixed-partial-fail") {
        return useShelfStore.getState().addPaths(["D:\\ok.txt", ""], "reference", "drag");
      }
      // backend-all-fail / backend-zero：纯有效路径，失败只来自后端。
      return useShelfStore.getState().addPaths(["D:\\only.txt"], "reference", "drag");
    });
  }

  it("10. UI 返回值与诊断 metadata 数量一致（added/failed/total）", async () => {
    (shelfAddPaths as Mock).mockResolvedValueOnce({
      added: [makeItem("ok1"), makeItem("ok2")],
      failed: [{ path: "x", reason: "r", code: "UNSUPPORTED", category: "unsupported" }],
    });

    // 诊断事件在 run 返回后才 flush，先在 run 内拿 UI 结果、在 run 外比对 metadata。
    let uiResult: { added: number; failed: ShelfFailedEntry[] } | undefined;
    const events = await captureShelfAddEvents(async () => {
      uiResult = await useShelfStore
        .getState()
        .addPaths(["D:\\ok1.txt", "D:\\ok2.txt", "D:\\bad.txt", ""], "reference", "drag");
    });
    if (!uiResult) throw new Error("addPaths 未返回结果");
    const result = uiResult;

    expect(result.added).toBe(2);
    expect(result.failed).toHaveLength(2); // empty_path + UNSUPPORTED
    const terminal = events.find((e) => e.status === "failed");
    expect(terminal).toBeTruthy();
    // 数量一致性契约：UI 展示的数字与诊断中心记录的数字来自同一份汇总。
    expect(terminal?.metadata).toMatchObject({
      total: 4,
      added: result.added,
      failed: result.failed.length,
    });
  });

  it("11. 诊断 metadata 全量键值断言：不含完整路径与文件名", async () => {
    (shelfAddPaths as Mock).mockResolvedValueOnce({
      added: [makeItem("ok")],
      failed: [{ path: "x", reason: "r", code: "NOT_FOUND", category: "not_found" }],
    });

    const events = await captureShelfAddEvents(async () => {
      await useShelfStore
        .getState()
        .addPaths(
          ["D:\\secret\\note.txt", "D:\\backend-fail.txt", "", "rel"],
          "managed",
          "drag",
        );
    });

    for (const event of events) {
      const metadata = event.metadata ?? {};
      // metadata 白名单：只有计数/模式/来源/稳定错误码。
      for (const key of Object.keys(metadata)) {
        expect(
          ["count", "total", "added", "failed", "mode", "source", "failure_codes"],
          `metadata 出现白名单外的键 ${key}`,
        ).toContain(key);
      }
      // 全量值不得包含路径/文件名片段（隐私红线）。
      const values = Object.entries(metadata)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join("|");
      expect(values).not.toContain("D:\\");
      expect(values).not.toContain("secret");
      expect(values).not.toContain("note.txt");
      expect(values).not.toContain("backend-fail");
    }
    // 兜底：整条事件载荷（含 message）也不得泄漏路径。
    const payload = JSON.stringify(events);
    expect(payload).not.toContain("secret");
    expect(payload).not.toContain("note.txt");
  });
});
