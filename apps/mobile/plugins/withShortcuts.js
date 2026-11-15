// 应用图标长按快捷方式（Android 静态 shortcuts）。
//
// 生成内容：
// - res/xml/shortcuts.xml：4 个入口（快速采集 / 拍照采集 / 语音速记 / 新建任务），
//   全部指向 launch-intent 模块的 ShortcutActivity 跳板（原因见该模块注释）；
// - res/drawable/shortcut_*.xml：4 个矢量图标（不依赖第三方资源，也不改全局图标体系）；
// - strings.xml：快捷方式短/长标签（Android 要求这两个属性必须是字符串资源）；
// - AndroidManifest：给 MainActivity 挂 android.app.shortcuts meta-data。
//
// 幂等：所有文件整体写入固定内容，重复 prebuild 不会叠加。
const { withAndroidManifest, withDangerousMod, withStringsXml, AndroidConfig } =
  require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const ACTIONS = [
  {
    id: "capture",
    actionValue: "capture",
    icon: "shortcut_capture",
    shortKey: "shortcut_capture_short",
    longKey: "shortcut_capture_long",
    shortLabel: "快速采集",
    longLabel: "拍照、选图、语音或文字，一起收进收集箱",
  },
  {
    id: "camera",
    actionValue: "camera",
    icon: "shortcut_camera",
    shortKey: "shortcut_camera_short",
    longKey: "shortcut_camera_long",
    shortLabel: "拍照采集",
    longLabel: "打开相机，拍完直接保存",
  },
  {
    id: "voice",
    actionValue: "voice",
    icon: "shortcut_voice",
    shortKey: "shortcut_voice_short",
    longKey: "shortcut_voice_long",
    shortLabel: "语音速记",
    longLabel: "说一句话，存成收集箱或任务",
  },
  {
    id: "task",
    actionValue: "task",
    icon: "shortcut_task",
    shortKey: "shortcut_task_short",
    longKey: "shortcut_task_long",
    shortLabel: "新建任务",
    longLabel: "直接写标题创建任务",
  },
];

// 4 个 24dp 矢量图标（白色单色，由启动器按主题着色）
const VECTORS = {
  shortcut_capture: { pathData: "M11,3h2v6h6v2h-6v6h-2v-6h-6v-2h6z" },
  shortcut_camera: {
    // evenOdd 让镜头圆孔透出背景，避免实心方块
    pathData: "M3,7h18v12h-18z M9,13a3,3 0 1 0 6,0a3,3 0 1 0 -6,0",
    fillType: "evenOdd",
  },
  shortcut_voice: { pathData: "M10,3h4v9h-4z M7.5,11h1.5v4.5h6v-4.5h1.5v6h-9z" },
  shortcut_task: {
    pathData: "M5,3h14v18h-14z M7,7h10v1.6h-10z M7,11h10v1.6h-10z M7,15h6v1.6h-6z",
    fillType: "evenOdd",
  },
};

function shortcutXml(packageName) {
  const entries = ACTIONS.map((item) => `    <shortcut
        android:shortcutId="${item.id}"
        android:enabled="true"
        android:icon="@drawable/${item.icon}"
        android:shortcutShortLabel="@string/${item.shortKey}"
        android:shortcutLongLabel="@string/${item.longKey}">
        <intent
            android:action="dev.taskdock.mobile.QUICK_${item.actionValue.toUpperCase()}"
            android:targetPackage="${packageName}"
            android:targetClass="dev.taskdock.modules.launchintent.ShortcutActivity">
            <extra
                android:name="dev.taskdock.mobile.QUICK_ACTION"
                android:value="${item.actionValue}" />
        </intent>
    </shortcut>`);

  return `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
${entries.join("\n")}
</shortcuts>
`;
}

function vectorXml(pathData, fillType) {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFFFF"${fillType ? `\n        android:fillType="${fillType}"` : ""}
        android:pathData="${pathData}" />
</vector>
`;
}

function writeFileIfChanged(filePath, content) {
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, "utf8");
    if (current === content) return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

const withShortcutResources = (config) =>
  withDangerousMod(config, [
    "android",
    async (mod) => {
      const platformRoot = mod.modRequest.platformProjectRoot;
      const packageName = mod.android?.package ?? config.android?.package;
      if (!packageName) {
        throw new Error("withShortcuts: 缺少 android.package，无法生成快捷方式");
      }
      const resRoot = path.join(platformRoot, "app", "src", "main", "res");
      writeFileIfChanged(
        path.join(resRoot, "xml", "shortcuts.xml"),
        shortcutXml(packageName),
      );
      for (const [name, icon] of Object.entries(VECTORS)) {
        writeFileIfChanged(
          path.join(resRoot, "drawable", `${name}.xml`),
          vectorXml(icon.pathData, icon.fillType),
        );
      }
      return mod;
    },
  ]);

const withShortcutStrings = (config) =>
  withStringsXml(config, (mod) => {
    let results = mod.modResults;
    for (const item of ACTIONS) {
      // setStringItem 接受的是 strings.xml 的 XML 节点数组（`$` 属性 + `_` 文本），
      // 不是 {name,value} 字面量；按已合并节点传可保持幂等（同名节点被替换）。
      results = AndroidConfig.Strings.setStringItem(
        [
          { $: { name: item.shortKey }, _: item.shortLabel },
          { $: { name: item.longKey }, _: item.longLabel },
        ],
        results,
      );
    }
    mod.modResults = results;
    return mod;
  });

const withShortcutManifest = (config) =>
  withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) throw new Error("withShortcuts: manifest.application 缺失");
    const activity = (application.activity ?? []).find(
      (item) => item.$ && item.$["android:name"] === ".MainActivity",
    );
    if (!activity) throw new Error("withShortcuts: 未找到 .MainActivity");
    activity["meta-data"] = activity["meta-data"] ?? [];
    const exists = activity["meta-data"].some(
      (item) => item.$ && item.$["android:name"] === "android.app.shortcuts",
    );
    if (!exists) {
      activity["meta-data"].push({
        $: {
          "android:name": "android.app.shortcuts",
          "android:resource": "@xml/shortcuts",
        },
      });
    }
    return mod;
  });

module.exports = function withShortcuts(config) {
  return withShortcutManifest(withShortcutStrings(withShortcutResources(config)));
};
