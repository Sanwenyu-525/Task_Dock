# 手机端视觉与交互规范

> 目标：触摸优先、信息密度高、**没有阴影陷阱**。规范条目若与代码不一致，以代码为准并回写本文。

## 1. 设计方向

保留产品既有的蓝/藏青识别色与语义 Token 体系，形态是 **Flat + 色块分区**，
在「实色表面」之上加两层克制的层次（第四轮，2026-11-14）：

- 表面不透明；卡片分三级（`GlassCard level`）：一级卡（今日专注/设备状态/项目摘要）用强一档描边 +
  极轻 `elevation`，二级卡（普通内容组）用 hairline，三级容器（工具图标组）不用边框。
- 分区用色块（图标底板、分组色条、标签胶囊）而不是加更多卡片边框。
- 字阶对比拉大：页标题 24/800，正文 14，元信息 13，标签 12。
- 动效轻量：只做透明度与 transform，尊重系统「减少动态效果」。

**图标**：统一 `AppIcon`（`src/components/icons/`）。几何取自项目已有的 lucide 图标
（桌面端 `lucide-react` 已在用同一套），构建期栅格化成单色位图，运行时只做 `tintColor`。
不引入运行时图标库、图标字体或 Emoji；新增/修改语义必须更新 `iconMap.json` 并运行
`npm run icons:generate`（生成器 `apps/mobile/scripts/gen-ui-icons.mjs`，路径全部相对脚本位置，
不依赖盘符或用户名），`npm run icons:check` 只校验生成物是否最新、不写文件。
少量业务图标可在 `iconMap.json` 的 `overrides` 里沿用 lucide 文件轮廓做同语言微调（如 PDF 的 P）。

**品牌**：应用自身标识只用 `BrandMark`（蓝→青渐变圆角方块 + 白色 `</>`），
不得复用 `project` / `workspace` / `boxes` / `folders` 等功能语义，也不允许页面各画一个方块。

明确不采用：半透明玻璃卡片、整块渐变背景、夸张投影、大圆角玻璃拟态、自定义字体
（字体需要新增资产依赖，未经授权不引入）。

## 2. Token

### 2.1 颜色角色（`src/theme/tokens.ts`）

按**用途**命名，不按颜色命名。三个蓝必须分开：`accent`（品牌蓝，图标/装饰）、`accentText`
（功能蓝，小字号文字）、`accentFill`（填充，承载白字）。同一个蓝既做文字又做按钮底色时，
只改一个值就会有一边掉到 4.5:1 以下（`#1677FF` 白底只有 4.10:1，小字不合格）。

| 角色 | 用途 | 浅色 | 深色 |
|---|---|---|---|
| `bg` | 窗口底 | `#F7FAFE` | `#080E1A` |
| `bgAccent` | 次级底（输入区、Tab 栏） | `#EEF5FD` | `#0D1523` |
| `card` / `cardSolid` | 一级卡片（不透明） | `#FFFFFF` | `#111A28` |
| `cardDone` | 已完成行表面 | `#EFFBF9` | `#0E211F` |
| `cardBorder` | 卡片 hairline | `#E8EDF4` | 蓝灰 14% |
| `sheet` | 弹层底板 | `#FFFFFF` | `#131C2B` |
| `overlay` | 弹层遮罩 | 深色 46% | 更深 66% |
| `text` / `textSoft` / `muted` / `faint` | 四级文本 | `#172033` / `#3C4B63` / `#5E6D82` / `#7D8DA4` | 由亮到暗 |
| `accent` | 品牌蓝：**图标/装饰/非文本强调**（白底 4.10:1，小字禁用） | `#1677FF` | `#7FB3FF` |
| `accentText` | 功能蓝：**小字号文字/链接/标签**（白底 5.91:1） | `#0B5FCF` | `#8CC0FF` |
| `accentFill` | 强调**填充**（承载白字，≥4.5:1） | `#0D66E0` | `#0D66E0` |
| `accentSoft` | 强调底色（选中胶囊） | 10% | 16% |
| `accentAlt` | 辅助青蓝（装饰色块/分区标识） | `#35B8F5` | `#67C8F7` |
| `brandBase` / `brandBaseAlt` | 仅 `BrandMark` 的蓝→青渐变 | `#1677FF` / `#35C2F5` | `#2F7BEF` / `#36C0F2` |
| `accentWash` | 浅蓝水洗底（欢迎区/占位底板） | `#EAF4FF` | 青蓝 14% |
| `ok` / `okSoft` / `onOk` | 成功（勾选，文字与白勾均 ≥4.5:1） | `#0A7A6F` | `#3ED6C6` / 深色勾 |
| `warn` / `warnSoft` | 警示（逾期、待同步） | `#8A5006` | `#F0B45B` |
| `danger` / `dangerFill` / `onDanger` | 危险（删除、拒绝） | `#BE332B` | `#FF837C` / `#B5342C` |
| `track` | 中性轨道/中性磁贴 | `#EEF3FA` | 蓝灰 12% |
| `separator` | 分割线 | `#E8EDF4` | 蓝灰 10% |

规则：

- 深色下 `ok` 很亮，勾选符号必须用 `onOk`（深色），白勾会糊。
- 语义色只用于状态，不做装饰；0 值统计一律中性底。
- 组件里不允许出现字面量色值（`#fff`、`rgba(...)`），只能用 `tokens.*`。
- 对比度是契约而不是审美：`src/theme/__tests__/contrast.test.ts` 按 WCAG 分别对浅/深色断言
  正文 4.5:1、图标 3:1、填充白字 4.5:1；调色值前先跑该测试。
  浅色实测：`text` 16.27、`textSoft` 8.83、`muted` 5.27、`faint` 3.38（仅装饰）、
  `accentText` 5.91、`onAccent`/`accentFill` 5.26、`ok` 5.22、`warn` 6.50、`danger` 5.68。

### 2.2 间距 / 圆角 / 字阶

```ts
space  = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, section: 20, xl: 22, xxl: 30 }
radius = { card: 20, row: 16, control: 12, tile: 12, sheet: 28, chip: 999 }
font   = { page: 24, display: 30, stat: 26, section: 17, title: 16, reading: 15,
           body: 14, meta: 13, label: 12, tab: 11 }
```

`font.page` 是一级页标题；`font.section` 是模块标题（区域标题/卡片标题）；
`font.display` 只保留给启动层/引导。第三轮把正文 13→14、辅助说明 12→13、标签 11→12，
**11sp 只剩 `font.tab`**（TabBar 这类纯导航短词，靠字重与选中色保证识别）。
`space.section` 是工作区/工具/我的页的模块间距（20dp），页面内小间距仍用 `space.md`。

硬下限：

- 可点区域 ≥ 44dp；Tab 项 ≥ 52dp，FAB 58dp。
- 正文不小于 14dp；辅助说明 13dp；标签 12dp；只有 TabBar 导航词用 11dp。
- 页面左右留白统一 `space.lg`（16dp），列表底部留 96dp 给浮动 TabBar。

## 3. 表面硬规则（每条都有真机根因）

1. **半透明卡片不许用 `elevation`。** Android 把阴影画在视图下方，半透明卡片会把阴影透出来，
   浅色模式下表现为卡片里嵌一块矩形白/灰框。四级调整（2026-11-14）：表面已全部改实色，
   因此**只允许一级卡（`level="primary"`）**用 `cardShadow()` 的 2dp 轻阴影 + 强一档描边，
   二级/三级卡仍然零 `elevation`。半透明表面 + 阴影的组合仍然禁止。
2. **表面必须不透明。** `card`、`cardSolid`、`cardDone`、`sheet` 都是实色；
   `cardSolid` 语义是「需要完全遮住下层时用的合成色」，滑删层依赖它。
3. **所有 `TextInput` 显式给底色 + `underlineColorAndroid="transparent"`。**
   Android 默认 `EditText` 背景是直角白色块，浅色主题下与圆角卡片叠在一起就是「白方框」。
4. **滑删只有一个方向**：手指向左滑，删除按钮从右侧露出。红底外圈圆角与卡片一致
   （`radius.row`），内侧保持直角；容器补不透明底色并把红底比卡片内缩 1dp，
   否则沿半透明描边下缘会透一条红线。
5. **红底透明度跟随位移**：闭合时 `opacity: 0`。卡片入场是淡入动画，红底若常驻挂在
   卡片下方会透出来，表现成「切页时闪一下删除按钮」。
6. **开启过程中卡片右侧圆角收成直角**：红底内侧是直角，卡片右边若保持圆角，
   两块拼在一起会露缺口。圆角插值必须与位移动画使用**同一个驱动**（都走 JS），
   混用 native/JS 会让节点被标记为 native 并抛异常崩溃（真机实测）。
5. 浮层（TabBar）才允许 `barShadow`；`floatingShadow` 只给真正悬浮的控件。

## 4. 组件清单与约束

| 组件 | 职责 | 约束 |
|---|---|---|
| `GlassCard` | 卡片表面（三级） | `primary` 强描边 + 极轻阴影（只给今日专注/设备状态这类重点卡）；`secondary`（默认）实色 + hairline；`tertiary` 无边框浅蓝容器（图标组、未接入占位）。半透明表面仍然禁止 |
| `SwipeRow` | 双向滑删容器 | 红底圆角/内缩见 §3；卡片表面色由 `surface` 传入，必须不透明 |
| `TaskRow` | 任务行 | 标题 16/600，最多两行；**三个热区互不重叠**：左侧 44dp 勾选区只切换完成/恢复、行主体轻点打开 `TaskEditorSheet`、任意区域长按开动作表、左滑删除；优先级/截止/逾期/重复/标签用 12sp 胶囊（优先级只显示「高/中/低」一字，完整语义进无障碍文案；截止 accentSoft + 时钟，逾期 warnSoft）；完成态淡青底 + 白勾 + 标题删除线。交互路由由 `src/domain/taskRowAction.ts` 定义并有回归测试 |
| `TaskGroupHeader` | 分组头 | 24dp 语义图标底板（24/8 圆角，色调随分组）+ 13/700 标题 + 数量 + 折叠箭头 + 右侧细分隔线 + 可选的逾期/恢复提示胶囊；有 `onPress` 时整行可点，箭头随开合转向 |
| `MetricTile` | 统计磁贴 | 18dp 语义图标 + 26sp/800 数字 + 12sp 标签，左对齐；`variant="column"` 由调用方放进一张卡（首页效率概览、设置页摘要都是「一张卡三段」）；0 值图标/数字退回中性色；只接收真实统计值（`StatCard` 已删除，避免两套统计组件） |
| `TabBar` | 底部导航 | 浮动圆角栏 + 滑动指示胶囊；**5 个一级栏：首页 / 任务 / 工作区 / 工具 / 我的**，图标走 `AppIcon`（home / tasks / workspace / tools / profile，22dp），选中项 accent 图标 + `accentText` 文字 + `accentSoft` 胶囊；点击项 ≥54dp |
| `ScreenHeader` | 一级页顶栏 | 56dp，标题 `font.page` + 右侧 44dp 图标插槽；不参与内容滚动 |
| `BackButton` | 二级页返回 | 44dp 命中区，`AppIcon name="back"`（22dp），仅在 `onBack` 传入时渲染 |
| `AppIcon` | 全站唯一图标出口 | 语义名 → lucide 几何（或 `iconMap.json` 的 `overrides`）；按尺寸自动选 md(96px)/sm(64px)/lg(128px) 位图，保证 16→32dp 视觉重量一致；`tintColor` 着色，`fadeDuration=0` 防闪烁；生成物带 `ICON_MAP_HASH`，测试会拦住「改了映射没重跑生成器」 |
| `FileTypeIcon` | 文件类型图标 | 形状由 `fileTypeKind` 决定（PDF 用文件轮廓 + P，Markdown 用文件 + 笔），颜色取自语义 Token（PDF danger、文档 accentText、表格/音频 ok、演示/压缩/APK warn、代码/视频 accent、文本/通用 muted）；传出的方向由外层底板表达，不再用同一套灰色 |
| `IconTile` | 图标底板 | `primary` 浅蓝渐变底 + 细描边 + 蓝线图标（真实入口）；`neutral` 中性底 + 灰线（未接入）；圆角 = 边长的 30%；品牌块不再走这里，统一 `BrandMark` |
| `BrandMark` | 应用品牌标识 | 蓝→青渐变圆角方块 + 白色 `</>`；24/32/46/64dp 四档；不得复用 `project`/`boxes` 等业务图标 |
| `FeatureIconPlaceholder` | 未接入能力占位 | 图标+名称(+说明)，`accessibilityState.disabled`，不可点、不渲染二级页；`compact` 用 46dp 中性底板并与 `IconEntry` 同为 85dp 内容高度，同一行内图标/文字基线对齐；`inline` 变体可省略 `label`（模块标题已写明名称时不重复） |
| `ClampedText` | 长文本限高 | 默认 N 行，用透明同宽文本量真实行数决定是否显示「展开全文」；收集箱长速记固定 5 行 |
| `IconEntry` | 四列真实入口 | 46dp `IconTile` + 12sp 名称，`badge` 只传真实计数 |
| `SectionHeader` | 区域标题 | 图标 + 标题 + 右侧动作；无 `onAction` 时动作文字置灰不可点 |
| `ProjectSpaceCard` / `ProjectSpacePlaceholder` | 项目空间 | 卡片字段全来自 `workspace_projects` 语义；未同步时渲染 72dp 无边框浅蓝占位 + 36dp 中性图标，视觉权重低于「常用工具」，卡内不重复模块标题 |
| `FileCollectionCard` | 文件集合 | 三列文件夹卡；有 `onPress` 才是真实入口（白卡 + 描边 + 蓝色图标/说明），否则标注「暂未接入」（浅蓝无描边面板 + 中性图标） |
| `Chip` | 筛选/选项 | 选中用 `accentFill` 承载白字（不是 `accent`） |
| `SegmentedControl` | 分段控件 | 内容由调用方渲染；只负责轨道、滑动指示器、无障碍语义 |
| `BottomSheet` | 弹层基座 | 全应用唯一弹层手感；关闭动画播完再卸载；减少动效时直接呈现 |
| `ActionSheet` | 长按动作表 | 替代原生 Alert；只回调不改数据 |
| `TaskEditorSheet` | 任务编辑器 | 三态提交；重复预设；标签与相对提醒见 §6 |
| `SearchField` | 搜索框 | 44dp；`AppIcon` 放大镜与清除按钮；清除按钮要有 label |
| `Toast` | 轻提示 | 位置跟随操作区：顶部/中部操作、列表行与加载错误置顶（推送页在 AppBar 下 8dp，Tab 页贴页面顶端）；FAB、底部主按钮、底部工具行与长按动作表触发的提示贴底，并避开 FAB/工具栏/键盘/安全区。2.4s 自动淡出、不拦截触摸；用 `id` 区分同文案连续提示 |
| `EmptyState` | 空态 | 说「下一步做什么」，不只说「没有内容」 |
| `PressableScale` | 按压回弹 | 只做 transform + native driver；减少动效时不缩放 |
| `CaptureCard` | 收集箱卡片 | 底部一行两动作，44dp 命中区；退出动画由父级控制卸载时机 |
| `AppBar` | 推送页顶栏 | 自绘返回箭头 + 16/600 标题 + 徽标/动作插槽；返回热区 ≥44dp |
| `Badge` | 规划状态徽标 | `planned`（accentSoft 底/accent 字）与 `unimplemented`（track 底/muted 字） |
| `ToggleSwitch` | 开关 | RN 核心 Switch 包 token 配色；disabled 态交系统渲染 |
| `SettingSection` | 设置分区块 | GlassCard + 24dp 图标底板标题（图标随 section 语义）；头部右侧可挂徽标 |
| `SettingRow` | 静态信息行 | label 左 / value 右；`valueTone="muted"` 表达未配置/规划值 |
| `SettingActionRow` | 可点设置行 | label(+helper) + 尾部插槽 + 可选箭头；命中区 ≥44dp；无 onPress 退化为静态行 |
| `StatusPill` | 状态胶囊 | 状态点 + 文案，ok/warn/danger/neutral 四态 |
| `NoteCard` | 笔记卡片 | 标题（空标题回退摘要）+ 两行摘要 + `revision·时间`；置顶图钉在 footer 右侧；45 行内不出现滑删 |

新增组件前先确认：现有组件是否只差一个 tone/prop。禁止另造平行按钮、平行卡片。

## 5. 页面信息架构

**首页（第 1 个 Tab，工作台）**

```
工作台                              [通知]
┌ 早上好，开发者           [BrandMark] ┐   ← 白→accentWash 渐变欢迎区，92dp
│ 专注重要的事，高效推进…（320/130%+ 用短句）│
└──────────────────────────────────────┘
🎯 今日专注
   当前专注 [待处理]    任务标题 21sp（最多两行）
   [中] [🕒 截止时间] [分类]
   ─────────────────────────────
   任务页可查看全部待办             [去处理 ›]
📈 效率概览                查看详情 ›
   [icon 待办 15] [icon 今日 0] [icon 完成 9]   ← 一张卡三段，320dp/大字号不裂
📄 最近内容                  更多 ›
   笔记/速记 × 最多 3 条（真实 updatedAt 倒序）
⊞ 快捷入口
   [新建任务] [收集箱] [笔记] [文件互传]
   AI 助手（仅占位，不可点）
```

所有数字来自本机 SQLite（`listTasks` / `listNotes` / `listCaptures`）；没有进度字段的任务
不推算百分比，任务模型只有 pending/completed 两态。

**任务页（第 2 个 Tab）**

```
任务                              [搜索] [+]
今天 11月13日 周五                ← formatDayLabel(now)，分钟级刷新
[全部] [未完成] [今天] [逾期] [已完成] ← 筛选胶囊
（搜索默认收起；点右上搜索图标展开 SearchField，关闭时清空 query）
[待办 15] [今天 0] [逾期 2] [完成 9] ← 紧凑统计条，320dp/大字号自动 2×2
── 今天（3）▾ ─────────────        ← 点击整行折叠/展开
  任务行…
── 本周（2）▾ ─────────────
  任务行…
```

新建入口为页头 `+`、空态按钮与首页「新建任务」快捷入口，三者共用 `TaskEditorSheet`；
第二轮已移除右下 58dp FAB，避免与固定 TabBar、键盘和安全区争抢空间。空态提示为「点右上角 +」。

**任务行交互（第三轮，防误触）**：轻点左侧 44dp 勾选圈 = 完成/恢复；轻点行主体 = 打开编辑
（同一个 `TaskEditorSheet`，不新增详情页）；长按 = 动作表；向左滑动 = 删除。
整行轻点**不再**切换完成——曾导致用户想查看内容时误打卡。

分组固定顺序：今天（含逾期）→ 本周 → 以后 → 无日期 → 已完成。
逾期项并入「今天」，分组头右侧提示「N 项已逾期」。折叠后只保留分组头与计数，
箭头转为向右；折叠是纯展示状态，不写库、不改变筛选与排序。

**工作区（第 3 个 Tab，蓝青专业版核心页）**

```
工作区                                ← 页头不放 disabled 搜索/新建（不可用不做视觉承诺）
[ 项目空间 | 我的工作区 ]              ← 分段，选中项 accent 实底白字
▦ 我的项目空间
   ┌ 项目数据尚未同步到手机   ┐        ← 76dp 紧凑占位，卡内不重复「项目空间」
   └ 接入后在这里查看项目与事项 ┘
📌 常用工具
   [收集箱] [笔记] [文件互传] [同步中心]  ← 四项固定真实入口，无自定义排序
📡 协作动态
   项目活动尚未同步到手机             ← inline 占位，不展示假头像/提交/时间
📁 文件集合
   [文件互传·真实] [文件暂存架·占位] [项目资源·占位]
```

「常用工具」只是固定快捷入口，不代表已实现用户自定义置顶；没有置顶配置时不展示「编辑」伪按钮。

点「我的工作区」后切换为 2×2 占位网格：场景工作区 / 开发工作台 / 工作现场 / 工作流，
均为 `FeatureIconPlaceholder`（不可点、无二级页），避免出现没有真实数据的空详情页。
**Project Workspace ≠ Planning Project ≠ Scenario Workspace ≠ Dev Workbench ≠ File Shelf**：
本轮手机端没有 `workspace_projects` 同步链路，不新增端点、迁移或同步协议，也不填演示项目。

**工具页（第 4 个 Tab）**

```
工具                                [通知]
▦ 常用工具   [收集箱] [笔记] [文件互传] [同步中心]  ← 全部真实
⚡ 效率工具   [快速笔记] [剪贴板] [文件暂存架] [工作流]  ← 快速笔记=直接新建（真实），后三占位
⌨ 开发工具   [代码片段] [API 调试] [JSON 格式化] [正则测试]  ← 仅占位
```

第三轮删除了重复的「收集与暂存」分区：上一版把收集箱/文件互传/文件暂存架在多个分区重复列出，
页面被拉长近一倍。现在每个能力只出现一次，已实现功能一个未删。
收集箱＝速记文本、文件互传＝局域网文件、桌面文件暂存架＝用户主动管理的资源：
三者是不同数据，互不冒充。

**我的（第 5 个 Tab）**

```
我的
[Task Dock · 开发效率中枢 · v版本]                ← 应用卡，44dp 图标
📱 设备与连接
   [已配对 / 需重新配对 / 本机模式] + 配对设备名   ← 状态独立小卡
   同步中心 / 文件互传 / 配对新设备 / 设备详情      ← 4 个高频入口
   处理冲突（真实冲突数） · 主屏小组件              ← 次要入口收成一行链接，仍可达
📄 个人功能     笔记（N 条）/ 收集箱（N 条）/ 通知
⚙ 设置与偏好   设置（主题、通知提醒、本地数据与关于）+ 本机数据摘要
```

设备状态只表达配对结果，不把「已配对」说成「已自动同步」。
第三轮把 6 行设备菜单压成「4 行 + 2 链接」：页面从长清单变成按频率分层的入口区。

**二级页（从工具/我的进入，隐藏 TabBar，硬件返回 = pop）**

收集箱页：标题 + 返回 + 计数副标题 → 录入区 → 搜索 → 卡片列表 → 空态。
录入区是一整块带底色的「可写区域」：输入框、「换行可继续写」提示与「记录」按钮
共用同一个 `inputShell` 底色与圆角，提示和按钮不再落在无色背景上。
设置页：标题 + 返回 → 3 块数据磁贴 → 外观（主题三态 + 预览）→ 提醒（权限状态 + 测试 +
通知与后台入口）→ 本地数据 → 关于（版本 / 后端 / 数据范围）。
**配对/同步/文件互传不再放在设置里**：它们是操作而不是偏好，统一收到「我的 → 设备与连接」。
笔记页：标题 + 返回 + 「N 篇 · 已配对 / 仅本机」→ 搜索 → 筛选胶囊
（全部/置顶/收藏）→ 置顶 / 全部笔记两组 → FAB。本机 CRUD 与同步均为真实能力，
**不挂「规划中」徽标**；同步状态按配对元数据实时读取。
设备页：标题 + 返回 + 「配对设备 {serverName} · 同步需手动发起」副标题 → 连接状态卡（桌面端名、地址、
上次连接、「已配对 / 未配对 / 需重新配对」三态；未配对时只留「配对新设备」主操作）→
「同步与传输」分组（同步中心、文件互传、处理冲突，冲突条数用 danger 胶囊）→
「连接与更多」分组（配对新设备、主屏小组件/分享接收带「已接入」徽标）→ 局域网说明。
新一级栏固定 5 项：首页 / 任务 / 工作区 / 工具 / 我的；旧「任务/收集箱/笔记/设备/设置」
五入口的迁移见 `src/lib/navigationMap.ts`（收集箱与笔记进工具栏，设备与设置进我的）。

### 推送页（App 内栈导航，隐藏 TabBar，硬件返回 = pop）

导航不引库：`App.tsx` Shell 持有 `Route[]` 栈（`src/lib/nav.ts` 定义 Route/Nav 契约），
栈非空时全屏渲染栈顶页并隐藏 TabBar；编辑页自带返回监听（先保存再关）。

| 页 | 入口 | 状态口径 |
|---|---|---|
| 笔记编辑 | 笔记页卡片/FAB | 真实 CRUD；返回即保存（空笔记丢弃）；pin/收藏即时落库；底部工具栏 加粗/列表/标签/分享（Share API） |
| 配对新设备 | 设备 → 配对新设备 | 真实配对：「扫描二维码 / 手动输入」分段 → 取景框（相机权限按需申请）或地址+6 位码 → 确认指纹 → 配对成功；失败按稳定错误码给可操作提示。取景框内扫描线上下往返（约 1.6s 单程，native driver），系统「减少动态效果」时静止居中 |
| 同步 | 设备 → 同步中心 | 真实已配对/未配对状态；显示桌面端名、地址、指纹、上次连接；可「测试连接」「立即同步」与「解除本机配对」；待发送操作=任务/笔记/收集箱 outbox 实数、上次接收=最近一次 pull 应用数、上次同步=接收/发送/冲突摘要；页头按配对状态显示「已配对 / 本机模式」，不把配对元数据等同于当前在线或上次同步成功；同步范围标注「任务 / 收集箱 / 笔记」 |
| 处理冲突 | 同步页「处理冲突」行 | 逐条展示冲突：实体标签（任务/笔记/收集箱）+ 标题或内容、原因（桌面端已更新/已删除等）、桌面端版本；操作「采用桌面端 / 保留本机」；无冲突时为空态 + 规则说明 |
| 文件互传 | 设备 → 文件互传 | 接收位置 + 「来自电脑 / 发往电脑」两组；底部固定「发送文件到电脑」，传输中切换为字节进度与取消；行内文件类型图标（PDF/文档/表格/演示/图片/视频/音频/压缩包/代码/文本/Markdown/APK/通用，形状区分类型、方向色区分来源），状态只在接收中/失败上色；支持下拉刷新 |
| 主屏小组件 | 设备 → 主屏小组件 | 预览 mock + 尺寸/内容/外观偏好存 kv `widget_prefs`；添加按钮给规划中提示 |
| 分享接收 | 设备 → 分享接收 | 路由参数收文本（将来接 intent-filter）；无内容空态；有内容时可真实存入收集箱 |
| 通知与后台 | 设置 → 提醒 | 真实：权限/测试通知/提醒动作开关（kv，见 01 §6）；vivo 后台警告卡；远程推送「未实现」、后台同步「规划中」均为不可用开关 |

## 6. 交互细节

- **滑删**：只允许向左滑出右侧删除按钮。横向位移 >10dp 且大于纵向 1.6 倍时接管手势，
  **两个方向都接管**（向右滑不露出按钮，但必须吸收，否则松手会被 Pressable 当成点击，
  把任务误标成完成）；超过 88dp 的 40% 吸附打开，向左甩（vx < -0.5）直接打开；
  已打开时向右拖/甩只关闭。打开过程中卡片右侧圆角同步收成直角。
- **分组折叠**：点分组头整行开合，带布局动画；减少动态效果时直接切换。
- **长按任务行**：打开动作表（完成本期/编辑/删除），危险项用 `danger`。
- **任务行热区**：勾选圈 44dp 只做完成/恢复；行主体轻点进编辑；两区不得共用 `hitSlop`，
  也不得把整行包成 `checkbox`。
- **重复预设**：不重复 / 每天 / 工作日 / 每周 / 每月；`by_weekday` 取当天，
  `anchor` 写本地日期 `YYYY-MM-DD`。
- **提醒**：无截止时间时给「不提醒 / 10 分钟后 / 1 小时后 / 明天 9:00」；
  有截止时间时切换为相对模式「不提醒 / 提前 10 分钟 / 提前 30 分钟 / 提前 1 小时」，
  并在提交时同时写 `remind_at` 与 `advance_minutes`。切换截止时间导致模式翻转时重置提醒选择。
- **标签**：空格/逗号分隔，提交时 trim + 去空；列表显示前 2 个 + `+N`。
- **完成重复任务**：提示「已完成本期，下次 X」，任务保留在列表中。
- **搜索**：标题、描述、分类、标签；结果计数带当前筛选说明；空查询等于不过滤。

## 7. 无障碍与减少动态

- 可点元素必须有 `accessibilityRole` 与可读 `accessibilityLabel`；图标按钮的 label
  要说明动作（「删除任务：写周报」），不能只写「按钮」。
- 卡片不是按钮时，不要给它 `accessibilityRole="button"` 抢走焦点。
- 滑删红底在未打开时 `accessibilityElementsHidden` + `importantForAccessibility="no-hide-descendants"`，
  打开后才可读可点。
- 数字用 `fontVariant: ["tabular-nums"]`，避免刷新时跳宽。
- 所有位移/弹簧动画统一走 `MotionProvider` 的 `reduceMotion` 判断。
- 对比度：正文与次级文本 ≥4.5:1；`faint` 只能用于装饰。

### 7.1 启动动效（冷启动）

原生启动图与 JS 启动层是**同一张「清单骨架」**，交接时不允许跳尺寸或跳位置。

- 原生图：`expo-splash-screen` 配置插件，`imageWidth=80`，浅色底 `#F3F5FA`、深色底 `#080D16`；
  图片由 `scripts/gen-splash.mjs` 生成（`assets/splash-mark.png` / `splash-mark-dark.png`），
  App 内改动几何后必须重跑生成脚本 + `npx expo prebuild --platform android`。
- JS 首帧：`LaunchOverlay` 画同一块 80×80 骨架（圆角 22、1dp 描边、3 行圆点 + 进度条），
  位置必须与原生图完全重合；`onLayout` 后等一帧再 `SplashScreen.hide()`，并把原生退出动画
  设为 0（`SplashScreen.setOptions({ duration: 0 })`）——默认 400ms 淡出会盖住动画开头，
  两边同构时硬切不可见。
- 启动层根节点必须带 `zIndex` / `elevation`（当前 1000）：TabBar 自带 `elevation`，真机实测
  会从无 elevation 的启动层背景里浮出来，底栏在启动动画期间一直可见。
- 动效顺序（约 640ms，只在进程冷启动播一次）：

  | 时间 | 动作 | 实现 |
  |---|---|---|
  | 0 / 80 / 160ms | 三行进度条从左端依次填充（200ms ease-out） | `scaleX` + 左端锚定位移，native driver |
  | 300ms | 首行圆点变蓝、白色勾选 spring 弹入（≈280ms） | `scale` + 轻微 `rotate` 回正，damping 14 |
  | 380ms | 字标「TaskDock」上移 8dp 淡入（240ms） | `translateY` + `opacity` |
  | 460ms | 说明文字「正在打开本地数据…」淡入（220ms） | `opacity` |
  | ≥640ms 且数据就绪 | 整体下沉 6dp、缩至 0.985、淡出 180ms，露出已挂载的主界面 | `translateY`/`scale`/`opacity` |

- 只动 `opacity` / `transform`；不出现 spinner。启动层不是「加载遮罩」——`Shell` 在下面
  已经挂载，退场只是揭幕。
- 减少动态效果：跳过全部位移/弹簧，直接呈现最终帧，数据就绪即卸载（不额外等待 640ms）。
- 例外说明：`LaunchOverlay` 直接读 `useColorScheme()`，因为 `kv.theme_mode` 尚未读出、
  `ThemeProvider` 还没挂载；颜色仍全部来自 `palette()`，不写色值。骨架的尺寸/圆角属于
  品牌图形几何（要与原生位图逐像素对齐），不受「不写死圆角」约束，但必须与生成脚本同步。

## 8. 禁止事项

- 不给二级/三级卡片加 `elevation` / `shadow*`；不用半透明卡片表面（一级卡的 `cardShadow()` 例外，见 §3.1）。
- 不写死颜色、圆角、间距；不从组件里直接读 `useColorScheme`（统一走 `useTheme()`）。
- 不新增运行时图标库、图标字体或 Emoji；不手绘通用图标（统一 `AppIcon`）。
  图标几何来自 `iconMap.json` 的 lucide 映射与少量 `overrides`；新增/修改语义要运行
  `npm run icons:generate`，提交前跑 `npm run icons:check`。
- 品牌标识只用 `BrandMark`，不复用 `project` / `workspace` / `boxes` / `folders` 等功能语义。
- 不做整块渐变、模糊、玻璃拟态。渐变只允许出现在四处：`IconTile` 底板、`BrandMark`、
  首页欢迎区、一级卡片的描边/阴影强调；都用 RN 原生 `backgroundImage` 与 `elevation`，
  不引第三方渐变库。文件类型色只能取语义 Token，不得给 13 种类型各配一种装饰色。
- 不用原生 `Alert` 做操作反馈（用 Toast / ActionSheet）。
- 不为了「更花」改业务语义（完成态、逾期分组、重复推进的文案与数据必须一致）。

## 9. 未验证项

> 2026-11-14 第五轮更正：下列前三项已在本轮真机复验（320/375/390/430dp、深色、130%/150%
> 字号均有截图，证据见 `tmp/acceptance/mobile-visual-system-v5/report.md`）。仍保留原记录以说明
> 当时的验证边界。

- 320dp 窄屏下的换行与溢出：**未复验**（本轮真机为 1080×2400 / 约 393dp）。
- TalkBack 完整朗读顺序：**未验证**（只检查了关键控件有 label）。
- 大字体（系统 200%）下的截断：**未验证**。
- 2026-11-08 新增 8 屏（笔记/编辑器/配对/同步/冲突/小组件/分享/通知与后台）：**真机未走查**，
  本轮验收到 tsc + 纯函数断言为止。

## 变更记录

- 2026-11-08 首版：记录第四轮重做的 Token、表面规则与组件约束。
- 2026-11-08 原型落轮：Tab 扩为 4 个（任务/收集箱/笔记/设置，与 DESIGN.md 对齐）；
  新增推送页栈导航与 9 个通用组件；页面 IA 补笔记页与 7 个推送页（对照
  tmp/acceptance/stitch-mobile-prototypes/ 的 v2 原型）。
- 2026-11-08 原型归档：v2 终版与 33 个导出变体迁入 [prototypes/](prototypes/README.md)；
  上条 `tmp/acceptance/stitch-mobile-prototypes/` 为生成期记录，归档后以 `prototypes/` 为准。
- 2026-11-08 启动动效：新增 §7.1（原生骨架图 → 三行填充 → 勾选弹入 → 字标上移 → 揭幕），
  含几何同步、640ms 最短展示、减少动态与深色原生图约定。
- 2026-11-08 真机走查修复（笔记/规划屏批次）：推送页顶栏移出滚动容器（滚动后返回箭头不再
  滚出屏幕，与编辑器/分享页一致）；配对页步骤条第 3 段不再被连接线压成竖排；规划中开关禁用态
  降透明度并改用中性 track（原 disabled 仍显示为蓝色「开」）；`ActionSheet` 无障碍前缀参数化
  （笔记不再播报「任务操作」）；笔记搜索时副标题显示「找到 N 篇 · 共 M 篇」；推送页打开时底层
  Tab 页置 `no-hide-descendants`（TalkBack 不再读到被盖住的内容）；键盘避让收敛到
  `lib/keyboard.ts` 单实现，笔记编辑器底部操作行/工具栏与分享页输入区不再被 IME 覆盖；
  编辑器工具栏 `paddingBottom` 让开手势条（`insets.bottom`）。
- 2026-11-08 配对落轮：配对/同步两页由「规划态」改为真实能力；补充扫码/手动输入分段、
  确认页、成功态、已配对连接卡与解除配对交互；小组件/分享接收仍保持规划徽标。
- 2026-11-08 批次二（子智能体并行）：新增语义色 `inkText`（恒暗表面上的文字，两套主题同值
  #B7C2D6；对 `ink` 浅色 9.88:1 / 深色 10.50:1），取景框虚线框与扫描线从 `accentSoft` 改 `accent`
  （原 10% 叠深底仅 1.09–1.31:1）；笔记预览新增 `plainPreview()`，`excerpt`/`noteDisplayTitle` 不再
  显示 `**`、`- [ ]`、`#` 等原始标记。另更正：`uiautomator dump` 会强制包含「不重要」视图，
  不能作为 `importantForAccessibility` 的验收依据，该项改由 TalkBack 实测。
- 2026-11-09 Toast 位置：由「全部贴屏幕底部」改为跟随操作区（顶部/中部操作、列表行与错误置顶；
  FAB、底部主按钮、底部工具行与长按动作表贴底）。新增 `ToastMessage.placement` 单条覆盖；
  顶部锚点复用 `APP_BAR_HEIGHT`，推送页底部提示补 `insets.bottom`，编辑器底部提示按
  「工具栏 56 + 安全区/键盘 + 8」计算（原 62dp 在安全区较大时会压到工具栏）。
- 2026-11-09 按 v2 原型对齐主 Tab 三屏与笔记细节（用户选定范围；字体仍用系统字体，不内置）：
  - 任务页：统计区由彩色胶囊改为**白卡 + 标签在上、数值在下**（`StatCard` 全局改版，设置页同步
    生效）；筛选 chips 移到搜索框上方，文案改为 `全部/未完成/今天/逾期/已完成`；页头日期改为
    `今天 11月9日 周一`（每分钟刷新，不再显示秒——副作用是任务页 `uiautomator dump` 恢复可用）；
    分组头计数改为 `(N)`，`N 项已逾期` 改为琥珀胶囊（`hintTone="warn"`）。
  - 收集箱：副标题 `N 条速记 · 仅本机保存`，占位 `随手记一条…`，按钮 `记下`，搜索占位
    `搜索收集箱`；卡片操作由描边胶囊改为**文字链接**（转任务/删除，保留 44dp 命中区）。
  - 设置页：统计卡改为 `任务/收集/已完成`（白卡）。
  - 笔记：卡片 footer 去掉「已收藏」，只保留 `revision N · 时间`；分组头计数同上改为 `(N)`。
  - 大字号兜底：`fontScale > 1.15` 时任务统计改为 2×2（`useWindowDimensions`），避免
    「已逾期/已完成」被截成省略号。
  - 有意保留的偏差：分组头仍保留折叠箭头（原型无折叠交互）；收集箱保留「任务页 →」入口；
    设置页「外观」保留三段预览缩略图与「手机与同步」节（后者承载真实的配对/连接状态）。
- 2026-11-09 UI/UX 择优合并（不再逐像素照抄原型，按语义与可用性取舍）：
  - 取原型：任务页「本机模式」由绿点灰胶囊改为 **accentSoft 蓝底标签**（绿点会被读成
    「已联网/已连接」，与实际语义相反）；任务行逾期改为 **warnSoft 琥珀胶囊**，与分组头的
    `N 项已逾期` 以及原型一致（红色留给优先级/删除）；设置页节标题右侧补 **hairline 分割线**，
    与任务分组头同一套「标题 + 细线」节奏；设置页「本地数据」改为真实读数（`SQLite vN · WAL`、
    待同步操作条数），替代原泛化说明；笔记卡片置顶图钉移到底部右侧，标题行不再被图标挤断。
  - 取现有实现：笔记页/编辑页移除「规划中」徽标（本机 CRUD 是真实能力，徽标会造成
    「整页未完成」的误读）；保留设置页主题三态预览缩略图；保留收集箱多行速记；保留分组头
    折叠箭头；FAB 继续用方形（与全局按钮语言一致，不回到原型的圆形）。
  - 修复：`AppBar` 徽标由 `alignSelf:"flex-start"` 顶到栏顶、视觉上跑到标题上方，改为包一层
    垂直居中容器（影响笔记编辑、小组件、冲突、分享、配对页的顶栏）。
  - 设置页「关于」的版本号改为直接读 `app.json`，不再手写字面量（此前 0.1.3 已落后于 0.1.5）；
    「发送测试通知」的次按钮描边从 `cardBorder` 改为 `accent`（浅色下灰 hairline 几乎不可见）。
  - Tab 图标换成原型的一套（原型用 Material Symbols 的 `check_circle / inbox / description /
    settings`）：任务＝**勾选圆**（始终描边，选中只转 accent，不是实心）、收集箱＝**近方形托盘
    + 底部 U 形开口**、笔记＝**带折角文档**、设置＝**齿轮**；尺寸按原型 22dp 重画。替换原来的
    列表/叠卡/文档/滑杆。仍全部用 View 绘制，不引入图标库。
  - 验证：tsc exit 0；release 构建成功；真机（vivo V2323A）浅色/深色抽查通过——蓝底模式标签、
    节标题细线、动态副标题、`SQLite v3 · WAL` 与待同步条数、版本 `0.1.5`、笔记图钉与编辑页顶栏
    对齐、四枚新 Tab 图标的选中/未选中态均符合预期。逾期行琥珀胶囊因当前无逾期数据未取得截图
    （代码级改动，待下轮复验）。
- 2026-11-09 二次复查补齐（用户追问「还有哪些漏了」）：
  - 任务页搜索占位改为原型文案 `搜索任务、标签、分类`（原为「搜索标题、描述或标签」，漏了分类）。
  - 任务行截止时间由裸文本改为 **accentSoft 时间胶囊 + 时钟图标**（原型形态）；已完成行仍用
    普通弱化文字；逾期行保持 warnSoft 琥珀。
  - 优先级胶囊文案由「高/中/低」改为「**高优先级/中优先级/低优先级**」，去掉前置圆点
    （颜色+完整文案已足够，原型也不带点）。
  - 新增 `font.reading = 15`：笔记编辑器正文 15/23、笔记卡片摘要 15/21（原型的长文本字号
    明显大于通用正文；13 在写作面上偏小）。
  - 收集箱提示由「换行可继续写」改为 **「回车换行 · 点「记下」保存」**，把保存动作说清楚。
  - 设置「本地数据」补 **已排期提醒 N 条**（`listReminderSchedules` 中未来项），与原型的三行
    本地数据读数对齐。
  - 验证：tsc exit 0；增量构建 30s；真机 229（时间胶囊+新占位）、230（已排期提醒）、
    231（笔记摘要 15）、232（编辑正文 15）、233（收集箱提示）通过。优先级完整文案因当前无
    带优先级的任务未截图，只完成代码级改动。
- 2026-11-09 任务同步 UI：同步页新增「立即同步」「待发送任务」「上次接收」「上次同步
  接收/发送/冲突摘要」；冲突页由空态改为逐条冲突卡（采用桌面端 / 保留本机）；任务页页头
  按配对状态显示「同步已连接 / 本机模式」；设置页摘要改为「任务可手动同步」、本地数据读数为
  「本地待发操作」。冲突页按钮曾因内层 `flex` 重叠，已把 `flex` 移到外层 `Pressable`
  并真机复验。证据 `tmp/acceptance/mobile-sync/`。
- 2026-11-09 收集箱/笔记同步 UI：笔记页与收集箱页头读配对状态，显示「同步已连接 /
  仅本机」；同步页磁贴改为「待发送操作」、同步范围改为「任务 / 收集箱 / 笔记」；冲突页
  增加实体标签（任务/笔记/收集箱），收集箱预览取 `content`；设置页摘要改为
  「任务/笔记/收集箱可手动同步」。真机 vc13 复验页头。证据 `tmp/acceptance/mobile-sync-v2/`。
- 2026-11-09 文件互传 UI：主操作移到固定底部操作区（发送 / 传输中切换为字节进度 +
  取消），列表按「来自电脑 / 发往电脑」分组，行内用扩展名色块与主操作按钮；状态只在
  接收中（琥珀）/失败（红）上色，ready 保持中性；补充分方向空态、下拉刷新与
  320dp 窄屏下隐藏 ready 胶囊的响应式规则。真机 vc18 复验空态、列表、下载进度、
  打开、20MB 上传与取消；修复接收位置卡片纵排（`GlassCard` 内显式横排）与取消后
  半成品残留。证据 `tmp/acceptance/file-transfer-ui/`。
- 2026-11-09 设备 Tab 与文件类型图标：底部 Tab 扩为 5 个（任务/收集箱/笔记/设备/设置），
  配对、同步、文件互传、冲突、小组件、分享从「设置 → 手机与同步」迁到设备页；
  设置页只留外观/提醒/本地数据/关于。文件行不再写扩展名，改为 `FileTypeIcon` 的
  13 种 View 自绘形状（PDF/文档/表格/演示/图片/视频/音频/压缩包/代码/文本/Markdown/
  APK/通用），类型决定形状、方向决定蓝/绿底色。真机 vc20/vc21 复验 5 Tab、设备页、
  13 种图标与明暗主题；桌面端左侧导航新增「手机互传」页。证据
  `tmp/acceptance/file-transfer-ui/`。
- 2026-11-13 蓝青专业版 UI 与信息架构重构（apps/mobile）：
  - Token：`palette()` 浅/深两套改为用户锁定的蓝青值（`#1677FF` / `#35B8F5` /
    `#19C6C2` / `#EAF4FF` / `#F7FAFE` / `#172033` / `#66758A` / `#E8EDF4`），新增
    `accentAlt` / `accentWash` 语义键、`font.page=24`、`space.section=20`；组件仍只用 Token。
  - 导航：底部改为 首页 / 任务 / 工作区 / 工具 / 我的；收集箱、笔记移到「工具」的二级页，
    设备、设置移到「我的」的二级页；五个旧入口全部保留页面与数据，映射固化在
    `src/lib/navigationMap.ts`（附 vitest 断言）。
  - 新增组件：`Glyph`（26 枚 View 自绘线性图标，不引图标库）、`ScreenHeader`、`BackButton`、
    `HeaderIconButton`、`SectionHeader`、`IconEntry`、`MetricTile`、`EntryRow`、
    `FileCollectionCard`、`FeatureIconPlaceholder`、`ProjectSpaceCard` /
    `ProjectSpacePlaceholder`。
  - 新增页面：`HomeScreen`（工作台）、`WorkspaceScreen`（工作区）、`ToolsScreen`、`ProfileScreen`；
    `WorkspaceScreen` 顺序为 Header → 项目空间/我的工作区分段 → 我的项目空间 → 置顶工具 →
    协作动态 → 文件集合；「我的工作区」为 2×2 占位。
  - 数据边界：手机端没有 `workspace_projects` 同步链路，项目空间与协作动态只渲染紧凑占位，
    不填演示项目/成员/百分比，不新增端点、迁移或同步协议；`ProjectSpaceCard` 保留真实字段结构。
  - 未接入能力一律用 `FeatureIconPlaceholder`（AI 助手、代码片段、API 调试、JSON 格式化、
    正则测试、剪贴板、文件暂存架、工作流、场景工作区、开发工作台、工作现场）。
  - 验证：`npm run typecheck` exit 0；`npm test` 17 文件 / 171 用例通过；Android 真机本轮
    **未执行**（见验收报告）。
- 2026-11-13 蓝青专业版第二轮整改（apps/mobile，接上条）：
  - 任务页改为固定 `ScreenHeader`（「任务」+ `formatDayLabel`）、右上搜索/新建两个 44dp 图标，
    搜索默认收起；统计改为四列紧凑条，`fontScale > 1.15` 或宽 <360dp 时 2×2；移除 FAB。
    创建入口统一为页头 `+`、空态按钮与首页快捷入口，共用 `TaskEditorSheet`。
  - 首页创建信号改由 Shell 持 `createPending`，任务页消费后归零；`ProjectSpaceCard` 的
    `onPress` 真正绑定 `PressableScale`，无回调时只读并标记 `disabled`；两者抽为 domain/nav
    纯函数并补测试。
  - 工作区/工具/首页占位改为紧凑图标（项目空间单行状态、协作动态 inline、我的工作区 2×2、
    文件集合图标+名称）；「置顶工具」正名为「常用工具」，删除不可用的编辑/管理/全部动态伪按钮。
  - 同步文案只表达配对事实：Profile/Device 为「已配对」，副标题「配对设备 {serverName} ·
    同步需手动发起」；Notes/Inbox 为「已配对 / 仅本机」；不再使用「同步已连接」。
  - 验证：`tsc --noEmit` exit 0；vitest 18 文件 / 178 用例通过；`assembleRelease` exit 0，
    但产物仍为 debug 签名且 `versionCode 21 / 0.1.6`（`app.json` 为 24 / 0.1.7），不作为正式
    发布包；详见 `tmp/acceptance/mobile-blue-cyan-ui/round2-report.md`。
- 2026-11-13 蓝青专业版第三轮精修（apps/mobile，接上条）：
  - **Token**：`accent` 拆成品牌蓝（图标/装饰）与 `accentText`（小字号文字）；
    `accentFill`/`ok`/`warn`/`danger`/`muted`/`faint` 全部按 WCAG 重算并新增
    `src/theme/__tests__/contrast.test.ts` 契约（浅/深色独立断言）。
    字阶新增 `section: 17`、`tab: 11`，正文 14 / 辅助 13 / 标签 12，11sp 只留 TabBar。
  - **任务页防误触**：行内拆成「44dp 勾选 → 完成/恢复」「主体轻点 → 编辑弹层」「长按 → 动作表」
    「左滑 → 删除」；交互路由抽到 `src/domain/taskRowAction.ts` 并补 4 项回归测试。
    完成态删除线改为直接加在标题 `Text` 上（透明字 + `textDecorationColor` 覆盖层在 Fabric
    下不画线，真机实测）。已完成分组提示改为「勾选可恢复」。
  - **首页**：欢迎区 80dp + 白底描边装饰块；今日专注去掉重复状态文案、标题 20sp、底部改
    「查看任务 ›」文字链接；效率概览改无图标磁贴（色点+标签+26sp 数字，0 值中性色）。
  - **工作区**：移除页头 disabled 搜索/新建；项目与协作动态占位去掉重复标题，项目占位 76dp；
    文件集合三卡固定说明槽位，图标/标题/说明三行对齐。
  - **工具页**：四分区收敛为三区（常用/效率/开发），删除重复的「收集与暂存」；「快速笔记」
    改为直接新建笔记，不再是「笔记」的第二入口；页面高度从约 2 屏降到约 1 屏。
  - **我的**：应用卡收紧；设备状态独立小卡；设备入口 4 行 + 底部「处理冲突 / 主屏小组件」
    两个 44dp 链接；个人功能去冗余说明；设置行说明压成一行。
  - **长文本**：新增 `ClampedText`，收集箱速记默认 5 行 + 「展开全文」，不再一条占满屏幕。
  - 验证：`tsc --noEmit` exit 0；vitest 20 文件 / 197 用例通过；`expo export:embed` exit 0；
    release 重打包真机 360dp 浅色完成五页 + 编辑弹层截图。深色 / 320·375·390·430dp /
    130%·150% 字号矩阵与正式 `assembleRelease` **未执行**（设备占用、内存 1.6GB），见
    `tmp/acceptance/mobile-blue-cyan-ui/round3-report.md`。

## 2026-11-14 第四轮：图标体系重建、卡片分层与局部渐变（最小范围放宽）

**背景**：第三轮之后，图标仍是 `Glyph.tsx` 用 View/矩形/旋转线条手绘，比例、曲线、交点和视觉重量
都达不到成品水平；`AppBar`/`FileTypeIcon`/`NoteEditorScreen`/`FilesScreen` 还各自画图标，
存在多套并行实现。卡片全部同一层级，缺少主次。

**技术约束（决定了方案）**：本机可用内存约 1.1GB，`react-native-svg` 属于原生模块，需要
`expo prebuild` + Gradle 重建 APK（历史多次 `hs_err_pid` JVM 崩溃）；图标字体同样要往 APK
`res/` 注册资源，必须重建 `resources.arsc`。因此本轮不引入任何新依赖。

**做法**：
1. 图标几何复用**项目已有的** lucide（桌面端 `lucide-react@0.469` 正在使用），
   用 `tmp/acceptance/mobile-visual-system-v4/tools/build-icons.mjs` 在构建期栅格化为
   md 96px / sm 64px / lg 128px 三档透明 PNG，base64 内联进 `iconAssets.g.ts`，
   运行时由 `AppIcon` 用 `tintColor` 着色。语义表在 `src/components/icons/iconMap.json`（96 枚）。
2. `Glyph.tsx`、`FileTypeIcon` 的手绘逻辑、`AppBar`/`BackButton` 的箭头、`NoteEditor` 的
   图钉/更多/工具栏字符、`FilesScreen` 的删除叉、`SearchField` 的放大镜与叉、`NotesScreen` 的
   FAB 加号，全部改为 `AppIcon`；`Glyph.tsx` 与 `StatCard.tsx` 已删除。
3. `GlassCard` 增加 `level`（primary/secondary/tertiary）；`IconTile` 统一图标底板；
   `MetricTile` 增加 `column` 变体（首页效率概览、设置页摘要共用「一张卡三段」）；
   `ActionSheet` 动作支持行首图标；`EmptyState` 改为 32dp 语义图标 + 柔和底板。
4. 允许的局部效果（**仅此三类**）：`IconTile` 与欢迎区的 `linear-gradient`（RN 原生
   `backgroundImage`，Fabric 实现，无第三方库）、一级卡片的 `cardShadow()`（3dp，实色表面下安全）、
   `tintColor` 单色图标。禁止整块渐变、模糊、玻璃拟态与大面积炫光。
5. 窄屏 / 大字号适配：欢迎区在 `width < 360 || fontScale >= 1.3` 时隐藏品牌块（纯装饰），
   避免「下午好，开发者」在 150% 字号下折成两行；任务筛选在 `fontScale >= 1.3` 时改为换行排布，
   「已完成」不再被横向滚动裁掉；工具页「文件暂存架」视觉名缩为「暂存架」（读屏仍播报全称）。
6. 图标验收页 `IconGalleryScreen`（开发专用，无导航入口，我的 → 连点版本号 5 次进入），
   展示全部图标 @24、16/20/24/32 尺寸矩阵、正常/选中/禁用三态、三种底板。
7. 契约测试 `src/components/icons/__tests__/iconMap.test.ts`：语义表与位图一一对应、
   `sm`/`lg` 变体齐全、每个 data URI 都是合法 PNG 头，防止「加了语义名忘记跑生成器」。

**兼容性**：不改业务语义、不改数据层、不改导航结构（仅新增一个无入口的验收路由）；
包体变化为 96 枚图标约 186KB 原始 PNG（base64 后约 253KB，未压缩进 JS bundle）；
深色模式、320–430dp、130%/150% 字号均真机复拍。

## 2026-11-14 第五轮：图标工程归位、品牌统一与视觉收口

**背景**：第四轮的图标质量已达标，但生成器仍在 `tmp/acceptance/.../tools/build-icons.mjs`，
含 `D:/Develop/task_dock` 绝对路径；首页/我的用 `IconTile tone="brand"` + `project`（boxes）
冒充品牌；API 用 `webhook` 难辨识；PDF 用 `file-badge` 读不出；欢迎区、统计区、分组头与效果图仍有差距。

**做法**：
1. 生成器迁入 `apps/mobile/scripts/gen-ui-icons.mjs`，全部路径基于 `import.meta.url`；
   lucide 从 `apps/mobile/node_modules` 或仓库根 `node_modules` 定位，Playwright 缺 Chromium 时
   回退扫描 `ms-playwright/chromium-*`；失败给明确错误。新增 `npm run icons:generate` /
   `icons:check`，生成物带 `ICON_MAP_HASH`，契约测试会拦住「改映射未重跑」。
   连续两次生成 SHA-256 一致（`tmp/acceptance/mobile-visual-system-v5/build/icons-final-run*.sha256`）。
2. 品牌：新增 `BrandMark`（`brandBase`→`brandBaseAlt` 渐变 + 白 `</>`），首页欢迎区 48/36dp、
   我的应用卡 54dp、图标预览 24/32/46/64dp；`IconTile` 删除 `brand` 语气，禁止再用 `project` 冒充品牌。
3. 图标语义：`api` webhook→`plug`；新增 `brand`→`code-xml`、`calendarDays`→`calendar-days`；
   `filePdf` 用 `overrides` 在 lucide 文件轮廓内画 P；`fileMarkdown` 保留文件+笔；
   文件类型色改为语义 Token（PDF danger、文档 accentText、表格/音频 ok、演示/压缩/APK warn 等），
   方向仍由 FilesScreen 底板表达。
4. 视觉：欢迎区改为白→accentWash 渐变（品牌块在 320dp 用 36dp，130%+ 字号隐藏）；
   `MetricTile` 改「18dp 图标 → 26/800 数字 → 12 标签」左对齐；今日专注卡加“当前专注/待处理”、
   分类胶囊和“去处理”按钮；任务优先级只显示一字；`TaskGroupHeader` 改 24dp 语义图标底板，
   折叠箭头移到数量后；`SettingSection` / 设置页 / Files 分组头统一为图标底板；
   `cardShadow()` 3dp→2dp；Profile 行间加 hairline。
5. 窄屏/字号：320dp 欢迎语用短句「专注重要的事，高效推进。」；任务筛选在 320dp 或 130%+ 换行；
   130%/150% 欢迎语同一短句，避免“务。”孤字换行；工作区文件集合在 130%+ 字号改为全宽横排，
   避免三列卡把「文件暂存架」压成省略号。

**验证**：`tsc --noEmit` exit 0；vitest 21 文件 / 205 用例通过；`icons:check` 98 图标 / 125 变体
up-to-date；真机 vc44→vc48，360/320/375/390/430dp、浅/深色、100%/130%/150% 矩阵与 12 个二级页
截图；任务创建/勾选/编辑/长按/滑删、收集箱 3→4→3 回归通过。正式 Gradle `assembleRelease`
仍 **BLOCKED**（构建时可用内存约 1.7GB，历史 JVM 崩溃），本轮用 `expo export:embed` + release
底包 repack 验证，不视为发布构建。


## 2026-11-14 第六轮：视觉收口（工作区权重、占位区分、工具页基线）

**背景**：第五轮已完成图标、品牌、五页与二级页整改。本轮按真机 vc49 截图复核，只修真实缺陷，
不重建设计系统：① 工作区项目占位仍用 `GlassCard level="primary"`（强描边 + 阴影 + 44dp 蓝底图标），
在手机端没有项目数据时反而比可用的常用工具更醒目；② 文件集合三张卡都是白卡 + 描边，
真实/未接入只靠图标颜色区分，扫视时仍像三个都能点；③ 工具页同一行里真实入口用 46dp 底板，
占位用 40dp 底板，320/360dp 下「快速笔记」与「剪贴板」等标签基线相差约 4–6dp。

**做法**：
1. `ProjectSpacePlaceholder` 降为 `GlassCard level="tertiary"`（无边框浅蓝），图标改 36dp 中性底板，
   高度 72dp；保留「尚未同步」状态与说明，不增加假项目/进度/跳转。工作区视觉重量恢复为
   **真实常用工具 ＞ 未接入的项目/协作占位**。
2. `FileCollectionCard`：真实入口保持白卡 + hairline + 蓝色图标 + `accentText` 说明；
   未接入项改 `bgAccent` 无描边面板 + 中性图标 + `muted` 文字。三项仍等高、等距，占位卡内不写假数量。
3. `FeatureIconPlaceholder` 的 `compact` 变体改为 46dp 中性底板、`gap:7`、标签 `lineHeight:16`、
   `paddingVertical:8`，与 `IconEntry` 完全同高（85dp 内容），同一行内图标与文字基线对齐。
4. 其余页面与组件不改：首页/任务/我的、二级页、图标映射、品牌组件、Token 值均保持第五轮状态。

**验证**：`tsc --noEmit` exit 0；vitest 21 文件 / 205 用例通过；`icons:check` 98 图标 / 125 变体；
真机 vc50（`expo export:embed` + release 底包 repack，非 Gradle release）拍摄整改前/后五页，
320/360/390/430dp 与深色五页；任务创建/完成/恢复/编辑/长按动作表/滑删、四个工作区入口、
快速笔记、设备详情、设置与 Android 返回键回归通过，测试任务已删除，统计恢复 15/0/9。
证据：`tmp/acceptance/mobile-visual-system-v6/`。正式 `assembleRelease` 仍 **BLOCKED**（内存限制）。
