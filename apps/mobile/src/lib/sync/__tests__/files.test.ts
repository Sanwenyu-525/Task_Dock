// 文件互传客户端测试：注入 fetchImpl 验证分块协议、AAD 绑定、重试与取消。
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../errors";
import { deriveSyncKey, encryptEnvelope, decryptEnvelope } from "../crypto";
import { AAD_FILES_LIST, createFileClient, type RemoteFile } from "../files";
import { createSyncClient, type FetchLike, type HttpResponseLike } from "../client";

// 连接元数据只用于「未注入 fetchImpl」的 fail-closed 用例；其余用例全部注入 fetchImpl。
const { loadConnectionMock } = vi.hoisted(() => ({ loadConnectionMock: vi.fn() }));
vi.mock("../../../db/syncConnection", () => ({ loadConnection: loadConnectionMock }));

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
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function clientWith(
  handler: (method: string, path: string, data: unknown) => Promise<unknown>,
) {
  const key = await deriveSyncKey(TOKEN);
  const calls: Array<{ method: string; path: string; data: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const aad = aadOf(init.method ?? "GET", path);
    let data: unknown;
    if (init.body) {
      data = decryptEnvelope(key, aad, JSON.parse(init.body));
    }
    calls.push({ method: init.method ?? "GET", path, data });
    const payload = await handler(init.method ?? "GET", path, data);
    // 与真实服务端一致：响应也是加密信封。
    return jsonResponse(200, encryptEnvelope(key, aad, payload));
  };
  const client = createFileClient({ baseUrl: "https://host", token: TOKEN, syncKey: key, fetchImpl });
  return { client, calls };
}

function aadOf(method: string, path: string): string {
  if (path === "/v1/files") {
    return method === "GET" ? AAD_FILES_LIST : "taskdock-sync-v1|POST|/v1/files";
  }
  const match = /\/v1\/files\/([0-9a-f]{32})(\/chunk\/(\d+)|\/complete|\/delete)?/.exec(path);
  if (!match) return "unknown";
  if (match[2]?.startsWith("/chunk")) {
    return `taskdock-sync-v1|${method}|/v1/files/${match[1]}/chunk/${match[3]}`;
  }
  if (match[2] === "/complete") return `taskdock-sync-v1|POST|/v1/files/${match[1]}/complete`;
  if (match[2] === "/delete") return `taskdock-sync-v1|POST|/v1/files/${match[1]}/delete`;
  return "unknown";
}

describe("createFileClient（注入 fetchImpl）", () => {
  it("list/create/uploadChunk/complete 全链路加密", async () => {
    const { client, calls } = await clientWith(async (method, path, data) => {
      if (method === "GET" && path === "/v1/files") {
        return { files: [fileRecord()] };
      }
      if (method === "POST" && path === "/v1/files") {
        return { file: fileRecord({ direction: "to_desktop", chunks: 2 }) };
      }
      if (/chunk\/0$/.test(path)) {
        expect((data as { data: string }).data).toBeTruthy();
        return { file: fileRecord({ direction: "to_desktop", received_chunks: 1 }) };
      }
      if (/complete$/.test(path)) {
        return { file: fileRecord({ direction: "to_desktop", status: "ready", completed_at: "x" }) };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    const list = await client.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("a.txt");

    const created = await client.create("hello.txt", 10);
    expect(created.chunks).toBe(2);
    expect(calls[1].data).toEqual({ name: "hello.txt", size: 10 });

    await client.uploadChunk(created.id, 0, new Uint8Array([1, 2, 3]));
    expect(calls[2].path).toBe(`/v1/files/${created.id}/chunk/0`);

    const done = await client.complete(created.id);
    expect(done.status).toBe("ready");
  });

  it("downloadChunk 校验 index 并返回字节", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const { client } = await clientWith(async (method, path) => {
      const index = Number(/chunk\/(\d+)$/.exec(path)?.[1]);
      expect(method).toBe("GET");
      return { index, data: Buffer.from(bytes).toString("base64") };
    });
    const got = await client.downloadChunk("f".repeat(32), 1);
    expect(Array.from(got)).toEqual([9, 8, 7]);
  });

  it("remove 返回非 deleted 时报错（删除未生效可见）", async () => {
    const { client } = await clientWith(async () => ({ deleted: false }));
    await expect(client.remove("f".repeat(32))).rejects.toMatchObject({ kind: "validation" });
  });

  it("参数校验：空名/非法大小/密钥长度", async () => {
    const { client } = await clientWith(async () => ({ file: fileRecord() }));
    // create 的参数校验是同步抛出。
    expect(() => client.create("  ", 10)).toThrow(AppError);
    expect(() => client.create("a", 0)).toThrow(AppError);
    expect(() =>
      createFileClient({
        baseUrl: "https://host",
        token: TOKEN,
        syncKey: new Uint8Array(8),
        fetchImpl: async () => jsonResponse(200, {}),
      }),
    ).toThrow();
  });

  it("cancel() 终止在途（后续分块之间由 fileIo 检查）", async () => {
    let attempts = 0;
    const key = await deriveSyncKey(TOKEN);
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      return jsonResponse(500, {});
    };
    const client = createFileClient({ baseUrl: "https://host", token: TOKEN, syncKey: key, fetchImpl });
    const pending = client.list();
    const assertion = expect(pending).rejects.toMatchObject({ kind: "network" });
    client.cancel();
    await assertion;
    expect(attempts).toBeLessThanOrEqual(2);
  });
});

// 防 tree-shake 引用：createSyncClient 在同文件用于确保 client/files 的 FetchLike
// 形状一致（同构契约）。这里显式断言一次。
describe("FetchLike 契约一致性", () => {
  it("files 与 sync 客户端接受同一 fetchImpl 形状", async () => {
    const key = await deriveSyncKey(TOKEN);
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, encryptEnvelope(key, "taskdock-sync-v1|GET|/v1/changes", { cursor: "0", changes: [] }));
    const syncClient = createSyncClient({ baseUrl: "https://host", token: TOKEN, syncKey: key, fetchImpl });
    const page = await syncClient.pull("0", 1);
    expect(page.changes).toEqual([]);
  });
});

describe("文件传输 TLS 指纹 fail-closed", () => {
  // 回归：此前缺指纹时惰性通道返回 null，等于以「首用信任」把 Bearer 令牌
  // 与文件分块发给未固定身份的对端；现必须在发请求前拒绝。
  it("已配对连接缺少 SPKI 指纹时拒绝发请求", async () => {
    loadConnectionMock.mockResolvedValueOnce({ tlsFingerprint: "" });
    const key = await deriveSyncKey(TOKEN);
    const client = createFileClient({
      baseUrl: "https://192.168.1.10:47822",
      token: TOKEN,
      syncKey: key,
    });

    await expect(client.list()).rejects.toThrow(/TLS 指纹/);
  });
});
