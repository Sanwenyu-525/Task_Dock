//! 剪贴板类教程（2 篇，verified，均自带 en-US）。

import type { HelpArticle } from "../types";

export const CLIPBOARD_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.clipboard.history",
    categoryId: "clipboard",
    status: "verified",
    contentVersion: 2,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "剪贴板历史：查找、收藏与复用",
        summary: "复制的内容自动进入剪贴板历史；按类型查看详情、收藏置顶、直接复用。",
        sections: [
          { type: "heading", text: "历史如何产生" },
          {
            type: "paragraph",
            text: "在系统里复制文本、图片、文件或链接后，条目会自动进入「剪贴板」页的历史列表（Ctrl+4）。task_dock 在本机记录，绝不上传；日志与事件不记录正文内容。",
          },
          { type: "heading", text: "查看与复用" },
          {
            type: "steps",
            items: [
              "点击条目打开详情：文本看完整正文，HTML 用白名单只读预览（不执行脚本、链接不可点），文件列路径并可打开 / 定位。",
              "详情内可以收藏、置顶，或把条目关联到某个任务。",
              "需要再次使用时直接复制；也可以用「逐项粘贴」把截图组按顺序粘贴到目标窗口。",
              "想把内容送到另一个窗口：点条目右侧的箭头打开「复制或粘贴到…」，再选一个目标窗口。窗口行主体是**复制并切换**（只复制内容并激活该窗口，不发送按键，到目标窗口后请自行按 Ctrl+V）；行尾的粘贴按钮会**切换到该窗口并发送一次 Ctrl+V**，结束后尝试恢复原剪贴板，但目标应用是否接收无法自动验证。",
              "「复制并切换」「粘贴到目标窗口」「逐项粘贴」是三种操作：复制并切换只复制并激活窗口；粘贴到目标窗口对单条内容发送粘贴按键；逐项粘贴按顺序处理整组或多选条目。复制成功但窗口切换失败时，内容仍在剪贴板里，可只重试切换。",
            ],
          },
          { type: "heading", text: "搜索与清理" },
          {
            type: "paragraph",
            text: "顶部搜索框按标题与类型过滤历史；全局搜索（Ctrl+Shift+F）同样覆盖剪贴板分类。清理策略在设置中调整，收藏与置顶条目不会被自动清理。",
          },
          {
            type: "tip",
            text: "剪贴板是被动记录；想把内容**主动**收纳起来，把条目「添加到暂存架」会生成独立副本，两边删除互不影响。",
          },
        ],
      },
      "en-US": {
        title: "Clipboard history: find, pin and reuse",
        summary:
          "Anything you copy lands in the clipboard history automatically; inspect details by type, pin favorites and reuse directly.",
        sections: [
          { type: "heading", text: "How history is created" },
          {
            type: "paragraph",
            text: "After you copy text, images, files or links anywhere in the system, the entry appears in the history list on the \"Clipboard\" page (Ctrl+4). Task Dock records it locally and never uploads it; logs and events never contain the copied content itself.",
          },
          { type: "heading", text: "Inspect and reuse" },
          {
            type: "steps",
            items: [
              "Click an entry to open its details: full text for text, a sanitized read-only preview for HTML (no scripts run, links not clickable), and file paths with open / reveal actions for files.",
              "Inside the details you can favorite, pin, or link the entry to a task.",
              "To use it again, copy it directly; or use \"Paste one by one\" to paste a screenshot group into a target window in order.",
              "To send content to another window: click the arrow on the entry to open \"Copy or paste to…\" and pick a target window. The main body of a window row is copy & switch (copies the content and activates that window without sending keystrokes — press Ctrl+V yourself afterwards); the paste button at the row end switches to that window and sends one Ctrl+V, then tries to restore your previous clipboard, though whether the target app accepted it cannot be verified automatically.",
              "\"Copy & switch\", \"Paste to target window\" and \"Paste one by one\" are three distinct operations: copy & switch only copies and activates the window; paste to target window sends the paste keystroke for a single entry; paste one by one walks through a whole group or a multi-selection in order. If copying succeeded but the window switch failed, the content is still on the clipboard and you can retry just the switch.",
            ],
          },
          { type: "heading", text: "Search and cleanup" },
          {
            type: "paragraph",
            text: "The search box at the top filters history by title and type; global search (Ctrl+Shift+F) also covers the clipboard category. Cleanup policy is configured in Settings; favorited and pinned entries are never auto-cleaned.",
          },
          {
            type: "tip",
            text: "The clipboard is a passive record; to collect content actively, \"Add to shelf\" creates an independent copy — deleting on either side never affects the other.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["剪贴板", "历史", "收藏", "置顶", "HTML 预览", "逐项粘贴", "搜索", "复制并切换", "粘贴到目标窗口", "窗口切换"],
      "en-US": ["clipboard", "history", "favorite", "pin", "HTML preview", "paste one by one", "search", "copy and switch", "paste to window", "window switch"],
    },
    relatedFeatureIds: ["ux.clipboard-viewers", "core.global-search"],
    relatedRouteIds: ["clipboard"],
  },
  {
    id: "help.clipboard.image-paste",
    categoryId: "clipboard",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "图片查看与逐项粘贴",
        summary: "图片条目用灯箱放大查看（缩放/平移/另存），截图组支持逐项粘贴到目标窗口。",
        sections: [
          { type: "heading", text: "图片灯箱" },
          {
            type: "steps",
            items: [
              "点击图片条目进入详情，选择「放大查看」打开灯箱。",
              "滚轮缩放、拖拽平移；双击在适应窗口与原始大小之间切换。",
              "灯箱内可直接「复制原图」或「另存为」；按 Escape 只关闭灯箱这一层。",
            ],
          },
          { type: "heading", text: "逐项粘贴" },
          {
            type: "steps",
            items: [
              "在截图组上选择「逐项粘贴」，切换到目标窗口。",
              "按提示依次粘贴每一项；面板会记住当前进度，中断后可从上次的条目继续。",
              "粘贴意图有 15 秒有效期，导航被取消或页面异常时不会在很久之后突然弹出。",
            ],
          },
          {
            type: "note",
            text: "缩略图是懒加载的：滚动到才加载，图片很多时列表依然流畅。",
          },
        ],
      },
      "en-US": {
        title: "Image viewer and paste one by one",
        summary:
          "View images in a lightbox (zoom / pan / save as) and paste screenshot groups into a target window step by step.",
        sections: [
          { type: "heading", text: "Image lightbox" },
          {
            type: "steps",
            items: [
              "Click an image entry to open its details and choose \"View full size\" to open the lightbox.",
              "Scroll to zoom, drag to pan; double-click toggles between fit-to-window and original size.",
              "Inside the lightbox you can \"Copy original\" or \"Save as\" directly; Escape closes only the lightbox layer.",
            ],
          },
          { type: "heading", text: "Paste one by one" },
          {
            type: "steps",
            items: [
              "Choose \"Paste one by one\" on a screenshot group and switch to the target window.",
              "Paste each item as prompted; the panel remembers the progress, so an interrupted run resumes from the last item.",
              "A paste intent expires after 15 seconds, so it never pops up long after navigation was cancelled or the page crashed.",
            ],
          },
          {
            type: "note",
            text: "Thumbnails are lazy-loaded: they load on scroll, so the list stays smooth even with many images.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["图片", "灯箱", "缩放", "另存为", "逐项粘贴", "截图组"],
      "en-US": ["image", "lightbox", "zoom", "save as", "paste one by one", "screenshot group"],
    },
    relatedFeatureIds: ["ux.image-fullscreen"],
    relatedRouteIds: ["clipboard"],
  },
];
