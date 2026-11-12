// fileIo.downloadRemoteFile 的下载完整性用例：
// - 分块字节按序写入内存 SAF 目录（src/test/mocks/expo-file-system.ts）；
// - SHA-256 与桌面端清单一致 → 下载成功；
// - 不一致（传输损坏/被篡改）→ 删除本地半成品并明确报错（fail-closed）；
// - 清单缺 sha256（空串，防御路径）→ 跳过复核；
// - 取消 → 半成品删除（既有行为回归）。
import { beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../errors";
import { FILE_CANCELLED_MESSAGE, type FileClient, type RemoteFile } from "../files";
import { downloadRemoteFile } from "../fileIo";

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
    cancel(): void {},
  };
}

function splitBytes(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
  }
  return chunks;
}

beforeEach(() => {
  __resetFs();
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
