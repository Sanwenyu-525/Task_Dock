//! 工作台极轻量启动入口（2026-11-19 启动诊断升级）。
//!
//! 为什么需要这一层：此前 workspace.html 直接以 `<script type="module"
//! src="/src/workspace/main.tsx">` 启动，整个静态依赖图（React + 8 个业务面板 +
//! 全部 store/bridge）必须在 main.tsx 主体执行前下载+解析完。诊断只能看到
//! 「模块脚本尚未执行」，无法区分「请求卡住 / 某个依赖 404 / 转换报错 / CSP 拦截」。
//!
//! 本文件刻意做到零静态业务依赖（不 import React、不 import WorkbenchShell、
//! 不 import 任何页面/store），只用浏览器原生能力：
//!   1. 入口一执行就记录 `bootstrap-start` —— 证明 HTML + 看门狗 + 本入口已就绪；
//!   2. 记录 `main-import-start` 后 `import("./main")` 动态加载真正入口；
//!   3. resolve 记 `main-import-resolved`，reject 记 `main-import-failed` 并调用
//!      watchdog.fail() 进入 error 态、写一次 UI_BOOT_FATAL，绝不静默吞掉。
//!
//! 这样动态 import 状态（not-requested/requested/pending/resolved/rejected）与
//! watchdog 的资源/CSP 采样叠加后，即可把「模块脚本尚未执行」定位到具体请求。
//!
//! 类型在此内联、不从 bootProtocol 静态导入：保持本模块对构建图的零依赖。
//! watchdog 自身也可能加载失败——那层由 workspace.html 的入口 script error 事件
//! 与内联「死人在场」保险兜底（见 boot-watchdog.js / workspace.html）。

/** watchdog 最小接口：本入口只用到这几个成员。 */
interface BootApi {
  startedAt: number;
  stage(name: string): void;
  importState?(next: "requested" | "pending" | "resolved" | "rejected"): void;
  fail(info: { stage?: string; message?: string; name?: string; stack?: string }): void;
}

function getBootApi(): BootApi | null {
  try {
    const api = (
      window as unknown as Record<string, unknown>
    ).__TASK_DOCK_BOOT__ as BootApi | undefined;
    return api && typeof api === "object" && typeof api.stage === "function"
      ? api
      : null;
  } catch {
    return null;
  }
}

function stage(name: string): void {
  try {
    getBootApi()?.stage(name);
  } catch {
    // 诊断信号自身绝不能阻断启动。
  }
}

function importState(next: "requested" | "pending" | "resolved" | "rejected"): void {
  try {
    getBootApi()?.importState?.(next);
  } catch {
    // 旧版 watchdog 无此方法时安全跳过（阶段信号仍完整）。
  }
}

/** stack 先做长度上限，敏感路径/query 的过滤在 watchdog 诊断输出时统一处理。 */
function clampStack(stack: unknown): string | undefined {
  if (typeof stack !== "string" || !stack) return undefined;
  return stack.slice(0, 2000);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
void (async () => {
  const api = getBootApi();
  stage("bootstrap-start");
  importState("requested");
  stage("main-import-start");
  importState("pending");

  try {
    // 字面量动态 import：Vite 在 dev 下解析为原生 module 请求，在 build 下生成
    // 独立 chunk。两者都会进入 watchdog 的 resource 采样，可据此定位卡住的依赖。
    await import("./main");
    stage("main-import-resolved");
    importState("resolved");
  } catch (error) {
    stage("main-import-failed");
    importState("rejected");
    const err = error instanceof Error ? error : new Error(String(error));
    const info = {
      stage: "main-import-failed",
      name: err.name,
      message: err.message,
      stack: clampStack(err.stack),
    };
    // 不再另留 console 副本：失败详情（stage/name/message/stack）由下方 fail() 经
    // watchdog 写一次 UI_BOOT_FATAL 诊断——该通道独立于本模块加载图，比在
    // 可能同样加载失败的入口里引日志模块更可靠，也不影响 UI 恢复卡。
    // 不静默吞：交给 watchdog 进入 error 态并写一次 UI_BOOT_FATAL。
    // fail 在 watchdog API 缺失时是 no-op，此时 HTML 的死人在场保险仍兜底。
    try {
      (api ?? getBootApi())?.fail(info);
    } catch {
      /* fail 自身失败也不能从 catch 里再抛 */
    }
  }
})();
