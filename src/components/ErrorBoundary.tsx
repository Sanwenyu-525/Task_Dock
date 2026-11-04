//! 主窗口渲染异常兜底（React Error Boundary）。
//!
//! 定位：最后一道防线，只处理 **组件渲染/生命周期异常**；业务请求失败仍由各模块
//! 的 `reportError` / 内联错误状态负责。不做自动无限重载：用户点击「重试加载」才重试，
//! 若仍失败会再次落到这里（不会破坏业务数据）。

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  /** 便于多窗口区分文案（主窗口/快速捕获等） */
  scope?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  attempt: number;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 处理器自身不能抛出异常：日志失败也不能影响兜底渲染
    try {
      console.error("[error-boundary]", this.props.scope ?? "main", error, info.componentStack);
    } catch {
      // ignore
    }
    this.setState({ info });
  }

  private retry = () => {
    this.setState((s) => ({ error: null, info: null, attempt: s.attempt + 1 }));
  };

  render() {
    const { error, info, attempt } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="empty-state error-boundary" role="alert">
        <AlertTriangle size={32} className="empty-state-icon" aria-hidden="true" />
        <div className="empty-title">界面渲染失败</div>
        <p className="empty-hint">
          当前界面遇到异常，已停止渲染以保护数据。可以重试加载；若持续失败，请重启应用后反馈日志。
        </p>
        <p className="empty-hint error-text" data-tip={info?.componentStack ?? undefined}>
          错误：{error.message || error.name}
          {attempt > 0 ? `（已重试 ${attempt} 次）` : ""}
        </p>
        <button type="button" className="btn primary" onClick={this.retry}>
          重试加载
        </button>
      </div>
    );
  }
}
