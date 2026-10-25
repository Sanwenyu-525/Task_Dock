# Task Dock v0.3 — UI/UX 深度重构与毛玻璃主题验收报告

> 交付日期：2026-10-25 · 版本 0.2.0 → 0.3.0
> 范围：P0 修复、设计 Token 重构、四页面信息架构、Windows 毛玻璃主题、响应式与交互反馈

---

## 0. 测试结果总览（真实执行）

| 检查项 | 命令 | 结果 |
|---|---|---|
| 前端类型检查 + 构建 | `npm run build`（tsc --noEmit + vite build） | ✅ 通过（CSS 31.5KB / JS 321.7KB gzip 99.3KB） |
| 前端单元测试 | `npx vitest run` | ✅ 4 个文件 37 个测试全部通过 |
| Rust 编译检查 | `cargo check` | ✅ 0 error / 0 warning |
| Rust 测试 | `cargo test` | ✅ 80 个测试全部通过 |

新增前端测试文件：`src/lib/agentTree.test.ts`（监控树/实时状态语义，10 例）、
`src/lib/historyGroup.test.ts`（时间轴分组聚合，8 例）、`src/lib/theme.test.ts`（材质回退，8 例）。
新增 Rust 测试：`agents::tests::instance_id_linked_on_sessions_and_runs_or_null`、
`db::tests::v1_to_v2_upgrade...` 升级至 v3 断言。

**并发协作说明**：本次交付期间，另一进程对后端进行了正交重构（`ingest(ev, Transport)`
服务端权威通道、`ingest_batch` 批量原子接入、DB 迁移原子化、v3 `transport_verified`
分层验证列、scheduler P0 回归测试）。两者最终合并后 80 个 Rust 测试全绿；
期间由本方修复了其迁移中的 3 处编译错误（mock.rs 参数错位、db/mod.rs 导入、
http_ingest.rs move-after-use）并升级迁移测试断言至 v3。

---

## Phase 1 — 审计与 P0 修复

### 修改文件
后端：`src-tauri/src/db/models.rs`、`src-tauri/src/agents/mod.rs`、`src-tauri/src/commands/tasks.rs`、
`src-tauri/src/commands/system.rs`、`src-tauri/src/commands/settings.rs`、`src-tauri/src/db/mod.rs`、
`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`
前端：`src/lib/bridge.ts`、`src/store/*`（3 个）、`src/App.tsx`、
`src/components/**`（全部核心组件）、`src/lib/agentTree.ts`（新增）

### 修复清单

1. **QuickAdd 绕过 Store**（P0-1）：改为 `useTasksStore.quickCreate`，创建后同步刷新
   列表、全局统计与当前视图；解析/创建分别有 `parsing/creating` 状态，按钮禁用防
   重复提交，失败走 error Toast，成功显示「已创建」反馈。
2. **TitleBar 非响应式状态**（P0-2）：`worstAgentState` 重写为纯函数并订阅
   `useAgentsStore`；**completed 历史轮次不再计入实时状态**；优先级
   failed > waiting > running > disconnected > idle；failed 仅 60 分钟窗口内计入
   （陈旧失败不污染状态点）。失联 ≠ 失败。
3. **监控树 default 实例**（P0-3）：根因是后端 snapshot SQL 未返回 `instance_id`
   列（数据模型有、查询没查）。已在 `AgentSession`/`AgentRun` 结构体与 SQL 中补齐；
   前端 `buildTree` 按真实 `agent_instances.id` 关联分组；**未知关系落入
   「未关联实例」分组，绝不伪造实例**。新增 Rust 测试锁定 NULL 语义。
4. **styles.css 未定义变量**（P0-4）：`--text-muted` 等 7 处引用无定义、
   `source-grid/source-card` 残留死代码、`modal-mask/backdrop` 双类并存——
   随 Phase 2 全量重写消除。
5. **主题切换不同步**（P0-5）：托盘 `theme-changed` 事件此前只写 store 不更新 DOM。
   现全部入口（设置页/标题栏菜单/托盘/系统主题变化）收敛到
   `useSettingsStore` 的 `applyThemeToDom/applyMaterial`，立即生效、无需重启。
6. **全局统计依赖筛选**（P0-6）：新增 Rust `task_stats` 命令（跨视图 SQL 聚合），
   极简模式、紧凑模式、任务概览卡、标签徽标全部改用全局统计；
   HistoryPanel 订阅 `notification`/`agent-changed` 事件实时刷新；
   Agent 待处理事项「转为任务」走 `useTasksStore.refresh`，任务页同步更新。
7. **窗口最小尺寸冲突**（P0-7）：`tauri.conf.json` 常驻 minWidth 320 钳制极简模式
   280×140。改为 conf 下限 240×96 + `apply_mode_inner`/启动恢复前先
   `set_min_size`（按模式 240×96 / 340×280 / 340×340）再 `set_size`。
   三模式视图常驻挂载（CSS 隐藏），切换保留内容状态与滚动位置，不触发数据刷新。
8. **安全与交互**（P0-8）：接入 Token 默认遮盖（`3f1c••••`），提供显示/复制按钮；
   「复制目录」真正写入剪贴板（新增 `copyText` 工具：clipboard API + execCommand
   兜底）；全部异步操作补齐 try/catch + busy 状态 + 失败 Toast。

## Phase 2 — 设计 Token 与样式重构

`src/styles.css` 全量重写（1463 行 → 语义化 Token 体系）：

- 完整 Token 集：`--surface-base/raised/overlay/hover`、`--glass-tint/blur/saturation`、
  `--border-subtle/strong`、`--text-primary/secondary/tertiary`、`--accent`、
  `--status-running/waiting/success/error/disconnected`，含深色主题全套覆盖。
- 圆角基线：窗口 14px / 卡片 10px / 控件 8px；主色 `#6366F1`；
  浅色玻璃基底 `rgba(248,250,255,0.70)`，深色 `rgba(18,23,34,0.66)`。
- `@media (prefers-contrast: more)` 提高边框与文本反差；
  `@media (prefers-reduced-motion: reduce)` 关闭全部动画。
- 统一 `:focus-visible` 键盘焦点环；按钮 hover/pressed/focus/disabled 四态完整。
- 删除全部死代码与未定义变量引用。

## Phase 3 — 四页面信息架构

- **任务页**：全局概览卡（待完成/今日到期/逾期，逾期卡可点击跳转过滤）→ 快速添加
  主入口 → 日期视图筛选（主）→ 状态/排序（次级工具栏）→ 搜索可展开收起。
  完成任务 Toast 带「撤销」；空状态为图标+标题+引导的完整设计；保留双击编辑
  并增加悬停可见的编辑按钮。
- **Agent 页**：拆分「运行监控 / 接入管理」两分区。运行监控含四格摘要
  （运行中/等待介入/异常/已连接来源）+ 需关注筛选 + 关注优先级排序的
  Agent→实例→会话→轮次树（等待/失败高亮，跳转原会话，待处理事项转任务）。
  接入管理含发现网格、向导、通用桥接（Token 遮盖）与自定义来源；
  明示「已安装 ≠ 已连接」。Mock 控制台移入设置页开发者选项。
- **历史页**：通知+事件统一时间轴，按日分组（吸顶标签），连续重复失联/重连
  组内聚合显示 ×N（跨日不折叠，保留全部原始记录），来源/类型/时间三维过滤，
  点击展开详情，通知点击即读，清空需 3 秒内二次确认。
- **设置页**：六分组（外观与主题/窗口与快捷键/通知/Agent 接入/数据与备份/
  开发者选项），可折叠 Section，统一行高与说明文字；Agent 接入与开发者选项
  默认折叠（普通用户只见主要设置）。

## Phase 4 — Windows 毛玻璃主题

- **原生效果**：新增 `apply_window_material` Rust 命令，直接调用
  `window-vibrancy`（Tauri 自身 Windows 传递依赖，**零新增 crate**）：
  Win11（build≥22000）Mica 优先 → Win10 1803+ Acrylic → 均失败返回
  `applied=false`。选择直调而非 Tauri `set_effects` 的原因：后者在 Windows 上
  恒返回 Ok、吞掉底层错误，无法诚实判断是否生效。
- **材质设置**：`Settings.material`（solid|glass，默认 glass，DB 白名单校验），
  与配色（light/dark/system）正交组合。
- **回退链**：glass 请求 → 原生探测失败 / `prefers-contrast: more` /
  `prefers-reduced-transparency: more` 任一命中 → `data-material=solid` 不透明
  主题，并清除原生效果；设置页显示降级原因与实际命中效果。
- **无双重模糊**：glass 模式 CSS 仅提供半透明 tint（`--glass-tint`），
  不叠加 `backdrop-filter`；模糊完全由系统 Mica/Acrylic 完成。
- **生效路径**：启动时在窗口显示前应用（防透明闪烁）；运行时切换即时生效；
  重启后从 DB 恢复材质+配色；系统主题/对比度/透明偏好变化实时重算。
  窗口拖动、缩放、贴边吸附、点击区域不受影响（材质只动合成层）。

## Phase 5 — 响应式与视觉验证

- **截图走查**（9 张，见 `docs/screenshots/`）：通过自建 Tauri IPC mock harness
  （`scripts/make-preview.mjs` → `dist/preview.html`，桌面壁纸背景模拟透出）
  在真实浏览器中渲染实际 UI 代码并截图：四页面 × 浅/深色 × glass、
  320px 窄窗口、极简/紧凑模式。经视觉模型评审确认布局正确。
- **实测断言**：320px 下发现网格自动单列、`overflowX=false`、Token 遮盖生效、
  监控树实例 proc-111/proc-222 正确渲染、极简模式全局统计与 Agent 状态
  优先级正确、标题栏窄窗口隐藏品牌文字不溢出。
- **模式切换**：三视图常驻挂载，滚动位置与搜索状态保留。

---

## 视觉验收（截图对照）

| 场景 | 文件 | 结论 |
|---|---|---|
| 任务页 · 浅色 glass | `01-tasks-light-glass.png` | 概览卡/快速添加/筛选/任务卡层次清晰 |
| Agent 监控 · 浅色 glass | `02-agents-monitor-light-glass.png` | 实例层级正确，等待会话排前 |
| 历史时间轴 · 浅色 glass | `03-history-light-glass.png` | 分组/未读/聚合×2/详情展开正常 |
| 设置页 · 浅色 glass | `04-settings-light-glass.png` | 六分组折叠正常 |
| 任务页 · 深色 glass | `05-tasks-dark-glass.png` | 深色玻璃可读性良好 |
| 320px 接入管理 | `07-320-onboarding-light-glass.png` | 单列无溢出，Token 遮盖 |
| 极简模式 · 深色 glass | `08-minimal-dark-glass.png` | 全局统计 + 状态胶囊 |
| 紧凑模式 · 浅色 glass | `09-compact-light-glass.png` | 双区渲染正常 |

> 「改造前」截图无法提供：项目非 git 仓库，v0.2 视觉无存档。
> 浏览器 mock 无法呈现原生 Mica/Acrylic 的真实模糊（截图中的"透出"为壁纸+CSS
> tint 模拟），原生材质需在 Windows 实机验证（见剩余风险）。

## Windows 兼容性

- Win11（22000+）：Mica 首选；Win10 1803+（17134+）：Acrylic；
  更早系统/探测失败：自动 solid 回退，UI 明示原因。
- 100%/125%/150% 缩放：全部尺寸使用 LogicalSize，最小尺寸随模式同步。
- 高对比度：`prefers-contrast` 提升反差 + 强制 solid 材质。
- 托盘 / 全局快捷键 / 单实例 / 贴边吸附：逻辑未改动，启动路径回归通过
  （`restore_window` 复用同一 `set_mode_window_size`）。

## 剩余风险与限制

1. **原生毛玻璃未实机验证**：本次环境未运行 Tauri 桌面窗口。Mica/Acrylic 的
   真实透出效果、与 CSS 14px 圆角边缘的合成表现需在 Win10/Win11 实机走查；
   若 Mica 在圆角外出现材质方块，可将 glass 模式圆角降至 8-10px（一行 CSS）。
2. **Acrylic 拖动性能**：Win10 Acrylic 随窗口移动重算模糊，长时拖动可能掉帧；
   建议低配机器使用 solid（设置页可切）。
3. **`prefers-reduced-transparency`** 依赖较新 WebView2（Chromium 118+）；
   旧版本该查询不匹配时保持 glass，需用户手动切 solid。
4. **模式切换状态保留**：三视图间已保留；完整模式内部四个标签页切换仍会
   重建面板（有意为之，避免启动时执行发现扫描；进入 Agent 页才扫描）。
5. **并发重构未完全合入的部分**：Transport 分层验证（transport_verified）后端
   已就绪，前端健康徽标尚未区分「通道已验证 vs 会话已验证」两档，留待下版本。
6. **导出/导入往返测试**中 `created_at` 重盖问题由并发重构引入并已由其修复
   （本轮最终 80 测试全绿时确认）。

## 依赖变更

- 新增直接依赖：`window-vibrancy = "0.6"`（Cargo）——与 Tauri 的 Windows 传递依赖
  同版本，**零新增 crate**，理由：Tauri 原生 `set_effects` 在 Windows 恒 Ok 吞错，
  无法可靠判断毛玻璃是否生效。
- 前端零新增 npm 依赖。
