// P0-01 发送链路的行为验收：不是「函数返回了」，而是断言**数据库里的真实状态**。
//
// 用真实 SQLite（node:sqlite harness）+ 内存文件系统，只替换原生边界与远端客户端；
// 远端用可编程假客户端模拟桌面端的状态码，业务代码原样运行。
import { beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({
  list: (async () => []) as () => Promise<unknown[]>,
  create: (async () => ({})) as (name: string, size: number) => Promise<unknown>,
  uploadChunk: (async () => ({})) as (id: string, index: number, bytes: Uint8Array) => Promise<unknown>,
  complete: (async () => ({})) as (id: string) => Promise<unknown>,
  shelf: (async () => ({})) as (id: string, groupId?: string | null) => Promise<unknown>,
  groups: (async () => []) as () => Promise<unknown[]>,
  createCalls: 0,
  uploadCalls: 0,
  removeCalls: 0,
  cancelCalls: 0,
}));

vi.mock("../../../lib/sync/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/sync/files")>();
  const client = {
    list: () => remote.list(),
    create: (name: string, size: number) => {
      remote.createCalls += 1;
      return remote.create(name, size);
    },
    uploadChunk: (id: string, index: number, bytes: Uint8Array) => {
      remote.uploadCalls += 1;
      return remote.uploadChunk(id, index, bytes);
    },
    complete: (id: string) => remote.complete(id),
    downloadChunk: async () => new Uint8Array(0),
    remove: async () => {
      remote.removeCalls += 1;
      return undefined;
    },
    importToShelf: (id: string, groupId?: string | null) => remote.shelf(id, groupId),
    shelfGroups: () => remote.groups(),
    cancel: () => {
      remote.cancelCalls += 1;
    },
  };
  return { ...actual, createFileClient: () => client };
});

vi.mock("../../../db/syncConnection", () => ({
  loadConnection: async () => ({
    baseUrl: "https://192.168.1.9:4782",
    serverName: "DESKTOP",
    tlsFingerprint: "a".repeat(64),
    apiVersion: 2,
  }),
  readToken: async () => "b".repeat(64),
}));

// album.ts 依赖 react-native 的 PermissionsAndroid，node 环境不加载；
// 本测试不覆盖相册路径，只隔离这个原生边界。
vi.mock("../album", () => ({
  createPdfFromImages: vi.fn(),
  createThumbnail: async () => null,
  resolveDisplayName: async () => null,
  saveToSystemGallery: vi.fn(),
  transformImage: vi.fn(),
}));

import * as repo from "../../../db/captureAssets";
import { closeDatabase, openDatabase } from "../../../db/database";
import { AppError } from "../../../lib/errors";
import { createCancelledError, FileHttpError } from "../../../lib/sync/transferError";
import { __resetFs, __seedFile, fileByUri } from "../../../test/mocks/expo-file-system";

import { createTransferCancelToken } from "../cancel";
import {
  cleanupStagedAfterRun,
  reconcileShelfDestinations,
  retryShelfImport,
  sendToDesktop,
} from "../service";

const STAGING_DIR = "file:///data/user/0/dev.taskdock.mobile/files/taskdock-captures/staging";
const SHA = "c".repeat(64);

function remoteFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "f".repeat(32),
    direction: "to_desktop",
    name: "照片.jpg",
    size: 32,
    sha256: SHA,
    status: "ready",
    chunk_size: 32,
    chunks: 1,
    received_chunks: 1,
    created_at: "2026-11-15T00:00:00Z",
    updated_at: "2026-11-15T00:00:00Z",
    completed_at: "2026-11-15T00:00:00Z",
    shelf_item_id: null,
    shelf_imported_at: null,
    shelf_group_id: null,
    ...overrides,
  };
}

async function savedAsset(name = "照片.jpg", sha: string | null = SHA) {
  const bytes = new Uint8Array(32).fill(7);
  const file = __seedFile(STAGING_DIR, name, bytes);
  const asset = await repo.createStagedAsset({
    kind: "photo",
    source: "camera",
    name,
    localPath: file.uri,
    mime: "image/jpeg",
    byteSize: bytes.length,
  });
  if (sha) {
    await repo.markAssetSaved(asset.id, {
      localPath: file.uri,
      byteSize: bytes.length,
      sha256: sha,
      thumbnailPath: null,
    });
  }
  const fresh = await repo.getAsset(asset.id);
  if (!fresh) throw new Error("asset missing");
  return fresh;
}

/** 仍处于 staged 的素材：cleanupStagedAfterRun 只处理这个状态。 */
async function stagedAsset(name = "待清理.jpg") {
  const bytes = new Uint8Array(32).fill(9);
  const file = __seedFile(STAGING_DIR, name, bytes);
  const asset = await repo.createStagedAsset({
    kind: "photo",
    source: "camera",
    name,
    localPath: file.uri,
    mime: "image/jpeg",
    byteSize: bytes.length,
  });
  return asset;
}

async function destinationState(assetId: string, kind: "desktop" | "shelf") {
  const items = await repo.listDestinations(assetId);
  return items.find((item) => item.destination === kind) ?? null;
}

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
  __resetFs();
  remote.createCalls = 0;
  remote.uploadCalls = 0;
  remote.removeCalls = 0;
  remote.cancelCalls = 0;
  remote.list = async () => [];
  remote.groups = async () => [{ id: "g-default", name: "默认分组", builtin: true }];
  remote.create = async (name: string, size: number) =>
    remoteFile({ name, size, status: "pending", sha256: "", chunks: 1, chunk_size: size, received_chunks: 0, completed_at: null });
  remote.uploadChunk = async () => remoteFile({ status: "pending", sha256: "", completed_at: null });
  remote.complete = async (id: string) => remoteFile({ id });
  remote.shelf = async (id: string, groupId?: string | null) =>
    remoteFile({ id, shelf_item_id: `mf-${id}`, shelf_group_id: groupId ?? "g-default" });
});

describe("上传前预检的错误分类（P0-01）", () => {
  it("桌面端 401：整批 failed + stopBatch，绝不写成「等待电脑」", async () => {
    const asset = await savedAsset();
    remote.list = async () => {
      throw new FileHttpError(401, "unauthorized");
    };

    const result = await sendToDesktop([asset], { target: "inbox" });

    expect(result.offline).toBe(false);
    expect(result.stopBatch).toBe(true);
    expect(result.outcomes[0]?.state).toBe("failed");
    const desktop = await destinationState(asset.id, "desktop");
    expect(desktop?.state).toBe("failed");
    expect(desktop?.lastError ?? "").toContain("重新扫码配对");
    // 预检失败时不应尝试任何上传
    expect(remote.createCalls).toBe(0);
  });

  it("电脑关闭/断网：pending（offline=true），保留可重试", async () => {
    const asset = await savedAsset();
    remote.list = async () => {
      throw new AppError("network", "java.net.ConnectException: ECONNREFUSED");
    };

    const result = await sendToDesktop([asset], { target: "inbox" });

    expect(result.offline).toBe(true);
    expect(result.outcomes[0]?.state).toBe("pending");
    const desktop = await destinationState(asset.id, "desktop");
    expect(desktop?.state).toBe("pending");
    expect(desktop?.lastError ?? "").toContain("电脑端暂时不可达");
  });

  it("TLS 指纹不匹配：failed + stopBatch，不能降级成离线", async () => {
    const asset = await savedAsset();
    remote.list = async () => {
      throw new AppError(
        "validation",
        "桌面端证书指纹不匹配（可能存在中间人），请重新扫码配对",
        undefined,
        "tls_pin_mismatch",
      );
    };

    const result = await sendToDesktop([asset], { target: "shelf" });

    expect(result.offline).toBe(false);
    expect(result.stopBatch).toBe(true);
    expect((await destinationState(asset.id, "desktop"))?.state).toBe("failed");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("failed");
  });
});

describe("上传成功与暂存架失败必须分开（P0-03 客户端侧）", () => {
  it("旧桌面端不支持暂存架（404）：desktop=done、shelf=failed，并提示升级", async () => {
    const asset = await savedAsset();
    remote.shelf = async () => {
      throw new FileHttpError(404, "not_supported");
    };

    const result = await sendToDesktop([asset], { target: "shelf", shelfGroupId: "g-default" });

    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    const shelf = await destinationState(asset.id, "shelf");
    expect(shelf?.state).toBe("failed");
    expect(shelf?.remoteId).toBe("f".repeat(32));
    expect(shelf?.lastError ?? "").toContain("升级桌面端");
    expect(result.outcomes[0]?.state).toBe("failed");
    expect(result.outcomes[0]?.remoteId).toBe("f".repeat(32));
    // 上传只发生一次，且失败不删除远端传输记录
    expect(remote.createCalls).toBe(1);
  });

  it("暂存架 404 + 分组可用 = 记录不存在：desktop=done、shelf=failed，提示不是升级", async () => {
    const asset = await savedAsset();
    remote.shelf = async () => {
      throw new FileHttpError(404, "not_found");
    };

    const result = await sendToDesktop([asset], { target: "shelf", shelfGroupId: "g-default" });

    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    const shelf = await destinationState(asset.id, "shelf");
    expect(shelf?.state).toBe("failed");
    expect(shelf?.lastError ?? "").toContain("找不到该文件记录");
    expect(shelf?.lastError ?? "").not.toContain("升级桌面端");
    expect(result.stopBatch ?? false).toBe(false);
  });

  it("暂存架 409 冲突：desktop=done、shelf=pending（可重试），不误报整个素材失败", async () => {
    const asset = await savedAsset();
    remote.shelf = async () => {
      throw new FileHttpError(409, "conflict");
    };

    const result = await sendToDesktop([asset], { target: "shelf" });

    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    const shelf = await destinationState(asset.id, "shelf");
    expect(shelf?.state).toBe("pending");
    expect(shelf?.remoteId).toBe("f".repeat(32));
    expect(result.outcomes[0]?.state).toBe("pending");
  });

  it.each([
    [429, "too_many_requests"],
    [503, "internal_error"],
  ])("暂存架 %d：desktop=done、shelf=pending", async (status, code) => {
    const asset = await savedAsset();
    remote.shelf = async () => {
      throw new FileHttpError(status, code);
    };

    const result = await sendToDesktop([asset], { target: "shelf" });

    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("pending");
    expect(result.outcomes[0]?.state).toBe("pending");
  });

  it("暂存架网络中断：desktop=done、shelf=pending，不伪装成永久失败", async () => {
    const asset = await savedAsset();
    remote.shelf = async () => {
      throw new AppError("network", "java.net.ConnectException: ECONNRESET");
    };

    const result = await sendToDesktop([asset], { target: "shelf" });

    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    const shelf = await destinationState(asset.id, "shelf");
    expect(shelf?.state).toBe("pending");
    expect(result.outcomes[0]?.state).toBe("pending");
  });

  it("暂存架 401：desktop=done、shelf=failed、stopBatch=true", async () => {
    const asset = await savedAsset();
    remote.shelf = async () => {
      throw new FileHttpError(401, "unauthorized");
    };

    const result = await sendToDesktop([asset], { target: "shelf" });

    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("failed");
    expect(result.stopBatch).toBe(true);
    expect(result.outcomes[0]?.state).toBe("failed");
  });

  it("暂存架 TLS 失败：desktop=done、shelf=failed、stopBatch=true", async () => {
    const asset = await savedAsset();
    remote.shelf = async () => {
      throw new AppError("validation", "证书指纹不匹配", undefined, "tls_pin_mismatch");
    };

    const result = await sendToDesktop([asset], { target: "shelf" });

    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("failed");
    expect(result.stopBatch).toBe(true);
  });

  it("暂存架用户取消：desktop=done、shelf=cancelled", async () => {
    const asset = await savedAsset();
    remote.shelf = async () => {
      throw createCancelledError();
    };

    const result = await sendToDesktop([asset], { target: "shelf" });

    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("cancelled");
    expect(result.outcomes[0]?.state).toBe("cancelled");
  });
});

describe("仅重试暂存架（不重新上传文件）", () => {
  async function uploadedAsset() {
    const asset = await savedAsset();
    await repo.setDestination(asset.id, "desktop", {
      state: "done",
      remoteId: "f".repeat(32),
      bytesTotal: asset.byteSize,
      bytesDone: asset.byteSize,
    });
    return asset;
  }

  it("成功：只写 shelf=done，desktop 保持 done，不再创建上传", async () => {
    const asset = await uploadedAsset();
    const result = await retryShelfImport(asset, "f".repeat(32), "g-default");
    expect(result.state).toBe("done");
    expect(result.stopBatch).toBe(false);
    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("done");
    expect(remote.createCalls).toBe(0);
    expect(remote.uploadCalls).toBe(0);
  });

  it("409：shelf=pending，不停止后续项目", async () => {
    const asset = await uploadedAsset();
    remote.shelf = async () => {
      throw new FileHttpError(409, "conflict");
    };
    const result = await retryShelfImport(asset, "f".repeat(32), null);
    expect(result.state).toBe("pending");
    expect(result.stopBatch).toBe(false);
    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("pending");
  });

  it("401：shelf=failed 且 stopBatch=true（批量必须停止）", async () => {
    const asset = await uploadedAsset();
    remote.shelf = async () => {
      throw new FileHttpError(401, "unauthorized");
    };
    const result = await retryShelfImport(asset, "f".repeat(32), null);
    expect(result.state).toBe("failed");
    expect(result.stopBatch).toBe(true);
    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("failed");
  });

  it("TLS 失败：failed 且 stopBatch=true，错误不被包装成离线", async () => {
    const asset = await uploadedAsset();
    remote.shelf = async () => {
      throw new AppError("validation", "证书指纹不匹配", undefined, "tls_pin_mismatch");
    };
    const result = await retryShelfImport(asset, "f".repeat(32), null);
    expect(result.state).toBe("failed");
    expect(result.stopBatch).toBe(true);
    expect((await destinationState(asset.id, "shelf"))?.lastError ?? "").toContain("安全校验");
  });

  it("成功但响应缺 shelf_item_id：shelf=failed，不能伪装 done", async () => {
    const asset = await uploadedAsset();
    remote.shelf = async (id: string) => remoteFile({ id, shelf_item_id: null });

    const result = await retryShelfImport(asset, "f".repeat(32), null);

    expect(result.state).toBe("failed");
    expect(result.stopBatch).toBe(false);
    expect(result.message).toContain("暂存架条目");
    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("failed");
  });

  it("404 not_found：failed，提示记录不存在而不是升级桌面端", async () => {
    const asset = await uploadedAsset();
    remote.shelf = async () => {
      throw new FileHttpError(404, "not_found");
    };
    const result = await retryShelfImport(asset, "f".repeat(32), null);
    expect(result.state).toBe("failed");
    expect(result.stopBatch).toBe(false);
    expect(result.message).toContain("找不到该文件记录");
    expect(result.message).not.toContain("升级桌面端");
  });
});

describe("五文件混合结果（3 成功 / 1 上传失败 / 1 暂存架失败）", () => {
  it("五项独立落库：前三 done、第四 desktop failed、第五 desktop done + shelf failed", async () => {
    const assets = await Promise.all(
      ["A", "B", "C", "D", "E"].map((tag) =>
        savedAsset(`${tag}.pdf`, `${tag}`.repeat(64).slice(0, 64)),
      ),
    );
    const ids = new Map<string, string>();
    remote.create = async (name: string, size: number) => {
      if (name.startsWith("D.")) throw new FileHttpError(400, "upload_rejected");
      const id = `${name.charCodeAt(0)}`.repeat(32).slice(0, 32);
      ids.set(name, id);
      return remoteFile({
        id,
        name,
        size,
        status: "pending",
        sha256: "",
        chunks: 1,
        chunk_size: size,
        received_chunks: 0,
        completed_at: null,
      });
    };
    remote.uploadChunk = async (id: string) =>
      remoteFile({
        id,
        direction: "to_desktop",
        status: "pending",
        sha256: "",
        received_chunks: 1,
        completed_at: null,
      });
    remote.complete = async (id: string) =>
      remoteFile({
        id,
        direction: "to_desktop",
        status: "ready",
        completed_at: "2026-11-16T00:00:00Z",
      });
    remote.shelf = async (id: string, groupId?: string | null) => {
      if (id === ids.get("E.pdf")) {
        throw new FileHttpError(400, "shelf_rejected");
      }
      return remoteFile({
        id,
        shelf_item_id: `mf-${id}`,
        shelf_group_id: groupId ?? "g-default",
      });
    };

    const result = await sendToDesktop(assets, { target: "shelf", shelfGroupId: "g-default" });

    expect(result.stopBatch ?? false).toBe(false);
    expect(result.outcomes).toHaveLength(5);
    expect(result.outcomes.slice(0, 3).map((item) => item.state)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(result.outcomes[3]?.state).toBe("failed");
    expect(result.outcomes[4]?.state).toBe("failed");
    expect(result.outcomes[4]?.remoteId).toBe(ids.get("E.pdf"));

    expect((await destinationState(assets[0].id, "desktop"))?.state).toBe("done");
    expect((await destinationState(assets[1].id, "desktop"))?.state).toBe("done");
    expect((await destinationState(assets[2].id, "desktop"))?.state).toBe("done");
    expect((await destinationState(assets[3].id, "desktop"))?.state).toBe("failed");
    expect((await destinationState(assets[4].id, "desktop"))?.state).toBe("done");
    expect((await destinationState(assets[4].id, "shelf"))?.state).toBe("failed");
    expect((await destinationState(assets[4].id, "shelf"))?.remoteId).toBe(ids.get("E.pdf"));

    // D 没有进入分块/complete；A-C 和 E 各上传一次，E 暂存架失败不触发重传。
    expect(remote.createCalls).toBe(5);
    expect(remote.uploadCalls).toBe(4);
    expect(remote.removeCalls).toBe(0);
  });
});

describe("重试幂等（不因重试产生重复文件）", () => {
  it("远端已有同 SHA-256 的 ready 记录时跳过上传，直接复用 file id", async () => {
    const asset = await savedAsset();
    remote.list = async () => [remoteFile({ name: "照片_桌面端清洗后.jpg" })];

    const result = await sendToDesktop([asset], { target: "shelf" });

    expect(remote.createCalls).toBe(0);
    expect(remote.uploadCalls).toBe(0);
    expect(result.outcomes[0]?.state).toBe("done");
    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "desktop"))?.remoteId).toBe("f".repeat(32));
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("done");
  });

  it("批次中途 401：只尝试一次上传，剩余素材直接 failed（不继续发）", async () => {
    const first = await savedAsset("第一张.jpg");
    const second = await savedAsset("第二张.jpg");
    remote.create = async () => {
      throw new FileHttpError(401, "unauthorized");
    };

    const result = await sendToDesktop([first, second], { target: "inbox" });

    expect(remote.createCalls).toBe(1);
    expect(result.stopBatch).toBe(true);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((outcome) => outcome.state === "failed")).toBe(true);
    expect((await destinationState(second.id, "desktop"))?.state).toBe("failed");
    expect((await destinationState(second.id, "desktop"))?.lastError ?? "").toContain("重新扫码配对");
  });

  it("用户取消：cancelled，不写 done", async () => {
    const asset = await savedAsset();

    const result = await sendToDesktop([asset], {
      target: "inbox",
      isCancelled: () => true,
    });

    expect(result.outcomes[0]?.state).toBe("cancelled");
    expect((await destinationState(asset.id, "desktop"))?.state).toBe("cancelled");
    expect(remote.createCalls).toBe(0);
  });
});

describe("取消令牌接入传输层（P0-01 第四轮）", () => {
  it("上传前取消：不创建远端记录，写 cancelled", async () => {
    const asset = await savedAsset();
    const token = createTransferCancelToken();
    token.cancel();

    const result = await sendToDesktop([asset], { target: "inbox", cancelToken: token });

    expect(remote.createCalls).toBe(0);
    expect(remote.uploadCalls).toBe(0);
    expect(result.outcomes[0]?.state).toBe("cancelled");
    expect((await destinationState(asset.id, "desktop"))?.state).toBe("cancelled");
  });

  it("第一个分块上传中取消：停止并清理未完成远端记录", async () => {
    const asset = await savedAsset();
    const token = createTransferCancelToken();
    // 真实 FileClient.cancel() 会 abort 在途请求；这里用“分块回调里置位”模拟
    // 同一个取消窗口，断言业务层不会再发 complete，并清理半成品。
    remote.uploadChunk = async () => {
      token.cancel();
      return remoteFile({ status: "pending", sha256: "", completed_at: null });
    };

    const result = await sendToDesktop([asset], { target: "inbox", cancelToken: token });

    expect(remote.createCalls).toBe(1);
    expect(remote.uploadCalls).toBe(1);
    expect(remote.removeCalls).toBe(1);
    expect(result.outcomes[0]?.state).toBe("cancelled");
    expect((await destinationState(asset.id, "desktop"))?.state).toBe("cancelled");
    expect(remote.cancelCalls).toBeGreaterThan(0);
  });

  it("五文件第二项取消：第三至第五项不发请求并写 cancelled", async () => {
    const assets = await Promise.all([
      savedAsset("一.jpg"),
      savedAsset("二.jpg"),
      savedAsset("三.jpg"),
      savedAsset("四.jpg"),
      savedAsset("五.jpg"),
    ]);
    const token = createTransferCancelToken();
    remote.uploadChunk = async () => {
      // 第一项正常完成；第二项在分块请求返回时取消，随后不应再 complete。
      if (remote.uploadCalls === 2) token.cancel();
      return remoteFile({ status: "pending", sha256: "", completed_at: null });
    };

    const result = await sendToDesktop(assets, { target: "inbox", cancelToken: token });

    expect(remote.createCalls).toBe(2);
    expect(remote.uploadCalls).toBe(2);
    expect(result.outcomes).toHaveLength(5);
    expect(result.outcomes[0]?.state).toBe("done");
    expect(result.outcomes.slice(1).every((outcome) => outcome.state === "cancelled")).toBe(true);
    expect((await destinationState(assets[0].id, "desktop"))?.state).toBe("done");
    for (const asset of assets.slice(1)) {
      expect((await destinationState(asset.id, "desktop"))?.state).toBe("cancelled");
    }
  });

  it("upload 已完成但暂存架导入前取消：desktop=done、shelf=cancelled、不重传", async () => {
    const asset = await savedAsset();
    const token = createTransferCancelToken();
    remote.complete = async (id: string) => {
      token.cancel();
      return remoteFile({ id });
    };

    const result = await sendToDesktop([asset], {
      target: "shelf",
      cancelToken: token,
    });

    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("cancelled");
    expect(result.outcomes[0]?.state).toBe("cancelled");
    expect(remote.createCalls).toBe(1);
  });

  it("暂存架导入中取消：desktop 保持 done、shelf=cancelled、只重试导入", async () => {
    const asset = await savedAsset();
    const token = createTransferCancelToken();
    remote.shelf = async () => {
      token.cancel();
      throw createCancelledError();
    };

    const result = await sendToDesktop([asset], {
      target: "shelf",
      cancelToken: token,
    });

    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("cancelled");
    expect(result.outcomes[0]?.state).toBe("cancelled");
  });
});

describe("暂存架远端状态对账（P0-02）", () => {
  async function uploadedShelfAsset() {
    const asset = await savedAsset();
    await repo.setDestination(asset.id, "desktop", {
      state: "done",
      remoteId: "f".repeat(32),
      bytesDone: asset.byteSize,
      bytesTotal: asset.byteSize,
    });
    await repo.setDestination(asset.id, "shelf", {
      state: "done",
      remoteId: "f".repeat(32),
      remoteShelfId: "mf-old",
    });
    return asset;
  }

  it("远端明确 shelf_item_id=null：保留 desktop done，清空过期引用并标 failed", async () => {
    const asset = await uploadedShelfAsset();
    remote.list = async () => [remoteFile({ shelf_item_id: null })];

    const result = await reconcileShelfDestinations();

    expect(result.stale).toBe(1);
    expect((await destinationState(asset.id, "desktop"))?.state).toBe("done");
    const shelf = await destinationState(asset.id, "shelf");
    expect(shelf?.state).toBe("failed");
    expect(shelf?.remoteShelfId).toBeNull();
    expect(shelf?.lastError ?? "").toContain("重新导入");
  });

  it("老桌面端字段缺失：不把缺失当删除", async () => {
    const asset = await uploadedShelfAsset();
    const { shelf_item_id: _omit, ...oldRemote } = remoteFile();
    remote.list = async () => [oldRemote];

    const result = await reconcileShelfDestinations();

    expect(result.stale).toBe(0);
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("done");
    expect((await destinationState(asset.id, "shelf"))?.remoteShelfId).toBe("mf-old");
  });

  it("远端 shelf id 变化：更新本地引用，仍为 done", async () => {
    const asset = await uploadedShelfAsset();
    remote.list = async () => [remoteFile({ shelf_item_id: "mf-new" })];

    const result = await reconcileShelfDestinations();

    expect(result.updated).toBe(1);
    const shelf = await destinationState(asset.id, "shelf");
    expect(shelf?.state).toBe("done");
    expect(shelf?.remoteShelfId).toBe("mf-new");
    expect(shelf?.remoteId).toBe("f".repeat(32));
  });
});

describe("清理 staged 时必须保留待重试的暂存架记录（P0 生命周期）", () => {
  it("desktop=done、shelf=pending 时不得删除资产记录和本地文件", async () => {
    const asset = await stagedAsset();
    await repo.setDestination(asset.id, "desktop", {
      state: "done",
      remoteId: "f".repeat(32),
      bytesDone: asset.byteSize,
      bytesTotal: asset.byteSize,
    });
    await repo.setDestination(asset.id, "shelf", {
      state: "pending",
      remoteId: "f".repeat(32),
      lastError: "暂存架待重试",
    });

    const removed = await cleanupStagedAfterRun([asset.id]);

    expect(removed).toBe(0);
    expect(await repo.getAsset(asset.id)).not.toBeNull();
    expect(fileByUri(asset.localPath!)?.deleted ?? true).toBe(false);
    expect((await destinationState(asset.id, "shelf"))?.state).toBe("pending");
    expect((await destinationState(asset.id, "desktop"))?.remoteId).toBe("f".repeat(32));
  });

  it("只有 desktop=done、没有待重试目的地时才允许清理", async () => {
    const asset = await stagedAsset("仅桌面完成.jpg");
    await repo.setDestination(asset.id, "desktop", {
      state: "done",
      remoteId: "f".repeat(32),
      bytesDone: asset.byteSize,
      bytesTotal: asset.byteSize,
    });

    const removed = await cleanupStagedAfterRun([asset.id]);

    expect(removed).toBe(1);
    expect(await repo.getAsset(asset.id)).toBeNull();
    expect(fileByUri(asset.localPath!)?.deleted ?? false).toBe(true);
  });
});
