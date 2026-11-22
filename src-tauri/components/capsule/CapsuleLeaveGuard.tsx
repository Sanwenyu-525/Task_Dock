//! 胶囊内的未保存草稿确认条。
//!
//! 全局 `TabLeaveGuard` 挂在 `FullView` 内，而胶囊模式下 `.dock-app` 是
//! `display:none` + `inert`：从胶囊发起「编辑任务 / 逐项粘贴 / 暂存定位 /
//! 添加应用」等带 `after` 的导航时，若被完整窗口里的未保存草稿拦截，
//! `pendingTab` 已写入但确认条不可见，点击表现为「没反应」。
//!
//! 本组件只负责把同一个待决导航呈现在胶囊面板里：
//! - 只在 `pendingTab` 与**当前活动守卫**一致时渲染（守卫可能已被卸载/替换，
//!   此时确认条没有可放弃的对象，不能给出会误丢他人的确认）；
//! - 结构复用既有 `.cap-confirm` 样式，不新增 CSS；
//! - 不修改 `setTab` 门禁，也不新增 store 字段。
//!
//! 卸载即取消待决意图：面板收起 / 切换分类 = 用户放弃本次跳转，`after`
//! 不能留给下一次进入再突然执行。确认/取消路径此时 `pendingTab` 已为 null，
//! 清理是幂等 no-op。

import { useEffect, useRef } from "react";
import { activeTabGuard, useActiveTabGuardId } from "../../lib/tabGuard";
import { useUiStore } from "../../store/useUiStore";

export default function CapsuleLeaveGuard() {
  const pending = useUiStore((s) => s.pendingTab);
  const confirm = useUiStore((s) => s.confirmPendingTab);
  const cancel = useUiStore((s) => s.cancelPendingTab);
  const activeGuardId = useActiveTabGuardId();
  /**
   * 卸载清理只使用 hook 已提供的值/动作，不直接读 `useUiStore.getState()`：
   * 部分外壳测试把 store 函数 mock 成「只接受 selector」，直接取 getState 会崩。
   */
  const latest = useRef({ pending, cancel });
  latest.current = { pending, cancel };
  /**
   * 卸载取消的会话号。`main.tsx` 启用了 StrictMode：开发模式挂载后会立即执行
   * 一次「清理 → 重跑」，若在 cleanup 里同步清 pending，刚出现的确认条会被
   * 自己抹掉。取消推迟到微任务，并由随后的 setup 递增会话号使其失效：
   * 真卸载不会再 setup，微任务按原会话号执行取消。
   */
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    return () => {
      const captured = latest.current.pending;
      if (!captured) return;
      queueMicrotask(() => {
        if (seqRef.current !== seq) return; // StrictMode 的「清理 → 重跑」
        // 按最后一次渲染展示的待决意图取消；面板卸载后本实例不再渲染，
        // 正常路径（收起/切分类/确认）不会同时产生第二个待决导航。
        if (latest.current.pending === captured) latest.current.cancel?.();
      });
    };
  }, []);

  if (!pending || activeGuardId !== pending.guardId) return null;
  const label = activeTabGuard()?.label() ?? "当前编辑";

  return (
    <div className="cap-confirm" role="alert">
      <p className="cap-confirm-text">
        『{label}』有未保存的修改
        <span>切换页面会丢失这些修改。</span>
      </p>
      <div className="cap-confirm-actions">
        <button type="button" className="cap-mini" onClick={cancel}>
          继续编辑
        </button>
        <button type="button" className="cap-mini cap-confirm-danger" onClick={confirm}>
          放弃并切换
        </button>
      </div>
    </div>
  );
}
