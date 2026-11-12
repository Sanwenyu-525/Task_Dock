// 给 MainActivity 追加系统分享入口的 intent-filter（ACTION_SEND text/plain）。
//
// 为什么需要：Android 分享面板按 intent-filter 匹配接收方；expo prebuild 生成的
// MainActivity 只有 MAIN/LAUNCHER 过滤器。本插件在 prebuild 时给主 Activity 追加
// 一个独立的 intent-filter（带 DEFAULT category 与 text/plain mimeType），
// 浏览器等应用即可选「分享到 TaskDock」。
//
// 不混入 LAUNCHER 过滤器：mimeType 出现在 LAUNCHER 过滤器里会影响桌面图标匹配语义。
// android/ 是生成目录，源码只有本插件；重复执行 prebuild 会重新生成并再次应用本插件
// （内部做了幂等检查，不会叠加过滤器）。
const { withAndroidManifest } = require("@expo/config-plugins");

const ACTION_SEND = "android.intent.action.SEND";

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
    const alreadyRegistered = activity["intent-filter"].some((filter) =>
      (filter.action ?? []).some((action) => action.$ && action.$["android:name"] === ACTION_SEND),
    );
    if (!alreadyRegistered) {
      activity["intent-filter"].push({
        $: {},
        action: [{ $: { "android:name": ACTION_SEND } }],
        category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
        data: [{ $: { "android:mimeType": "text/plain" } }],
      });
    }
    return next;
  });
};
