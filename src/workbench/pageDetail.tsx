//! 页面级右侧详情栏共享契约（2026-11-15）。
//!
//! 背景：19 张效果图的右栏都是「当前页面选中对象的详情」，而外壳此前只有一份
//! 跨页通用的上下文栏。若让各页面自建右栏，会立刻长出第二套 Shell（双右栏、
//! 双滚动、切页残留旧详情）。本文件是唯一的页面 → 外壳详情通道。
//!
//! 设计要点：
//! - **Portal 而不是全局状态**：详情内容仍在页面自己的 React 树里渲染（state、
//!   props、订阅全部属于页面），只是挂载位置在外壳的右栏宿主节点。避免「页面把
//!   ReactNode 塞进 store → 外壳渲染 → 数据过期一帧」的时序问题，也避免重复订阅。
//! - **宿主由外壳下发**：右栏关闭或窄窗降级时宿主为 `null`，页面自动什么都不渲染，
//!   不需要每页各写一遍 `detailOpen` 判断。
//! - **切页不残留**：页面通过 `useWorkbenchPageActive()` 判定自己是否可见；被保活
//!   但隐藏的页面（DeferredView）不向宿主投送内容，右栏因此不会显示上一页的旧详情。
//! - **空态回退**：没有页面投送内容时，宿主节点保持 `:empty`，外壳据 CSS 相邻选择器
//!   显示通用上下文栏 —— 不需要 JS 计数，也不会闪烁。
//!
//! 约束：页面只投送「只读展示 + 少量就地操作」，不把整页业务搬进右栏；复杂编辑仍在
//! 中央内容区（编辑器、抽屉、灯箱各守原职责）。

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useWorkbenchPageActive } from "../lib/windowHost";

/** 外壳下发的详情栏宿主节点；`null` = 右栏不可用（已关闭 / 窄窗降级 / 不在工作台）。 */
const DetailHostContext = createContext<HTMLElement | null>(null);

export function WorkbenchDetailHostProvider({
  host,
  children,
}: {
  host: HTMLElement | null;
  children: ReactNode;
}) {
  return <DetailHostContext.Provider value={host}>{children}</DetailHostContext.Provider>;
}

/** 读取详情栏宿主（页面一般不需要直接用，用 `WorkbenchPageDetail` 即可）。 */
export function useWorkbenchDetailHost(): HTMLElement | null {
  return useContext(DetailHostContext);
}

interface PageDetailProps {
  /** 卡片标题；同时作为该区块的可访问名。 */
  title?: ReactNode;
  /** 标题右侧的操作区（只放一两个就地操作）。 */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * 页面详情卡：投送到外壳右栏。同一页面可以投送多张卡（按渲染顺序堆叠），
 * 例如「任务详情」+「相关资源」。
 */
export function WorkbenchPageDetail({ title, actions, children }: PageDetailProps) {
  const host = useWorkbenchDetailHost();
  const pageActive = useWorkbenchPageActive();
  // 隐藏的保活页面不投送：否则切页后右栏会继续显示上一页的详情。
  if (!host || pageActive === false) return null;
  return createPortal(
    <section className="wb-detail-card" aria-label={typeof title === "string" ? title : undefined}>
      {(title || actions) && (
        <header className="wb-detail-card-head">
          {title ? <h3>{title}</h3> : null}
          {actions ? <div className="wb-detail-card-actions">{actions}</div> : null}
        </header>
      )}
      <div className="wb-detail-card-body">{children}</div>
    </section>,
    host,
  );
}

/** 一条「标签 → 值」事实；`value` 为 `null`/`undefined` 时整行不渲染（不造假字段）。 */
export type DetailFact = { label: ReactNode; value: ReactNode } | null | false;

/**
 * 详情栏事实表：统一的标签列宽度与行距，避免每页各写一套 dl 网格。
 * 只渲染真实有值的行——数据缺失时不出现空行，也不补「—」占位噪声
 * （需要显式「无」语义时由调用方传字面值）。
 */
export function WorkbenchDetailFacts({ rows }: { rows: DetailFact[] }) {
  const visible = rows.filter((row): row is { label: ReactNode; value: ReactNode } => !!row);
  if (visible.length === 0) return null;
  return (
    <dl className="wb-detail-facts">
      {visible.map((row, index) => (
        <div className="wb-detail-fact" key={index}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 详情栏空态：页面支持详情但当前没有选择对象时使用。 */
export function WorkbenchDetailEmpty({ icon, text }: { icon?: ReactNode; text: ReactNode }) {
  return (
    <div className="wb-detail-empty">
      {icon ? <span className="wb-detail-empty-icon" aria-hidden="true">{icon}</span> : null}
      <p>{text}</p>
    </div>
  );
}
