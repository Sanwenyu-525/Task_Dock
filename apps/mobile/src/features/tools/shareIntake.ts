// 系统分享 → 工具快捷动作的内存交接。
//
// 为什么用内存而不是路由参数：nav.push 的签名刻意保持 4 个参数（App.tsx 的历史约定），
// 不为了一个草稿再加第 5 个参数。分享流程是「同一进程内：采集页 → 用户点动作 → 工具页」，
// 内存交接足够；进程被杀后待处理分享仍由 pendingShare 持久化槽保留，不会丢内容。
//
// 每个槽只保留最近一次，带 10 分钟有效期：避免用户上周分享的文本悄悄出现在今天的编辑器里。

const MAX_AGE_MS = 10 * 60 * 1000;

interface Pending<T> {
  value: T;
  at: number;
}

let snippetDraft: Pending<string> | null = null;
let textDraft: Pending<string> | null = null;
let imageDraft: Pending<{ uri: string; name: string }> | null = null;
let linkDraft: Pending<{ url: string; title?: string }> | null = null;

function take<T>(slot: Pending<T> | null): T | null {
  if (!slot) return null;
  const fresh = Date.now() - slot.at <= MAX_AGE_MS;
  return fresh ? slot.value : null;
}

export function offerSnippetDraft(text: string): void {
  snippetDraft = { value: text, at: Date.now() };
}

export function takeSnippetDraft(): string | null {
  const value = take(snippetDraft);
  snippetDraft = null;
  return value;
}

/** JSON / 正则 / 代码对比共用的纯文本草稿（每个工具取走即清空）。 */
export function offerTextDraft(text: string): void {
  textDraft = { value: text, at: Date.now() };
}

export function takeTextDraft(): string | null {
  const value = take(textDraft);
  textDraft = null;
  return value;
}

export function offerImageDraft(uri: string, name: string): void {
  imageDraft = { value: { uri, name }, at: Date.now() };
}

export function takeImageDraft(): { uri: string; name: string } | null {
  const value = take(imageDraft);
  imageDraft = null;
  return value;
}

export function offerLinkDraft(url: string, title?: string): void {
  linkDraft = { value: { url, title }, at: Date.now() };
}

export function takeLinkDraft(): { url: string; title?: string } | null {
  const value = take(linkDraft);
  linkDraft = null;
  return value;
}

/** 测试/调试辅助：清空所有草稿，避免跨用例串数据。 */
export function __clearToolDrafts(): void {
  snippetDraft = null;
  textDraft = null;
  imageDraft = null;
  linkDraft = null;
}
