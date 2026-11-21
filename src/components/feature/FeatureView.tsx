//! 页面级按需加载视图：代码按需 import、首次加载占位、失败重试、实例缓存策略。
//!
//! 为什么不用 `React.lazy`：
//! - `lazy` 会把**失败的 Promise 永久缓存**，页面级「重试」永远拿到同一个拒绝，
//!   等于没有重试；
//! - `lazy` 无法区分「代码已缓存」与「实例是否保留」，也无法上报加载耗时。
//! 因此这里直接消费 `featureRuntime` 的 Promise 缓存：同一模块并发只 import 一次，
//! 失败后点重试才真正重新请求（Vite/Tauri 本地资源的失败通常是磁盘/热更新瞬时问题）。
//!
//! 生命周期（与 docs/ON_DEMAND_LOADING.md §3 对应）：
//! - 首次 `active` → `loadFeature`（loading → ready）；
//! - `ready` 且 `active` → `activateFeature`；离开 → `deactivateFeature`；
//! - `instance: "release"` 的页面在离开时卸载实例并记一次 release（代码仍缓存）；
//! - `instance: "keep"` 的页面保活（草稿/滚动位置不丢），只由外壳设为 hidden。
//!
//! 边界：本组件只负责**页面代码与页面实例**。业务数据由页面自己按 `active` 加载，
//! 重型服务（设备会话、文件任务等）由各自模块在用户操作时初始化 —— 加载页面代码
//! 不等于启动这些服务。

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import {
  activateFeature,
  deactivateFeature,
  getFeatureSnapshot,
  loadFeature,
  noteFeatureInstanceReleased,
  peekFeatureModule,
  type FeatureInstancePolicy,
} from "../../lib/featureRuntime";
import { installFeatureRegistry } from "../../lib/featureRegistry";
import { useLocale } from "../../hooks/useLocale";

// 前置条件：注册表必须已安装。窗口入口会显式安装一次（`main.tsx` /
// `workspace/workspaceEntry.tsx`），这里再兜底一次——组件测试、按需渲染的子树都可能
// 绕过入口直接挂载本组件；`installFeatureRegistry` 幂等且只登记元数据。
installFeatureRegistry();

type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface FeatureViewProps<P> {
  /** 功能 ID（必须在 `featureRegistry` 登记）。 */
  id: string;
  /** 当前页面是否可见/应处于活跃态。 */
  active: boolean;
  /** 失败提示用的可读名（已本地化）。 */
  label: string;
  /**
   * 渲染函数：只有代码就绪后才调用，参数是真实页面组件。
   * 用泛型参数声明页面 props，调用点仍然是类型安全的。
   */
  children: (Component: ComponentType<P>) => ReactNode;
  /** 覆盖实例策略（默认取注册表）。 */
  instance?: FeatureInstancePolicy;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "页面代码加载失败";
}

export default function FeatureView<P>({
  id,
  active,
  label,
  children,
  instance,
}: FeatureViewProps<P>) {
  const { t } = useLocale();
  // 第二次进入时模块已在缓存：初始化即 ready，不产生 loading 闪烁。
  const [status, setStatus] = useState<LoadStatus>(() =>
    peekFeatureModule(id) ? "ready" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 首次激活前不渲染子树；激活过才进入「保活/释放」判定。
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);

  // 代码加载：只在可见时发生（预加载由导航项的 hover 单独触发）。
  useEffect(() => {
    if (!active) return;
    if (peekFeatureModule(id)) {
      setStatus("ready");
      setError(null);
      return;
    }
    let alive = true;
    setStatus("loading");
    loadFeature(id)
      .then(() => {
        if (!alive) return;
        setStatus("ready");
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setStatus("error");
        setError(describe(cause));
      });
    return () => {
      alive = false;
    };
    // attempt 只用于「用户点重试」；status 不进依赖，避免 loading 自触发第二次请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, active, attempt]);

  const policy: FeatureInstancePolicy = instance ?? getFeatureSnapshot(id)?.instance ?? "keep";
  // 渲染期派生「代码已就绪」：hover 预加载完成的页面不应再闪一帧 loading。
  const cachedModule = peekFeatureModule<{ default: ComponentType<P> }>(id);
  const ready = status === "ready" || (active && Boolean(cachedModule?.default));

  // 活跃态上报：只有真正渲染出页面后才算激活（loading/错误不算）。
  useEffect(() => {
    if (!active || !ready) return;
    void activateFeature(id).catch(() => {
      // 激活失败已由 runtime 记录；页面本身仍可渲染，不额外打断。
    });
    return () => {
      deactivateFeature(id);
      if (policy === "release") noteFeatureInstanceReleased(id);
    };
  }, [id, active, ready, policy]);

  const keepAlive = policy === "keep";
  const shouldRender = visited && (active || keepAlive);

  if (!shouldRender) return null;

  if (ready && cachedModule?.default) {
    const Component = cachedModule.default;
    return <>{children(Component)}</>;
  }

  if (status === "error" || ready) {
    // 隐藏的保活页不渲染错误卡片：失败提示只属于当前可见页面，否则切页后
    // 旧页面的 alert 仍留在 DOM 里（读屏会念、测试也会误判为「错误未恢复」）。
    // 再次进入时下方 effect 会因 active 变化自动重试一次。
    if (!active) return null;
    return (
      <div className="panel-status" role="alert">
        <p className="panel-status-text">
          {t("nav.loadFailed", { label })}
          {error ? `：${error}` : ""}
        </p>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            setError(null);
            setStatus("idle");
            setAttempt((value) => value + 1);
          }}
        >
          <RotateCcw size={12} aria-hidden="true" /> {t("common.retry")}
        </button>
      </div>
    );
  }

  // 首次加载占位：不做持续动画（本地 chunk 通常 < 100ms，动画反而像卡顿）。
  // 加载中就切走时，children 内的 hidden 容器还没生成，必须在这里隐藏旧页占位。
  if (!active) return null;
  return <div className="panel-loading" role="status" aria-label={t("nav.loading")} />;
}
