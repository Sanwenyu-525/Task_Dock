// 给 MainActivity 追加系统分享入口的 intent-filter（文本 / 图片 / 音频 / 文件，含多选）。
//
// 为什么需要：Android 分享面板按 intent-filter 匹配接收方；expo prebuild 生成的
// MainActivity 只有 MAIN/LAUNCHER 过滤器。本插件在 prebuild 时为主 Activity 追加
// 独立 intent-filter（带 DEFAULT category 与 mimeType），浏览器、相册、文件管理器
// 即可选「分享到 TaskDock」。
//
// 覆盖范围：
//   ACTION_SEND          + text/* image/* audio/* application/*
//   ACTION_SEND_MULTIPLE + image/* audio/* application/*
// 不混入 LAUNCHER 过滤器：mimeType 出现在 LAUNCHER 过滤器里会影响桌面图标匹配语义。
// android/ 是生成目录，源码只有本插件；重复执行 prebuild 会重新生成并再次应用本插件
// （内部按 action+mime 幂等，不会叠加过滤器）。
const { withAndroidManifest } = require("@expo/config-plugins");

const ACTION_SEND = "android.intent.action.SEND";
const ACTION_SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE";

const SINGLE_MIME_TYPES = ["text/*", "image/*", "audio/*", "application/*"];
const MULTI_MIME_TYPES = ["image/*", "audio/*", "application/*"];

function makeFilter(action, mimeType) {
  return {
    $: {},
    action: [{ $: { "android:name": action } }],
    category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
    data: [{ $: { "android:mimeType": mimeType } }],
  };
}

function hasFilter(filters, action, mimeType) {
  return filters.some((filter) => {
    const actions = (filter.action ?? []).map((item) => item.$?.["android:name"]);
    const mimeTypes = (filter.data ?? []).map((item) => item.$?.["android:mimeType"]);
    return actions.includes(action) && mimeTypes.includes(mimeType);
  });
}

module.exports = function withShareTargetActivity(config) {
  return withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("withShareTargetActivity: manifest.application 缺失，无法注册分享入口");
    }
    const activity = (application.activity ?? []).find(
      (item) => item.$ && item.$["android:name"] === ".MainActivity",
    );
    if (!activity) {
      throw new Error("withShareTargetActivity: 未找到 .MainActivity，无法注册分享入口");
    }

    activity["intent-filter"] = activity["intent-filter"] ?? [];
    const filters = activity["intent-filter"];

    for (const mimeType of SINGLE_MIME_TYPES) {
      if (!hasFilter(filters, ACTION_SEND, mimeType)) {
        filters.push(makeFilter(ACTION_SEND, mimeType));
      }
    }
    for (const mimeType of MULTI_MIME_TYPES) {
      if (!hasFilter(filters, ACTION_SEND_MULTIPLE, mimeType)) {
        filters.push(makeFilter(ACTION_SEND_MULTIPLE, mimeType));
      }
    }
    return next;
  });
};
