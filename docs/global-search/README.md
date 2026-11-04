# 全局搜索（Global Search，v0.9）

Task Dock 的统一本地检索层：一个搜索入口查找分散在各模块中的内容，并直接跳转到对应功能与具体条目。

- 命令：`global_search`（Tauri IPC，只读）
- 快捷键：`Ctrl + Shift + F`（应用内获得焦点时可用，非系统级常驻热键；再按一次关闭）
- 代码：`src-tauri/src/global_search/`（查询与排序）、`src-tauri/src/commands/global_search.rs`（命令薄壳）、
  `src/lib/globalSearchBridge.ts`、`src/store/useGlobalSearchStore.ts`、`src/hooks/useGlobalSearchShortcut.ts`、
  `src/components/global-search/`（弹窗 / 结果列表 / 定位工具 / 样式）

## 1. 架构

```
GlobalSearchDialog（常挂载，open 控制渲染；overlayStack "dialog" 层）
  └─ useGlobalSearchStore（防抖 220ms → seq 乱序防护 → globalSearchBridge）
        └─ invoke("global_search", { query, categories?, limitPerCategory? })
              └─ commands::global_search（spawn_blocking，不阻塞主线程）
                    └─ global_search::run_search
                          └─ Db::with_read（同一个只读连接，PRAGMA query_only）
                                ├─ tasks / clipboard_items / quick_capture_items / shelf_items
                                ├─ navigation_targets / agent_sessions+runs / workspace_snapshots
                                └─ planning_projects / features / milestones
```

- **一次请求一条只读连接**：全部已选分类的查询在同一个 `with_read` 闭包内完成，天然一致快照；
  不为分类建独立线程，不新增轮询与后台任务。
- **不建第二套数据库**：直接查询现有业务表；无复制表、无派生索引（见 §10 性能）。
- **只读**：搜索不写任何业务表；`with_read` 连接本身 `query_only`。

## 2. 数据源列表（8 类）

| 分类 | 表 | 搜索字段 | 备注 |
|---|---|---|---|
| tasks | `tasks` | 标题、描述、分类、标签（JSON） | 覆盖待办+已完成；SQL 层未完成优先 |
| clipboard | `clipboard_items` | 正文、预览、标题、来源应用、来源窗口标题、文件路径 | 不返回正文/HTML/二进制，只给 preview；置顶收藏优先 |
| capture | `quick_capture_items` | 内容、链接、备注、类型 | 覆盖 inbox/handled/converted；未处理优先 |
| shelf | `shelf_items` | 显示名、内容（含链接 URL）、备注、原始/托管路径 | 不读文件内容；`exists_state=missing` 如实标注「文件已失效」 |
| apps | `navigation_targets` | 显示名、分类、URL、路径、app_key、窗口标题提示、exe 路径 | 仅已保存目标（`hidden=0`）；已发现（未登记）应用暂不搜索，见 §11 |
| agents | `agent_sessions` + `agent_runs`（JOIN `agent_sources`） | 会话标题、外部 ID、来源名、轮次任务标题 | 强制 `origin='real'` 且来源 `hidden=0`（对齐 snapshot_query 隔离）；不触碰对话内容/payload/meta |
| workspace | `workspace_snapshots`（LEFT JOIN `tasks`） | 现场名、备注、关联任务标题 | 恢复现场绝不因点击搜索结果触发 |
| planning | `planning_projects` + `planning_features` + `planning_milestones` | 名称/标题、描述 | 含归档项目（副标题标注「已归档」）；与 featureCatalog 内置功能目录无关 |

未来快速笔记（quick notes）落地后：在 `run_search` 增加一个 `search_notes(conn, ...)` 分支 +
`CATEGORIES` 加一项 + 前端 `GLOBAL_SEARCH_CATEGORIES/LABELS` 与 `openResult` 各加一档即可，
无需改动搜索框架（轻量适配器模式）。

## 3. 查询接口

```ts
globalSearch(query: string, categories?: string[] | null, limitPerCategory?: number | null)
  → GlobalSearchResponse
```

- `query`：后端 trim、按字符截断到 100 字符；空白返回空结果（不发 SQL）。
- `categories`：缺省/空数组 = 全部分类；非法值返回 Validation 错误；选中分类只查该类。
- `limitPerCategory`：缺省 6、上限 20（越界收敛）；SQL `LIMIT limit+1` 探测 `has_more`。

## 4. 搜索结果结构（serde snake_case，前端逐字段镜像）

```ts
interface GlobalSearchResult {
  id: string;            // 结果自身 id（跳转主键；run=轮次id、session=会话id…）
  category: string;      // 八类之一
  kind: string;          // 子类型：task/session/run/snapshot/project/feature/milestone/text/image…
  title: string;         // 截断 80 字符
  subtitle: string;      // 来源/状态标注（如「会话 · Codex」「已失效」「已归档」）
  snippet: string;       // 摘要，截断 160 字符
  occurred_at: string | null;
  status: string | null;
  priority: number | null;  // 任务 0-3；规划功能 P0→0/P1→1/P2→2
  target_id: string | null; // 跳转目标（通常即定位 id）
  parent_id: string | null; // 父级（run→session、snapshot→task、feature/milestone→project）
}
interface GlobalSearchGroup { category: string; items: GlobalSearchResult[]; has_more: boolean; }
interface GlobalSearchResponse { query: string; groups: GlobalSearchGroup[]; total_returned: number; }
```

组顺序固定（tasks → planning），只返回有命中的分组。

## 5. 分类规则

前端分类筛选（全部 + 8 类）与后端一一对应；选择分类后仅查询该类别，避免无用请求。
分类名常量：后端 `global_search::CATEGORIES`、前端 `GLOBAL_SEARCH_CATEGORIES`，两侧一一对应。

## 6. 结果排序（确定性，可测试）

1. 匹配等级（纯函数 `rank_match`）：标题精确匹配(0) > 标题前缀(1) > 标题包含(2) > 摘要/正文命中(3) > 其他列命中(4)；
2. 同等级内保持 SQL 业务次序（稳定排序）：任务未完成优先、剪贴板置顶→收藏→时间、暂存架置顶→时间等；
3. 记录的 `updated_at` 变化不会改变匹配等级。

SQL 全部参数绑定；LIKE 模式转义 `\ % _` + `ESCAPE '\'`（对齐 `clipboard::store::like_pattern`），
用户输入不会变成通配符；SQLite LIKE 对 ASCII 不区分大小写，对中文等多字节无大小写概念（第一版口径，见 §11）。

## 7. 目标跳转机制

统一走「一次性定位意图」：`useGlobalSearchStore.openResult(item)` 关闭弹窗 → `setTab` +
写入 `pendingLocate { category, id, kind, parentId, keyword, token }` → 目标模块消费（滚动/高亮/开详情）→
`consumeLocate()` 清除（先例：`agentFocus`/`appConfig`）。

| 分类 | 跳转实现 | 消费方 |
|---|---|---|
| tasks | 切任务页 + 按 keyword 过滤（view=all/status=all）→ 滚动到 `data-task-id` 高亮 | TasksPanel |
| clipboard | 切剪贴板页 → 直接按 id 打开条目详情（`ClipboardItemDetail` 独立取数，不依赖当前过滤） | ClipboardWorkspace |
| capture | 切收集箱 → 切「全部」筛选确保已处理/已转可见 → 滚动高亮 `data-capture-id` | CaptureInboxPanel |
| shelf | 切暂存架 → 清搜索过滤（详情数据源是当前列表）→ `setDetail(id)` 打开详情 | ShelfWorkspace |
| apps | 不经意图：直接 `navNavigate(targetId, { action: "focus_or_launch" })`（已有窗口优先聚焦）；失败回显在弹窗 notice，不伪装成功 | useGlobalSearchStore |
| agents | 会话：`focusAgent({sourceId, sessionId, refId:null})`；轮次：`refId=runId`（复用既有定位全链路） | AgentPanel（零新增） |
| workspace | 找关联任务 → 打开上下文抽屉（`openContext`）→ 展开目标快照；**绝不自动恢复现场**；未关联任务时如实提示 | TaskContextDrawer |
| planning | project→选中项目开总览；feature/milestone→先切所属项目再复用 `openFeature/openMilestone` 高亮定位 | PlanningWorkspace |

不能精确定位的结果一律如实降级（提示），不伪装成可点击的成功跳转。

## 8. 搜索限制

- 只读：不修改任务状态、剪贴板记录、Agent 状态、暂存数据、现场、规划进度。
- 不返回大正文：剪贴板正文/HTML 不出 IPC；暂存架 `content` 不返回（可参与命中）；
  不读取文件内容做全文检索；图片/文件二进制完全不加载。
- 每类默认 6 条、上限 20；总结果 = 分类数 × 每类上限。
- Agent 只搜标题/外部 ID/来源名/任务标题；mock/benchmark/selftest 数据按既有隔离规则排除。
- 已发现（未登记）应用不进入搜索结果（见 §11）。

## 9. 隐私策略

- 全部搜索只在本地 SQLite 执行，无网络请求、无云端服务、无 AI 总结。
- 搜索词与命中内容不写入运行日志（后端无 query 日志；错误只带错误类别）。
- 最近搜索仅存 `localStorage`（key `taskdock.global_search.recent`，≤10 条，去重、最新在前、
  可一键清除），随 WebView 数据目录留存，不出本机。

## 10. 性能设计

- 前端：防抖 220ms；请求代际防乱序（旧响应丢弃）；失败保留旧结果 + 重试；弹窗关闭清定时器；
  不重复发起同一查询；结果列表按 id 稳定 key，输入不重建弹窗。
- 后端：`spawn_blocking` 包裹；单一只读连接；`LIMIT limit+1`；不读大字段；无新线程/轮询。
- 实测（2026-11-04，debug 构建，`search_scale_benchmark_10k_rows`，Windows 本机）：
  **10k 任务 + 10k 收集箱 + 2k 剪贴板 + 1k 暂存架（共 23k 行）全分类一次查询：命中 19ms / 空结果 12ms**。
  LIKE 扫描在该量级远低于可感知阈值，**暂不引入 FTS5**；若未来数据量级显著增长再评估
  （索引只能作为派生索引，需单独评估备份一致性并交主 Agent 协调）。

## 11. 当前边界与后续接入

- **已发现（未登记）应用**：第一版只搜索已保存导航目标（`navigation_targets`）。搜索已发现应用需要
  只读的扫描缓存访问器（现有 `scan_installed_apps` TTL 内只读、过期会同步重扫，不适合在按键路径触发）
  与 AppPicker 确认登记链路，留待下一轮以「弹窗打开阶段后台刷新一次缓存」的方式接入。
- **大小写**：LIKE 对 ASCII 不区分大小写；如需全 Unicode 折叠，引入 `LOWER()` 表达式索引或 FTS5 时一并处理。
- **快速笔记**：模块实现后按 §2 末尾的适配器步骤接入，分类自动出现（无虚假数据源）。
- **FTS5**：见 §10，有实测依据后再议。

## 12. 测试与证据

- Rust：`src-tauri/src/global_search/mod.rs` 模块内 15 个用例（转义/等级/全类命中/Agent 隔离/
  排序/limit+1/空查询/特殊字符/超长/非法分类/同名异 ID/Unicode/失效标注/万级基准）。
- 前端：`src/store/useGlobalSearchStore.test.ts`（防抖/乱序/失败保旧/分类/四类跳转分发/最近搜索）、
  `src/components/global-search/GlobalSearchDialog.test.tsx`（渲染/键盘循环/Enter/Escape 弹层/最近搜索/点击）。
- 验收资料：`tmp/acceptance/global-search/`。
