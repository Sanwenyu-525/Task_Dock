//! 动作执行器：把「确认 → 执行 → 结果提示」收敛成一份实现。
//!
//! 页面只负责把 `ActionDefinition` 交给它；可用性已由 `ActionRegistry.resolveAvailableActions`
//! 统一判定，这里只处理需要二次确认的动作，并保证失败时给出真实错误。

import { useCallback, useState, type ReactNode } from "react";
import { Dialog } from "../ui/Dialog";
import { executeAction } from "../../lib/crossTab/actionRegistry";
import type { ActionDefinition, ActionResult, TransferContext, TransferItem, TransferTarget } from "../../lib/crossTab/types";
import { useLocale } from "../../hooks/useLocale";

export type Notify = (message: string, kind?: "success" | "error" | "warning" | "info") => void;

interface PendingAction {
  action: ActionDefinition;
  items: TransferItem[];
  context: TransferContext;
  target?: TransferTarget;
}

export interface ActionDispatcherApi {
  /** 请求执行；需要确认的动作会先弹确认框。 */
  dispatch: (input: PendingAction) => Promise<ActionResult | null>;
  /** 挂在页面里的确认框节点。 */
  dialog: ReactNode;
  running: boolean;
}

export function useActionDispatcher(notify: Notify): ActionDispatcherApi {
  const { t } = useLocale();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(
    async (input: PendingAction, confirmed: boolean) => {
      setRunning(true);
      try {
        const result = await executeAction(
          input.action.actionId,
          { items: input.items, context: input.context, target: input.target },
          { confirmed },
        );
        notify(result.message, result.ok ? "success" : "error");
        return result;
      } finally {
        setRunning(false);
        setPending(null);
      }
    },
    [notify],
  );

  const dispatch = useCallback(
    async (input: PendingAction): Promise<ActionResult | null> => {
      if (input.action.confirmationRequired) {
        setPending(input);
        return null;
      }
      return run(input, true);
    },
    [run],
  );

  const dialog = (
    <Dialog
      open={pending !== null}
      onClose={() => setPending(null)}
      title={pending?.action.title ?? t("common.confirm")}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={() => setPending(null)}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={running}
            onClick={() => {
              if (pending) void run(pending, true);
            }}
          >
            {t("common.confirm")}
          </button>
        </>
      }
    >
      <p>{pending?.action.description || pending?.action.title}</p>
      {pending && pending.items.length > 0 && (
        <p className="tp-hint">
          {t("transfer.selected", { count: pending.items.length })}
        </p>
      )}
    </Dialog>
  );

  return { dispatch, dialog, running };
}
