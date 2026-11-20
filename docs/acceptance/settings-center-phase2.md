# 设置中心第二阶段验收报告（2026-11-20）

> 结论：**Dev 功能验收通过（浏览器 harness 全矩阵）**。页面结构、视觉规范、Agent 页信息
> 重组、搜索定位、滚动归属、5 尺寸响应式、明暗主题对比度均通过实测；**原生窗口验收与真实
> 数据库重启回读未执行**，见 §8。

## 1. 范围与原则

- 保留第一阶段布局（工作台全局导航 + 设置内部分类树 + 右侧独立页面 + 右栏摘要），不重写架构。
- 只改真实问题：横向溢出成因、滚动归属、搜索定位、视觉不一致、Agent 页信息堆叠。
- 不改协议、数据库、迁移、鉴权；不改 `src/lib/workbenchLayout.ts`、`styles-tokens.css`、
  `styles-pages.css` 等并行任务在途文件。

## 2. 变更文件清单

| 文件 | 改动 |
|---|---|
| `src/components/settings/SettingsGroup.tsx` **新增** | 分组基元：标题/说明/动作/内容 → `.settings-group` |
| `src/components/settings/settings-page.css` | 分组样式、键值列表、溢出防线、可读性 token、滚动所有权、窄档例外 |
| `src/components/settings/mcp-access.css` | 身份卡/审计行/诊断步骤/行内确认样式重写 |
| `src/components/settings/McpAccessSection.tsx` | 拆成「MCP 访问 / Agent 身份 / 审计」三组；空状态、搜索、null 兜底 |
| `src/components/settings/pages/AgentSettingsPage.tsx` | 只保留「本地 HTTP 接入」分组；MCP 开关移入 MCP 分组 |
| `src/components/settings/pages/DataBackupSettingsPage.tsx` | 四个分组；记录空状态；指标改 `.settings-kv-*`；刷新按钮 |
| `src/components/settings/pages/DiagnosticsSettingsPage.tsx` | 三组（采样/指标/保留）；指标改键值列表 |
| `src/components/settings/pages/FeaturesSettingsPage.tsx` | 说明并入 `.setting-label`（布局 A） |
| `src/components/settings/pages/NotificationSettingsPage.tsx` | 说明并入标签块；数值控件改 `.settings-inline-controls` |
| `src/components/settings/pages/AppearanceSettingsPage.tsx` | 布局说明并入标签块 |
| `src/components/settings/SettingsPanel.tsx` | 切页/搜索定位时页面滚动区归零；同页重复命中重新定位 |
| `src/lib/settingsCategories.ts` | 17 个页面的搜索别名补齐（中文设置项名 + 英文词） |
| `src/locales/zh-CN/index.ts`、`en-US/index.ts` | 新增分组/空态/搜索文案；搜索提示改为「设置页面」语义 |
| `src/components/settings/SettingsPanel.test.tsx` | 更新空态文案断言；新增「切页滚动归零」用例 |
| `src/components/settings/McpAccessSection.test.tsx` | 容器断言改为新类；新增「null 列表不白屏」用例 |

未改动：`src-tauri/**`、数据库/迁移、`featureRegistry`、`styles.css`、`styles-pages.css`、
`styles-tokens.css`、`src/lib/workbenchLayout.ts`。

## 3. P0：数据与备份页横向溢出

### 3.1 实测结论（先校准事实）

在当前 HEAD（含第一阶段重构）与真实 `dist` 产物上，用 Chromium 遍历整棵 DOM 测
`scrollWidth - clientWidth`：

| 场景 | 结果 |
|---|---|
| 数据页 5 尺寸（1440/1280/1024/768/640）× 明暗 | 页面滚动区 `overflowX = 0`，`documentElement` 也 0 |
| 超长数据压测（8 份备份、>100 字符文件名、长路径、长审计明细） | 同上，0 |
| 停靠主窗（`.tab-content-settings` 最宽 560px） | 0 |

因此**截图中的横向滚动条在当前代码上已不可复现**（截图早于第一阶段重构）。但机制仍在：
`.settings-page-host` 只声明 `overflow-y: auto`，按规范另一轴会计算为 `auto`，任何子元素
溢出都会长出横向滚动条。本轮把「能产生溢出的结构」逐条拆掉，并用压测复验。

### 3.2 真实成因与修复

| # | 成因（DOM/CSS 事实） | 位置 | 修复 |
|---|---|---|---|
| 1 | 全局 `.btn-row` 是 `flex-wrap: nowrap; flex-shrink: 0`（工具条语义），数据页 4 个按钮 + 标签在中等宽度直接顶出 | `styles.css:3655` | `.settings-panel .btn-row { flex-wrap: wrap; flex-shrink: 1; max-width: 100% }` |
| 2 | `.settings-select-trigger` 固定 `150px`，520–760 区间不收缩，把标签压成竖排 | `styles.css:2740` | `flex: 0 1 150px; width: auto; min-width: 0` |
| 3 | `.setting-note` 无 `overflow-wrap`，长路径/英文串溢出 | `styles.css:3239` | `overflow-wrap: anywhere`（含后代） |
| 4 | `.backup-item > span` 第二列 `nowrap + ellipsis`，审计明细被静默截断 | `styles.css:3686` | 值列 `white-space: normal`；指标改用 `.settings-kv-row`（值可换行） |
| 5 | `.empty-hint` `max-width: 260px` 且不换行 | `styles.css:1599` | `max-width: none; overflow-wrap: anywhere` |
| 6 | `.preset-picker` 用 `1fr 1fr`，长 tagline 撑破列 | `styles-themes.css` | `repeat(2, minmax(0, 1fr))` + `.preset-card { min-width: 0 }` |
| 7 | 行不换行，长标签挤走控件 | 全局 `.setting-row` | `flex-wrap: wrap`（窄档仍转列） |
| 8 | 真正的表格无处可滚 | — | 只允许 `.settings-table-scroll` 自己滚（预留，当前无表格） |

**没有**使用 `overflow-x: hidden` 掩盖。验收脚本同时检查「宿主 overflow」与「元素右边界是否
越过宿主内容盒」，两者都为 0 才算通过。

### 3.3 修复前后对比（640 宽，同构建注入旧声明复现）

| 图 | 说明 |
|---|---|
| `shots/ba-data-640-before-injected-legacy-css.png` | 注入旧声明 `> span { flex: 1 1 180px }`：行高 **223px**、控件被推到行底部 |
| `shots/ba-data-640-after.png` | 当前构建：行高 **33px**，标签与控件同行 |
| `shots/ba-nav-640-before-injected-legacy-css.png` | 注入旧声明：18 行被压成 **13px**、右侧开关/排序按钮**完全不可见**（越界 357px） |
| `shots/ba-nav-640-after.png` | 当前构建：行高正常、控件完整、列表内部滚动 |

`before` 图是把修复前声明重新注入同一构建得到的复现，不是旧版本截图（文件名已标注
`injected-legacy-css`）；数值来自同一次测量的 `getBoundingClientRect`。

### 3.4 本轮自测中额外抓到并修掉的两个「行高被撑开」问题

统一 `.setting-row` 时，`flex: 1 1 180px` 写在标签上会按**行方向**解析；一旦该行是纵向
（窄档 520px 以下转列，或页面显式 `.setting-row.column`，如外观页预设卡行），`flex-basis`
变成**高度**：

| 现象 | 实测 | 修复 |
|---|---|---|
| 640 宽数据页每行高 223px、控件贴到底部 | `height = 223px` | 基准只写在 `@container (min-width:521px)` 且 `:not(.column)` 的行上 |
| 外观页「视觉主题」行上方空出 100+ px，预设卡被推到底部 | 行高约 250px（内容约 110px） | 同上（排除 `.column`） |

修复后 640 数据页行高 33px；外观页 1024/1440/640 三档 `overflowX = 0`。

## 4. Agent 接入页重排结果

保留全部命令与安全逻辑（未改 Rust、未改 IPC 契约、未改令牌/撤销/授权流程），只重排信息：

| 区域 | 内容 | 载体 |
|---|---|---|
| ① 本地 HTTP 接入 | 启用开关、端口、令牌（隐藏/复制）、断线判定、投递目录 + 说明 | `SettingsGroup` + `.setting-row` |
| ② MCP 访问管理 | 状态条（运行/端口/活跃身份/最近调用）、服务开关（默认关闭）、连接诊断（逐步状态）、刷新 | `SettingsGroup` + `.settings-status` |
| ③ Agent 身份管理 | 创建凭据（一次性令牌 + 客户端配置片段）、搜索、身份卡（范围/项目/能力/工作区/换令牌/撤销）、空状态 | `SettingsGroup` + `.settings-identity` + `EmptyState` |
| ④ 审计记录 | 分页记录（时间/身份/动作/实体/授权/结果/错误类）、空状态 | `SettingsGroup` + `.settings-audit-*` |

顺带修掉一个**会白屏的真实缺陷**：`mcp_agent_list` 等命令在服务未启动分支可能返回 `null`，
原实现 `setAgents(null)` 后渲染期 `.filter` 抛错 → 整个设置页进入错误边界（浏览器实测
`MISSING`）。现所有列表响应经 `asList()` 归一化，并新增回归用例。

## 5. 搜索验证

| 项 | 结果 |
|---|---|
| 匹配范围 | 页面标题、所属分类、别名（17 页补齐，如「自动备份/保留天数/投递目录/凭据/静默/试听/OCR」） |
| 结果粒度 | **设置页面**（不是单条设置项）——提示文案与空态已改为「搜索设置页面或关键词」「没有匹配的设置页面」 |
| 点击后行为 | 切到目标页面 → 页面滚动区归零 → 焦点落 `.settings-page-title` → 导航选中态同步 |
| 同页重复命中 | 也会重新归零并聚焦（`focusNonce` 驱动） |
| 无匹配 | 显示空态，不保留过期选项 |

实测（1440×900，16 条断言全通过）：搜索「备份」→ 命中「数据与备份」→ 页面切换 / `scrollTop=0`
/ 焦点在标题 / 导航选中一致 / 无横向溢出。

## 6. 响应式矩阵（5 尺寸 × 导航开合 × 详情栏开合 × 明暗）

`node tmp/acceptance/settings-center-2/responsive.mjs`（浅色、深色各跑一遍）：

| 尺寸 | 面板宽（nav 全宽 / 折叠） | 导航形态 | 横向溢出 |
|---|---|---|---|
| 1440×900 | 910 / 1014（detail on）；1218 / 1322（detail off） | tree | 0 |
| 1280×800 | 750 / 854；1058 / 1162 | compact（detail on）/ tree | 0 |
| 1024×768 | 802 / 906 | tree | 0 |
| 768×900 | 546 / 650 | compact | 0 |
| 640×800 | 418 / 522 | compact | 0 |

- 共 40 个组合（20 × 2 主题），`hostOverflow = 0`、`docOverflow = 0`，没有控件被压到不可用尺寸
  （脚本唯一命中的 1 个 `1×1` 元素是 Switch 内部隐藏的原生 checkbox，非可见控件）。
- 断点切换（1440→640→1440）：当前页面保持「智能剪贴板」，未提交草稿 `keepass.exe` 保持，
  导航形态 compact ↔ tree 正确切换。

## 7. 滚动、对比度与功能回归

### 7.1 滚动归属（7/7 通过）

| 断言 | 实测 |
|---|---|
| 数据页由页面滚动区承接 | `scrollHeight 647 > clientHeight 513` |
| 页面滚到底后不拖动外层 | `documentElement.scrollTop` 保持 0 |
| 导航自定义列表内部滚动 | 列表 `scrollHeight 712 > clientHeight 242` |
| 导航自定义页自身不滚 | `host.scrollHeight == clientHeight` |
| 滚轮滚列表不滚页面 | 列表 0→300，页面 0 |
| 诊断日志 / 应用管理无横向溢出 | 0 |

本轮修掉两个真实缺陷：`variant="split"` 用 `min-height: 100%`（不是 `height`）导致列表撑高页面、
抢走滚动；`.nav-visibility-body` 未参与 flex 链导致列表按内容长高。

### 7.2 辅助文字对比度（WCAG AA，12/12 ≥ 4.5:1）

| 元素 | 浅色 | 深色 |
|---|---|---|
| 页面副标题 | 5.35:1 | 7.84:1 |
| 分组说明 | 5.74:1 | 7.16:1 |
| 说明文字 `.setting-note` | 5.74:1 | 7.16:1 |
| 备份文件名/时间 | 5.35:1 | 7.84:1 |
| 分组标题 | 17.74:1 | 13.52:1 |
| 设置项名称 | 7.58:1 | 7.95:1 |

修复前 `.settings-page-desc` / 备份文件名在浅色面为 **4.43:1**（不达标）。改为局部变量
`--settings-text-muted`（muted 86% + primary），仍低于设置项名称，保留层级。

### 7.3 交互回归（16/16）

搜索定位（含同页重复）、导航树滚轮隔离、键盘方向键切页与焦点、主题切换（`data-theme=dark`
+ 卡片深色面 `rgb(22,32,50)`）、语言切换（标题 `Appearance & theme`、提示
`Search settings pages or keywords`）。

### 7.4 单元/组件测试

| 范围 | 结果 |
|---|---|
| `SettingsPanel.test.tsx` | 24/24 |
| `McpAccessSection.test.tsx` | 13/13（含新增 null 兜底） |
| `settingsCategories` / `settingsSections` / `SettingsNavigation` / 语音 / 快捷键盘 / 应用管理 / 资源清理 / 移动同步 | 全部通过 |
| `npx tsc --noEmit` | 通过 |

**已知失败（与本次改动无关，HEAD 既有）**：`NavigationVisibilitySection*.test.tsx` 9 个用例
断言旧文案「上移 规划中心」，而 HEAD 的 `nav.roadmap` 已是「项目中枢」
（`src/locales/zh-CN/index.ts:789`）；`git show HEAD:...test.tsx` 同样含「规划中心」。
属导航重命名任务的用例未同步，本任务不越界修改。

## 8. 未执行 / 不可替代的验收

| 项 | 状态 | 说明 |
|---|---|---|
| 原生窗口 Dev 走查（`npm run tauri dev` 截图） | **未执行** | 环境已有 dev 实例占用 47821 端口与共享工作树；本轮全部 UI 证据来自浏览器 harness（真实 `dist` 产物 + IPC 模拟），**不等同**原生 WebView2 渲染 |
| 真实数据库持久化回读（改设置→重启→回读） | **未执行** | 单测只断言 `update_settings` 调用与 store 值；Rust 侧未跑（共享 target 锁） |
| Release 安装包验收 | 不适用 | 本任务为 Dev 功能验收，不推进状态机、不生成 `buildId` |
| 拖拽排序自动滚动 | 部分 | 已确认列表可内部滚动（自动滚动前提），未做真实拖拽到边缘的动画取证 |
| 全量矩阵最后一次复跑 | 部分 | D: 盘写满（`ENOSPC`）导致 85 例复跑在 tts-cache 处中止；上一轮 85 例构建与本轮仅差「`.column` 行不再继承 flex 基准」与「错误态不叠加空状态」，前者已复测 3 档、后者由单测覆盖 |

## 9. 诊断日志异常核查（详见 `docs/issues/2026-11-20-settings-center-diagnostics-findings.md`）

| 事件 | 次数 / 最新 | 结论 |
|---|---|---|
| `settings.get_settings` | 220 / 2026-11-20 11:15 | **当前仍存在**：`state not managed for db`，出错窗口 `context-menu 209 / notification 9 / capture 2`；根因是 `tauri.conf.json` 预创建窗口早于 `setup()` 里的 `manage(db)` |
| `settings.update_settings` navWidth 120–800 | 5 / 2026-11-19 22:39 | **历史，已修复**：HEAD 已按字段校验 96–320 / 260–480，与前端常量一致 |
| `ui.boot_slow` | 13 release / 50 dev | dev 冷启动特征；release 最新 11-17 |
| `ui.boot_timeout` | 14 release / 23 dev | 历史 + dev 环境 |
| `workbench.startup-reveal` | 3 release / 47 dev | 兜底生效（强制显示，不白屏）；dev 编译期 |
| `agents.http_ingest` | 24 release / 68 dev | 两实例共用固定端口 47821 的预期降级 + dev token 不一致 |
| `agent.agent_access_conflicts` | 3（仅 dev，11-19） | 「工作空间尚未初始化」：面板并行拉 conflicts，应在 status 之后拉 |

本次改动**未新增**任何诊断事件。

## 10. 剩余问题清单

1. `get_settings` 启动竞态（设置页会先显示「加载中」，命令失败后由前端重试）——需独立任务，
   涉及 `tauri.conf.json` 窗口装配。
2. 搜索仍是「页面级」：若要定位到单条设置项，需要在 `SETTINGS_SECTION_META` 之外新增
   设置项锚点索引与滚动定位协议（本次未做，文案已如实表述）。
3. `NavigationVisibilitySection*.test.tsx` 的旧文案断言（9 例）待导航重命名任务同步。
4. `.help-context-btn` 内部有 5px 内容溢出（不影响可读性，未处理）。
5. 原生窗口与真实持久化验收未执行（见 §8）。
6. **D: 盘已满（0 可用）**：本轮后续的构建/截图写入多次因 `ENOSPC` 失败，需要清理
   `src-tauri/target*` 或按 `npm run guard:cleanup` 处置后再做原生验收。
