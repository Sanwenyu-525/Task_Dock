//! 剪贴板类教程（2 篇，verified）。

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
              "想把内容送到另一个窗口：点条目右侧的箭头选择「复制并切换到…」，再选一个目标窗口；这会复制内容并激活该窗口，但**不会自动粘贴**，到目标窗口后请自行按 Ctrl+V。",
              "「复制并切换」与「逐项粘贴」是两种操作：前者只复制并切换窗口，后者会逐项发送粘贴按键；复制成功但窗口切换失败时，内容仍在剪贴板里，可只重试切换。",
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
    },
    keywords: {
      "zh-CN": ["剪贴板", "历史", "收藏", "置顶", "HTML 预览", "逐项粘贴", "搜索", "复制并切换", "窗口切换"],
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
    },
    keywords: {
      "zh-CN": ["图片", "灯箱", "缩放", "另存为", "逐项粘贴", "截图组"],
    },
    relatedFeatureIds: ["ux.image-fullscreen"],
    relatedRouteIds: ["clipboard"],
  },
];
