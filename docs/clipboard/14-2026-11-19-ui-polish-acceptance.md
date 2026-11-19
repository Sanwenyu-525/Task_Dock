# 14 · 2026-11-19 智能剪贴板第三轮 UI/UX 精修验收

> 日期：2026-11-19 · 基线：`main` / `27f7e11`（任务开始时为 `f832de4`；任务期间外部提交先把 HEAD
> 推到 `5fd8751`，再于 17:59 推到 `27f7e11`；本轮剪贴板文件仍未提交，验收产物来自当前工作树）
> 平台：Windows 11 x64 · 前端：React + TypeScript + Vite · 样式：`clipboard-page.css` + `styles.css`
> 原则：**功能能点不等于 UI 通过；未执行的不写成通过；截图不能证明功能可用。**
> 证据边界：第九节截图来自 **Playwright Chromium 1243 + 项目 preview harness**，不是 Windows
> 原生窗口截图；真实 Windows 功能复测未执行，原因与范围见第十节。

---

## 一、结论速览

| 维度 | 结论 | 依据 |
|---|---|---|
| UI/UX | **部分通过** | 同行等高、四段式层级、操作收敛、`previewed`/`selected` 独立、无外壳宿主时的页面本地右栏已落地；短文本在含图片/文件卡的同行仍有约 45px 正文余量（P2） |
| 功能回归 | **部分通过** | 剪贴板定向 Vitest 111/111、exit 0；真实 Windows 采集/粘贴/灯箱/暂停恢复未执行 |
| 性能 | **部分通过** | 未新增轮询、监听、JS 逐卡测高或第二套图片缓存；单个 `ResizeObserver` 只观察页面宽度；未做原生 CPU/内存/帧率采样 |
| 响应式 | **部分通过** | 720–1920 共 24 组浏览器矩阵 `misalignedRows=0`、`overflowX=false`；右栏只在页面宽度 ≥1180px 时启用；DPR 仅 1，125%/150% 未测 |
| 真实 Windows 验收 | **未执行** | 并行会话占用唯一真机实例，未取得前台操作授权；未启动隔离实例，见第十节 |
| 文档与截图归档 | **通过** | 14 号报告、15 张正式截图、`manifest.json`、截图总索引与证据索引已建立并同步本轮修复 |

> **不能由本报告推导的结论**：系统剪贴板链路正常；原生窗口圆角/DWM 材质/贴边吸附正常；
> 125%/150% DPI 正常；全部分组/灯箱链路已在真实窗口验收通过。以上均未取得本轮证据。

---

## 二、代码基线、协作与写入范围

| 项 | 值 |
|---|---|
| 分支 / HEAD | `main` / **`27f7e11`**（`feat(cross-tab): 全局工作篮与跨 Tab 联动（v79 迁移/面板/文件写入）`）。任务开始时 HEAD 为 `f832de4`；任务进行中外部提交先推进到 `5fd8751`，再于 17:59 推进到 `27f7e11`，未触碰 `src/components/clipboard/` |
| 工作树 | **脏**：`src-tauri/`、移动端、文件工作区、标题栏、跨标签页、`WorkbenchShell.tsx` 等存在其他 Agent 在途改动 |
| 本轮 Git 操作 | 未 commit / push / stash / reset / clean；未切换分支；未触碰他人文件 |
| 真机实例 | 本轮未抢前台、未终止、未操作他应用；未取得授权，因此真实 Windows 项未执行 |
| 本轮写入 | 3 个产品组件 + 2 个样式文件 + 多个测试/截图脚本 + 文档；清单见下 |
| 状态管理 | `useClipboardStore` 未改写；没有第二套 Store、第二套密度或图片缓存 |

**本轮修改文件**

| 文件 | 改动 |
|---|---|
| `src/components/clipboard/ClipboardItemCard.tsx` | 四段式信息层级、`previewed` 独立态、复制/目标窗口分体、去掉重复详情入口、标题与预览去重、图片自动标题去重 |
| `src/components/clipboard/ClipboardGroupCard.tsx` | 主体改为真按钮、整组复制带文字、删除收进更多菜单、元数据贴底 |
| `src/components/clipboard/ClipboardWorkspace.tsx` | 工具栏三组、高级筛选折叠与生效数量、预览作用域清理、右栏关闭按钮与 `previewed` 绑定；**本轮新增页面本地右栏回退**（`WorkbenchDetailHostProvider` + 单 `ResizeObserver`） |
| `src/components/clipboard/clipboard-page.css` | 同行等高、卡片内部 Flex、标题 2 行、正文 3/4/5 行、宽图 104–124、竖图 186–206、工具栏/筛选/分组卡、删除旧 1320/1920 硬编码列规则；**本轮降低短卡留白**（基础 184px、紧凑 140px、大图 224px、间距 4px） |
| `src/styles.css` | 分体复制、预览中标记、focus ring 不被裁切的全局样式（语义 Token） |
| `ClipboardItemCard.test.tsx` / `ClipboardGroupCard.test.tsx` / `ClipboardPanel.test.tsx` / `ClipboardWorkspace.scroll.test.tsx` | 同步新交互；新增 `previewed`/`selected` 独立、CSS 等高契约、菜单内删除、卡片主体详情 |
| `scripts/make-preview.mjs` | 走查夹具文案、迷你窗口缩略图 SVG；仅合成数据 |
| `tmp/acceptance/clipboard-ui-polish-20261119/shot.mjs` | 15 张正式截图 + 720–1920 × 4 变体矩阵 + `manifest.json`；逐张/逐变体增量落盘；**本轮新增等视口内图片占位消失后再拍** |

未改：`ClipboardItemDetail.tsx`、`ClipboardGroupDetail.tsx`、`Media.tsx`、`clipboardDensity.ts`、
`useClipboardStore.ts`、`WorkspaceSplit.tsx`、`workspaceSplit.css`、`pageDetail.tsx`。
`src/workbench/WorkbenchShell.tsx` 保持其他会话的在途状态，本轮没有覆盖或提交。
密度、640 图片预览、懒加载/LRU/去重、来源/时间筛选、灯箱、分组逐项粘贴、删除确认与滚动保护
均沿用原实现。

> Git 说明：任务期间外部提交先把 HEAD 从 `f832de4` 推到 `5fd8751`，再于 17:59 推到 `27f7e11`。
> 按 `AGENTS.md` §3.2，**不能用 `main` 的提交判断哪些任务已完成**；本报告结论只以本轮工作树中
> 的实际文件与真实命令输出为准。

---

## 三、本轮 UI 问题与根因

### 3.1 卡片底部参差（P1，已修复）

旧 `.clip-list-grid` 使用 `align-items: start`，每张卡按自身内容高度排布。上一轮真实截图
`tmp/acceptance/clipboard-workbench-responsive/shots/04-large-1600.png` 中：短文字卡约 178px，
图片卡约 390px；第二行文件卡与图片卡的动作行不在同一基线。根因不是卡片内边距，而是**网格行
没有把同行卡片拉到同一高度**，卡片内部也没有“正文吃余量、动作贴底”的结构。

### 3.2 信息层级不统一（P1，已修复）

旧卡片的来源/窗口在标题下，大小/次数在动作区附近；不同模板各写各的，导致同一行中元数据
有的悬在中间、有的贴底。`07-density-list-1600.png` 里大小与使用次数被推到卡片右下角，和
来源行分离。

### 3.3 操作拥挤且重复（P1，已修复）

旧动作行同时放复制、目标窗口箭头、收藏、置顶、`Maximize2` 查看详情、更多六个入口；卡片主体
本身已打开右栏，右栏又有「完整详情」，形成两个含义相同的详情入口。

### 3.4 预览态缺失（P1，已修复）

`previewId` 与 `selectedItems` 是两个状态，但卡片只有 `selected` 视觉；右栏没有关闭按钮；
筛选变化后 `previewId` 可能残留一条已不在列表中的记录。

### 3.5 工具栏与筛选（P2，已修复）

720 窄窗下搜索框被挤到约 210px，其余控件换到第二行；左侧“历史/分组”没有边界容器；时间/来源
不可折叠；顶部与侧栏的收藏入口存在重复风险。

### 3.6 图片与分组卡（P1/P2，已修复）

竖图舞台最高 340px、宽图 240px，图片卡远高于文字卡；分组卡动作只有图标、删除常显、卡片中部
大片空白（`12-groups-1600.png`）。标题单行省略、正文在 1320px 容器为 6 行，均不符合本轮要求。

### 3.7 右栏宿主缺失（P1，本轮修复）

`WorkbenchShell` 只在项目工作空间分支挂 `.wb-detail-slot`，剪贴板 `RouteSlot` 没有
`detailSlot`，`useWorkbenchDetailHost()` 返回 null。上一轮为了不覆盖共享的 `WorkbenchShell.tsx`，
点卡直接回退完整详情；07/08 因此不是右栏截图。

本轮没有改共享外壳，而是在 `ClipboardWorkspace` 内增加**页面本地右栏回退**：仍复用
`WorkbenchPageDetail` / `.wb-context`，只补一个宿主容器；页面实际宽度 ≥1180px 时启用，
窄窗（720/1024）仍回退完整详情。1600 窗口扣右栏 320px 后内容区 974px、3 列，07/08 已按真实
右栏重拍。

### 3.8 短文本留白（P2，已部分缓解）

等高策略会让同一行短文字卡被图片/文件卡拉高。本轮把卡片基础高度从 200 降到 184、宽图舞台从
128–148 降到 104–124、间距从 6 降到 4、动作区上内边距从 6 降到 4；1600 默认第一行文字卡
约 201px、图片卡约 246px，余量从上一版约 100px 降到约 45px。**没有用 masonry 或按行单独测高**，
因为那会破坏“同一行等高”的既定方向；残留余量仍列为 P2。

---

## 四、修改内容

### 4.1 同行等高、行间可不同高

- `.clip-list-grid` 改为 `align-items: stretch`；列表密度单独 `align-items: start`（单行密排
  不该被拉高）。
- 卡片模板固定为 `top / main / actions` 三段网格；图片卡多一条 `hero` 行：
  `auto auto minmax(0,1fr) auto`，基础 `min-height: 184px`（紧凑 140px，大图 224px）。
- 卡片主体 `.clip-item-main` 改为纵向 Flex：正文/文件清单 `flex: 0 1 auto; min-height: 0`，
  元数据 `margin-top: auto`，动作行独立网格区域并贴底。
- 结果：同一行由最高内容决定行高，短卡把余量收进正文区；不同行仍是不同高度，不做整页统一
  最高行高。该策略保证了动作行基线；短文本行仍可能留出约 45px 正文余量（见第十二节 P2）。

### 4.2 信息架构与内容截断

- 第一层：类型、收藏/置顶、时间、预览中、选择框；
- 第二层：标题 → 正文/图片/文件/链接摘要；
- 第三层：来源应用、窗口、分辨率、大小、使用次数，统一贴底；
- 第四层：复制 + 目标窗口、收藏/置顶、更多。
- 舒适标题最多 2 行；正文 3 行起、560px 4 行、1000px 5 行（删除旧 1320px/6 行）；紧凑 2 行、
  列表 1 行。标题与预览相同时不重复渲染（图片标题=“截图 1280×720”时不重复、链接标题=域名且
  无路径时省略 URL 摘要、文件标题含数量）。紧凑卡 247px 宽时来源名保留、使用次数隐藏，避免
  “截图工具”被挤成“截”；次数仍在右栏/完整详情可见。
- 图片：宽图 `clamp(104px, 9cqi, 124px)`，竖图（高宽比 > 1.2）左侧纵向舞台
  `min-height: 186px; max-height: 206px`；`object-fit: contain` 不裁切；仍走 640 预览、
  视口内加载、LRU 与请求去重。
- 文件：文件名优先、类型降级、路径截断；数量只出现一次；删除历史不删除本地文件的说明保留。
- 链接：域名 + 真实标题 + URL 摘要 + 来源；不自动请求链接。
- 分组：封面、类型组成、条目数、更新时间、自动/手动标识；整组复制改为带文字按钮；删除进菜单。

### 4.3 操作收敛与预览态

- 删除动作行里的 `Maximize2` 详情按钮；卡片主体 → 右栏预览 → 右栏「完整详情」一条链路；
  页面宽度不足 1180px 或抽屉/独立页时主体仍回退到原完整详情。
- 复制保留文字按钮；目标窗口箭头与复制合成 `.clip-copy-split` 分体按钮，仍是两个独立动作，
  aria-label 明确「复制或粘贴到目标窗口」。
- 收藏/置顶保留图标切换，有 `aria-pressed`、`data-tip` 与激活态；窄卡收回更多菜单，不重复。
- `previewed?: boolean` 独立于 `selected`：左侧 2px 强调条 + 描边 + 顶行「预览中」标记；
  批量选择仍是勾选 + 选中底色；两者可同时存在。
- `previewId` 用不含排序的作用域键清理：筛选/搜索/分区变化立即收起，删除导致条目消失也清理；
  排序不打断预览。
- 右栏新增「关闭预览」图标按钮（只收右栏，不清批量选择）；`完整详情` 仍在右栏。

### 4.4 工具栏与筛选

- 工具栏拆为 `查找（搜索+排序+筛选导航）` / `视图密度` / `管理（批量+清理规则）` 三组；组间
  10px，组内 6px；760px 以下整组换行。
- 搜索框 `flex: 1 1 320px; min-width: 160px`；密度分段控件独立；批量与清理形成管理组。
- 左侧历史/分组加边框容器；时间/来源收进「时间与来源」折叠头，显示已生效筛选数量；类型、
  收藏、重置仍是独立组；重置改为分隔线而非第二个按钮边框。
- 收藏入口只在页面态侧栏出现；抽屉态才在工具条出现，避免重复。

### 4.5 列数策略（重要）

删除舒适/紧凑在 `@container (min-width: 1320px)` / `(min-width: 1920px)` 的强制 4/5/6 列规则。
列数现在完全由 `.clip-list-grid` 的 `repeat(auto-fill, minmax(300px, 1fr))`（紧凑 240px）
按 `.clip-page` **实际内容宽度**决定。实测：

| 窗口 | 内容区 | 筛选 | 列数 | 卡片宽 |
|---|---|---|---|---|
| 720×900 | 414 | 开 | 1 | 386 |
| 720×900 | 658 | 关 | 2 | 310 |
| 1024×900 | 718 | 开 | 2 | 340 |
| 1024×900 | 962 | 关 | 3 | 305 |
| 1280×900 | 974 | 开 | 3 | 309 |
| 1600×1000 | 1294 | 开 | 4 | 309 |
| 1920×1080 | 1614 | 开 | 5 | 309 |

> 不再为了“四列”把卡片缩小，也不在 1920 完整工作台打开右栏后强行保持四列；右栏由页面
> 本地回退提供时，1600 内容区变 974px、3 列，这是内容宽度的自然结果。

### 4.6 页面本地右栏（本轮新增）

- `ClipboardWorkspace` 引入 `WorkbenchDetailHostProvider`；新增 `localRailHost` state 与
  `pageRef`，用一个 `ResizeObserver` 观察 `.clipboard-page` 实际宽度，阈值 1180px。
- 有外壳宿主时继续用 `detailHost`；无宿主且页面足够宽时，在 `.clip-page-main` 右侧渲染
  `aside.wb-context.clip-local-rail`（320px，复用工作台右栏表面），`WorkbenchPageDetail`
  通过 provider 投送进该宿主。
- 无宿主且页面窄于 1180px、抽屉、独立页：`onPreview` 回退 `onDetail`，不强行挤占主内容。
- 没有改 `WorkbenchShell.tsx`、`pageDetail.tsx`，没有复制第二套检查器或第二套 Store。

---

## 五、前后对比

| 场景 | 旧实现 | 本轮 | 旧证据 |
|---|---|---|---|
| 第一行卡片底部 | 文字卡约 178px、图片卡约 390px，动作行错位 | 同行拉伸到同一底边；1600 文字卡约 201px、图片卡约 246px | `tmp/.../clipboard-workbench-responsive/shots/04-large-1600.png` |
| 列表元数据 | 大小/次数在右下角，与来源分离 | 来源、窗口、大小、次数统一贴底；列表 19 行、行宽 1266 | `07-density-list-1600.png` |
| 紧凑卡高度 | 元数据换行导致高度不一 | 标题单行、正文 2 行、元数据 nowrap，140px 起；1600 内容区 5 列 247px | `06-density-compact-1600.png` |
| 窄窗搜索 | 约 210px，控件换行 | 720 筛选开：内容 414、工具栏 70、搜索 510；工具栏整组换行 | `00-narrow-720.png` |
| 分组卡 | 复制仅图标、删除常显、中部空白 | 复制整组带文字、删除进菜单、主体按钮 + 贴底元数据；1600 内容区 3 列 417 | `12-groups-1600.png` |
| 详情入口 | 卡片动作行 + 右栏两个详情入口 | 卡片主体 → 右栏 → 完整详情一条链路；无宽右栏时回退完整详情 | 旧动作行 |
| 右栏预览 | 无关闭、卡片无预览标记；外壳无宿主时回退详情 | 页面本地右栏 320px；`previewed` 描边/左侧条/「预览中」；关闭与完整详情在右栏；07/08 为真实右栏 | `W06-rail-text-1600.png` |

---

## 六、功能回归

| 能力 | 结果 | 证据 |
|---|---|---|
| 舒适/紧凑/列表三密度 | 通过（jsdom + CSS 契约） | `ClipboardItemCard.test.tsx` 密度与 CSS 守卫；紧凑来源名不被次数挤掉 |
| 640 图片预览 / 懒加载 / LRU / 去重 | 通过（沿用未改） | `Media.test.tsx`、`ClipboardGroupLightbox.test.tsx` |
| 来源应用 / 记录时间筛选 | 通过（jsdom） | `ClipboardPanel.test.tsx` |
| 最近记录 / 使用最多排序 | 通过（jsdom） | `ClipboardWorkspace.scroll.test.tsx` |
| 重置筛选 / 左侧折叠 | 通过（jsdom） | `ClipboardPanel.test.tsx` |
| 右侧完整检查器 | 通过（浏览器页面本地右栏；真实外壳宿主仍未验收） | 07/08 实拍；`ClipboardPanel.test.tsx` |
| 收藏 / 置顶 / 多选 | 通过（jsdom） | `ClipboardItemCard.test.tsx`、`ClipboardPanel.test.tsx` |
| 单项 / 批量复制 | 通过（jsdom） | 同上 |
| 目标窗口复制与粘贴入口 | 通过（jsdom） | 分体复制测试、滚动测试 |
| 图片灯箱 | 通过（jsdom；真实窗口未执行） | `ClipboardGroupLightbox.test.tsx` |
| 分组 / 逐项粘贴 | 通过（jsdom） | `ClipboardGroupCard.test.tsx`、`ClipboardPanel.test.tsx` |
| 删除确认 / 失败恢复 / 滚动位置 | 通过（jsdom） | `ClipboardWorkspace.scroll.test.tsx`、Panel 删除用例 |
| 暂停 / 恢复 / 重启历史 | 未执行（真实 Windows） | 见第十节 |

> “通过（jsdom）”只说明组件契约与状态流；系统剪贴板、Win32 粘贴、真实灯箱窗口仍需真机。
> 不把 111 个 jsdom 用例的通过写成“功能全部可用”。

---

## 七、响应式测试

采集条件：Chromium 1243 / preview harness / DPR 1 / 浅色（深色单列一张）/ 合成夹具。
矩阵为 6 个尺寸 × 4 个变体（舒适+筛选开、舒适+筛选关、紧凑+筛选关、列表+筛选关），共 24 组。

| 窗口 | 舒适·筛选开（内容/列/卡宽） | 舒适·筛选关 | 紧凑·筛选关 | 列表·筛选关 |
|---|---|---|---|---|
| 720×900 | 414 / 1 / 386 | 658 / 2 / 310 | 658 / 2 / 311 | 658 / 1 / 630 |
| 800×900 | 494 / 1 / 466 | 738 / 2 / 350 | 738 / 2 / 351 | 738 / 1 / 710 |
| 1024×900 | 718 / 2 / 340 | 962 / 3 / 305 | 962 / 3 / 306 | 962 / 1 / 934 |
| 1280×900 | 974 / 3 / 309 | 1218 / 3 / 390 | 1218 / 4 / 292 | 1218 / 1 / 1190 |
| 1600×1000 | 1294 / 4 / 309 | 1538 / 4 / 370 | 1538 / 6 / 245 | 1538 / 1 / 1510 |
| 1920×1080 | 1614 / 5 / 309 | 1858 / 5 / 358 | 1858 / 7 / 255 | 1858 / 1 / 1830 |

24 组全部：`misalignedRows=0`、`overflowX=false`；列表变体 `cardCount=19`、行宽 630–1830。
右栏开变体只在 1600 页面实拍验证（07/08），未做 6 尺寸 × 右栏矩阵；DPR 仅 1；1740/2560 等
未测。结论：**浏览器渲染范围内，列数随内容宽度变化，无横向溢出、无同行底边错位、筛选折叠后
主内容自动扩展**。不能替代原生窗口/高 DPI 验收。

---

## 八、自动化、类型检查与构建

| 命令 | 工作目录 | 结果 |
|---|---|---|
| `npx vitest run src/components/clipboard/{ClipboardItemCard,ClipboardGroupCard,ClipboardPanel,ClipboardWorkspace.scroll,ClipboardGroupLightbox,Media}.test.tsx`（经 build-sched，任务 `l-mwnegpfe-8b9fe6`） | 仓库根 | **exit 0，6 文件 / 111 测试全部通过**（18:21:18 起，60.94s；日志 `.git/taskdock-build-sched/logs/l-mwnegpfe-8b9fe6.log`） |
| `tsc --noEmit`（包含在最终 `npm run build` 内） | 仓库根 | **exit 0**；最终构建任务 `m-mwneik0l-dd2356` 日志 `.git/taskdock-build-sched/logs/m-mwneik0l-dd2356.log` |
| `npm run build`（最终，任务 `m-mwneik0l-dd2356`） | 仓库根 | **exit 0**，`tsc --noEmit && vite build`；2186 modules，vite 59.20s；任务 124s；日志 `.../m-mwneik0l-dd2356.log` |
| `dist/index.html` SHA256 | 仓库根 | **`3632F251E88C958D2718208A262332C3EAB51A476EFE719D6058B142E98E0967`**（短标识 `3632F251E88C`） |
| `node tmp/acceptance/clipboard-ui-polish-20261119/shot.mjs` | 仓库根 | **exit 0，`screenshots=15 matrix=24 errors=0`**；15 张全部 `clippedCards=0/overflowX=false` |
| Rust 定向测试 | — | 未执行：本轮未改 `src-tauri/` |

**构建边界（必须读）**

- 最终 `npm run build` 一次通过（tsc + vite）。此前同一工作树的早期版本曾出现一次 vite 运行期
  OOM（exit 3221226505，任务 `m-mwne1za0-bc40b8`），重试后通过；该记录保留在调度日志中，
  不作为本轮最终构建结果，也不据此判定代码错误。
- 截图与矩阵来自最终 `dist` 产物 + preview harness；不是集成快照，不是正式安装包。
- 按 `AGENTS.md` §5.2，正式测试安装包仍应只从集成快照构建；本轮未生成正式包。
- 按 `AGENTS.md` §5.4（截至 `27f7e11` 已加入的测试规则），后续交互迭代应先用
  `npm run tauri dev` + `TASK_DOCK_DATA_DIR` 隔离自测，不再每改一处打整包；dev 结论不能充当
  验收证据。

---

## 九、截图索引

正式目录：`docs/screenshots/clipboard/2026-11-19/`；逐张窗口、内容宽度、DPR、密度、列数、
图片高度、横向溢出、裁切数、代码版本与构建标识见同目录 `manifest.json`（本轮 `codeVersion=27f7e11`、
`codeDirty=true`、`buildId=3632F251E88C`、`buildSha256=3632F251…E0967`）。

| 文件 | 场景 | 实测要点 |
|---|---|---|
| [`01-default-light.png`](../screenshots/clipboard/2026-11-19/01-default-light.png) | 1600×1000 默认：浅色、舒适、筛选展开 | 内容 1294、4 列、卡 309、5 行、错位 0；宽图舞台约 114、竖图舞台 186–206 |
| [`02-card-alignment.png`](../screenshots/clipboard/2026-11-19/02-card-alignment.png) | 同页下滚：混合图片/文字行 | 内容 1294、4 列、5 行、错位 0 |
| [`03-long-text.png`](../screenshots/clipboard/2026-11-19/03-long-text.png) | 长文字：标题 2 行、正文上限 | 内容 1294、单卡 309；正文上限由 `--clip-text-lines` 控制 |
| [`04-image-card.png`](../screenshots/clipboard/2026-11-19/04-image-card.png) | 竖图：不裁切、固定舞台 | 1024 内容 718、2 列、卡 340；竖图舞台 186–206 |
| [`05-files-card.png`](../screenshots/clipboard/2026-11-19/05-files-card.png) | 多文件：文件行与元数据 | 1024 内容 718、2 列、卡 340 |
| [`06-groups.png`](../screenshots/clipboard/2026-11-19/06-groups.png) | 分组：整组复制、删除菜单 | 1600 内容 1294、3 列、卡 417、10 组、4 行、错位 0 |
| [`07-preview-text.png`](../screenshots/clipboard/2026-11-19/07-preview-text.png) | **页面本地右栏**（文字） | 内容 974、3 列、`railOpen=true`、`detailFallback=false`、`previewedCards=1` |
| [`08-preview-image.png`](../screenshots/clipboard/2026-11-19/08-preview-image.png) | **页面本地右栏**（图片） | 内容 974、3 列、`railOpen=true`、`detailFallback=false`、`previewedCards=1` |
| [`09-batch.png`](../screenshots/clipboard/2026-11-19/09-batch.png) | 批量选择 3 项 | 内容 1294、4 列、5 行；选中态与预览态独立 |
| [`10-compact.png`](../screenshots/clipboard/2026-11-19/10-compact.png) | 紧凑密度 | 内容 1294、5 列、卡 247、缩略图保留、正文 2 行、140px 起；来源名完整、使用次数隐藏 |
| [`11-list.png`](../screenshots/clipboard/2026-11-19/11-list.png) | 列表密度 | 内容 1294、1 列、19 行、行宽 1266、缩略图保留 |
| [`12-dark.png`](../screenshots/clipboard/2026-11-19/12-dark.png) | 深色主题 | 内容 1294、4 列、卡 309 |
| [`13-narrow.png`](../screenshots/clipboard/2026-11-19/13-narrow.png) | 720 窄窗 | 内容 414、1 列、卡 386、工具栏 70（两行）、搜索 510、无横向溢出 |
| [`14-medium.png`](../screenshots/clipboard/2026-11-19/14-medium.png) | 1024 中等窗口 | 内容 718、2 列、卡 340、10 行 |
| [`15-wide.png`](../screenshots/clipboard/2026-11-19/15-wide.png) | 1920 大窗口 | 内容 1614、5 列、卡 309、4 行、无横向溢出 |

**截图边界**

- 15 张全部来自本轮最终代码的 `dist` + preview harness，不是设计稿，也不是 Windows 原生窗口。
- 07/08 的 `railOpen=true`、`detailFallback=false`：来自页面本地右栏，不是外壳 `.wb-detail-slot`；
  窄窗/抽屉仍走完整详情回退（1024 下未拍右栏，因为页面宽度低于 1180 阈值）。
- 06 是 3 列，不是旧文档写的 2 列；15 是 5 列 309px，不是旧的“1162px/3 列”。
- 夹具只含合成数据；无真实剪贴板正文、私人路径、聊天内容或令牌。

---

## 十、真实 Windows 验收

**未执行。** 原因不是代码阻塞，而是共享机器上另一会话的 `task-dock.exe`
（`task-dock-worktrees/r11-native`，任务进行时占用唯一真机实例）；本轮未取得抢前台、
操作他应用或终止该进程的授权，也没有为本轮单独构建并启动隔离实例。以下项目因此没有本轮结论：

- 系统文字 / 图片 / 文件采集；
- 复制回系统剪贴板；
- 指定窗口粘贴、逐项粘贴；
- 图片灯箱打开、切换、关闭、返回（历史遗留：曾出现窗口未响应）；
- 紧凑/列表切换、批量操作、暂停/恢复、重启历史恢复；
- 文件采集失败历史问题的复测；
- 真实窗口圆角、DWM 材质、贴边吸附、多显示器与 125%/150% DPI。

不以 jsdom 或浏览器截图替代以上真机结论。后续如获授权，应按 `docs/ACCEPTANCE_ROUTING.md` 在
`TASK_DOCK_DATA_DIR` 隔离实例上重新执行，并把结果追加到本报告（不改写本次结论）。

---

## 十一、性能

- 未新增轮询、订阅、全局监听或第二套图片缓存；预览态只是 class 与一个 `previewId`。
- 图片仍按可视区加载 640 预览，192px 缩略图兜底，48 条 LRU 与请求去重未改。
- 卡片等高使用网格拉伸与内部 Flex，不引入 JS 测量每张卡高度；页面本地右栏只增加一个
  `ResizeObserver` 观察 `.clipboard-page` 宽度，不逐卡监听。
- 未做原生 CPU/内存/滚动帧率采样；不以单次截图宣称性能通过。结论为**部分通过**。

---

## 十二、遗留问题

| 级别 | 问题 | 影响 / 后续 |
|---|---|---|
| P2 | 短文本在含图片/文件卡的同行仍保留约 45px 正文余量 | 已从上一版约 100px 降到约 45px；等高策略优先保证动作基线，不强行拉长正文。若产品要求完全无空白，需要另立“同排缩略图/分区模板”设计，不在本轮范围 |
| P2 | 外壳仍没有给剪贴板下发 `detailSlot` | 本轮以页面本地右栏解决 1600 页面预览；若后续 `WorkbenchShell.tsx` 恢复宿主，应再做一次外壳宿主定向复测，避免两套右栏同时出现 |
| P2 | 真实 Windows 链路未执行 | 采集、粘贴、灯箱、暂停恢复仍无本轮真机结论 |
| P2 | 截图 DPR=1 | 未覆盖 125%/150%；原生验收补测 |
| P3 | 列表密度行高约 60–150px、元数据分两段 | 11-list 已可扫描，但比严格“单行”更松；是否进一步压成 56–64px 需产品确认，不擅自改 |
| P3 | `ClipboardWorkspace.tsx` 工具栏/筛选 JSX 缩进未统一 | 项目无 prettier/eslint 配置；为避免整文件格式化扩大 diff，未做纯格式整理 |
| P3 | 截图依赖手工 preview server | `serve-preview.mjs` 曾自动退出；重跑前需确认 4181 返回 200；未改为常驻服务，避免新增进程 |
| P3 | 分组卡 3 列 / 1920 4 列与历史文档冲突 | 旧文档的 2 列/3 列已过时；本报告与截图 README 已按 1294/3、1614/4 更正 |

---

## 十三、文档与证据

| 项 | 位置 |
|---|---|
| 本报告 | `docs/clipboard/14-2026-11-19-ui-polish-acceptance.md` |
| 模块 UI 文档 | `docs/clipboard/07-ui-and-integrations.md` §14.8（本轮设计决策；历史 §14.7 保留） |
| 正式截图 | `docs/screenshots/clipboard/2026-11-19/`（15 张 + `manifest.json`） |
| 截图总索引 | `docs/screenshots/README.md`（README 图 / 历史验收 / 设计迭代 / 临时证据） |
| 证据索引 | `docs/clipboard/evidence/README.md`（顶部「当前有效入口（2026-11-19）」） |
| 原始矩阵 / 截图脚本 | `tmp/acceptance/clipboard-ui-polish-20261119/`（`matrix.json`、`shot-results.json`、`shot.mjs`；临时证据，不进正式目录） |
| 历史材料 | `docs/clipboard/01`–`13` 未覆盖；`tmp/acceptance/clipboard-workbench-responsive/` 保留为原始工作记录，正式结论以本报告为准 |

**维护约定**

- 历史截图目录 `v05/v06/v07/readme-20261108` 不删除、不重命名；正式目录只归档本轮最终确认图。
- 临时目录被 `.gitignore` 忽略；不要把临时截图复制回正式目录冒充最新证据。
- 后续若调整卡片留白或恢复外壳右栏宿主，应新增日期报告/截图目录，并在本报告第十二节追加
  “已修复/已复测”说明，不直接改写本次“部分通过”的历史结论。
