//! 渲染异常兜底（React Error Boundary），主窗口与独立小窗口共用。
//!
//! 定位：最后一道防线，只处理 **组件渲染/生命周期异常**；业务请求失败仍由各模块
//! 的 `reportError` / 内联错误状态负责。
//!
//! 安全边界：界面只展示审查过的通用文案与重试入口，**不展示** `error.message`、
//! 组件堆栈或任何原始异常文本；原始错误只写入 console 诊断通道。
//! 小窗口（快速捕获/通知/右键菜单）使用 `variant="compact"`，避免把主窗口完整
//! 错误页塞进悬浮窗；不会自动重载，也不改变业务数据。

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  /** 便于多窗口区分诊断来源（主窗口/快速捕获等），只进日志与通用文案 */
  scope?: string;
  /** full = 主窗口完整兜底；compact = 小型悬浮窗口轻量兜底（内联样式） */
  variant?: "full" | "compact";
}

interface State {
  error: Error | null;
  attempt: number;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 处理器自身不能抛出异常：日志失败也不能影响兜底渲染。
    // 原始对象与堆栈只进 console（审查过的诊断通道），不进入 DOM。
    try {
      console.error("[error-boundary]", this.props.scope ?? "main", error, info.componentStack);
    } catch {
      // ignore
    }
  }

  private retry = () => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    const { error, attempt } = this.state;
    if (!error) return this.props.children;

    const retried = attempt > 0 ? `已重试 ${attempt} 次。` : "";

    if (this.props.variant === "compact") {
      return (
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            height: "100%",
            padding: 12,
            boxSizing: "border-box",
            color: "var(--text-secondary)",
            fontSize: 12,
            textAlign: "center",
            background: "transparent",
          }}
        >
          <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>界面暂时不可用</div>
          <div>已停止渲染以保护当前内容。{retried}</div>
          <button
            type="button"
            onClick={this.retry}
            style={{
              padding: "4px 12px",
              fontSize: 12,
              borderRadius: "var(--radius-base, 8px)",
              border: "1px solid var(--border-subtle, rgba(128,128,128,0.3))",
              background: "var(--surface-raised, rgba(128,128,128,0.12))",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </div>
      );
    }

    return (
      <div className="empty-state error-boundary" role="alert">
        <AlertTriangle size={32} className="empty-state-icon" aria-hidden="true" />
        <div className="empty-title">界面渲染失败</div>
        <p className="empty-hint">
          当前界面遇到异常，已停止渲染以保护数据。可以重试加载；若持续失败，请重启应用后反馈日志。
          {retried}
        </p>
        <button type="button" className="btn primary" onClick={this.retry}>
          重试加载
        </button>
      </div>
    );
  }
}
