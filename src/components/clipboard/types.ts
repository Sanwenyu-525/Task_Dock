import type { Task } from "../../lib/bridge";

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
  | { kind: "paste"; id: string; name: string };

export type LinkTask = Task | null;
