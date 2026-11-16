// fileIo.downloadRemoteFile 的下载完整性用例：
// - 分块字节按序写入内存 SAF 目录（src/test/mocks/expo-file-system.ts）；
// - SHA-256 与桌面端清单一致 → 下载成功；
// - 不一致（传输损坏/被篡改）→ 删除本地半成品并明确报错（fail-closed）；
// - 清单缺 sha256（空串，防御路径）→ 跳过复核；
// - 取消 → 半成品删除（既有行为回归）。
import { beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../errors";
import { FILE_CANCELLED_MESSAGE, type FileClient, type RemoteFile } from "../files";
import { downloadRemoteFile, isOpaqueFileName, uploadDisplayName, uploadLocalFile } from "../fileIo";

import {
  FileMode,
  File as FsFile,
  __resetFs,
  __seedFile,
  fileByUri,
} from "../../../test/mocks/expo-file-system";

import { sha256Hex } from "../sha256";

const DIR = "mem://downloads";

function remoteFile(overrides: Partial<RemoteFile> = {}): RemoteFile {
  return {
    id: "f".repeat(32),
    direction: "to_phone",
    name: "样本.txt",
    size: 10,
    sha256: "",
    status: "ready",
    chunk_size: 8,
    chunks: 2,
    received_chunks: 2,
    created_at: "2026-11-13T00:00:00Z",
    updated_at: "2026-11-13T00:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

/** 最小 FileClient：downloadRemoteFile 只用到 downloadChunk / cancel。 */
function fakeClient(chunks: Uint8Array[]): FileClient {
  return {
    async list() {
      throw new Error("not used");
    },
    async create() {
      throw new Error("not used");
    },
    async uploadChunk() {
      throw new Error("not used");
    },
    async complete() {
      throw new Error("not used");
    },
    async downloadChunk(_id: string, index: number): Promise<Uint8Array> {
      return chunks[index];
    },
    async remove() {
      throw new Error("not used");
    },
    async importToShelf() {
      throw new Error("not used");
    },
    async shelfGroups() {
      throw new Error("not used");
    },
    cancel(): void {},
    cancelList(): void {},
  };
}

function splitBytes(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
  }
  return chunks;
}

function uploadClient(options: {
  list?: () => Promise<RemoteFile[]>;
  completeError?: Error;
  uploadError?: Error;
}) {
  const created = remoteFile({
    direction: "to_desktop",
    size: 10,
    chunk_size: 8,
    chunks: 2,
    status: "pending",
  });
  const calls = { list: 0, complete: 0, remove: 0, upload: 0 };
  const client: FileClient = {
    async list() {
      calls.list += 1;
      if (options.list) return options.list();
      throw new Error("list not configured");
    },
    async create() {
      return created;
    },
    async uploadChunk() {
      calls.upload += 1;
      if (options.uploadError) throw options.uploadError;
      return created;
    },
    async complete() {
      calls.complete += 1;
      throw options.completeError ?? new Error("complete response lost");
    },
    async downloadChunk() {
      throw new Error("not used");
    },
    async remove() {
      calls.remove += 1;
    },
    async importToShelf() {
      throw new Error("not used");
    },
    async shelfGroups() {
      throw new Error("not used");
    },
    cancel() {},
    cancelList() {},
  };
  return { client, created, calls };
}

beforeEach(() => {
  __resetFs();
});

describe("uploadLocalFile complete 竞争与清理边界", () => {
  const payload = new Uint8Array(10).fill(7);
  const uploadFile = (name: string) =>
    __seedFile(DIR, name, payload) as unknown as Parameters<typeof uploadLocalFile>[1];

  it("complete 响应丢失但列表确认 ready：返回成功，不删除完整文件", async () => {
    const helper = uploadClient({
      completeError: new Error("timeout after server complete"),
      list: async () => [
        remoteFile({
          id: "f".repeat(32),
          direction: "to_desktop",
          status: "ready",
          completed_at: "2026-11-16T00:00:00Z",
        }),
      ],
    });
    const file = uploadFile("complete-ready.bin");
    const remote = await uploadLocalFile(helper.client, file, () => undefined);
    expect(remote.status).toBe("ready");
    expect(helper.calls.complete).toBe(1);
    expect(helper.calls.list).toBe(1);
    expect(helper.calls.remove).toBe(0);
  });

  it("complete 失败且列表也失败：unknown 保留远端记录，不删除", async () => {
    const helper = uploadClient({
      completeError: new Error("timeout"),
      list: async () => {
        throw new Error("list also failed");
      },
    });
    const file = uploadFile("complete-unknown.bin");
    await expect(uploadLocalFile(helper.client, file, () => undefined)).rejects.toThrow("timeout");
    expect(helper.calls.list).toBe(1);
    expect(helper.calls.remove).toBe(0);
  });

  it("complete 失败且列表仍为 pending：保持 pending 待对账，不冒险删除", async () => {
    const helper = uploadClient({
      completeError: new Error("connection reset"),
      list: async () => [
        remoteFile({
          id: "f".repeat(32),
          direction: "to_desktop",
          status: "pending",
          received_chunks: 2,
          completed_at: null,
        }),
      ],
    });
    const file = uploadFile("complete-pending.bin");
    await expect(uploadLocalFile(helper.client, file, () => undefined)).rejects.toThrow(
      "connection reset",
    );
    expect(helper.calls.list).toBe(1);
    expect(helper.calls.remove).toBe(0);
  });

  it("complete 尚未发起时分块失败：安全删除本轮创建的半成品", async () => {
    const helper = uploadClient({ uploadError: new Error("chunk rejected") });
    const file = uploadFile("chunk-fail.bin");
    await expect(uploadLocalFile(helper.client, file, () => undefined)).rejects.toThrow(
      "chunk rejected",
    );
    expect(helper.calls.complete).toBe(0);
    expect(helper.calls.remove).toBe(1);
  });

  it("用户在分块后取消：complete 未发起，删除半成品并抛取消语义", async () => {
    const helper = uploadClient({});
    const file = uploadFile("cancel-before-complete.bin");
    let checks = 0;
    await expect(
      uploadLocalFile(helper.client, file, () => undefined, () => {
        checks += 1;
        return checks >= 2; // 第一块上传后取消
      }),
    ).rejects.toMatchObject({ kind: "network" });
    expect(helper.calls.complete).toBe(0);
    expect(helper.calls.remove).toBe(1);
  });
});

describe("downloadRemoteFile SHA-256 复核", () => {
  it("分块哈希与清单一致 → 写入完整文件并返回 URI", async () => {
    const data = new Uint8Array(1000);
    crypto.getRandomValues(data);
    const chunks = splitBytes(data, 8);
    const file = remoteFile({
      size: data.length,
      chunks: chunks.length,
      received_chunks: chunks.length,
      sha256: sha256Hex(data),
    });
    const progress: Array<[number, number]> = [];
    const uri = await downloadRemoteFile(
      fakeClient(chunks),
      file,
      DIR,
      (done, total) => progress.push([done, total]),
    );
    expect(uri).toBe(`${DIR}/${file.name}`);
    const stored = fileByUri(uri);
    expect(stored).toBeTruthy();
    expect(stored?.deleted).toBe(false);
    const merged = new Uint8Array(data.length);
    let offset = 0;
    for (const part of stored?.parts ?? []) {
      merged.set(part, offset);
      offset += part.length;
    }
    expect(Array.from(merged)).toEqual(Array.from(data));
    // 每块回调一次，最后一项是 [总块数, 总块数]
    expect(progress.length).toBe(chunks.length);
    expect(progress[progress.length - 1]).toEqual([chunks.length, chunks.length]);
    expect(progress[0]).toEqual([1, chunks.length]);
  });

  it("清单大写 hash 与小写计算值一致 → 复核通过", async () => {
    const data = new TextEncoder().encode("大小写归一");
    const chunks = splitBytes(data, 4);
    const file = remoteFile({
      size: data.length,
      chunks: chunks.length,
      sha256: sha256Hex(data).toUpperCase(),
    });
    const uri = await downloadRemoteFile(fakeClient(chunks), file, DIR, () => undefined);
    expect(fileByUri(uri)?.deleted).toBe(false);
  });

  it("SHA-256 不匹配 → 删除本地半成品并抛 validation", async () => {
    const data = new TextEncoder().encode("桌面端提供的原始内容");
    const corrupted = data.slice();
    corrupted[3] ^= 0xff; // 中途翻转一个字节
    const chunks = splitBytes(corrupted, 6);
    const file = remoteFile({
      size: data.length,
      chunks: chunks.length,
      sha256: sha256Hex(data),
    });
    await expect(
      downloadRemoteFile(fakeClient(chunks), file, DIR, () => undefined),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).kind).toBe("validation");
      expect((error as AppError).message).toContain("SHA-256");
      return true;
    });
    const stored = fileByUri(`${DIR}/${file.name}`);
    expect(stored?.deleted).toBe(true);
    expect(stored?.deleteAttempts).toBe(1);
  });

  it("清单 sha256 为空（防御路径）→ 跳过复核，下载成功", async () => {
    const data = new TextEncoder().encode("legacy");
    const chunks = splitBytes(data, 3);
    const file = remoteFile({ size: data.length, chunks: chunks.length, sha256: "" });
    const uri = await downloadRemoteFile(fakeClient(chunks), file, DIR, () => undefined);
    expect(fileByUri(uri)?.deleted).toBe(false);
  });

  it("取消 → 半成品删除且错误为取消语义（既有行为回归）", async () => {
    const data = new TextEncoder().encode("cancel-me-cancel-me");
    const chunks = splitBytes(data, 6);
    const file = remoteFile({ size: data.length, chunks: chunks.length, sha256: sha256Hex(data) });
    let seen = 0;
    await expect(
      downloadRemoteFile(
        fakeClient(chunks),
        file,
        DIR,
        () => undefined,
        () => {
          seen += 1;
          return seen >= 1; // 第一块之后取消
        },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as AppError).message).toBe(FILE_CANCELLED_MESSAGE);
      return true;
    });
    expect(fileByUri(`${DIR}/${file.name}`)?.deleted).toBe(true);
  });

  it("mock 的 SAF 语义：句柄未关闭时 delete 失败（与真机一致，防测试替身漂移）", async () => {
    const seeded = __seedFile(DIR, "handle.txt", new TextEncoder().encode("x"));
    const handle = seeded.open(FileMode.WriteOnly);
    expect(() => seeded.delete()).toThrow();
    handle.close();
    expect(() => seeded.delete()).not.toThrow();
    expect(new FsFile(seeded.uri).exists).toBe(false);
  });
});

describe("uploadDisplayName / isOpaqueFileName", () => {
  function fake(name: string, uri = `content://media/external/file/${name}`, type = "image/jpeg") {
    return { name, uri, type, size: 10, exists: true } as unknown as Parameters<typeof uploadDisplayName>[0];
  }

  it("识别 vivo 风格的非显示名", () => {
    expect(isOpaqueFileName("document:1000069262")).toBe(true);
    expect(isOpaqueFileName("document%3A1000069262")).toBe(true);
    expect(isOpaqueFileName("image:1000069917")).toBe(true);
    expect(isOpaqueFileName("video:1000069917")).toBe(true);
    expect(isOpaqueFileName("1000069262")).toBe(true);
    expect(isOpaqueFileName(" IMG_20261115.jpg ")).toBe(false);
    expect(isOpaqueFileName("")).toBe(true);
  });

  it("非显示名回退为时间戳名，真实文件名原样保留", () => {
    const fallback = uploadDisplayName(fake("document:1000069262"));
    expect(fallback.startsWith("手机文件-")).toBe(true);
    expect(fallback.endsWith(".jpg")).toBe(true);
    const imageFallback = uploadDisplayName(fake("image:1000069917"));
    expect(imageFallback.startsWith("手机文件-")).toBe(true);
    expect(imageFallback.endsWith(".jpg")).toBe(true);
    expect(uploadDisplayName(fake("IMG_0001.jpg"))).toBe("IMG_0001.jpg");
  });
});
