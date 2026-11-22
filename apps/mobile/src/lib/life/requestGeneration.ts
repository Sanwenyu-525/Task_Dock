/**
 * 请求代际控制（生活页详情/列表共用）。
 *
 * 每次发起请求取一个新的代际号；响应回来时只有代际仍然最新的那次允许写状态。
 * 这样旧请求无论成功、失败还是 finally 收尾，都不能覆盖/关闭用户后来打开的内容。
 */
export interface RequestGeneration {
  next(): number;
  isCurrent(sequence: number): boolean;
}

export function createRequestGeneration(): RequestGeneration {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(sequence: number) {
      return sequence === current;
    },
  };
}
