// 列表读取快速失败与请求级隔离测试：
// - 列表独立超时/重试，离线/超时落到可重试错误态；
// - TLS/未配对等不可重试错误直接停止并分类到对应入口；
// - cancelList 只取消列表读取，不中止在途上传/下载；
// - 并发护栏保证同一时刻只有一个在途列表请求，旧响应/错误被忽略。
//
// 传输类（创建/分块上传/分块下载/完成/删除）仍走 30s × 3 次语义，
// 本文件只通过隔离用例验证列表取消不会波及其余请求。
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../errors";
import { deriveSyncKey, encryptEnvelope } from "../crypto";
import type { FetchLike, HttpResponseLike } from "../client";
import {
  AAD_FILES_LIST,
  FileHttpError,
  aadFileChunk,
  classifyListError,
  createFileClient,
  createListRunTracker,
  type FileClient,
  type RemoteFile,
} from "../files";

const TOKEN = "a".repeat(64);

function fileRecord(overrides: Partial<RemoteFile> = {}): RemoteFile {
  return {
    id: "f".repeat(32),
    direction: "to_phone",
    name: "a.txt",
    size: 10,
    sha256: "hash",
    status: "ready",
    chunk_size: 8,
    chunks: 2,
    received_chunks: 2,
    created_at: "2026-11-12T00:00:00Z",
    updated_at: "2026-11-12T00:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

interface Harness {
  client: FileClient;
  key: Uint8Array;
  signals: AbortSignal[];
}

async function harness(
  handler: (path: string, init: Parameters<FetchLike>[1]) => Promise<HttpResponseLike>,
  options: { listTimeoutMs?: number; listMaxRetries?: number } = {},
): Promise<Harness> {
  const key = await deriveSyncKey(TOKEN);
  const signals: AbortSignal[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (init.signal) {
      signals.push(init.signal);
      // 原生通道在 abort 时会取消请求并 reject；注入的内存 fetch 必须同样响应信号，
      // 否则本端计时器触发的 abort 不会让挂起的 Promise 回落。
      if (init.signal.aborted) throw new Error("aborted");
      const aborted = deferred<HttpResponseLike>();
      init.signal.addEventListener("abort", () => aborted.reject(new Error("aborted")));
      return Promise.race([handler(path, init), aborted.promise]);
    }
    return handler(path, init);
  };
  const client = createFileClient({
    baseUrl: "https://host",
    token: TOKEN,
    syncKey: key,
    fetchImpl,
    listTimeoutMs: options.listTimeoutMs,
    listMaxRetries: options.listMaxRetries,
  });
  return { client, key, signals };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("列表读取：正常返回与错误分类", () => {
  it("列表正常返回：解析 files 信封并返回记录", async () => {
    const { client, key } = await harness(async () =>
      jsonResponse(
        200,
        encryptEnvelope(key, AAD_FILES_LIST, { files: [fileRecord()] }),
      ),
    );

    const list = await client.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("a.txt");
  });

  it("桌面端离线（连接拒绝）→ 分类为离线错误态，可手动重试", async () => {
    const { client } = await harness(async () => {
      throw new Error("connect ECONNREFUSED 192.168.1.10:47822");
    });

    const error = await client.list().catch((e) => e);
    expect(error).toMatchObject({ kind: "network" });
    const failure = classifyListError(error);
    expect(failure.kind).toBe("offline");
    expect(failure.needsRepair).toBe(false);
  });

  it("请求超时 → 快速失败并落到离线错误态（列表独立超时，不沿用 30s）", async () => {
    const { client } = await harness(async () => new Promise(() => undefined), {
      listTimeoutMs: 20,
      listMaxRetries: 1,
    });

    const error = await client.list().catch((e) => e);
    expect(error).toMatchObject({ kind: "network", code: "request_timeout" });
    const failure = classifyListError(error);
    expect(failure.kind).toBe("offline");
    expect(failure.message).toContain("桌面端可能未启动");
  });

  it("TLS 指纹不匹配：不自动重试，分类为需重新配对", async () => {
    const calls = vi.fn();
    const { client } = await harness(async () => {
      calls();
      throw new AppError(
        "validation",
        "桌面端证书指纹不匹配（可能存在中间人），请重新扫码配对",
        undefined,
        "tls_pin_mismatch",
      );
    });

    await expect(client.list()).rejects.toMatchObject({ code: "tls_pin_mismatch" });
    // 安全失败不可重试：只发了一次请求。
    expect(calls).toHaveBeenCalledTimes(1);
    const failure = classifyListError(
      new AppError("validation", "指纹不匹配", undefined, "tls_pin_mismatch"),
    );
    expect(failure.kind).toBe("repair");
    expect(failure.needsRepair).toBe(true);
  });

  it("未配对错误：分类为配对引导，不进加载死循环", () => {
    const failure = classifyListError(
      new AppError("validation", "尚未配对，请先与桌面端配对", undefined, "not_paired"),
    );
    expect(failure.kind).toBe("unpaired");
    expect(failure.needsRepair).toBe(false);
  });

  it("网络中断（原生通道 offline 错误码）：分类为离线错误态", () => {
    const failure = classifyListError(
      new AppError("network", "安全通道连接失败", undefined, "offline"),
    );
    expect(failure.kind).toBe("offline");
    expect(failure.needsRepair).toBe(false);
  });

  it("401/403 授权失效：分类为需重新配对，不当成普通离线", () => {
    expect(classifyListError(new FileHttpError(401, "unauthorized")).needsRepair).toBe(true);
    expect(classifyListError(new FileHttpError(403, null)).needsRepair).toBe(true);
    expect(classifyListError(new FileHttpError(503, null)).needsRepair).toBe(false);
  });
});

describe("请求级隔离：列表取消不波及其余传输", () => {
  it("页面退出取消列表读取：在途 list 被中止并抛取消错误", async () => {
    const listDeferred = deferred<HttpResponseLike>();
    const { client } = await harness(async () => listDeferred.promise);

    const pending = client.list();
    client.cancelList();
    listDeferred.resolve(jsonResponse(200, {}));

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("列表取消不中止在途上传：uploadChunk 的信号不被 abort", async () => {
    const uploadDeferred = deferred<HttpResponseLike>();
    const { client, key, signals } = await harness(async () => uploadDeferred.promise);

    const pendingUpload = client.uploadChunk("f".repeat(32), 0, new Uint8Array([1, 2, 3]));
    // 模拟一次无关的列表刷新取消：只应取消列表，不能碰上传分块。
    client.cancelList();

    const uploadSignal = signals[0];
    expect(uploadSignal.aborted).toBe(false);

    uploadDeferred.resolve(
      jsonResponse(
        200,
        encryptEnvelope(key, aadFileChunk("POST", "f".repeat(32), 0), {
          file: fileRecord({ direction: "to_desktop", received_chunks: 1 }),
        }),
      ),
    );
    await expect(pendingUpload).resolves.toMatchObject({ id: "f".repeat(32) });
  });

  it("下载不被无关列表刷新取消：downloadChunk 的信号不被 abort", async () => {
    const downloadDeferred = deferred<HttpResponseLike>();
    const { client, key, signals } = await harness(async () => downloadDeferred.promise);

    const pendingDownload = client.downloadChunk("f".repeat(32), 0);
    client.cancelList();

    const downloadSignal = signals[0];
    expect(downloadSignal.aborted).toBe(false);

    downloadDeferred.resolve(
      jsonResponse(
        200,
        encryptEnvelope(key, aadFileChunk("GET", "f".repeat(32), 0), {
          index: 0,
          data: Buffer.from([9, 8, 7]).toString("base64"),
        }),
      ),
    );
    const bytes = await pendingDownload;
    expect(Array.from(bytes)).toEqual([9, 8, 7]);
  });
});

describe("只读分组探测：并入列表快速失败轨", () => {
  it("shelfGroups 挂起时按列表超时快速失败，不沿用传输轨 30s × 3", async () => {
    const { client } = await harness(async () => new Promise(() => undefined), {
      listTimeoutMs: 20,
      listMaxRetries: 1,
    });

    const error = await client.shelfGroups().catch((e) => e);
    expect(error).toMatchObject({ kind: "network", code: "request_timeout" });
  });
});

describe("并发护栏：连续重试不产生多个并行列表请求", () => {
  it("旧列表被新刷新取代：旧请求取消，新列表正常完成", async () => {
    const firstDeferred = deferred<HttpResponseLike>();
    let secondHandler: (() => Promise<HttpResponseLike>) | null = null;
    const { client, key } = await harness(async () => {
      if (secondHandler) return secondHandler();
      return firstDeferred.promise;
    });

    const first = client.list();
    // 第二次刷新先取消上一次在途列表读取，再发起新请求。
    client.cancelList();
    secondHandler = async () =>
      jsonResponse(
        200,
        encryptEnvelope(key, AAD_FILES_LIST, { files: [fileRecord()] }),
      );
    const second = client.list();

    firstDeferred.resolve(jsonResponse(200, {}));
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    await expect(second).resolves.toHaveLength(1);
  });

  it("tracker 序号：新序号使旧序号过期，dispose 后全部过期", () => {
    const tracker = createListRunTracker();
    const run1 = tracker.begin();
    expect(tracker.stale(run1)).toBe(false);

    const run2 = tracker.begin();
    expect(tracker.stale(run1)).toBe(true);
    expect(tracker.stale(run2)).toBe(false);

    tracker.dispose();
    expect(tracker.stale(run2)).toBe(true);
  });

  it("重试后恢复：第一次失败落错误态，第二次列表成功并清空错误态", async () => {
    let attempts = 0;
    const { client, key } = await harness(async () => {
      attempts += 1;
      // 列表自带 1 次自动重试：前两次尝试都失败，第一次 list 调用才会落到错误态。
      if (attempts <= 2) throw new Error("connect ECONNREFUSED 192.168.1.10:47822");
      return jsonResponse(
        200,
        encryptEnvelope(key, AAD_FILES_LIST, { files: [fileRecord()] }),
      );
    });

    await expect(client.list()).rejects.toMatchObject({ kind: "network" });
    const list = await client.list();
    expect(list).toHaveLength(1);
    expect(attempts).toBe(3);
  });
});
