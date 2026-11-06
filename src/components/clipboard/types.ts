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
  /** 复制并切换到目标窗口：只复制 + 切换，不自动粘贴 */
  | { kind: "copy-switch"; item: ClipboardItem };

export type LinkTask = Task | null;
