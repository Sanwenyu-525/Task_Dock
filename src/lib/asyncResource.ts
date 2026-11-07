//! 单次资源请求槽：最新请求优先 + 挂载期在途合并。
//!
//! ## 为什么需要它
//! 资源管理各分区原先各自维护 `mountedRef` + `busyRef` + `requestRef` 三件套。
//! `React.StrictMode` 下 Effect 会「执行 → 清理 → 再执行」：
//! 1. 第一次挂载发起请求，`busyRef = true`；
//! 2. 清理把请求标记失效（`requestRef += 1`），组件仍存活；
//! 3. 第二次挂载再次调用加载，被 `busyRef` 拦下（**直接 return，不改 loading**）;
//! 4. 第一次请求完成时因序号失效而不写状态；
//! 5. `loading` 永远停在 true——页面永久停在「读取中」。
//!
//! 因此这里不再用「忙碌就拒绝」的语义：
//! - **挂载期**（`coalesce`）复用仍在途的同一个 Promise：StrictMode 的第二次挂载
//!   接的是第一次的请求，既不重复启动高成本扫描（磁盘统计、内存目录），
//!   也一定有人把 `loading` 收尾；
//! - **用户主动刷新/重试**（`reload`）必定发起新请求并让旧请求失效：
//!   清理动作之后必须看到新数据，不能被在途的旧扫描顶掉。
//!
//! 状态只由「当前代次」写入：旧请求即使晚到也不会污染新结果；卸载后 `alive`
//! 置 false，任何在途响应都不再写状态。没有轮询、没有定时器、没有重试风暴。
//!
//! 错误文案统一走 `localizedErrorMessage`（与三个分区原有口径一致）。

import { useCallback, useEffect, useRef, useState } from "react";
import { localizedErrorMessage } from "../i18n/errors";

/**
 * 模块级在途请求表（key → Promise）。
 *
 * 只用于「挂载期合并」：组件卸载不会取消在途请求（IPC 无法中断），
 * 但表项在 Promise 结算后立即移除，不会长期驻留或跨页面复用旧数据。
 */
const inFlight = new Map<string, Promise<unknown>>();

export interface AsyncResource<T> {
  /** 最近一次**成功**结果；失败后清空，避免把过期指标显示成当前值。 */
  data: T | null;
  loading: boolean;
  error: string | null;
  /**
   * 用户主动刷新 / 失败重试：总是发起新请求。
   * 返回的 Promise 在**本次请求结算后**（成功或失败，状态已提交）resolve，
   * 供「操作 + 重新读取」这类事务用 `await` 把操作锁覆盖到重采样完成。
   */
  reload: () => Promise<void>;
}

/**
 * @param key     在途合并键（同一资源用同一个常量键；不同分区不要复用）
 * @param fetcher 取数函数（每次调用读取最新引用，不因重渲染重复请求）
 * @param options.immediate 是否在挂载时立即取一次（默认 true）
 */
export function useAsyncResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { immediate?: boolean } = {},
): AsyncResource<T> {
  const { immediate = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState<string | null>(null);

  // 每次渲染刷新引用：请求只在挂载或显式 reload 时发起，闭包不会过期。
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const aliveRef = useRef(false);
  const requestRef = useRef(0);

  const start = useCallback(
    (coalesce: boolean): Promise<void> => {
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);

      const shared = coalesce ? (inFlight.get(key) as Promise<T> | undefined) : undefined;
      let pending: Promise<T>;
      if (shared) {
        pending = shared;
      } else {
        pending = fetcherRef.current();
        inFlight.set(key, pending);
        // 结算即摘除表项；用双参数 then 消化拒绝，避免派生 Promise 未处理。
        const settled = () => {
          if (inFlight.get(key) === pending) inFlight.delete(key);
        };
        pending.then(settled, settled);
      }

      const commit = (apply: () => void) => {
        if (!aliveRef.current || request !== requestRef.current) return;
        apply();
      };
      // 无论成败都 resolve（错误已写进 error 状态）：调用方可以 await 结束操作锁，
      // 不必为「读取失败」再写一遍异常路径。
      return new Promise<void>((resolve) => {
        pending.then(
          (result) => {
            commit(() => {
              setData(result);
              setLoading(false);
            });
            resolve();
          },
          (reason: unknown) => {
            commit(() => {
              setData(null);
              setError(localizedErrorMessage(reason));
              setLoading(false);
            });
            resolve();
          },
        );
      });
    },
    [key],
  );

  useEffect(() => {
    aliveRef.current = true;
    if (immediate) start(true);
    return () => {
      // 卸载/失效：先作废代次，旧响应不会再写状态。
      aliveRef.current = false;
      requestRef.current += 1;
    };
  }, [immediate, start]);

  const reload = useCallback(() => start(false), [start]);

  return { data, loading, error, reload };
}
