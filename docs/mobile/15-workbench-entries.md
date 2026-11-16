# 15 · 工作台入口自定义（Workbench Entry Customization）

> 2026-11-15 第十轮。移动端工作台的「快捷入口」从**写死数组**改为**注册表 + 用户配置**驱动：
> 用户可以决定工作台显示哪些入口、隐藏哪些、以什么顺序排列，并在独立的管理页里完成
> 搜索 / 批量 / 恢复默认；暂不可用能力与用户主动隐藏严格分在两个区域。
>
> 桌面端仍使用自己的一套（`src/lib/navigationRegistry.ts` + `navVisibility.ts` +
> `navigationLayout.ts`，键 `navigation_layout`），两端**只共享语义，不共享配置**。

## 1. 为什么不是「加几个开关」

改造前 `HomeScreen` 里是一段写死的 `quickEntries` 数组：无法表达「这个能力移动端还没有」，
无法表达「默认显示还是默认隐藏」，也无法在 App 升级新增功能时区分

- 用户主动隐藏过的入口（**不允许**因为升级自动重新出现）；
- 从来没出现过的入口（新功能，**应该**按默认规则加入）。

所以本功能的主体是数据模型：一份稳定的注册表 + 一份可迁移的配置 + 一套纯函数归一化。

## 2. 数据模型（三层，依赖方向自上而下）

| 层 | 文件 | 职责 | 依赖约束 |
|---|---|---|---|
| 元数据 | `src/lib/entryRegistry.ts` | 27 个入口的 id/label/icon/描述/分类/可用性/落点/默认可见/默认顺序 | 纯数据 + 纯函数，**不得** import react/react-native/db |
| 配置 | `src/lib/entryLayout.ts` | 结构定义、默认值、归一化（迁移 / 损坏 / 新增合并）、显示隐藏排序纯函数 | 只依赖注册表 |
| 持久化 | `src/db/entryLayout.ts` | 读写 kv 里的 `workbench_entries`，读永不抛、写失败必须抛 | 只依赖 kv + 配置层 |
| 运行时 | `src/lib/entryLayoutStore.ts` | 订阅（`useSyncExternalStore`）、单飞加载、串行写队列、乐观更新与回滚 | 依赖上面三层 |

界面只读 `useEntryLayout()`，不各自持有配置副本——这正是「不同页面不能各自保存互相冲突的
配置」这条要求的落地方式。

### 2.1 入口元数据字段

```ts
interface MobileEntry {
  id: string;            // 稳定 ID，配置里存的就是它，发布后不得改名
  label: string;         // 用户可见名称
  icon: string;          // 语义图标名，必须存在于 components/icons/iconMap.json
  description: string;   // 一行简介，管理页副标题
  category: "capture" | "task" | "device" | "system";
  availability: "available" | "unavailable";
  reason?: string;       // 仅 unavailable：为什么移动端不支持
  launch?: EntryLaunch;  // 仅 available：route / tab / createTask
  defaultVisible: boolean;
  order: number;         // 默认顺序（越小越靠前）
}
```

刻意**没有**加的字段：`fallbackRoute`（曾用于「未接入说明页」）。2026-11-15 同时收口的
导航决策是「未接入能力不保留推送路由」，所以暂不可用入口现在没有任何落点，
点开只弹原因提示，绝不会跳进不存在的页面。

### 2.2 可用性 vs 用户隐藏

| 状态 | 含义 | 能否加入工作台 | 出现在哪 |
|---|---|---|---|
| available | 移动端有真实页面/能力 | 能 | 工作台（若显示）、管理页「已显示/未显示」、全部功能 |
| unavailable | 移动端缺能力或只有桌面端数据链路 | **不能** | 管理页「暂不可用」、全部功能「暂不可用」 |
| 用户隐藏 | 可用但用户选择不显示 | 能（随时加回） | 管理页「未显示」、全部功能「未显示」 |

暂不可用与用户隐藏必须是两个区域、两种文案、两种操作（前者没有「添加」按钮）。

## 3. 配置结构与迁移

kv 键：`workbench_entries`（移动端专属；桌面端是 settings 表的 `navigation_layout`）。

```json
{ "version": 1, "visible": ["capture", "create-task", "workspace", "stash", "tools"], "known": ["…全部可用入口…"] }
```

- `visible`：工作台显示顺序（数组顺序即排列顺序）；**空数组合法**（用户可以把工作台清空）。
- `known`：写入时「全部可用入口」的快照，用于区分「用户隐藏」与「版本新增」。
- `version`：结构版本，当前 `1`。

`normalizeEntryLayout(raw)` 的判定顺序（`src/lib/entryLayout.ts`）：

1. 不是对象 / `visible` 不是数组 → **损坏**，整体回默认（`source: "default"`）；
2. 逐项校验：必须存在、可用、不重复，否则丢弃并计入 `dropped`；
3. `known` 缺失（更早格式）→ 保守地把「现存全部可用入口」视为已知，
   宁可少自动补，也不把用户隐藏过的入口翻出来；
4. 不在 `known` 且 `defaultVisible` 的入口 → 按 `order` 插到默认位置（**新功能合并规则**）；
5. `known` 收敛为当前全部可用入口，下次写入即自洽。

于是三条承诺同时成立：

- 新功能（`defaultVisible: true`）在升级后自动出现；
- 用户隐藏过的入口不会因为升级重新出现；
- 已删除 / 改名的入口在读取时被安全清理（`dropped`），不会让配置永久带脏数据。

版本变化（`version !== 1`）标记 `migrated`，结构按当前版本重建、用户选择保留；
`entryLayoutStore` 在启动时对 `corrupt / migrated / dropped>0` 做一次**修复写回**，
避免每次启动都重复兜底。

## 4. 持久化与失败语义

| 场景 | 行为 |
|---|---|
| 首次安装（无键/空串） | 默认布局，`source: "default"`，不标记损坏 |
| JSON 解析失败 | 默认布局 + `corrupt: true`，启动时写回修复 |
| 结构错误（`visible` 非数组） | 同上 |
| 读取本身失败（数据库错误） | 默认布局 + `readFailed: true`；`entryLayoutStore` 仍标记 `loaded`，App 正常启动 |
| 写入失败 | `commit*` 抛异常 → 界面 Toast 明确失败；内存回滚到最后一次成功落盘的配置（`persisted`） |
| 设备断网 | 无影响：配置只在本机 SQLite，不参与同步 |

写入一律串行（`writeChain`）：连续点按 / 连续拖拽产生的多个「读-改-写」不会互相覆盖。
界面采用乐观更新——先改内存让用户立刻看到，落盘失败再回滚并提示。

## 5. 界面

| 界面 | 入口 | 行为 |
|---|---|---|
| 工作台（`HomeScreen`） | 默认首页 | 按 `visible` 渲染 `WorkbenchEntryRail`（2026-11-16 起为单行横向轨道，见 §12；改造前是 `WorkbenchEntryGrid` 的固定列网格）；`SectionHeader` 右侧「管理」；长按磁贴进入编辑态；空态给「全部功能 / 恢复默认」 |
| 编辑态（`WorkbenchEntryRail`） | 长按磁贴 | 磁贴右上角 × + 右下角拖动手柄（左右拖动排序）；轻点磁贴开动作表（前移/后移/移除）；拖拽为「松手落位」；右上角「完成」退出 |
| 入口管理页（`EntryManagerScreen`, 路由 `entry_manager`） | 工作台「管理」 | SegmentedControl「布局管理 / 全部功能」；已显示（拖动手柄 + ×）/ 未显示（+）/ 暂不可用（原因 + Badge）；搜索；批量模式 + BulkActionBar；恢复默认；Toast 反馈。仍为纵向列表，不改成横向 |
| 全部功能页（`EntryManagerScreen`, 路由 `all_features`） | 管理页页签、工作台空态 | 按分类分组展示全部入口，区分三态，可点开可用入口，暂不可用点开只提示原因 |

拖拽不抢页面滚动：编辑态拖动磁贴手柄时工作台 `ScrollView` 关闭滚动（`entryDragActive`），
松手后恢复；管理页列表只在手柄上启动拖拽，行本身仍可滚动。

## 6. 新增一个移动端功能入口（检查清单）

1. `src/lib/entryRegistry.ts` 追加一条记录（新 `id`、`order` 取当前最大值之后）；
2. `launch` 指向**真实存在**的路由/底部栏；没有真实页面的一律 `availability: "unavailable"` + `reason`；
3. 图标加进 `components/icons/iconMap.json` 并 `npm run icons:generate`；
4. 决定 `defaultVisible`——首次安装就出现的才设 `true`，`known` 机制会自动处理老用户；
5. 跑 `npm --prefix apps/mobile test`：注册表契约测试会校验 id/order 唯一、路由存在、图标存在。

## 7. 两端关系

| 能力 | 桌面端 | 移动端 |
|---|---|---|
| 元数据源 | `src/lib/navigationRegistry.ts` | `src/lib/entryRegistry.ts` |
| 归一化思路 | `navVisibility.ts`（version/lists/known） | `entryLayout.ts`（同思路，规则见 §3） |
| 持久化 | SQLite `settings.navigation_layout` | 本机 kv `workbench_entries` |
| 管理 UI | `NavigationVisibilitySection.tsx` | `EntryManagerScreen.tsx` |

两端**独立配置**：改移动端不会影响桌面端，反之亦然。共享的只有「稳定 ID + 元数据语义 +
默认规则 + 归一化思路」，没有共享运行时状态。移动端没有为此重构桌面端任何代码。

## 8. 测试

| 文件 | 覆盖 |
|---|---|
| `src/lib/__tests__/entryRegistry.test.ts` | id/order 唯一、可用性字段契约、路由与图标存在、默认布局、既有入口一个不少 |
| `src/lib/__tests__/entryLayout.test.ts` | 损坏兜底、空数组合法、逐项校验、known 合并、版本迁移、增删排序、幂等 |
| `src/lib/__tests__/entryReorder.test.ts` | 横向轨道落位 / 列表换位 / 轻点判定的边界与异常输入 |
| `src/lib/__tests__/entryRail.test.ts` | 320/360/393/420/800dp 等宽度与 1~24 个入口的单行/溢出判定、磁贴宽高上下限、字体缩放、末尾完整可见、偏移收敛 |
| `src/db/__tests__/entryLayout.test.ts` | 真实 SQLite 往返、损坏恢复、旧版本迁移、已删除入口清理、读失败标记 |
| `src/lib/__tests__/entryLayoutStore.test.ts` | 单飞加载、串行写不互相覆盖、重启一致性、恢复默认 |
| `src/lib/__tests__/entryLayoutStoreWriteFailure.test.ts` | 写盘失败注入：回滚到最近成功、失败不残留 settings、连续失败不污染、失败后仍可写、慢写串行 |
| `src/lib/__tests__/entryLayout.test.ts` 的「边界输入与 dropped 统计」 | 非字符串 / 重复 / 未知 / 暂不可用 / 空数组 / known 缺失或不全 / 旧结构 / 损坏 |

`vitest.config.ts` 为 mobile 自带 React 19.3.0 与仓库根 19.3.1 的双实例补了
`react/jsx-runtime`、`react/jsx-dev-runtime` alias（automatic JSX 走子路径，只写 `react`
不命中）；入口模块本身不依赖渲染器。2026-11-16 全量 54 文件 / 561 例通过。capture 组件
测试的环境问题由该模块自己的测试改动修复，不属于入口模块。

## 9. 变更记录

- 2026-11-15：新建。工作台入口注册表 + 配置 + 管理页 + 全部功能页 + 长按编辑；
  同时把 `HomeScreen` 里写死的 `quickEntries` 与「AI 助手」降饱和占位磁贴移出工作台
  （后者归入暂不可用，理由：移动端没有 AI 对话与执行链路）。
- 2026-11-15（真机验收）：release APK（versionCode 61 / 0.1.13）装在物理机
  `192.168.5.7:41789` 上逐项验证——隐藏后冷启动仍只显示两枚磁贴、搜索加回并可跳转「文件互传」、
  管理页与编辑态两种拖拽顺序在冷启动后保持、全部隐藏后空状态（全部功能 / 恢复默认）可用、
  暂不可用不可添加且点击只提示不跳转、批量添加与移除、自动保存提示。
  证据：`tmp/acceptance/mobile-entry-customization/report.md` §10 与同目录 `shots/`。
- 2026-11-16（两端隔离取证）：移动端连续做「拖动换位 + 移除两项」并冷启动后，桌面端
  `application_settings.navigation_layout` 的 bytes / sha256 / updated_at 与改前完全一致；
  移动端配置位于 app 私有目录（`/data/data/dev.taskdock.mobile/`，release 包不可 `run-as`），
  桌面端在 `%APPDATA%\com.taskdock.desktop\task-dock.db`，两端键名 `workbench_entries` /
  `navigation_layout` 互不引用（桌面端对 `workbench_entries` 引用 0 处）。
  反方向（改桌面端后验移动端）未执行，避免写入用户真实配置，详见报告 §10 隔离取证。
- 2026-11-16（第二轮质量加固）：补写盘失败注入 10 例、归一化边界 13 例，入口模块 7 文件
  114 例通过；`commitEntryLayout` 失败改为整份快照回滚（不再残留 `source:"settings"` /
  `corrupt:false`）；`normalizeEntryLayout` 对 `visible` 逐项校验，非字符串计入 `dropped`。
  管理页 `openEntry` 对 tab/createTask 先 `onBack()` 再切换，修掉「点了没反应」；窄屏
  `compact` 隐藏简介、列表拖动手柄与工作台 × 扩大命中区；`QuickTile` 标签改 2 行并收紧
  内距，保持 78 高，修 4 列下「本机素材暂存」省略号。typecheck 0、全量 561 例通过、
  release APK versionCode 64 / 0.1.16 已构建并安装（自建 heavy `h-mwiujy9y-9e90f5`，
  398s），真机验证配置跨版本保留与小屏/拖拽。19 个入口的
  真机逐项点击受设备自动化漂移影响只完成 1 项，其余以代码契约 + 单测覆盖，详见
  `tmp/acceptance/mobile-entry-customization/report-round2.md`。
- 2026-11-16（六点拖拽手柄）：新增 `src/components/entry/GripDots.tsx`（2 列 × 3 行，
  `accessible={false}`、`importantForAccessibility="no-hide-descendants"`，颜色由外层
  `tokens.muted` 传入）。管理页 `DragHandle` 由旋转 `AppIcon name="more"` 改为
  `GripDots dot={3} gap={3}`（容器 22×40）；工作台网格手柄改为 `GripDots dot={2.5} gap={2}`
  （容器 18×18）。原 `handleIcon`/`gripIcon` 旋转样式删除；无障碍标签、`hitSlop` 与
  拖拽几何（78 高、18×18 手柄）不变。入口 7 文件 / 114 例与 `tsc --noEmit` 通过；
  vc64 管理页已截图确认 6 点（`62-grip-manager.png`），网格编辑态手柄截图待补。

## 10. 开发者工具入口（2026-11-16 第十一轮，历史状态）

> 本节记录的是第十一轮的 11 个开发者工具入口；同日产品整改后已被 §12 取代。
> 历史事实保留，但**当前实现以 §12 为准**。

本轮把工具页 10 个灰色占位替换为 11 个有真实页面的开发者工具，并全部登记进同一份入口注册表：

| 入口 id | 标签 | order | 默认可见 | 路由 |
|---|---|---|---|---|
| `tool.snippet` | 代码片段 | 301 | 否 | `tool_snippets` |
| `tool.json` | JSON 格式化 | 302 | 否 | `tool_json` |
| `tool.timestamp` | 时间戳转换 | 303 | 否 | `tool_timestamp` |
| `tool.text` | 文本编解码 | 304 | 否 | `tool_text_codec` |
| `tool.regex` | 正则测试 | 305 | 否 | `tool_regex` |
| `tool.diff` | 代码对比 | 306 | 否 | `tool_diff` |
| `tool.image-compress` | 图片压缩 | 307 | 否 | `tool_image_compress` |
| `tool.color-picker` | 取色器 | 308 | 否 | `tool_color_picker` |
| `tool.api` | API 调试 | 309 | 否 | `tool_api` |
| `tool.docs` | 项目资料 | 310 | 否 | `tool_docs` |
| `tool.github` | GitHub 入口 | 311 | 否 | `tool_github` |

约束与行为：

- 新增 `dev` 分类（`CATEGORY_LABELS.dev = "开发者工具"`，位于 `task` 与 `device` 之间）；
- **全部 `defaultVisible: false`**：不因升级自动塞进工作台，用户可在管理页或工具页星标加入；
- 工具页星标直接调用 `commitEntryVisibility`，与管理页共用同一份配置、写队列与回滚逻辑，
  没有第二套收藏/入口机制；星标只是快捷方式，不改变注册表语义；
- 11 个入口都是 `availability: "available"` 且有真实页面；未完成能力（API 真实发送）
  仍以入口内「发送禁用 + 原因」呈现，不把入口标成不可用，因为编辑/历史/导入是真实可用的；
- 工具页「最近使用」来自 `tools.recent.v1`（上限 12，`recordToolUse` 写入，工具页常驻时
  通过 `subscribeRecentTools` 刷新），不是首页入口配置，不会影响 `workbench_entries`；
- API 调试的网络阻塞与评审记录见 [16-dev-tools-network-review.md](16-dev-tools-network-review.md)。

自动化验证：`src/lib/__tests__/entryRegistry.test.ts` 继续校验 id/order 唯一、图标存在、
分类有标签、可用入口有落点；`src/db/__tests__` 新增工具数据层 8 例。全量结果见验收报告。

## 11. 变更记录（续）

- 2026-11-16（第十一轮）：新增 11 个开发者工具入口与 `dev` 分类，全部默认隐藏；
  工具页改为真实入口 + 最近使用 + 星标加入工作台；管理页无需改代码即可显示新分类；
  入口注册表测试与全量 vitest 通过。真机验收与构建结果见
  `tmp/acceptance/mobile-dev-tools/report.md`。

## 12. 工具产品整改（2026-11-16 第十二轮，现行）

产品判断：手机上「也能做」不等于值得做。输入型、重编辑型工具（API 调试、正则、代码对比）
退出普通工具体系；JSON / 时间戳 / 编解码合并为低频「文本处理」；代码片段改为查看优先的
「常用片段」；GitHub 并入「资料与链接」。**稳定 id 不改名，旧配置安全迁移，数据库不删表。**

### 12.1 现行入口（5 个，全部默认隐藏）

| 入口 id | 标签 | order | 路由 | 定位 |
|---|---|---|---|---|
| `tool.snippet` | 常用片段 | 301 | `tool_snippets` | 查看 / 搜索 / 复制 / 分享优先，编辑在详情里 |
| `tool.image-compress` | 图片压缩 | 302 | `tool_image_compress` | 高优先级，真正重编码，不改扩展名伪装 |
| `tool.color-picker` | 取色器 | 303 | `tool_color_picker` | 读取真实像素，输出 HEX / RGB / HSL |
| `tool.docs` | 资料与链接 | 304 | `tool_resources` | 聚合项目资料与 GitHub 链接，只保存链接 |
| `tool.text` | 文本处理 | 305 | `tool_text` | 高级工具，聚合 JSON / 时间戳 / 编解码 |

`CATEGORY_LABELS.dev = "效率工具"`。已撤下且不再注册路由的 id：`tool.api`、`tool.regex`、
`tool.diff`；它们没有替代入口，旧配置中的这些项按失效项丢弃并计入 `dropped`。

### 12.2 旧配置迁移（不改稳定 id、不破坏历史）

`LEGACY_ENTRY_ALIASES`（`src/lib/entryLayout.ts`）：

| 旧 id | 新 id | 说明 |
|---|---|---|
| `tool.json` | `tool.text` | JSON 降级为文本处理内能力 |
| `tool.timestamp` | `tool.text` | 时间戳并入文本处理 |
| `tool.github` | `tool.docs` | GitHub 并入资料与链接 |

读取时先映射别名再校验可用性；别名命中不计 `dropped`，并令 `migrated=true`。
若旧配置同时含 `tool.json` 与 `tool.text`，去重后只剩 `tool.text`，顺序按首次出现保留。
API / 正则 / 代码对比仍按失效项清理（无别名），不会出现空白磁贴或死路由。

### 12.3 工具页信息架构（现行）

顺序：最近使用 → 常用操作（采集中心 / 快速笔记 / 文件互传 / 扫码配对）→ 图片与素材
（图片压缩、取色器、本机素材库、文件导入）→ 资料与内容（常用片段、资料与链接）→
高级工具（文本处理，低视觉优先级）。项目空间 / 功能看板 / 剪贴板 / 投屏占位已从工具页移除。

- 搜索只覆盖上表 5 个工具与真实快捷动作，不返回已撤下功能；
- 最近使用读取 `tools.recent.v1` 后用 `toolById` 过滤，旧 `tool.json` / `tool.api` 等记录自动消失；
- 从聚合页进入子页面时，子页面把最近使用记录归到父 id（文本处理 / 资料与链接）；
- 星标仍直接调用 `commitEntryVisibility`，与管理页共用同一份配置与写队列；
- 320–340dp 用 2 列，其余 4 列（`gridColumnsForWidth`），四个分区不会出现 3+1 挤压。

### 12.4 验收与构建

自动化：入口 / 迁移 / 响应式 / 目录契约测试见
`src/lib/__tests__/entryLayout.test.ts`、`entryRegistry.test.ts`、`responsiveLayout.test.ts`、
`src/features/tools/__tests__/toolCatalog.test.ts`。构建与真机结果以
`tmp/acceptance/mobile-tools-product-remediation/report.md` 为准（未写「通过」前不得视为已验证）。

## 13. 首页快捷入口横向轨道（2026-11-16 第十三轮，现行）

> 更正（2026-11-16）：§5 描述的「`WorkbenchEntryGrid` 固定列数网格」已被本节取代。
> 网格的 `flexWrap` 会在入口超过列数（窄屏 2 / 其余 4）时换行，320dp 窄屏下 4 个入口就是
> 两行，组件高度随入口数量增长。本节为当前实现；§5 的历史表述保留，不再作为现状。

### 13.1 问题与目标

改造前：`HomeScreen` 传 `columns={narrow ? 2 : 4}`，`WorkbenchEntryGrid` 用
`flexDirection: row + flexWrap: wrap`，单元格宽度 = `(内容宽 - gap×(列数-1)) / 列数`。
后果：入口 > 4 必然第二行；< 360dp 时 4 个入口排成 2×2；大屏上第 5 个入口明明放得下也被
强行换行；快捷入口区域的高度被入口数量牵着走，把「最近动态」不断挤出首屏。

目标：**任何数量都单行**。超出可用宽度才横向滚动；能完整放下时不产生无意义滑动。

### 13.2 结构（纯函数 + 视图两层）

| 层 | 文件 | 职责 |
|---|---|---|
| 几何 | `src/lib/entryRail.ts` | `railMetrics(可视宽度, 入口数, fontScale)` → 磁贴宽/高、步进、内容宽、是否溢出、最大偏移、完整可见数；`entryTileHeight` / `entryTileLineHeight` / `railMinTileWidth` / `clampRailOffset` |
| 落位 | `src/lib/entryReorder.ts` | `railDropIndex(from, dx, step, count)`（只看横向位移；原 `gridDropIndex` 随网格删除） |
| 视图 | `src/components/entry/WorkbenchEntryRail.tsx` | 横向 `ScrollView`、吸附、位置恢复、编辑态磁贴与手柄拖拽、动作表 |
| 磁贴 | `src/components/QuickTile.tsx` | 新增可选 `width` / `height` / `labelLineHeight`；不传时保持原 `flex:1` 行为 |

配置、注册表、持久化、导航全部沿用原有链路，**本轮没有新增第二套入口配置**：
`useEntryLayout()`（`lib/entryLayoutStore.ts`）→ `entriesForIds(layout.config.visible)`
→ 轨道按数组顺序渲染 → `entryTargetOf` 执行原来的 route / tab / createTask。

### 13.3 几何规则（可复算）

- 轨道可视宽度 = 实测宽度（`onLayout`），首帧用窗口宽度兜底——两帧都是单行，不会先出两行再变一行；
- 可视内容区 = 可视宽度 − 左右各 `space.lg`（16dp）内边距；
- 基准宽度 = 按「4 个并排」算：`(内容区 − 8×3) / 4`（4 只是基准除数，不是显示上限）；
- 溢出时（数量 > 4）从基准宽度再让出 `space.sm`（8dp），让第 5 个入口露出边缘作为滑动提示；
- 磁贴宽度夹在 `[60, 104]`，字体缩放 ≥ 1.25 时下限抬到 72；
- 是否滚动只由「内容宽 + 内边距 > 可视宽度」决定，与入口数量阈值无关。

实测几何（fontScale = 1，内边距 16dp/侧）：

| 可视宽度 | 入口数 | 磁贴宽 | 内容宽 | 是否滚动 | 最大偏移 | 首屏完整可见 |
|---|---|---|---|---|---|---|
| 320dp | 4 | 66 | 288 | 否 | 0 | 4 |
| 320dp | 5 | 60 | 332 | 是 | 44 | 4 |
| 360dp | 4 | 76 | 328 | 否 | 0 | 4 |
| 360dp | 5 | 68 | 372 | 是 | 44 | 4 |
| 393dp | 8 | 76 | 664 | 是 | 303 | 4 |
| 420dp | 8 | 83 | 720 | 是 | 332 | 4 |
| 800dp | 6 | 104 | 664 | 否 | 0 | 6 |
| 800dp | 8 | 104 | 888 | 是 | 120 | 6 |

高度：`max(78, 上下内边距 16 + 图标 24 + 图标间距 6 + 行高×2)`；行高 = `round(12×1.2×fontScale)`。
fontScale 1 → 78；1.3 → 84；2 → 104。**入口数量不参与高度计算**。

### 13.4 交互

- 滚动：`ScrollView horizontal`（平台原生惯性、边缘停止、与首页纵向滚动方向锁），
  `showsHorizontalScrollIndicator={false}`；1~4 个且放得下时不启用吸附；
- 吸附：`snapToInterval = 磁贴宽 + 8`、`snapToAlignment="start"`、`decelerationRate="fast"`；
  不启用 `disableIntervalMomentum`，快速连续滑动可以一次跨多个入口；
- 末尾：内容尾部保留 16dp 内边距，滚到底时最后一个入口完整可见（`railMetrics` 单测守护）；
- 位置恢复：上次偏移存在模块内存（`rememberedRailOffset`，不写库、不绑定配置）；
  回到首页时恢复到该位置；入口减少 / 屏幕变宽导致越界时用 `clampRailOffset` 收敛；
- 编辑态：磁贴右上 × 直接移除；点磁贴弹「前移 / 后移 / 移除」动作表（读屏用户的替代路径）；
  只有右下角六点手柄接 `PanResponder`（`onStartShouldSetPanResponderCapture`），
  拖动时松手按 `railDropIndex` 落位；磁贴本体不接管手势，长轨道里后半段入口仍可滑到。

### 13.5 与既有入口自定义的兼容

| 能力 | 现状 |
|---|---|
| 显示 / 隐藏 | `commitEntryVisibility` → 轨道按 `visible` 重排，移除项不占位；全部隐藏仍走原空态（全部功能 / 恢复默认） |
| 自定义排序 | 轨道顺序 = `visible` 数组顺序；首页拖拽/动作表与管理页拖拽都写同一份配置（`commitEntryOrder` 串行写队列） |
| 持久化 | kv `workbench_entries` 未变；schema、迁移别名、`known` 合并规则未改 |
| 导航 | `entryTargetOf` 未改；route / tab / createTask 三种落点行为不变 |
| 管理页 | 仍为纵向列表 + 行拖拽（`settleReorder`），未强制改成横向 |
| 数量边界 | 空配置 → 空态；1 个 → 单行不滚；4→5、10→2、快速连改 → 由 `visible` 重算，位置越界自动收敛 |

### 13.6 全局一致性审计

| 区域 | 是否同语义 | 处理 |
|---|---|---|
| 工具页「常用操作 / 最近使用」 | 否：整页工具目录的一部分，需要纵向浏览与搜索 | 不改（`ToolsScreen` 的最近使用本来就是横向 chip 条） |
| 工作区「我的工作区」宫格 | 否：占位能力清单，不是可配置的轻量入口 | 不改 |
| 采集页分享动作、表单动作行 | 否：一次操作的动作按钮组，不是入口集合 | 不改 |
| 任务 / 笔记 / 诊断日志 / 文件列表 | 否：按顺序阅读的长列表 | 不改 |

结论：只有首页「快捷入口」是「可配置的轻量入口集合」，复用范围限定在该组件，没有把卡片列表批量改成横向。

### 13.7 自动化

`src/lib/__tests__/entryRail.test.ts` 覆盖 280/320/360/393/412/420/430/600/800/1024dp ×
1/2/3/4/5/6/8/10/16/24 个入口：单行、溢出判定、磁贴宽上下限、末尾完整可见、空配置、
异常输入、字体缩放高度与最小宽度、偏移收敛。`entryReorder.test.ts` 改为 `railDropIndex`。
运行结果见 `tmp/acceptance/mobile-entry-rail/report.md`（未执行前不得视为已验证）。