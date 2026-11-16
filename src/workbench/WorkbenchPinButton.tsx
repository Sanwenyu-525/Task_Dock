// 工作台自绘标题栏的「置顶 / 取消置顶」按钮。
//
// 归属：功能工具组（主题 / 外观 / 置顶）的最后一项，紧邻窗口控制组的分隔线。
//
// 交互契约：
// - 点击切换**当前 workspace 窗口**的 alwaysOnTop（Tauri window API，不新增业务 IPC）；
// - 状态以真实窗口为准：挂载时 `isAlwaysOnTop()` 回读，窗口重新获得焦点时再回读，
//   切换后也用 `isAlwaysOnTop()` 校准，避免只凭点击意图显示激活态；
// - 激活态走 `.wb-icon-btn.is-on`（accent-soft 底 + accent 描边），不只靠 tooltip；
// - 失败时提示并回读真实状态，不把失败的切换留在界面上；
// - 非 Tauri 环境（jsdom / 浏览器预览）没有窗口 API：按钮仍可聚焦、有清晰名称，
//   动作 no-op，不抛错、不阻断渲染。
//
// 持久化：工作台窗口几何由 Rust 侧持久化，alwaysOnTop 目前没有对应设置键；
// 本轮只做运行期状态，重开工作台回到窗口创建时的 `always_on_top(false)`。
//
// 2026-11-16：状态与写入抽到 `useWorkbenchPin`，顶栏窄窗的「更多」菜单复用同一份，
// 避免出现两个置顶入口各自维护状态。本组件对外 API（含 `window` 注入点）不变。
import { Pin, PinOff } from "lucide-react";
import { useWorkbenchPin, type WorkbenchPinHandle } from "./useWorkbenchPin";

export type { WorkbenchPinHandle };

export default function WorkbenchPinButton({
  window: injected,
}: {
  /** 测试注入点；不传时取当前 WebView 窗口。 */
  window?: WorkbenchPinHandle | null;
}) {
  const { pinned, busy, toggle, label } = useWorkbenchPin(injected);

  return (
    <button
      type="button"
      className={`wb-icon-btn wb-pin-btn${pinned ? " is-on" : ""}`}
      aria-label={label}
      aria-pressed={pinned}
      data-tip={label}
      data-tauri-drag-region="false"
      aria-busy={busy || undefined}
      onClick={() => void toggle()}
    >
      {pinned ? (
        <Pin size={14} aria-hidden="true" />
      ) : (
        <PinOff size={14} aria-hidden="true" />
      )}
    </button>
  );
}
