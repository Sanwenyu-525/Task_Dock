# 移动端页面原型（TaskDock Mobile Prototypes）

本目录归档 TaskDock Android 端的 Stitch 页面原型：**v2 终版 11 屏** + 用户导出的
**33 个迭代变体**（按页面归组）。原型用于视觉与信息架构对照，不是可运行代码；
实现现状以 `apps/mobile/` 与 [../README.md](../README.md) 为准。

## 目录结构

```
prototypes/
├── README.md              # 本索引
├── index.html             # 可浏览画廊（缩略图 + 筛选 + 直达 HTML/PNG）
├── DESIGN.md              # Stitch 设计系统源文件（Flat Utility，Token/字阶/间距）
├── mapping.json           # 机器可读清单：原目录、新路径、尺寸、sha256、备注
├── final/                 # v2 终版 11 屏（PNG + HTML）
│   └── <key>/{screen.png,code.html}
└── variants/              # 用户导出的 33 个变体，按页面归组
    └── <screen>/<screen>-NN/{screen.png,code.html}
```

- 打开 [index.html](index.html) 可缩略图浏览全部原型；单屏 HTML 也可直接打开。
- 原型 HTML 使用 Tailwind CDN 与 Google Fonts，**离线打开可能缺样式**；视觉以同目录
  `screen.png` 为准。
- 原目录 `stitch页面原型/` 已按本结构迁入；原 `taskdock_N` 与新变体编号的对应关系见
  [mapping.json](mapping.json) 及各分组表。

## 终版 11 屏（v2）

来源：Stitch 项目 `14812669416183589298`「TaskDock Mobile 原型 v2（修正版）」，
设计系统 `assets/bf96cdfa71b948b9af519b75dd92d5bf`（由 `DESIGN.md` 上传生成）。
生成与验收记录见 `tmp/acceptance/stitch-mobile-prototypes/`（`tmp/` 不入库）。

| key | 页面 | 实现状态 | 对应代码 | 画布 | 文件 |
|---|---|---|---|---|---|
| `tasks` | 任务页 | 已实现 · 真机验证 | `src/screens/TasksScreen.tsx` | 2560×2088 | [PNG](final/tasks/screen.png) · [HTML](final/tasks/code.html) |
| `inbox` | 收集箱 | 已实现 · 真机验证 | `src/screens/InboxScreen.tsx` | 2560×2048 | [PNG](final/inbox/screen.png) · [HTML](final/inbox/code.html) |
| `notes` | 笔记列表 | 已实现 · 真机未走查 | `src/screens/NotesScreen.tsx` | 600×1600 | [PNG](final/notes/screen.png) · [HTML](final/notes/code.html) |
| `note_editor` | 笔记编辑 | 已实现 · 真机未走查 | `src/screens/NoteEditorScreen.tsx` | 2560×2048 | [PNG](final/note_editor/screen.png) · [HTML](final/note_editor/code.html) |
| `settings` | 设置 | 已实现 · 真机验证 | `src/screens/SettingsScreen.tsx` | 2560×2264 | [PNG](final/settings/screen.png) · [HTML](final/settings/code.html) |
| `notifications` | 通知与后台 | 已实现 · 真机未走查 | `src/screens/NotificationsScreen.tsx` | 2560×2172 | [PNG](final/notifications/screen.png) · [HTML](final/notifications/code.html) |
| `pairing` | 配对新设备 | 规划态结构 | `src/screens/PairingScreen.tsx` | 2560×2144 | [PNG](final/pairing/screen.png) · [HTML](final/pairing/code.html) |
| `sync` | 同步中心 | 规划态结构 | `src/screens/SyncScreen.tsx` | 2560×2048 | [PNG](final/sync/screen.png) · [HTML](final/sync/code.html) |
| `conflict` | 冲突处理 | 规划态结构 | `src/screens/ConflictScreen.tsx` | 780×1768 | [PNG](final/conflict/screen.png) · [HTML](final/conflict/code.html) |
| `widget` | 主屏小组件 | 规划态结构 | `src/screens/WidgetScreen.tsx` | 665×1600 | [PNG](final/widget/screen.png) · [HTML](final/widget/code.html) |
| `share` | 分享接收 | 规划态结构 | `src/screens/ShareScreen.tsx` | 2560×2048 | [PNG](final/share/screen.png) · [HTML](final/share/code.html) |

状态口径：

- **已实现 · 真机验证**：功能已落地，并有真机验收记录。
- **已实现 · 真机未走查**：功能已落地，本轮未做真机视觉/交互走查。
- **规划态结构**：页面结构与文案可看，底层能力（配对/同步传输/冲突合并/原生小组件/
  系统分享 intent）未实现；详见 [../README.md](../README.md) 的「未实现」表。

## 导出变体（33 个，按页面归组）

33 个变体覆盖 8 类页面；`note_editor`、`share`、`notifications` 没有导出变体，只有
`final/` 中的 API 直出终版。变体编号按原目录数字升序重排，`原目录` 列保留可追溯性。

### 任务（tasks，6 个变体）

| 变体 | 原目录 | 标题 | 画布 | 目检备注 | 文件 |
|---|---|---|---|---|---|
| `tasks-01` | `taskdock_1` | TaskDock - 任务 | 545×1600 | 完整任务页；无顶栏，统计块/筛选/分组/FAB/中文 Tab 齐全 | [PNG](variants/tasks/tasks-01/screen.png) · [HTML](variants/tasks/tasks-01/code.html) |
| `tasks-02` | `taskdock_2` | TaskDock 任务列表 | 1600×1404 | 宽幅画布导出，手机内容靠右；页面结构同任务页 | [PNG](variants/tasks/tasks-02/screen.png) · [HTML](variants/tasks/tasks-02/code.html) |
| `tasks-03` | `taskdock_3` | TaskDock 任务列表 | 1600×1305 | 宽幅画布导出，手机内容靠右；页面结构同任务页 | [PNG](variants/tasks/tasks-03/screen.png) · [HTML](variants/tasks/tasks-03/code.html) |
| `tasks-04` | `taskdock_9` | TaskDock - 任务 | 530×1600 | 完整任务页；分组标题带数量，其余同任务页 | [PNG](variants/tasks/tasks-04/screen.png) · [HTML](variants/tasks/tasks-04/code.html) |
| `tasks-05` | `taskdock_10` | TaskDock | 629×1600 | 完整任务页；无顶栏，结构同任务页 | [PNG](variants/tasks/tasks-05/screen.png) · [HTML](variants/tasks/tasks-05/code.html) |
| `tasks-06` | `taskdock_22` | TaskDock | 572×1600 | 完整任务页；无顶栏，结构同任务页 | [PNG](variants/tasks/tasks-06/screen.png) · [HTML](variants/tasks/tasks-06/code.html) |

### 收集箱（inbox，4 个变体）

| 变体 | 原目录 | 标题 | 画布 | 目检备注 | 文件 |
|---|---|---|---|---|---|
| `inbox-01` | `taskdock_6` | TaskDock - 收集箱 | 657×1600 | 收集箱；速记输入 + 搜索 + 列表 + 转任务/删除，结构完整 | [PNG](variants/inbox/inbox-01/screen.png) · [HTML](variants/inbox/inbox-01/code.html) |
| `inbox-02` | `taskdock_11` | TaskDock - 收集箱 | 610×1600 | 收集箱；结构同 taskdock_6 | [PNG](variants/inbox/inbox-02/screen.png) · [HTML](variants/inbox/inbox-02/code.html) |
| `inbox-03` | `taskdock_15` | TaskDock 收集箱 | 1600×1280 | 宽幅画布导出；收集箱结构完整，内容居中 | [PNG](variants/inbox/inbox-03/screen.png) · [HTML](variants/inbox/inbox-03/code.html) |
| `inbox-04` | `taskdock_20` | TaskDock - 收集箱 | 706×1600 | 收集箱；卡片间距更大，结构同 taskdock_6 | [PNG](variants/inbox/inbox-04/screen.png) · [HTML](variants/inbox/inbox-04/code.html) |

### 笔记（notes，12 个变体）

| 变体 | 原目录 | 标题 | 画布 | 目检备注 | 文件 |
|---|---|---|---|---|---|
| `notes-01` | `taskdock_14` | TaskDock - 笔记 | 559×1600 | 笔记列表；顶部品牌栏 + 搜索，规划徽标，FAB/中文 Tab 齐全 | [PNG](variants/notes/notes-01/screen.png) · [HTML](variants/notes/notes-01/code.html) |
| `notes-02` | `taskdock_16` | TaskDock - 笔记 | 536×1600 | 笔记列表；顶部汉堡菜单 + 品牌栏，结构同 taskdock_14 | [PNG](variants/notes/notes-02/screen.png) · [HTML](variants/notes/notes-02/code.html) |
| `notes-03` | `taskdock_17` | TaskDock - 笔记 | 553×1600 | 笔记列表；顶部品牌栏，结构同 taskdock_14 | [PNG](variants/notes/notes-03/screen.png) · [HTML](variants/notes/notes-03/code.html) |
| `notes-04` | `taskdock_19` | TaskDock - 笔记 | 520×1600 | 笔记列表；顶部品牌栏，结构同 taskdock_14 | [PNG](variants/notes/notes-04/screen.png) · [HTML](variants/notes/notes-04/code.html) |
| `notes-05` | `taskdock_21` | TaskDock - 笔记 | 563×1600 | 笔记列表；无顶栏，结构接近 v2 终版 | [PNG](variants/notes/notes-05/screen.png) · [HTML](variants/notes/notes-05/code.html) |
| `notes-06` | `taskdock_23` | TaskDock - 笔记 | 557×1600 | 笔记列表；原始图标名 push_pin 与 Tab 文案 description 外露，不可用 | [PNG](variants/notes/notes-06/screen.png) · [HTML](variants/notes/notes-06/code.html) |
| `notes-07` | `taskdock_24` | TaskDock 笔记 | 487×1492 | 笔记列表；底部 Tab 栏被裁切 | [PNG](variants/notes/notes-07/screen.png) · [HTML](variants/notes/notes-07/code.html) |
| `notes-08` | `taskdock_25` | TaskDock - 笔记 | 487×1490 | 笔记列表；底部 Tab 栏被裁切，置顶/收藏胶囊文字竖排换行 | [PNG](variants/notes/notes-08/screen.png) · [HTML](variants/notes/notes-08/code.html) |
| `notes-09` | `taskdock_26` | TaskDock - 笔记 | 487×1505 | 笔记列表；顶部汉堡菜单 + 品牌栏，筛选胶囊文字竖排换行 | [PNG](variants/notes/notes-09/screen.png) · [HTML](variants/notes/notes-09/code.html) |
| `notes-10` | `taskdock_27` | TaskDock - 笔记 | 545×1600 | 笔记列表；顶部品牌栏，无 FAB | [PNG](variants/notes/notes-10/screen.png) · [HTML](variants/notes/notes-10/code.html) |
| `notes-11` | `taskdock_29` | TaskDock - 笔记 | 546×1600 | 笔记列表；顶部 TD 标识 + 同步/更多动作，结构完整 | [PNG](variants/notes/notes-11/screen.png) · [HTML](variants/notes/notes-11/code.html) |
| `notes-12` | `taskdock_30` | TaskDock Mobile - 笔记 | 600×1600 | 笔记列表；无顶栏、结构完整，**v2 终版采用** | [PNG](variants/notes/notes-12/screen.png) · [HTML](variants/notes/notes-12/code.html) |

### 设置（settings，5 个变体）

| 变体 | 原目录 | 标题 | 画布 | 目检备注 | 文件 |
|---|---|---|---|---|---|
| `settings-01` | `taskdock_4` | TaskDock 设置 | 564×1600 | 设置页；统计块 + 外观/提醒/本地数据/关于，结构完整 | [PNG](variants/settings/settings-01/screen.png) · [HTML](variants/settings/settings-01/code.html) |
| `settings-02` | `taskdock_5` | 设置 - TaskDock | 571×1600 | 设置页；结构同 taskdock_4，间距略有差异 | [PNG](variants/settings/settings-02/screen.png) · [HTML](variants/settings/settings-02/code.html) |
| `settings-03` | `taskdock_7` | TaskDock 设置 (移动端) | 1600×1339 | 宽幅画布导出；设置页结构完整 | [PNG](variants/settings/settings-03/screen.png) · [HTML](variants/settings/settings-03/code.html) |
| `settings-04` | `taskdock_12` | TaskDock Settings | 564×1600 | 设置页；结构完整，HTML `<title>` 为英文但界面文案中文 | [PNG](variants/settings/settings-04/screen.png) · [HTML](variants/settings/settings-04/code.html) |
| `settings-05` | `taskdock_13` | TaskDock 设置 (移动端) | 1600×1415 | 宽幅画布导出；设置页结构完整 | [PNG](variants/settings/settings-05/screen.png) · [HTML](variants/settings/settings-05/code.html) |

### 配对新设备（pairing，1 个变体）

| 变体 | 原目录 | 标题 | 画布 | 目检备注 | 文件 |
|---|---|---|---|---|---|
| `pairing-01` | `taskdock_8` | TaskDock 配对新设备 | 1600×1340 | 配对新设备；规划徽标 + 三步 + 取景框 + 6 位码 + 安全说明 | [PNG](variants/pairing/pairing-01/screen.png) · [HTML](variants/pairing/pairing-01/code.html) |

### 同步中心（sync，1 个变体）

| 变体 | 原目录 | 标题 | 画布 | 目检备注 | 文件 |
|---|---|---|---|---|---|
| `sync-01` | `taskdock_18` | TaskDock 同步 (移动端) | 1600×1280 | 同步中心；规划徽标 + 连接卡 + 待发送/待接收 + 设备行 + 开关 | [PNG](variants/sync/sync-01/screen.png) · [HTML](variants/sync/sync-01/code.html) |

### 冲突处理（conflict，2 个变体）

| 变体 | 原目录 | 标题 | 画布 | 目检备注 | 文件 |
|---|---|---|---|---|---|
| `conflict-01` | `taskdock_28` | TaskDock - 处理冲突 | 706×1600 | 冲突处理；返回栏 + 1/2 + 规则卡 + 双版本卡 + 三操作；无规划徽标 | [PNG](variants/conflict/conflict-01/screen.png) · [HTML](variants/conflict/conflict-01/code.html) |
| `conflict-02` | `taskdock_31` | TaskDock 同步冲突解决 (移动端) | 706×1600 | 冲突处理；双版本卡 + 三操作；无规划徽标、无底部 Tab 栏 | [PNG](variants/conflict/conflict-02/screen.png) · [HTML](variants/conflict/conflict-02/code.html) |

### 主屏小组件（widget，2 个变体）

| 变体 | 原目录 | 标题 | 画布 | 目检备注 | 文件 |
|---|---|---|---|---|---|
| `widget-01` | `taskdock_32` | 主屏小组件 - TaskDock | 582×1600 | 主屏小组件；返回栏 + 预览 + 尺寸/数据源/外观/交互 + 添加按钮；含「实时同步」文案 | [PNG](variants/widget/widget-01/screen.png) · [HTML](variants/widget/widget-01/code.html) |
| `widget-02` | `taskdock_33` | 主屏小组件配置 - TaskDock | 665×1600 | 主屏小组件；配置项最完整，**v2 终版采用**；含「实时同步」文案 | [PNG](variants/widget/widget-02/screen.png) · [HTML](variants/widget/widget-02/code.html) |

## 已知差异与遗留

1. **conflict 终版缺「规划中」徽标**：`prompts.py` 该屏提示词漏写，用户已确认接受；
   两个导出变体同样没有徽标。若需统一，重跑 `FORCE=conflict python build_v2.py conflict`。
2. **widget 含「实时同步」旧口径**：与当前「仅本机」产品口径及同步「规划中」状态不一致，
   建议后续改为「本机 · 规划中」或移除。
3. **notes / widget 终版来自导出变体**（`notes-12`、`widget-02`），无 Stitch screenId，
   分辨率与 API 直出屏不一致；文案与布局已逐屏核对。
4. **导出画布尺寸不统一**：部分变体为 1600 宽桌面画布（内容居中/靠右），部分为 487–706 宽
   手机画布；对比时以内容而非画布比例为准。
5. **notes 变体存在缺陷**：`notes-06` 原始图标名/Tab 文案外露；`notes-07`、`notes-08`
   底部 Tab 被裁切；`notes-08`、`notes-09` 筛选胶囊竖排换行；`notes-10` 无 FAB。
   以上变体仅作迭代对照，不用于实现参考。
6. **原型 HTML 依赖外部 CDN**（Tailwind、Google Fonts、Material Symbols），离线打开可能
   缺样式；视觉验收以 `screen.png` 为准。

## 来源与生成

- v2 项目：Stitch `projects/14812669416183589298`；v1 对照项目
  `projects/5241286698533410445`（保留未动）。
- 设计系统：`assets/bf96cdfa71b948b9af519b75dd92d5bf`，由本目录 `DESIGN.md` 上传生成。
- 生成方式：本会话无原生 Stitch MCP 工具，使用 `tmp/acceptance/stitch-mobile-prototypes/build_v2.py`
  向同一 MCP 端点发送 JSON-RPC；细节与限流记录见该目录 `RESUME.md`、`report.md`。
- 变体来源：用户在 Stitch 网页端导出的 `stitch页面原型/taskdock_1..33`，2026-11-08 迁入本目录。
- 哈希与逐文件对应：见 [mapping.json](mapping.json)。

## 变更记录

- 2026-11-08 首版：33 个导出变体按页面归组迁入 `variants/`；v2 终版 11 屏归档到
  `final/`；新增 `README.md`、`index.html`、`mapping.json`，`DESIGN.md` 一并迁入。
  仅整理文件与索引，未修改原型内容、未改产品代码。
