# 全局按需加载架构（On-demand Loading）

> 状态：**已实施（2026-11-18）**。范围：桌面端主窗口 + 唯一大型工作台。
> 代码事实源：`src/lib/featureRuntime.ts`（生命周期）、`src/lib/featureRegistry.ts`（代码入口与策略）、
> `src/components/feature/FeatureView.tsx`（页面级加载/重试/实例策略）。
> 本文是新增功能的**强制规范**；与本文件冲突的实现视为缺陷。

## 1. 目标与判据

**目标**：TaskDock 可以拥有很多功能，但启动耗时、内存、CPU 与后台活动只应与
**用户实际使用的功能数量**相关，而不是与功能总数相关。

**四个必须分开的概念**（混为一谈会做出「假按需加载」）：

| 概念 | 含义 | 现状实现 |
| --- | --- | --- |
| 导航项隐藏 | 入口不出现在侧栏/胶囊 | `navVisibility` + `navigation_layout` 设置 |
| 页面代码未加载 | 页面 JS 还没被下载/解析 | `FeatureView` + `featureRuntime.loadFeature` |
| 页面业务数据未加载 | 没发该页面的查询 | 各面板挂载/可见时才请求 |
| 页面后台服务未启动 | 没有长连接/轮询/Worker | 由模块在用户操作时初始化（Rust 命令或控制器） |

**不变式**

1. 导航渲染只读元数据，**不得** import 页面组件（`navigationRegistry` 只依赖图标与类型）。
2. 未访问过的页面：代码不下载、不挂载、不发请求。
3. 已访问过的页面：代码缓存复用；实例是否保留由策略决定，但**后台活动必须随可见性停止**。
4. 隐藏入口不等于禁止访问：搜索/深链/快捷键/「更多」菜单仍可进入。

## 2. 现状审计（2026-11-18，改造前）

### 2.1 结论摘要

- 导航层**已经是**元数据驱动（`navigationRegistry` 仅有 ID/图标/顺序/默认显隐），没有
  「为生成导航而初始化所有页面」的问题；侧栏与胶囊共用同一条目，`RAIL_ORDER`/`TAB_ORDER`
  只作为已发布顺序与快捷键的**契约校验**，不构成第二份功能注册；调整排序只改渲染顺序，
  功能 ID 与代码入口不变；
- 代码层**部分按需**：工作台 14 个路由已用 `React.lazy`，但 6 个页面（任务/生活/Agent/
  行动/剪贴板/收集与暂存）是静态 import；主窗口 4 个页面同样静态 import；
- 数据层**大体正确**：页面数据由面板自取，`History`/`ActionCenter`/`Resource`/`Files`
  已按可见性门控；`Tasks`/`Agents` 是**全局核心服务**（胶囊、统计、徽标共用），不属于页面私有数据；
- 重型能力**不在前端**：没有 JS 图像/视频/OCR 引擎；ADB/Scrcpy/文件扫描/索引/剪贴板采集
  都由 Rust 命令在用户操作时启动，前端只持有页面级会话（投屏控制器、文件任务订阅）；
- 真正的缺陷是：**缺少统一生命周期与可观测性**，导致「哪些页面已加载/初始化几次/是否重复加载」
  无法回答；且 `React.lazy` 的失败 Promise 被永久缓存，页面加载失败后**无法真正重试**。

### 2.2 量化基线（`dist` 首屏 JS，Vite modulepreload 闭包）

| 窗口 | 首屏 chunk | 首屏 JS（raw） | 首屏 JS（gzip） | 最大共享 chunk |
| --- | --- | --- | --- | --- |
| 主窗口 `index.html` | 28 | 2247.6 kB | 685.1 kB | 895.6 kB（`global-search`） |
| 工作台 `workspace.html` | 16 | 1985.5 kB | 599.2 kB | 895.6 kB（同上） |
| 快速捕获 `capture.html` | 8 | 912.6 kB | 268.3 kB | 847.9 kB（React 运行时） |

改造前 `global-search` 这个 895.6 kB 的共享 chunk 把 6 个页面的代码与图标一并带进了两个窗口的
首屏（因为静态 import 让它们成为入口图的依赖）。

### 2.3 问题清单

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P0 | 加载失败无法重试（`React.lazy` 永久缓存拒绝） | 改用 `featureRuntime` 的 Promise 缓存 + `FeatureView` 重试 |
| P0 | 6 个工作台页面 / 4 个主窗口页面随启动进入首包 | 全部改为注册表驱动的动态 import |
| P1 | 无生命周期与指标：无法回答「初始化几次/是否重复」 | 新增 runtime + 诊断中心分区 |
| P1 | 隐藏页面仍挂载时，缺少统一的「暂停」语义 | `WorkbenchPageActiveContext` + runtime `active/suspended` |
| P1 | 设置页「手机同步」与手机互传的设备轮询只判 `document.hidden`，切到其它页面仍 1–3s 一次 | 改为 `useFullViewVisible()` 门控（页面不可见即不建立轮询） |
| P2 | 无可控预加载（悬停/空闲） | 悬停 + 受限空闲预加载（只取代码） |
| P2 | 页面实例只增不减 | 注册表 `instance: release` 策略（只读工具页） |

## 3. 四层架构

### 3.1 第一层：导航元数据

- `src/lib/navigationRegistry.ts`：稳定 ID、图标、顺序、默认显隐、快捷键说明、徽标口径；
- 用户配置：`navigation_layout`（SQLite）→ `useNavigationLayout` 合并默认值；
- **禁止**在导航文件里 import 页面组件；新增入口只登记元数据。

### 3.2 第二层：页面代码

- `featureRegistry.ts` 为每个页面登记 `load: () => import(...)`（静态字面量，保证可拆包）；
- `FeatureView` 在**首次可见**时调用 `loadFeature`：并发请求复用一个 Promise，成功后缓存模块；
- 加载中显示 `.panel-loading` 占位；失败显示原因 + 重试（`retryFeature`）；
- 加载占位只属于当前可见页；加载途中切页立即隐藏旧占位，重新进入复用在途请求或已完成缓存
  （2026-11-19：避免旧页占位出现在新页内容上方，造成页面仍在加载的错觉）；
- 二次进入：模块已缓存 → 首帧直接渲染内容，不出现 loading 闪烁。

### 3.3 第三层：业务数据

- 页面数据由面板自己负责，外壳**不预取**任何业务数据；
- 页面通过 `useFullViewVisible()` / `useWorkbenchPageActive()` 获得真实可见性，
  隐藏时停止轮询/订阅，恢复时补一次刷新；
- 缓存与去重属于数据层职责（如 `useAsyncResource` 的在途合并）；按需加载**不得**改变
  数据一致性：不得为了省一次请求而展示过期数据。

### 3.4 第四层：重型能力

- 前端没有媒体引擎；重型能力（ADB/Scrcpy/文件扫描/索引/OCR/剪贴板采集）由 Rust 命令在
  **用户操作时**启动，进程内常驻由设置开关与模块生命周期管理，不随页面显隐启停；
- 页面级会话（投屏窗口控制器、文件任务订阅）由页面在用户操作时建立，离开页面时释放；
- 前端 `featureRuntime` 提供 `dispose` 钩子用于功能级资源（连接/Worker/监听器），
  **不替代** Rust 侧的资源管理。

## 4. 生命周期

```text
unregistered → registered → loading → loaded → activating → active
                   ↑            └── failed ──┘        ↓
                   └──────────── retry ────────── inactive ⇄ suspended
                                                        ↓
                                              disposing → disposed
```

| 方法 | 职责 | 谁调用 |
| --- | --- | --- |
| `registerFeature` | 登记 ID/代码入口/等级/缓存/预加载策略；**不 import** | 窗口入口 `installFeatureRegistry()` |
| `loadFeature` | 去重 import、缓存模块、记录耗时、失败记录 | `FeatureView` / `preloadFeature` |
| `retryFeature` | 仅失败态重新 import（成功后清错误） | `FeatureView` 重试按钮 |
| `activateFeature` | 未加载先加载；标记 active（幂等） | `FeatureView`（代码就绪后） |
| `deactivateFeature` | 离开可见态 → inactive（保留实例与状态） | `FeatureView`（active 变 false） |
| `suspendFeature` / `resumeFeature` | 暂停/恢复（窗口不可见、长时间离开） | 页面/服务按需调用 |
| `noteFeatureInstanceReleased` | 记录页面实例被卸载（`release` 策略） | `FeatureView` |
| `disposeFeature` | 释放**功能级**资源（连接/Worker/监听器） | 功能所有者显式调用 |
| `preloadFeature` | 策略允许且无其他加载在飞时预取代码 | 导航悬停/聚焦、受限空闲 |

**关键区分**：`deactivate` ≠ `dispose`；页面组件卸载 ≠ 功能服务销毁。共享核心服务
（任务/Agent/剪贴板采集/微件桌面桥）不因页面离开而停止。

## 5. 功能与策略矩阵

等级：`heavy` 首包大或含长连接/大列表；`standard` 普通业务页；`light` 轻量页。
实例：`keep` 离开后保活（草稿/滚动位置不丢）；`release` 离开即卸载实例（只读工具页）。

| 功能 ID | 入口 | 等级 | 实例 | 预加载 | 数据/资源要点 |
| --- | --- | --- | --- | --- | --- |
| `page:workbench` | 开发工作台 | heavy | keep | hover | 项目上下文、任务快照；离开停止刷新 |
| `page:workspace` | 工作空间 | heavy | keep | hover | 项目/开发项目列表；有未保存草稿保护 |
| `page:files` | 文件工作区 | heavy | keep | hover | 目录列表挂载即读；**可见时**才轮询（2s） |
| `page:tasks` | 任务 | standard | keep | **idle** | 全局 `useTasksStore`（核心服务，启动加载） |
| `page:life` | 生活 | standard | keep | hover | 挂载时加载 |
| `page:vault` | 安全保险箱 | heavy | keep | hover | 挂载时按需解锁，不预取密文 |
| `page:agents` | Agent | heavy | keep | hover | 全局 `useAgentsStore` + 事件驱动 |
| `page:apps` | 应用 | standard | keep | hover | 挂载时扫描/读取 |
| `page:widgets` | 微件 | standard | keep | hover | 页面只配置；桌面窗口由 `WidgetDesktopBridge` 常驻管理 |
| `page:actions` | 行动 | standard | keep | hover | 可见时聚合（`useFullViewVisible` 门控） |
| `page:clipboard` | 剪贴板 | light | keep | hover | 页面/抽屉 active 时订阅，二者互斥 |
| `page:mobile` | 手机互传 | heavy | keep | hover | 设备/会话轮询仅在页面可见时建立（用户操作时才 attach 投屏） |
| `page:collection` | 收集与暂存 | standard | keep | hover | 子页挂载时加载，同一时刻只挂一个子页 |
| `page:workflows` | 工作流 | heavy | keep | hover | 挂载时加载 |
| `page:history` | 历史 | standard | **release** | hover | 可见时刷新；筛选会随实例释放重置 |
| `page:roadmap` | 规划中心 | heavy | keep | hover | 挂载时加载 |
| `page:capability` | 能力中心 | heavy | **release** | hover | 只读知识列表 |
| `page:settings` | 设置 | heavy | keep | hover | 表单草稿必须保活；手机同步分区仅在可见时轮询 |
| `page:help` | 帮助 | light | **release** | hover | 只读 |
| `page:diagnostics` | 诊断中心 | standard | **release** | hover | 本页含加载运行态视图 |
| `page:resource` | 资源管理 | heavy | **release** | hover | 可见时才采样趋势（`useResourceTrend`） |

> `home` 是工作台外壳的一部分，不是独立页面功能；它常驻渲染（默认视图）。

## 6. 缓存与预加载

**代码缓存**：模块对象按 ID 缓存，生命周期等于窗口。JS 模块无法真正卸载，因此「清除缓存」
没有意义；控制成本靠**限制进入过的页面数**与**实例策略**，而不是清模块表。

**实例缓存**：

- `keep`：已访问页面保留实例（草稿、滚动、局部状态）；
- `release`：离开即卸载（下次进入由模块缓存直接重建，无 loading 闪烁）；
- 不使用 LRU 强制淘汰保活实例：那会在用户无感知时丢失编辑内容，属于功能回归。

### 6.1 为什么不做 LRU 淘汰 / 定时过期

| 机制 | 现状 | 原因 |
| --- | --- | --- |
| 代码缓存上限 | 等于「本窗口进入过的页面数」 | JS 模块无法卸载；清表只会让下次重新下载，不释放内存 |
| 代码过期 | 不做 | 本地资源随应用版本更新，不存在「服务端旧数据」问题 |
| 实例 LRU | 不做 | 淘汰保活实例会静默丢失编辑内容/滚动位置（功能回归） |
| 内存压力释放 | `disposeFeature`（功能级资源）+ `release` 策略 | 页面隐藏时先停后台活动，通常已消除主要压力；真正的泄漏必须在真机采样定位 |
| 最近使用时间 | 记录 `lastActivatedAt` | 仅用于诊断；未来若引入淘汰策略，必须先证明「丢弃该页状态」是可接受的 |

**结论**：约束成本的手段是「不加载」与「隐藏即停」，不是「加载后再淘汰」。

**预加载规则**

| 时机 | 是否允许 | 约束 |
| --- | --- | --- |
| 悬停/聚焦导航项 | 允许（`preload: hover`） | 只取代码；划过隐藏按钮不触发 |
| 空闲 | 仅 `page:tasks`（1 个） | `requestIdleCallback`（timeout 5s），启动门完成后一次 |
| 有加载在飞 | 跳过 | 不与用户真正需要的页面抢资源 |
| 预加载失败 | 冷却 30s | 不重试风暴；不影响正常导航 |
| 重型服务 | **禁止** | 预加载绝不初始化连接/Worker/设备会话 |

## 7. 资源所有权

| 层级 | 资源 | 所有者 | 释放责任 |
| --- | --- | --- | --- |
| 页面级 | 定时器、事件监听、页面订阅、局部状态 | 页面组件 | `useEffect` 清理；隐藏时按 `active` 暂停 |
| 功能级 | 数据服务、文件任务订阅、投屏会话、长连接 | 功能模块 | 用户结束操作或 `disposeFeature` |
| 全局 | 设置/任务/Agent store、事件总线、剪贴板采集、微件窗口 | App 外壳 / Rust | 进程生命周期；由设置开关控制，不随页面启停 |

**禁止**：切页导致监听器累积；重复创建同一后台服务；隐藏页面持续计算；定时器不清理；
Worker 不释放；已关闭的设备连接仍占资源；多个页面各起一套同一服务。

**常驻例外**（不得因页面隐藏而停止）：Agent 事件接入与快照、任务提醒调度、剪贴板采集、
微件桌面窗口、文件监控/后台任务。

## 8. 诊断与指标

入口：诊断中心 →「按需加载（页面模块）」（`FeatureLoadSection`，只读内存，不写日志、不轮询）。

| 指标 | 口径 |
| --- | --- |
| 已加载页面 / 总数 | 本窗口内 `loads > 0` 的功能数 |
| 当前活动 | `state === active` 的功能数（正常 ≤ 1） |
| 合并的重复请求 | `loadRequests − loadExecutions`（正常为 0，变大说明绕过了 runtime） |
| 首次加载耗时 | 单次 `import()` 的 `performance.now()` 差值 |
| 加载/激活/释放 | 每个页面的 `loads` / `activations` / `instanceReleases` |
| 最近事件 | 40 条环形缓冲（register/load/failed/retry/activate/suspend/release…） |

持久化日志只写两类：**加载失败**（WARN，带 feature ID）与**慢加载 ≥ 1s**（INFO，带耗时）。
正常加载不写日志，避免生产环境日志膨胀。

## 9. 新增功能检查清单（强制）

新增页面/功能时，必须在 PR/交付说明中回答：

1. 页面代码何时加载？（默认：首次可见；不要在入口静态 import）
2. 业务数据何时获取？（默认：挂载/可见时；说明是否需要跨页缓存）
3. 重型服务何时初始化？（默认：用户触发操作时；说明依赖与失败行为）
4. 页面离开后如何处理？（`keep` 还是 `release`；隐藏时哪些轮询/订阅必须停）
5. 后台资源由谁管理？（页面/功能/全局；写出释放点）
6. 是否需要缓存？（数据缓存键与失效条件；不要缓存会过期的敏感数据）
7. 是否允许预加载？（默认 `hover`；`idle` 需要证明高概率且成本低）
8. 如何释放资源？（定时器/监听器/Worker/连接各自的清理代码位置）

**代码步骤**

```ts
// 1) src/lib/featureRegistry.ts 追加定义（load 必须是静态字面量 import）
{
  id: "page:reports",
  label: "报表",
  load: () => import("../components/reports/ReportsPanel"),
  tier: "standard",
  instance: "keep",   // 有草稿/滚动位置 → keep；只读工具页 → release
  preload: "hover",
}
// 2) 路由槽使用统一入口（不要直接 import 页面）
<RouteSlot label={...} id="reports" feature="page:reports" active={route === "reports"}>
  {(Panel) => <Panel />}
</RouteSlot>
```

**验收门槛**

- `featureRegistry.test.ts`：路由全覆盖、ID 唯一、`idle` 至多一个、`release` 白名单；
- 页面隐藏时必须停止自己的轮询/订阅（用 `useFullViewVisible` / `useWorkbenchPageActive`）；
- 不得为「省一次请求」破坏数据一致性；不得把常驻服务错误地跟随页面停止。

## 10. 验收方法与证据

```bash
# 首屏 JS 体积（对比不同产物目录）
node scripts/on-demand-audit.mjs dist-audit-before
node scripts/on-demand-audit.mjs dist

# 单元/契约/稳定性测试
npx vitest run src/lib/featureRuntime.test.ts src/lib/featureRegistry.test.ts \
  src/components/feature/FeatureView.test.tsx \
  src/components/feature/FeatureSwitchStability.test.tsx
```

实测数据、未验证项与限制见 [ON_DEMAND_LOADING_ACCEPTANCE.md](ON_DEMAND_LOADING_ACCEPTANCE.md)。

## 11. 已知边界

1. **JS 模块不可卸载**：代码缓存随窗口存活；「释放」只作用于实例与功能级资源。
2. **`release` 会重置页面内筛选/滚动**：只用于只读工具页，且已列入白名单；有编辑态的页面
   一律 `keep`，避免静默丢草稿。
3. **React StrictMode（仅开发）会让 activate/deactivate 计数略高**：生产构建不双调用 Effect，
   指标以 release/正式包为准。
4. **内存/句柄的真实泄漏**必须在真机（Windows release）采样；jsdom 只能证明代码与实例层不变量，
   不能替代 RSS 曲线。
5. **多窗口独立**：每个 WebView 有独立 runtime 与指标，诊断中心只显示当前窗口。
