// 允许局域网明文 HTTP（本轮配对传输基线，用户已确认）。
//
// 为什么需要：Android 9+ 默认禁止明文流量；桌面端手机接入是 `http://<局域网IP>:47822`。
// 这不是「顺手放开」：只在应用清单设置 usesCleartextTraffic，不引入全局网络库；
// 威胁模型与后续 TLS 计划见 docs/mobile/01-architecture.md 与验收报告。
//
// 该插件在 `expo prebuild` 时生效；`android/` 是生成目录（.gitignore），不手改清单。
const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (application) {
      application.$["android:usesCleartextTraffic"] = "true";
    }
    return next;
  });
};
