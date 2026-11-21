import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultRecordDetail, VaultRecordListItem } from "../lib/vault";

vi.mock("../lib/vault", () => ({
  vaultApi: {
    getRecord: vi.fn(),
    listRecords: vi.fn().mockResolvedValue([]),
    copySecret: vi.fn(),
    clearClipboardNow: vi.fn().mockResolvedValue({ cleared: true, reason: "cleared" }),
  },
  // store 首次 refreshStatus 时挂模块级订阅：单测里给可解除的空实现。
  onVaultLocked: vi.fn(() => Promise.resolve(() => {})),
  onVaultStatus: vi.fn(() => Promise.resolve(() => {})),
}));

import { vaultApi } from "../lib/vault";
import { resetVaultWatchForTests, useVaultStore } from "./useVaultStore";

const base: VaultRecordDetail = {
  id: "r1",
  rev: 1,
  type: "password",
  title: "示例站点",
  username: "alice",
  email: "",
  url: "https://example.com",
  platform: "",
  categoryId: "cat",
  categoryName: "账号",
  tagIds: [],
  tagNames: [],
  favorite: false,
  updatedAt: "2026-11-18T00:00:00Z",
  fieldCount: 1,
  note: "",
  createdAt: "2026-11-18T00:00:00Z",
  fields: [],
};

function detailWith(revealed: boolean): VaultRecordDetail {
  return {
    ...base,
    fields: [
      {
        id: "password",
        label: "密码",
        kind: "password",
        revealed,
        value: revealed ? "secret-value" : "••••••",
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(vaultApi.getRecord).mockImplementation(async (_id, reveal = []) => {
    return detailWith(reveal.includes("password"));
  });
  useVaultStore.setState({ detail: detailWith(false), error: null });
});

describe("useVaultStore field reveal", () => {
  it("reveals a hidden field and hides it again without dropping other fields", async () => {
    await useVaultStore.getState().toggleFieldReveal("password");
    expect(vaultApi.getRecord).toHaveBeenLastCalledWith("r1", ["password"]);
    expect(useVaultStore.getState().detail?.fields[0].revealed).toBe(true);

    await useVaultStore.getState().toggleFieldReveal("password");
    expect(vaultApi.getRecord).toHaveBeenLastCalledWith("r1", []);
    expect(useVaultStore.getState().detail?.fields[0].revealed).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useVaultStore 锁定与在飞请求", () => {
  beforeEach(() => {
    resetVaultWatchForTests();
    useVaultStore.setState({ detail: null, items: [], lastCopied: null, epoch: 0, loading: false });
  });

  it("锁定后到达的详情不得写回（丢弃明文）", async () => {
    const pending = deferred<VaultRecordDetail>();
    vi.mocked(vaultApi.getRecord).mockReturnValueOnce(pending.promise);

    const loading = useVaultStore.getState().selectRecord("r1", ["password"]);
    // 请求在飞时锁定：resetAfterLock 递增世代并清空。
    useVaultStore.getState().resetAfterLock();
    pending.resolve(detailWith(true));
    await loading;

    expect(useVaultStore.getState().detail).toBeNull();
    expect(useVaultStore.getState().epoch).toBe(1);
  });

  it("锁定后到达的复制回执不得写回，并补一次即时清理", async () => {
    const pending = deferred<{ token: string; clearedAfterSecs: number }>();
    vi.mocked(vaultApi.copySecret).mockReturnValueOnce(pending.promise);

    const copying = useVaultStore.getState().copyField("r1", "password", 30);
    useVaultStore.getState().resetAfterLock();
    pending.resolve({ token: "t-1", clearedAfterSecs: 30 });
    await copying;

    expect(useVaultStore.getState().lastCopied).toBeNull();
    expect(vaultApi.clearClipboardNow).toHaveBeenCalledTimes(1);
  });

  it("锁定后到达的列表不得覆盖已清空的状态", async () => {
    const pending = deferred<VaultRecordListItem[]>();
    vi.mocked(vaultApi.listRecords).mockReturnValueOnce(pending.promise);

    const loading = useVaultStore.getState().refreshList();
    useVaultStore.getState().resetAfterLock();
    pending.resolve([{ id: "r1" } as VaultRecordListItem]);
    await loading;

    expect(useVaultStore.getState().items).toEqual([]);
    expect(useVaultStore.getState().loading).toBe(false);
  });

  it("未锁定时正常写入（对照组）", async () => {
    vi.mocked(vaultApi.getRecord).mockResolvedValueOnce(detailWith(true));
    await useVaultStore.getState().selectRecord("r1", ["password"]);
    expect(useVaultStore.getState().detail?.fields[0].revealed).toBe(true);
  });

  it("resetAfterLock 递增世代并清空可见明文", () => {
    useVaultStore.setState({
      detail: detailWith(true),
      lastCopied: { token: "t", fieldId: "f", clearedAfterSecs: 30 },
    });
    useVaultStore.getState().resetAfterLock();
    const state = useVaultStore.getState();
    expect(state.detail).toBeNull();
    expect(state.lastCopied).toBeNull();
    expect(state.epoch).toBe(1);
    useVaultStore.getState().resetAfterLock();
    expect(useVaultStore.getState().epoch).toBe(2);
  });
});
