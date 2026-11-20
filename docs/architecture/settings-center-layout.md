# 设置中心布局重构（2026-11-20）

> 状态：已实施。本文档记录设置中心从「分类 tablist + 折叠卡片」升级为「树形二级导航 +
> 独立子页面」的实际技术方案、取舍与真实实现位置。事实优先级以代码为准。

## 1. 现状问题（重构前）

| # | 问题 | 原实现位置 |
|---|---|---|
| P1 | 常用设置需「选分类 → 找分组 → 展开折叠卡」三步操作 | `SettingsPanel.tsx` 的 `<Section>`（`CollapsibleSection` 外壳） |
| P2 | 复杂功能（导航自定义、剪贴板、诊断）被压进狭长折叠容器 | 同上；`nav-visibility-list` 限高 `clamp(200px, 42vh, 360px)` |
| P3 | 响应式断点双份定义：CSS `@media (min-width:1080px)` 与 TS `matchMedia` 手动同步 | `settings-page.css:57` + `SettingsCategoryNav.tsx:33` |
| P4 | 断点测量的是**窗口**宽度；工作台左导航宽度可拖拽（96–320px）、右详情栏可开合，窗口宽度≠设置工作区宽度 | 同上 |
| P5 | `SettingsPanel.tsx` 2015 行：页面框架、全部表单、备份/诊断/搜索/危险操作混在一个组件 | 整个文件 |
| P6 | 滚动所有权：页面滚动区 `.settings-category-panel.page-scroll` 与 `nav-visibility-list` 内部滚动嵌套，窗口变高列表仍只有 360px | `styles.css:17385` |
| P7 | 分类导航 `role="tablist"` 与「分类下还有分组」的两层结构语义不符 | `SettingsCategoryNav.tsx` |

## 2. 信息架构

```
settings-panel（容器查询容器 settings-page）
├── WorkbenchPageHeader（标题/副标题 + 搜索入口 actions）
├── settings-body
│   ├── SettingsNavigation          ← 设置模块内部导航（树形）
│   └── settings-page-host          ← 唯一页面滚动区（page-scroll）
│       └── 当前子页面（SettingsPageLayout）
└── WorkbenchPageDetail（右栏：当前配置摘要，Portal 到外壳）
```

一级分类（六个，ID 不变）与二级页面（原分组，ID 不变）：

| 分类 | 二级页面（`SettingsSectionId`） |
|---|---|
| general | appearance / navigation / window-hotkeys |
| features | features / apps / clipboard |
| notify-voice | notifications / audio-sound / tts / tts-cache |
| data-resources | resource-cleanup / data |
| integration | agent / diagnostics-logs / diagnostics / developer |
| help | help |

数据关系唯一事实源仍是 `lib/settingsCategories.ts` 的 `SETTINGS_SECTION_META`
（`sectionId → {labelKey, category, aliases}`）。导航组件与搜索都从注册表派生，
不维护第二份索引（完整性测试 `settingsCategories.test.ts` 继续拦截漏项）。

## 3. 关键决策与取舍

### 3.1 二级导航语义：tree（不再用 tablist）

- 分类 = `role="treeitem" aria-expanded`（可折叠组）；页面 = 叶子 `treeitem` +
  `aria-selected`；外层 `role="tree"`（`aria-label` 沿用 `settings.category.aria`）。
- 键盘：↑/↓ 在可见项间移动并**激活页面**（沿用旧 tablist「方向键即激活」的轻内容
  约定）；→ 展开 / 进入子级；← 折叠 / 回父级；Home/End 首尾；Enter/Space 激活分类
  （展开并打开其第一个页面）。
- 一级分类点击行为明确：展开/收起；展开时若当前页面不在该分类下则打开该分类
  第一个页面。不存在「既像按钮又不知道会发生什么」的状态。
- 漫游 tabindex：只有聚焦项 `tabindex=0`。

### 3.2 折叠卡不再作为主要外壳

- 17 个分组全部升级为独立页面，`Section`（`CollapsibleSection` 包装）删除。
- `CollapsibleSection` 仍保留给页面内部真正的低频细节：`DiagnosticsLogsSection`
  内部子区块、`McpAccessSection` 等自有折叠不动。
- `settingsSections.ts` 的折叠偏好键 `taskdock.settings.sections.v1` 保留读取兼容但
  页面级不再消费；`requestSettingsSectionReveal` 协议（sessionStorage 意图 + window
  事件）**原样保留**，外部调用方（`FullView`「自定义导航」、全局搜索、剪贴板工作区）
  零改动。

### 3.3 当前页面持久化（新增，替代分类持久化）

- 新键 `taskdock.settings.section.v1`：`{version:1, section: SettingsSectionId}`。
- 恢复：读 section → 有效则用（所属分类由注册表推导）；无效/损坏回退读
  `taskdock.settings.category.v1` → 取该分类第一个页面；再回退第一个分类第一个页面。
- 旧 `taskdock.settings.category.v1` 不删除、不写入（兼容旧版本回读）。

### 3.4 布局模板：一个骨架组件 + CSS 修饰类（不建 4 个模板文件）

`SettingsPageLayout` 提供「页面标题 + 描述 + actions + 内容」骨架，内容区挂模板类：

| 模板类 | 适用页面 | 形态 |
|---|---|---|
| `settings-page--standard` | 通知/语音/功能/开发者/帮助等 | 内容限宽 880px，`setting-row` 列表 |
| `settings-page--split`（配置+预览） | navigation | ≥1100px 容器：列表 + `NavigationPreview` 两栏；中/窄单列 |
| `settings-page--list` | apps / clipboard / data | 标题 + 操作栏 + 长列表（自然高度，页面滚动） |
| `settings-page--diagnostic` | diagnostics / diagnostics-logs / resource-cleanup | 指标摘要 + 工具栏 + 条目列表 |

不机械创建 `layouts/*.tsx`：四类模板的 JSX 差异只有「是否限宽/是否双栏/操作栏位置」，
用 CSS 类表达比四个壳组件更少代码。外观与主题页不加右栏预览——预设卡片本身就是
可视化预览（`preset-card` 缩略图），再加一层预览是重复。

### 3.5 响应式：容器查询为主，ResizeObserver hook 为辅

| settings-page 容器宽 | 布局 |
|---|---|
| ≥1100px | 导航 200px + 内容（预览类页面双栏） |
| 760–1099px | 导航 176px + 内容单列 |
| <760px | 导航折叠为顶部紧凑条（分类 Select + 当前分类页面 chips），内容独占 |

- CSS 全部改用 `@container settings-page (…)`（容器 = `.settings-panel.page-fill`，
  `container-type: inline-size`，既有声明保留）；删除旧 `@media (min-width:1080px)`
  规则。窗口宽度不再参与判断——全局导航拖宽/详情栏开合由容器宽度自然反映。
- TS 需要「布局模式」仅两处：导航组件渲染紧凑条 vs 树、以及无障碍朝向。
  统一走 `hooks/useSettingsResponsiveLayout.ts`（ResizeObserver 监听容器宽度，
  返回 `wide | medium | narrow`），断点常量与 CSS 注释互指；不再用 `matchMedia`，
  不允许各设置页自建监听器。

### 3.6 滚动所有权

- `.settings-page-host`（page-scroll）是页面级唯一滚动区；页头/导航固定。
- **导航自定义页例外**：页面骨架 `height:100%`，列表区 `min-height:0` 占满剩余高度，
  `.nav-visibility-list` 内部滚动（`max-height` 限高删除，改为 flex/grid 弹性占满）。
  原因：`useNavDragSort` 的边缘自动滚动直接滚 `listRef.scrollTop`
  （`useNavDragSort.ts:225`），列表失去内部滚动会破坏拖拽体验；占满高度后
  「窗口变高只有 360px」与「内外抢滚轮」同时消除。该页面自身不产生页面级滚动。
- `revealInScroller` 语义不变：只滚最近可滚祖先，不居中。

### 3.7 搜索：结果 → 分类 + 页面直达

- 匹配逻辑与别名（`matchesSettingsQuery` / `SETTINGS_SECTION_META.aliases`）不变。
- 结果项显示「页面名 + 所属分类」（复用 Combobox option 的 label + hint）。
- 选择后 `navigateToSection(sectionId)`：切页面（自动切所属分类展开）→ 页面内容
  直接呈现（无需展开步骤）→ 焦点移到页面标题（`tabindex=-1`）。
- **控件级定位暂缓**：注册表没有控件元数据（controlId → 所在页面），页面直达后
  原三步变一步、全部设置同屏可见，控件级索引的收益不再值得一份会漂移的索引。
  接口留位：`navigateToSection` 已按「未来可扩展 anchor 参数」设计。

### 3.8 状态与草稿

- 即时保存设置（`update()`）全部不变；`useSettingsStore` 是唯一写入通道。
- `excludeApps` 失焦提交 + **页面卸载前 flush**（从「分类切换前 flushDrafts」迁移为
  页面卸载守卫，语义等价且覆盖更多切换路径）。
- 导航排序/显隐写入串行化、失败回滚、界面切换单事务**全部保留在
  `NavigationVisibilitySection` 内**，本重构不触碰其逻辑；仅新增可选
  `onSurfaceSettled` 回调把当前界面镜像给 `NavigationPreview`（预览是镜像不是
  第二事实源）。

### 3.9 组件职责

```
settings/
  SettingsPanel.tsx            组合层：页头/搜索/导航/当前页面/右栏摘要/跨模块定位意图
  SettingsNavigation.tsx       树形导航（宽/中：tree；窄：分类 Select + 页面 chips）
  SettingsPageLayout.tsx       页面骨架（标题/描述/actions/模板类）
  NavigationPreview.tsx        只读导航预览（读 useNavigationLayout() 有效布局，含草稿）
  pages/*.tsx                  15 个文件承载 17 个子页面（语音三页合一个文件）
  hooks/useSettingsResponsiveLayout.ts
  settings-page.css
```

- 数据读取随页面挂载走：数据与备份页挂载读备份列表、剪贴板页挂载读统计/状态
  （原 `loadedSlices` 跨折叠缓存取消——切页重读一次，代价是廉价 SQLite 读，
  换取离开页面即释放订阅与状态的清晰生命周期）。
- 危险操作确认框（导入/清理测试数据）归 `DataBackupSettingsPage` 本地持有。
- `AppPicker` 悬挂逻辑（胶囊停靠时挂起）留在 `SettingsPanel`（跨页面意图）。

## 4. 迁移与兼容

| 项 | 结论 |
|---|---|
| 稳定 ID | 分类/分组 ID 全部不变；`SettingsSectionId` 契约不变 |
| 持久化 | 业务设置（SQLite）、导航布局、折叠偏好键均不迁移；新增 section 键为纯 UI 偏好 |
| 跨模块协议 | `SETTINGS_SECTION_REVEAL_EVENT` / `requestSettingsSectionReveal` / `consumeSettingsSectionReveal` 原样保留 |
| i18n | 新键集中在 `settings.nav.*` / `settings.page.*` / `settings.preview.*`，zh-CN 与 en-US 同步 |
| ARIA | tablist → tree 语义切换；对应测试重写（`SettingsPanel.test.tsx`） |

## 5. 回归测试矩阵

| 层 | 文件 | 覆盖 |
|---|---|---|
| 注册表 | `lib/settingsCategories.test.ts`（不变） | 分组↔分类完整性、别名、持久化 |
| 导航 | `settings/SettingsNavigation.test.tsx`（新增） | 树语义、键盘、激活、恢复、窄模式 |
| 页面 | `settings/SettingsPanel.test.tsx`（重写） | 页面直达、搜索定位、意图恢复、按需数据、草稿保护 |
| 导航自定义 | `NavigationVisibilitySection*.test.tsx`（不变） | 显隐/排序/拖拽/回滚 |
| 语音 | `AudioSettings.test.tsx`（更新渲染入口） | 声音/播报/缓存三页行为 |
| 类型 | `npm run typecheck` | — |

真机验收：`npm run tauri dev` + 独立数据目录，覆盖 §7 场景表（大/中/窄容器、
全局导航拖宽、详情栏开合、排序拖拽、明暗主题、中英文）。

## 6. 分阶段实施记录

1. 文档（本文件）→ 2. section 持久化 + 响应式 hook → 3. SettingsNavigation →
4. 页面拆分 → 5. NavigationPreview + 导航页 → 6. SettingsPanel 组合层 + 搜索 →
7. CSS（容器查询 + 旧类清理）→ 8. i18n → 9. 测试 → 10. Dev 验收。
