import type { ClipboardItem, Task } from "../../lib/bridge";

export type AskConfirm = (opts: {
  title: string;
  detail?: string;
  confirmLabel?: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}) => void;

export type ClipboardDetail =
  | { kind: "item"; id: string }
  | { kind: "group"; id: string }
  | { kind: "paste"; id: string; name: string }
  /** 任意多选逐项粘贴：不依赖永久分组 */
  | { kind: "paste-items"; ids: string[] }
  /** 复制并切换 / 粘贴到目标窗口：目标选择器内选择具体动作 */
  | { kind: "copy-switch"; item: ClipboardItem };

export type LinkTask = Task | null;
