# 按需加载改造：验收报告（2026-11-18）

> 规范与设计见 [ON_DEMAND_LOADING.md](ON_DEMAND_LOADING.md)。
> 本报告只写**实际执行**过的命令、真实输出与未执行项；没有真机数据的指标明确标注，
> 不用代码里出现 `import()` 代替证据。

## 1. 结论

- 主窗口与工作台的**所有路由页面**已改为首次可见时动态加载，页面代码入口集中到
  `src/lib/featureRegistry.ts`，统一生命周期在 `src/lib/featureRuntime.ts`；
- 首屏 JS（Vite modulepreload 闭包）实测下降：主窗口 **−230.9 kB raw / −57.0 kB gzip**，
  工作台 **−447.5 kB raw / −126.6 kB gzip**；
- 页面加载失败**可以真正重试**（原 `React.lazy` 会把失败 Promise 永久缓存）；
- 30 次连续切页：每个页面只 import 一次、同时只有一个 active、保活页草稿不丢（自动化测试）；
- 启动耗时、TTI、空闲内存需要真实 release 包与独立机器采样，本次**未执行**（见 §5）。

## 2. 改动清单

### 2.1 新增

| 文件 | 作用 |
| --- | --- |
| `src/lib/featureRuntime.ts` | 功能生命周期、加载去重、失败重试、预加载门控、指标与 40 条事件环 |
| `src/lib/featureRegistry.ts` | 20+ 页面的唯一代码入口与策略（tier/instance/preload） |
| `src/components/feature/FeatureView.tsx` | 页面级加载占位、失败重试、keep/release、active 上报 |
| `src/components/diagnostics/FeatureLoadSection.tsx` | 诊断中心「按需加载」分区（内存快照） |
| `src/lib/featureRuntime.test.ts` | 状态机/去重/重试/依赖/预加载/快照稳定性（10 例） |
| `src/lib/featureRegistry.test.ts` | 路由全覆盖、ID 唯一、idle≤1、release 白名单（7 例） |
| `src/components/feature/FeatureView.test.tsx` | 加载/重试/二次进入/keep/release（5 例） |
| `src/components/feature/FeatureSwitchStability.test.tsx` | 连续 30 次切页稳定性（1 例） |
| `scripts/on-demand-audit.mjs` | 首屏 JS 体积审计（可复现口径） |
| `docs/ON_DEMAND_LOADING.md` | 架构规范 + 策略矩阵 + 新增功能检查清单 |

### 2.2 修改

| 文件 | 改动 |
| --- | --- |
| `src/workbench/WorkbenchShell.tsx` | 14 个 `lazy()` + 6 个静态页面 → 统一 `RouteSlot feature="page:*"`；导航 hover/focus 预加载；受限空闲预加载 |
| `src/components/FullView.tsx` | Agent/行动/剪贴板/收集与暂存/设置 → `FeatureView`（任务页保留同步加载）；导航 hover/focus 预加载 |
| `src/main.tsx`、`src/workspace/workspaceEntry.tsx` | 渲染前 `installFeatureRegistry()`（只登记元数据） |
| `src/components/diagnostics/DiagnosticsCenterPanel.tsx` | 健康概览后插入按需加载分区 |
| `src/components/settings/MobileSyncSection.tsx` | 设备/文件轮询改为页面可见才建立（原只看 `document.hidden`，切页后在后台继续 3s/15s 轮询） |
| `src/components/mobile/VirtualDisplaySection.tsx` | 设备/会话轮询（1–3s）与工具链重试改为页面可见才建立 |
| `src/styles.css` | `.panel-status`（加载失败卡片）与诊断表样式 |
| `src/locales/zh-CN/index.ts`、`en-US/index.ts` | `nav.loadFailed` + 诊断分区词条 |
| `docs/ARCHITECTURE.md`、`docs/DEVELOPMENT.md`、`AGENTS.md` | 架构章节、审计命令、红线第 10 条与任务路由 |
| `src/components/workbench/DevWorkbenchPanel.tsx` | **修复仓库既有语法错误**（`else` 块缺一个闭合 `}`，HEAD 上 `tsc` 直接失败、无法构建）。属跨任务既有缺陷，仅补语法，不改逻辑 |

### 2.3 与并行任务的合并

- `WorkbenchShell.tsx` 在我改造期间被另一任务加入了「安全保险箱」入口与静态 `VaultPanel` 导入。
  我保留该功能，并把它的路由槽同样改为 `feature="page:vault"`（注册表登记 + 动态 import），
  避免新功能绕过规范；未改动其面板实现。
- `navigationRegistry.ts` 中「规划中心 → 项目中枢」改名与 `vault` 入口、`ProjectHubPanel`
  等改动来自其他任务，未纳入本次范围。

## 3. 首屏体积（实测）

命令（同一份 `vite.config.ts`，仅输出目录不同）：

```bash
node scripts/build-sched.mjs run --priority P1 --label ondemand-baseline -- npx vite build --outDir dist-audit-before
node scripts/build-sched.mjs run --priority P1 --label ondemand-after    -- npx vite build --outDir dist-audit-after
node scripts/on-demand-audit.mjs dist-audit-before
node scripts/on-demand-audit.mjs dist-audit-after
```

> 两个 `dist-audit-*` 目录在测量后已删除（可随时用上面命令重建）。
> `npm run build`（tsc + vite）中的 `tsc --noEmit` 已通过；随后 vite 清理**已存在的**
> `dist/assets`（137 个文件）时被环境的批量删除保护拦下
> （`[safe-delete] SAFE_DELETE_BULK_CONFIRM_REQUIRED`），属环境限制而非代码错误：
> 同一份配置输出到新目录的构建成功（`✓ built in 9.16s`，最终代码状态复测）。

| 窗口 | 指标 | 改造前 | 改造后 | 变化 |
| --- | --- | --- | --- | --- |
| 主窗口 `index.html` | 首屏 JS（raw） | 2247.6 kB | 2016.8 kB | **−230.8 kB（−10.3%）** |
| 主窗口 | 首屏 JS（gzip） | 685.1 kB | 628.2 kB | **−56.9 kB（−8.3%）** |
| 工作台 `workspace.html` | 首屏 JS（raw） | 1985.5 kB | 1538.0 kB | **−447.5 kB（−22.5%）** |
| 工作台 | 首屏 JS（gzip） | 599.2 kB | 472.6 kB | **−126.6 kB（−21.1%）** |
| 两者共用的最大共享 chunk | raw / gzip | 895.6 / 274.0 kB | 480.6 / 156.6 kB | **−415.0 kB** |

页面代码已独立成块（改造后产物中可直接核对）：

| 页面 | 独立 chunk |
| --- | --- |
| AgentPanel | 80.2 kB |
| TasksPanel | 74.9 kB |
| CollectionPanel | 158.5 kB |
| LifePanel | 27.0 kB |
| ActionCenterPanel | 16.7 kB |
| VaultPanel（并行任务新增） | 48.2 kB |

**诚实说明**

- 产物 JS 总量 3482.3 → 3603.3 kB（+121 kB）。原因不是重复打包页面，而是同一时段并行任务
  新增了 `VaultPanel`（48 kB）与项目中枢相关代码（`PlanningCenterPanel` 100→142 kB）；
  本次改造范围内的页面均已移出首屏。
- 首屏 chunk 数 28 → 50（主窗口）。这是共享模块被拆细的结果：总字节数下降，但请求数增加。
  Tauri 从本地资源加载，未观察到功能影响；后续若请求数成为瓶颈，可再合并 vendor chunk。
- 未做 `manualChunks` 调优：那会改变第三方依赖的分包策略，超出「按需加载」范围。

## 4. 功能与稳定性验收

### 4.1 自动化测试（实际执行）

```bash
npx vitest run src/workbench src/components/feature \
  src/lib/featureRuntime.test.ts src/lib/featureRegistry.test.ts
# → Test Files 34 passed (34)；Tests 255 passed (255)

npx vitest run src/components/mobile src/components/settings/MobileSyncSection.test.tsx
# → Test Files 7 passed (7)；Tests 54 passed (54)（含新增「页面不可见不轮询」用例）

# 合并复跑（按需加载 + 工作台 + 手机/设置）
npx vitest run src/workbench src/components/feature src/lib/featureRuntime.test.ts \
  src/lib/featureRegistry.test.ts src/components/mobile src/components/settings/MobileSyncSection.test.tsx
# → Test Files 41 passed (41)；Tests 310 passed (310)

npx vitest run src/components/FullView.test.tsx \
  src/components/FullView.navigationContract.test.tsx src/components/FullView.boundary.test.tsx
# → 22 passed / 8 failed：8 条全部是并行任务「规划中心→项目中枢」改名与新增 `vault` 入口
#   造成的标签/数量断言（`/^规划中心/`、`Roadmap`、入口数 20→21），详见 §6；
#   与本次改动无关——改造前这些用例匹配的是旧标签，边界恢复/页面切换用例均通过
```

覆盖到的行为：

| 验收项 | 证据 |
| --- | --- |
| 启动只加载导航元数据 | `navigationRegistry` 无页面 import（代码审计）+ 首屏体积实测 |
| 未访问页面不初始化 | 首屏 chunk 中不再包含 Agent/Collection/Life/Action 等页面代码 |
| 首次进入动态加载 | `FeatureView.test.tsx`「首次进入显示加载占位，代码就绪后渲染页面」 |
| 二次进入复用 | 同上「二次进入复用已加载代码」：loader 仅 1 次、无 loading 帧 |
| 加载失败可重试 | 同上「加载失败给出原因与重试，重试后成功」：attempts = 2 |
| 隐藏 Tab 不影响功能 | `FullView.test.tsx` 导航显隐用例（通过） |
| 拖拽排序/名称/恢复 | `WorkbenchShell.dragSort`、`FullView` 排序用例（通过） |
| 30 次切页 | `FeatureSwitchStability.test.tsx`：每页 `loadExecutions=1`、`active=1`、草稿保留、事件环 ≤40 |
| 实例释放 | `FeatureView.test.tsx`「release 策略」：离开即卸载且 `instanceReleases=1`，再进入不再 import |
| 隐藏页面停止后台轮询 | `MobileSyncSection.test.tsx`「页面不可见时不发起设备状态与文件列表轮询」；`VirtualDisplaySection` 投影轮询同样改为 `useFullViewVisible()` 门控（既有 54 条手机/设置测试全通过） |

### 4.2 并发与竞态

| 场景 | 处理 |
| --- | --- |
| 连续点击同一页面 | `loadFeature` 用 `inFlightLoads` 复用同一个 Promise（`loadRequests−loadExecutions` 计数可见） |
| 加载中切走页面 | effect 的 `alive` 标记丢弃过期结果；模块仍写入缓存，回来时直接就绪 |
| 加载失败后切走再回来 | `active` 变化触发 effect 重新加载（隐式重试一次），也可点重试 |
| 两次进入同一页面 | 模块命中缓存，首帧直接渲染内容（无 loading 帧） |
| 多个页面同时请求 | 各自独立 ID，互不阻塞；预加载在有加载在飞时让路 |

### 4.3 未执行的验收（环境限制）

| 项 | 状态 | 原因 / 复现方式 |
| --- | --- | --- |
| 软件启动耗时（进程 → 可交互） | **未执行（ENVIRONMENT BLOCKED）** | 需 release 包在独立桌面会话运行并读 `__TASK_DOCK_BOOT__.stages`；当前仓库被多个任务并行修改，启动测量会干扰他人验收 |
| 首屏可交互时间（TTI） | **未执行** | 同上；需 DevTools Performance 或原生探针 |
| 首次/二次进入页面墙钟耗时 | **未执行** | jsdom 的 import/render 时间不代表 WebView2；已给出「import 次数」结构性证据 |
| 空闲内存 / 30 次切页 RSS 曲线 | **未执行** | 需真机进程采样（`docs/PERFORMANCE_TESTING.md` 口径）；jsdom 无进程级内存 |
| 重型服务初始化次数（Rust 侧） | **未执行** | ADB/Scrcpy/文件索引在 Rust，需真机操作设备；前端侧只能证明「页面代码加载不触发服务」 |

复现建议：用集成快照构建 release 包 → 启动后读 `__TASK_DOCK_BOOT__`（modules/mounted/settings）
→ 依次进入 3 个重型页面（文件工作区/手机互传/开发工作台）各 5 次 → 记录 `Get-Process` 工作集
与诊断中心「按需加载」表（`loads/activations/releases` 应分别为 1/5/0 或按 release 策略增长）。

## 5. 诊断接入

- 入口：诊断中心 →「按需加载（页面模块）」；
- 指标：已加载/总数、当前活动、加载失败、合并的重复请求、每页首次加载耗时、加载/激活/释放次数、
  最近 8 条事件；
- 持久化：仅失败（WARN）与慢加载 ≥1s（INFO）写诊断库，正常加载不写日志。

## 6. 未解决 / 需要后续处理

1. **并行任务的测试红**：`FullView.test.tsx` / `FullView.navigationContract.test.tsx` 共 8 条用例
   仍按旧标签「规划中心」与旧入口数断言，而 `navigationRegistry` 已被另一任务改名为「项目中枢」
   并新增 `vault` 入口（`allEntryIds` 20→21）。属于该任务的测试同步，本次未改（避免覆盖他人范围）。
2. **`release` 策略的重置语义**：`history/capability/help/diagnostics/resource` 离开后筛选与滚动
   位置会重置。这是「限制实例缓存」的已知取舍；若用户反馈，改为 `keep` 即可（单行配置）。
3. **StrictMode 开发期计数偏高**：开发模式 Effect 双调用会让 activate/deactivate 计数略高；
   生产构建不受影响，验收以正式包为准。
4. **共享 chunk 仍偏大**（React 运行时 871 kB raw / 249 kB gzip）：与页面按需加载正交，
   属于依赖分包优化，未在本次范围。
5. **模块无法卸载**：JS 代码缓存随窗口存活；"释放"只作用于实例与功能级资源，文档已声明。
