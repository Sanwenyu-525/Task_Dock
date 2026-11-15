// 分享队列的文件所有权（P0）：
// 1. 被队列上限挤掉的载荷必须回收临时文件（否则连续分享留下孤儿）；
// 2. 已被采集页消费（转入资产库）的文件，不能因清空队列被误删；
// 3. 单个文件清理失败不能阻断同批其它文件的回收。
import { beforeEach, describe, expect, it } from "vitest";

import type { ShareIntentPayload } from "../modules/share-intent";
import { consumePendingShare, discardPendingShare, offerShare } from "../src/lib/pendingShare";
import { __activeFiles, __resetFs, __seedFile } from "../src/test/mocks/expo-file-system";

const SHARE_DIR_URI = "file:///data/user/0/dev.taskdock.mobile/files/share";
const SHARE_DIR_PATH = "/data/user/0/dev.taskdock.mobile/files/share";

function payloadWithFile(offerId: number): ShareIntentPayload {
  const name = `share-${offerId}.jpg`;
  __seedFile(SHARE_DIR_URI, name, new Uint8Array(32));
  return {
    offerId,
    text: null,
    truncated: false,
    originalLength: 0,
    receivedAt: Date.now(),
    items: [
      {
        kind: "image",
        mime: "image/jpeg",
        name,
        size: 32,
        path: `${SHARE_DIR_PATH}/${name}`,
      },
    ],
    rejected: [],
  };
}

beforeEach(() => {
  __resetFs();
  discardPendingShare();
});

// lastOfferId 是模块级单调量：各用例使用递增且不重叠的 offerId 区间。
describe("pendingShare 文件回收", () => {
  it("队列溢出时删除被挤掉载荷的临时文件", () => {
    for (let index = 0; index < 7; index += 1) {
      offerShare(payloadWithFile(9001 + index));
    }
    // 保留最近 5 条（9003..9007）；9001/9002 被挤掉并回收
    const active = __activeFiles();
    expect(active).toContain(`${SHARE_DIR_URI}/share-9003.jpg`);
    expect(active).toContain(`${SHARE_DIR_URI}/share-9007.jpg`);
    expect(active).not.toContain(`${SHARE_DIR_URI}/share-9001.jpg`);
    expect(active).not.toContain(`${SHARE_DIR_URI}/share-9002.jpg`);
  });

  it("discard 只删未被消费的载荷，已转入资产库的文件保留", () => {
    const first = payloadWithFile(9101);
    const second = payloadWithFile(9102);
    const third = payloadWithFile(9103);
    offerShare(first);
    offerShare(second);
    offerShare(third);

    // 采集页消费第一条（文件所有权转入资产库）
    const consumed = consumePendingShare();
    expect(consumed?.offerId).toBe(9101);

    discardPendingShare();

    const active = __activeFiles();
    expect(active).toContain(`${SHARE_DIR_URI}/share-9101.jpg`);
    expect(active).not.toContain(`${SHARE_DIR_URI}/share-9102.jpg`);
    expect(active).not.toContain(`${SHARE_DIR_URI}/share-9103.jpg`);
  });

  it("单个文件清理失败不阻断剩余项目", () => {
    const name = "share-9201.jpg";
    __seedFile(SHARE_DIR_URI, name, new Uint8Array(32));
    const mixed: ShareIntentPayload = {
      offerId: 9201,
      text: null,
      truncated: false,
      originalLength: 0,
      receivedAt: Date.now(),
      items: [
        {
          kind: "image",
          mime: "image/jpeg",
          name: "already-gone.jpg",
          size: 32,
          // 文件已被系统回收：delete 会抛错，但不能影响后面那条
          path: `${SHARE_DIR_PATH}/already-gone.jpg`,
        },
        {
          kind: "image",
          mime: "image/jpeg",
          name,
          size: 32,
          path: `${SHARE_DIR_PATH}/${name}`,
        },
      ],
      rejected: [],
    };
    offerShare(mixed);
    offerShare(payloadWithFile(9202));

    discardPendingShare();

    const active = __activeFiles();
    expect(active).not.toContain(`${SHARE_DIR_URI}/${name}`);
    expect(active).not.toContain(`${SHARE_DIR_URI}/share-9202.jpg`);
  });
});
