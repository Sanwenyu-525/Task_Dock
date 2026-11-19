//! 统一发送入口：菜单项全部来自 `ActionRegistry`，页面不硬编码任何一条。
//!
//! 规则：
//! - 只列出 `resolveAvailableActions` 判定为可用的动作（目标缺失/不支持时不会出现假菜单）；
//! - 「发送到文件工作区」不直接执行，而是打开预览对话框（预览 → 确认 是唯一通道）；
//! - 需要确认的动作交给 `ActionDispatcher`，失败如实提示。

import { useMemo } from "react";
import { Send } from "lucide-react";
import DropdownMenu, { type DropdownMenuItem } from "../ui/DropdownMenu";
import { resolveAvailableActions } from "../../lib/crossTab/actionRegistry";
import { SEND_TO_FILES_ACTION } from "../../lib/crossTab/modules/tray";
import type { ActionDefinition, TransferContext, TransferItem, TransferTarget } from "../../lib/crossTab/types";
import { useLocale } from "../../hooks/useLocale";
import { useActionDispatcher, type Notify } from "./ActionDispatcher";

export interface SendToMenuProps {
  items: TransferItem[];
  context: TransferContext;
  target: TransferTarget | null;
  onNotify: Notify;
  /** 打开发送预览（文件目标）；没有合法目标时菜单不会出现该项。 */
  onSendToFiles: () => void;
  disabled?: boolean;
  label?: string;
  side?: "bottom" | "top";
  alignment?: "start" | "end";
  /** 已在工作篮中的内容不需要「加入工作篮」这类动作。 */
  excludeActionIds?: string[];
}

export default function SendToMenu({
  items,
  context,
  target,
  onNotify,
  onSendToFiles,
  disabled,
  label,
  side = "bottom",
  alignment = "end",
  excludeActionIds,
}: SendToMenuProps) {
  const { t } = useLocale();
  const dispatcher = useActionDispatcher(onNotify);

  const available = useMemo(
    () =>
      resolveAvailableActions(items, context, target ?? undefined).filter(
        (action) => !excludeActionIds?.includes(action.actionId),
      ),
    [items, context, target, excludeActionIds],
  );

  const menuItems: DropdownMenuItem[] = useMemo(() => {
    const rows: DropdownMenuItem[] = [];
    for (const action of available) {
      const isSend = action.actionId === SEND_TO_FILES_ACTION;
      rows.push({
        key: action.actionId,
        label: isSend ? `${action.title}…` : action.title,
        description: action.description,
        onSelect: () => {
          if (isSend) {
            onSendToFiles();
            return;
          }
          void dispatcher.dispatch({ action, items, context, target: target ?? undefined });
        },
      });
    }
    if (rows.length === 0) {
      rows.push({
        key: "empty",
        label: t("transfer.actionUnavailable"),
        disabled: true,
      });
    }
    return rows;
  }, [available, context, dispatcher, items, onSendToFiles, t, target]);

  return (
    <>
      <DropdownMenu
        menuLabel={label ?? t("transfer.sendMenu")}
        side={side}
        alignment={alignment}
        items={menuItems}
        trigger={({ ref, expanded, onClick, onKeyDown }) => (
          <button
            ref={ref}
            type="button"
            className="btn sm"
            aria-label={label ?? t("transfer.sendMenu")}
            aria-expanded={expanded}
            data-tip={t("transfer.sendMenuHint")}
            disabled={disabled}
            onClick={onClick}
            onKeyDown={onKeyDown}
          >
            <Send size={12} aria-hidden="true" /> {label ?? t("transfer.sendMenu")}
          </button>
        )}
      />
      {dispatcher.dialog}
    </>
  );
}

/** 菜单动作列表（供右键菜单等非下拉入口复用同一份筛选结果）。 */
export function availableMenuActions(
  items: TransferItem[],
  context: TransferContext,
  target?: TransferTarget,
): ActionDefinition[] {
  return resolveAvailableActions(items, context, target);
}
