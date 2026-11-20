//! 原型交互模拟：预览态只推进会话状态，不修改文档。
//!
//! - `serverBacked`：调用 `collab_prototype_dispatch`（真实查看器使用，权威状态机）；
//! - 本地模式：编辑器中预览未保存内容时使用同一套动作语义。

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import StatusBadge from "../../ui/StatusBadge";
import {
  collabPrototypeDispatch,
  collabPrototypeState,
  type PrototypeEvent,
} from "../../../lib/collab";
import { errorMessage } from "../../../lib/errors";
import PrototypeRenderer from "./PrototypeRenderer";
import {
  dispatchLocalEvent,
  type ProtoComponent,
  type ProtoContent,
  type ProtoEvent,
} from "./prototype-types";

export interface SimulatorState {
  currentPage: string;
  modal: string | null;
  values: Record<string, unknown>;
}

export default function PrototypeInteractionSimulator({
  docId,
  content,
  serverBacked = false,
}: {
  docId?: string;
  content: ProtoContent;
  serverBacked?: boolean;
}) {
  const [state, setState] = useState<SimulatorState | null>(null);
  const [width, setWidth] = useState<number>(content.viewport.width);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const initial = useMemo<SimulatorState>(
    () => ({
      currentPage: content.pages[0]?.id ?? "page-1",
      modal: null,
      values: { ...content.state },
    }),
    [content],
  );

  useEffect(() => {
    let cancelled = false;
    setError("");
    if (serverBacked && docId) {
      setState(null);
      collabPrototypeState(docId)
        .then((s) => {
          if (!cancelled) setState(s);
        })
        .catch((e) => {
          if (!cancelled) {
            setError(errorMessage(e));
            setState(initial);
          }
        });
    } else {
      setState(initial);
    }
    return () => {
      cancelled = true;
    };
  }, [docId, serverBacked, initial]);

  const current = content.pages.find((p) => p.id === state?.currentPage) ?? content.pages[0];
  const modal = state?.modal
    ? content.pages.flatMap((p) => p.components).find((c) => c.id === state.modal) ?? null
    : null;

  const dispatch = async (event: ProtoEvent) => {
    if (!state || busy) return;
    if (serverBacked && docId) {
      setBusy(true);
      setError("");
      try {
        // 本地 ProtoEvent 与 IPC 契约字段一致，仅 action 用 string 便于编辑；服务端会校验白名单。
        setState(await collabPrototypeDispatch(docId, state, event as PrototypeEvent));
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    setState(dispatchLocalEvent(content, state, event));
  };

  const onClick = (_component: ProtoComponent, event: ProtoEvent) => {
    void dispatch(event);
  };

  if (!current) {
    return <div className="collab-muted">原型没有可预览的页面。</div>;
  }

  return (
    <div className="collab-prototype">
      <div className="collab-viewer-toolbar">
        <span className="collab-muted">页面：{current.name}</span>
        {state ? (
          <StatusBadge tone="info" size="sm">
            当前 {state.currentPage}
          </StatusBadge>
        ) : (
          <Loader2 size={14} className="spin" aria-label="加载交互状态" />
        )}
        <div className="collab-width-switch" role="group" aria-label="原型预览宽度">
          {[320, 400, 600].map((w) => (
            <button
              key={w}
              type="button"
              className={`seg-btn ${width === w ? "active" : ""}`}
              onClick={() => setWidth(w)}
              aria-pressed={width === w}
            >
              {w}px
            </button>
          ))}
        </div>
        {busy ? <Loader2 size={14} className="spin" aria-label="处理中" /> : null}
      </div>
      {error ? <div className="collab-inline-error">{error}</div> : null}
      <div className="collab-prototype-scroll">
        <div
          className="collab-prototype-canvas"
          style={{ width, height: content.viewport.height }}
          onClick={() => {
            if (state?.modal) void dispatch({ action: "closeModal" });
          }}
        >
          <PrototypeRenderer
            page={current}
            values={state?.values}
            interactive
            onEvent={onClick}
            onInput={(component, value) =>
              void dispatch({ action: "setValue", target: component.id, value })
            }
          />
          {modal ? (
            <div className="proto-modal-backdrop" onClick={(e) => e.stopPropagation()}>
              <div className="proto-modal" role="dialog" aria-modal="true" aria-label="原型弹窗">
                <div className="proto-modal-head">
                  <strong>{String(modal.props.label ?? modal.id)}</strong>
                  <button className="btn ghost small" onClick={() => void dispatch({ action: "closeModal" })}>
                    关闭
                  </button>
                </div>
                <div className="proto-modal-body">该弹窗由组件 {modal.id} 定义。</div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
