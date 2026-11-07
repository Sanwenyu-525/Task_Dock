/** @vitest-environment jsdom */
//! 资源请求槽回归：StrictMode 双挂载、请求交错、卸载、失败与重试。
//!
//! 这里刻意用「可控 Promise」而不是 resolved mock：要复现的正是
//! 「第一次请求在途 + 组件被清理又重新挂载」的时序，立即 resolve 的 mock
//! 永远走不到那条路径。

import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useAsyncResource } from "./asyncResource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ProbeProps {
  keyName?: string;
  immediate?: boolean;
  fetcher: () => Promise<string>;
}

/** 只暴露状态文本：断言只看渲染结果，不碰内部 ref。 */
function Probe({ keyName = "test:resource", immediate = true, fetcher }: ProbeProps) {
  const resource = useAsyncResource(keyName, fetcher, { immediate });
  return (
    <div>
      <span data-testid="state">
        {resource.loading ? "loading" : resource.error ? `error:${resource.error}` : `ready:${resource.data ?? "null"}`}
      </span>
      <button type="button" onClick={resource.reload}>
        reload
      </button>
    </div>
  );
}

function state() {
  return screen.getByTestId("state").textContent;
}

function clickReload() {
  act(() => {
    screen.getByRole("button", { name: "reload" }).click();
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useAsyncResource", () => {
  it("StrictMode 双挂载复用同一在途请求，loading 必定收尾", async () => {
    const first = deferred<string>();
    const fetcher = vi.fn(() => first.promise);

    render(
      <StrictMode>
        <Probe fetcher={fetcher} />
      </StrictMode>,
    );

    // 第二次挂载接的是第一次的请求：既没有重复扫描，也不会被「忙碌」拦死。
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state()).toBe("loading");

    await act(async () => {
      first.resolve("snapshot");
      await first.promise;
    });

    expect(state()).toBe("ready:snapshot");
  });

  it("卸载后完成的响应不写状态（重新挂载走新请求）", async () => {
    const first = deferred<string>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise);

    const view = render(<Probe fetcher={fetcher} keyName="test:unmount" />);
    expect(state()).toBe("loading");
    view.unmount();

    // 迟到的响应：不允许触发任何状态写入（React 会对已卸载组件报错）。
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      first.resolve("late");
      await first.promise;
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("旧请求晚到不覆盖新请求结果", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(<Probe fetcher={fetcher} keyName="test:interleave" />);
    clickReload();
    expect(fetcher).toHaveBeenCalledTimes(2);

    // 新请求先完成，旧请求后完成：最终结果必须是新的那一份。
    await act(async () => {
      second.resolve("new");
      await second.promise;
    });
    expect(state()).toBe("ready:new");

    await act(async () => {
      first.resolve("old");
      await first.promise;
    });
    expect(state()).toBe("ready:new");
  });

  it("失败结束 loading 并暴露错误，重试成功后可恢复", async () => {
    const failing = deferred<string>();
    const retry = deferred<string>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(failing.promise)
      .mockReturnValueOnce(retry.promise);

    render(<Probe fetcher={fetcher} keyName="test:retry" />);

    await act(async () => {
      failing.reject({ code: "UNKNOWN_ERROR" });
      await failing.promise.catch(() => {});
    });
    expect(state()?.startsWith("error:")).toBe(true);

    clickReload();
    await act(async () => {
      retry.resolve("after-retry");
      await retry.promise;
    });
    expect(state()).toBe("ready:after-retry");
  });

  it("immediate=false 时首帧不请求，reload 才加载", async () => {
    const pending = deferred<string>();
    const fetcher = vi.fn(() => pending.promise);

    render(<Probe fetcher={fetcher} keyName="test:lazy" immediate={false} />);
    expect(fetcher).not.toHaveBeenCalled();
    expect(state()).toBe("ready:null");

    clickReload();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve("lazy");
      await pending.promise;
    });
    expect(state()).toBe("ready:lazy");
  });

  it("失败后按键不会重复请求同一份在途结果", async () => {
    const pending = deferred<string>();
    const fetcher = vi.fn(() => pending.promise);

    function DoubleReload() {
      const [, force] = useState(0);
      return (
        <>
          <Probe fetcher={fetcher} keyName="test:double" />
          <button type="button" onClick={() => force((n) => n + 1)}>
            rerender
          </button>
        </>
      );
    }
    render(<DoubleReload />);
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => {
      screen.getByRole("button", { name: "rerender" }).click();
    });
    // 重渲染不触发请求：取数只由挂载与显式 reload 驱动。
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve("stable");
      await pending.promise;
    });
    expect(state()).toBe("ready:stable");
  });
});
