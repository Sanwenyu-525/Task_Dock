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
| 工作台（`HomeScreen`） | 默认首页 | 按 `visible` 渲染 `WorkbenchEntryGrid`；`SectionHeader` 右侧「管理」；长按磁贴进入编辑态；空态给「全部功能 / 恢复默认」 |
| 编辑态（`WorkbenchEntryGrid`） | 长按磁贴 | 磁贴抖动 + 右上角 × + 右下角拖动手柄；轻点开动作表（上移/下移/移除）；拖拽改为「松手落格」；右上角「完成」退出 |
| 入口管理页（`EntryManagerScreen`, 路由 `entry_manager`） | 工作台「管理」 | SegmentedControl「布局管理 / 全部功能」；已显示（拖动手柄 + ×）/ 未显示（+）/ 暂不可用（原因 + Badge）；搜索；批量模式 + BulkActionBar；恢复默认；Toast 反馈 |
| 全部功能页（`EntryManagerScreen`, 路由 `all_features`） | 管理页页签、工作台空态 | 按分类分组展示全部入口，区分三态，可点开可用入口，暂不可用点开只提示原因 |

拖拽不抢页面滚动：编辑态时工作台 `ScrollView` 关闭滚动（`entryDragActive`），
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
| `src/lib/__tests__/entryReorder.test.ts` | 网格落格/列表换位/轻点判定的边界与异常输入 |
| `src/db/__tests__/entryLayout.test.ts` | 真实 SQLite 往返、损坏恢复、旧版本迁移、已删除入口清理、读失败标记 |
| `src/lib/__tests__/entryLayoutStore.test.ts` | 单飞加载、串行写不互相覆盖、重启一致性、恢复默认 |

组件级（渲染）测试在本仓库不可行：`vitest.config.ts` 是 `environment: "node"`，
未安装 jsdom 与 `@testing-library/react-native`。因此界面部分以真机验收为准，
证据在 `tmp/acceptance/mobile-entry-customization/`。

## 9. 变更记录

- 2026-11-15：新建。工作台入口注册表 + 配置 + 管理页 + 全部功能页 + 长按编辑；
  同时把 `HomeScreen` 里写死的 `quickEntries` 与「AI 助手」降饱和占位磁贴移出工作台
  （后者归入暂不可用，理由：移动端没有 AI 对话与执行链路）。
- 2026-11-15（真机验收）：release APK（versionCode 61 / 0.1.13）装在物理机
  `192.168.5.7:41789` 上逐项验证——隐藏后冷启动仍只显示两枚磁贴、搜索加回并可跳转「文件互传」、
  管理页与编辑态两种拖拽顺序在冷启动后保持、全部隐藏后空状态（全部功能 / 恢复默认）可用、
  暂不可用不可添加且点击只提示不跳转、批量添加与移除、自动保存提示。受限项：真机「旧配置升级」
  无法复现（release 不可注入旧 JSON、无旧版包，迁移仅单测覆盖）、两端隔离缺桌面端运行时对照。
  证据：`tmp/acceptance/mobile-entry-customization/report.md` §10 与同目录 `shots/`。
