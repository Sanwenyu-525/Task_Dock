// 注册 TaskDock 主屏小组件的 AppWidgetProvider receiver（2×2 与 4×2 两种尺寸）。
//
// 为什么用插件：receiver 与 appwidget-provider 元数据必须进 AndroidManifest，
// 而 android/ 是 prebuild 生成目录不手改。Provider 类与 RemoteViews 布局都来自
// 本地 Expo module `modules/taskdock-widget/`（autolinking 打进 APK），
// 本插件只负责在应用清单里声明两个 receiver。
//
// 每个尺寸一个 receiver：AppWidgetProvider 的 meta-data 指向各自的
// @xml/taskdock_widget_*_info，系统小组件选择器按 receiver 出条目。
// 幂等：重复 prebuild 不会叠加 receiver。
const { withAndroidManifest } = require("@expo/config-plugins");

const APPWIDGET_UPDATE_ACTION = "android.appwidget.action.APPWIDGET_UPDATE";
const PROVIDER_META = "android.appwidget.provider";
const RECEIVER_BASE = "dev.taskdock.modules.taskdockwidget.TaskDockWidget";

const WIDGET_SIZES = [
  { key: "4x2", label: "TaskDock 4×2", resource: "@xml/taskdock_widget_4x2_info" },
  { key: "2x2", label: "TaskDock 2×2", resource: "@xml/taskdock_widget_2x2_info" },
];

module.exports = function withTaskDockWidgets(config) {
  return withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("withTaskDockWidgets: manifest.application 缺失，无法注册小组件 receiver");
    }
    application.receiver = application.receiver ?? [];

    for (const size of WIDGET_SIZES) {
      const receiverName = `${RECEIVER_BASE}${size.key}`;
      const alreadyRegistered = application.receiver.some(
        (receiver) => receiver.$ && receiver.$["android:name"] === receiverName,
      );
      if (alreadyRegistered) continue;

      application.receiver.push({
        $: {
          "android:name": receiverName,
          "android:exported": "false",
          "android:label": size.label,
          "android:description": "@string/taskdock_widget_description",
        },
        "intent-filter": [
          {
            $: {},
            action: [{ $: { "android:name": APPWIDGET_UPDATE_ACTION } }],
          },
        ],
        "meta-data": [{ $: { "android:name": PROVIDER_META, "android:resource": size.resource } }],
      });
    }
    return next;
  });
};
