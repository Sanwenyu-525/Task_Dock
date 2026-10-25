//! 剪贴板写入：navigator.clipboard 优先，失焦/不可用时回退 execCommand。
//! 不引入 clipboard 插件依赖（WebView2 中 tauri.localhost 为安全上下文，
//! 但窗口未聚焦时 Clipboard API 可能被拒，需要兜底）。

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落入兜底
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
