//! 收集箱面板（胶囊内）。取代原先轨道上的 Agent 重复入口：
//! Agent 已由顶部状态球直达，轨道第四类改为收集箱（任务 → 收集箱 → 剪贴板 → 应用）。
//!
//! 数据：复用 `useCaptureStore` 的轻量切片（quickCaptureList("inbox", 8, 0)
//! + quickCaptureState()），与完整收集箱页（`CaptureInboxPanel`）同一个 store、
//! 同一份后端命令；不建第二套快速捕获后端。
//!
//! 实时刷新**不自建监听**：全应用只有 App.tsx 挂了一条 quick-capture-created，
//! 它调用 `useCaptureStore.load()`；面板开着时 load() 顺带刷新 lite 切片
//! （见 store 内注释），不产生第二条订阅，也没有轮询。
//!
//! 真实性约束：
//! - 只列未处理记录，内容预览截断换行，不在轨道/面板外泄露正文；
//! - 读取失败显示错误态 + 重试，绝不伪装成「没有未处理记录」；
//! - 进入完整收集箱复用 `openFullApp("inbox")`（既有 Tab，不发明新导航）。

import { useEffect } from "react";
import {
  AlignLeft,
  ArrowUpRight,
  Inbox,
  Lightbulb,
  Link2,
  ListTodo,
  SquareCheckBig,
} from "lucide-react";
import type { CaptureItem, CaptureKind } from "../../lib/bridge";
import { useCaptureStore } from "../../store/useCaptureStore";
import { openFullApp } from "./actions";
import { EmptyState, PanelHead } from "./PanelKit";

/** 捕获类型 → 图标（lucide 既有图标，与完整页视觉一致）。 */
const KIND_ICONS: Record<CaptureKind, typeof ListTodo> = {
  task: ListTodo,
  idea: Lightbulb,
  text: AlignLeft,
  todo: SquareCheckBig,
  link: Link2,
};

function previewOf(item: CaptureItem): string {
  const raw = (item.content || "").replace(/\s+/g, " ").trim();
  if (raw) return raw;
  if (item.url) return item.url;
  return "（空内容）";
}

export default function InboxLite() {
  const lite = useCaptureStore((s) => s.lite);
  const liteLoading = useCaptureStore((s) => s.liteLoading);
  const liteError = useCaptureStore((s) => s.liteError);
  const inboxCount = useCaptureStore((s) => s.inboxCount);
  const loadInboxLite = useCaptureStore((s) => s.loadInboxLite);
  const releaseLite = useCaptureStore((s) => s.releaseLite);

  // 面板打开 → 取一次未处理切片 + 真实计数；关闭 → 释放并作废在途响应。
  useEffect(() => {
    void loadInboxLite();
    return () => releaseLite();
  }, [loadInboxLite, releaseLite]);

  const loading = liteLoading && lite === null;
  const hasError = liteError !== null;
  // 面板口径以切片为准：lite 为 null（未加载）时不拿全局计数冒充面板状态
  const items = lite ?? [];

  const retry = () => {
    void loadInboxLite();
  };

  return (
    <>
      <PanelHead
        title="收集箱"
        sub={
          loading
            ? "读取中"
            : hasError
              ? "读取失败"
              : `未处理 ${inboxCount} 条 · 最近 ${items.length} 条`
        }
        actions={
          <button
            type="button"
            className="cap-iconbtn"
            aria-label="打开完整收集箱"
            onClick={() => openFullApp("inbox")}
          >
            <ArrowUpRight size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        }
      />

      <div className="cap-list">
        {/* 错误优先于空态：有旧数据时叠加错误提示条（可重试），没有则错误空态 */}
        {hasError && items.length > 0 && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">读取失败，显示的是上次结果</span>
            <button type="button" className="cap-mini" aria-label="重试读取收集箱" onClick={retry}>
              重试
            </button>
          </div>
        )}

        {hasError && items.length === 0 && (
          <EmptyState
            icon={<Inbox size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="收集箱读取失败"
            actionLabel="重试"
            onAction={retry}
          />
        )}

        {!hasError && !loading && items.length === 0 && (
          <EmptyState
            icon={<Inbox size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="没有未处理的记录"
            actionLabel="打开完整收集箱"
            onAction={() => openFullApp("inbox")}
          />
        )}

        {items.map((it) => {
          const Icon = KIND_ICONS[it.kind] ?? AlignLeft;
          return (
            <div className="cap-item cap-clip-row" key={it.id}>
              <span className="cap-tile" aria-hidden="true">
                <Icon size={17} strokeWidth={1.8} />
              </span>
              <span className="cap-main">
                <span className="cap-item-title clip-2">{previewOf(it)}</span>
                <span className="cap-item-sub">
                  {it.note ? `${it.note} · ` : ""}
                  {it.kind === "link" && it.url ? "链接" : "捕获"}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">快速捕获的记录先落在这里，处理完自动移出</span>
        <button type="button" className="cap-link" onClick={() => openFullApp("inbox")}>
          完整收集箱
          <ArrowUpRight size={12} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
