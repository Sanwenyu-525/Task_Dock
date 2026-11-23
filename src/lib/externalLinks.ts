//! 外部链接（Markdown 预览等）的唯一打开入口。
//!
//! 为什么不直接用 `<a href>`：WebView2 里点击普通链接会把整个应用导航走，
//! 造成「文件预览把主窗口变成浏览器」。这里只放行 http/https/mailto，
//! 打开动作委托系统默认程序（Tauri opener 插件，权限 `opener:default` 已含
//! 这三类协议），未放行的协议一律拒绝并返回原因，由调用方提示。

export type ExternalLinkDecision =
  | { ok: true; href: string }
  | { ok: false; reason: "empty" | "too-long" | "relative" | "protocol" };

const ALLOWED = new Set(["http", "https", "mailto"]);

export function validateExternalUrl(raw: string): ExternalLinkDecision {
  const value = raw.trim();
  if (!value) return { ok: false, reason: "empty" };
  if (value.length > 2048) return { ok: false, reason: "too-long" };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: "protocol" };
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (!match) return { ok: false, reason: "relative" };
  if (!ALLOWED.has(match[1].toLowerCase())) return { ok: false, reason: "protocol" };
  return { ok: true, href: value };
}

/**
 * 用系统默认浏览器打开链接。失败抛错（调用方负责可读提示），
 * 不在这里吞异常，也不宣称「浏览器已成功加载」。
 */
export async function openExternalUrl(raw: string): Promise<void> {
  const decision = validateExternalUrl(raw);
  if (!decision.ok) {
    throw new Error(`不允许打开的链接（${decision.reason}）`);
  }
  // 动态导入：只在真正点击链接时加载插件，避免给纯文本预览增加启动成本。
  const opener = await import("@tauri-apps/plugin-opener");
  await opener.openUrl(decision.href);
}
