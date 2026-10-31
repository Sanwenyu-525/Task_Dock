// cdp-main-window.mjs 的类型声明（供 src/test 下的 vitest 用例做静态检查）。

export interface CdpTarget {
  targetId: string;
  url: string;
  title: string;
  type: string;
}

export interface PageIdentity {
  label: string | null;
  webviewLabel: string | null;
  tauri: boolean;
  mounted: boolean;
}

export interface TargetSelection {
  status: "ok" | "ambiguous" | "loading" | "not-found";
  target?: CdpTarget & { identity: PageIdentity | null; matches: boolean; ready: boolean };
  candidates?: Array<CdpTarget & { identity: PageIdentity | null; matches: boolean; ready: boolean }>;
  seen?: { enumerated: number; mainCandidates: number; contextMenu: number; devtools: number; nonPage: number };
  rationale: string;
}

export interface AttachResult {
  ok: boolean;
  target?: CdpTarget & { identity: PageIdentity | null; matches: boolean; ready: boolean };
  reason?: string;
  log: Array<Record<string, unknown>>;
}

export declare const CONTEXT_MENU_URL_RE: RegExp;
export declare const MAX_DEADLINE_MS: number;

export function classifyTargets(
  targets: Array<Partial<CdpTarget>>,
): { mainCandidates: CdpTarget[]; contextMenu: CdpTarget[]; devtools: CdpTarget[]; nonPage: CdpTarget[] };

export function selectMainWindow(
  targets: CdpTarget[],
  identities: Map<string, PageIdentity>,
): TargetSelection;

export function listTargets(
  port: number,
  fetchImpl?: typeof fetch,
): Promise<CdpTarget[]>;

export function attachMainWindow(options: {
  port: number;
  deadlineMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  probe?: (info: { targetId: string; url: string }) => Promise<PageIdentity>;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}): Promise<AttachResult>;
