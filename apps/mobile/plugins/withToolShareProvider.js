// 注册分享文件所需的 FileProvider（开发者工具的「分享图片 / 分享文本文件」）。
//
// 为什么需要：Android 7+ 禁止把 file:// 直接放进 ACTION_SEND，否则接收方启动时
// 抛 FileUriExposedException。工具产物都在应用私有目录里，必须经 FileProvider 转成
// content:// 并授予一次性读权限。
//
// android/ 是 prebuild 生成目录，不手改；本插件在每次 prebuild 时：
// 1) 在 AndroidManifest 里幂等注册 provider（authority 固定为 <package>.toolfiles）；
// 2) 写入 res/xml/taskdock_file_paths.xml（只暴露 files/ 与 cache/）。
// 原生侧 modules/share-intent 用同一个 authority 生成 content://。
const fs = require("fs");
const path = require("path");

const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");

const PROVIDER_CLASS = "androidx.core.content.FileProvider";
const RESOURCE_NAME = "taskdock_file_paths";
const RESOURCE_REF = `@xml/${RESOURCE_NAME}`;

const PATHS_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- TaskDock 工具产物的分享路径：只暴露应用私有 files/ 与 cache/，
     不映射外部存储，避免把任意路径变成可分享 URI。 -->
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <files-path name="files" path="." />
  <cache-path name="cache" path="." />
</paths>
`;

module.exports = function withToolShareProvider(config) {
  const packageName = config.android?.package;
  if (!packageName) {
    throw new Error("withToolShareProvider: app.json 缺少 android.package，无法确定 FileProvider authority");
  }
  const authority = `${packageName}.toolfiles`;

  config = withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("withToolShareProvider: manifest.application 缺失");
    }
    application.provider = application.provider ?? [];
    const exists = application.provider.some(
      (provider) =>
        provider.$?.["android:name"] === PROVIDER_CLASS &&
        provider.$?.["android:authorities"] === authority,
    );
    if (!exists) {
      application.provider.push({
        $: {
          "android:name": PROVIDER_CLASS,
          "android:authorities": authority,
          "android:exported": "false",
          "android:grantUriPermissions": "true",
        },
        "meta-data": [
          {
            $: {
              "android:name": "android.support.FILE_PROVIDER_PATHS",
              "android:resource": RESOURCE_REF,
            },
          },
        ],
      });
    }
    return next;
  });

  return withDangerousMod(config, [
    "android",
    async (next) => {
      const xmlDir = path.join(next.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, `${RESOURCE_NAME}.xml`), PATHS_XML, "utf8");
      return next;
    },
  ]);
};
