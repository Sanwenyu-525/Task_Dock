// 采集相关权限：麦克风（语音速记）与网络状态（自动同步判断是否计费网络）。
//
// 模块自身的 AndroidManifest 已声明，这里再显式写入主清单：
// 1) 让 `expo prebuild` 生成的主清单在任何 autolinking 配置下都带上这两项；
// 2) 权限用途在清单注释里可审计（录音只在本机处理，网络状态只读能力位）。
//
// 不申请存储权限：相册/文件通过 SAF 选择器读取，分享通过 ContentResolver 流式复制，
// 都不需要 READ_EXTERNAL_STORAGE（Android 13+ 更不需要）。
const { withAndroidManifest } = require("@expo/config-plugins");

const PERMISSIONS = [
  "android.permission.RECORD_AUDIO",
  "android.permission.ACCESS_NETWORK_STATE",
];

module.exports = function withCapturePermissions(config) {
  return withAndroidManifest(config, (next) => {
    const manifest = next.modResults.manifest;
    manifest["uses-permission"] = manifest["uses-permission"] ?? [];
    const existing = manifest["uses-permission"].map(
      (item) => item.$ && item.$["android:name"],
    );
    for (const permission of PERMISSIONS) {
      if (!existing.includes(permission)) {
        manifest["uses-permission"].push({ $: { "android:name": permission } });
      }
    }
    return next;
  });
};
