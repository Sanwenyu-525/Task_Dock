//! 剪贴板写入：Tauri 内统一走 Rust 受控写入，只有浏览器预览才用 Web API。
//!
//! Windows 下 WebView 的 Clipboard API 写入不会登记自写序列号，后台监听会把
//! 这次写入当成外部复制重新采集（从 Dock 复制的内容又回到历史）。因此原生窗口
//! 必须走 `clipboard_copy_text`，且写入失败时**不得**回退到未登记自写的 Web API。

import { isTauri } from "@tauri-apps/api/core";
import { clipboardCopyText } from "./bridge";

export async function copyText(text: string): Promise<boolean> {
  if (isTauri()) {
    try {
      await clipboardCopyText(text);
      return true;
    } catch {
      // 受控写入失败（剪贴板被占用/系统拒绝）必须如实返回失败：
      // 回退 Web API 会绕过自写登记，重新引入重复采集，且同样无法保证成功。
      return false;
    }
  }
  return copyTextInBrowser(text);
}

/** 浏览器预览没有 Tauri 监听器，才允许直接使用 Web API / execCommand。 */
async function copyTextInBrowser(text: string): Promise<boolean> {
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
