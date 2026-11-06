# 设置中心快速导航与智能搜索 — 设计文档（2026-11-06）

> 状态：已批准（用户选择「直接持久化 + 分期实现 + 批准实施」）。
> 任务：轻量级、可搜索、可快速定位的设置中心，不重建整套设置系统。

## 1. 背景与已确认约束

- 现状：`SettingsPanel` 由 16 个稳定分组 ID + `CollapsibleSection` 组成；折叠状态存
  `taskdock.settings.sections.v1`（localStorage）；跨模块定位复用
  `requestSettingsSectionReveal()`（sessionStorage + 事件 + 双 rAF）。
- 滚动容器：`.full-view > .tab-content` 单一纵向滚动（`overflow-y:auto`），不新增嵌套滚动。
- 唯一滚动 / 定位锚点已有：`[data-collapsible-section="settings-{id}"]`。
- 组件复用：`SearchField`、`Popover`(floating-ui flip/shift/size)、`DropdownMenu`、`CollapsibleSection` 均已可复用。
- i18n：`MessageKey = keyof typeof zhCN`，两份词典键必须同步；新增键同时写入 zh-CN/en-US。
- 工作区：并行未提交改动大量存在（`SettingsPanel.tsx` / `settingsSections.ts` /
  `AudioSettings.tsx` 均已 dirty），不得整文件覆盖，只做靶向编辑。
- 用户已确认：① 自动展开**直接持久化**（复用现有持久化，不做临时恢复）；
  ② 搜索索引**分期实现**：一期分组定位 + 设置项名映射到分组，项级精确锚点二期。

## 2. 方案比较与选择

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A 轻量复用 | 静态索引 + 分组定位，项名→分组 | 改动小、风险低、符合「轻量」 | 项级定位不精确 | **采用** |
| B 精确锚点 | 每个 `setting-row` 加 `data-setting-item` | 定位最准 | 触及 100+ 行、与并行改动冲突高 | 二期 |
| C Combobox 重做 | 复用 Combobox 做搜索 | 键盘已完备 | 结果富文本/分组路径受限 | 不采用 |

## 3. 架构

```
SettingsPanel (顶部)
 └─ SettingsToolbar [sticky, 紧凑]
     ├─ SearchField (顶部搜索框)
     │   └─ Popover 结果面板 (role=listbox, 键盘 ↑↓/Enter/Esc)
     ├─ DropdownMenu「全部分类」 (16 分组, 内部滚动)
     └─ 批量按钮「全部折叠/全部展开」(一次 setState + 一次 persist)
 └─ Section × 16 (原有 CollapsibleSection 不变)
```

- 新增 `src/lib/settingsSearchIndex.ts`：静态元数据 + 纯函数搜索（可单测，无 DOM 依赖）。
- 新增 `src/components/settings/SettingsToolbar.tsx`：工具栏 + 结果面板受控组件。
- 修改 `SettingsPanel.tsx`：挂载工具栏、接入批量展开/折叠、扩展定位（`requestId` 防旧请求覆盖、
  `scroll-margin-top` 处理 sticky 偏移、轻量高亮一次后恢复）。
- 样式追加 `src/styles.css`：`.settings-toolbar` / `.settings-search-*` / 高亮类，全部语义 Token，
  尊重 `prefers-reduced-motion`，深浅主题共用。
- i18n：`src/locales/zh-CN/index.ts` + `src/locales/en-US/index.ts` 同步加键。

## 4. 搜索索引（静态元数据，一期分组定位）

每条目：`{ id, kind: 'section'|'item', titleKey|title, sectionId, keywords[], descriptionKey? }`。
- 分组条目：16 分组标题 + 描述关键词（如「语音」→ tts / tts-cache / audio-sound；
  「备份」→ data；「快捷键」→ window-hotkeys；「导航」→ navigation）。
- 设置项条目：常见设置项名称 + 别名 → 映射到所属分组（点击展开并定位分组头；
  二期再加行级锚点精确到行）。
- 索引只存元数据，不缓存业务值；不扫 DOM、不触发 IPC、不轮询、不重建索引（模块级常量）。

匹配与排序（轻量本地）：
- 英文不区分大小写；中文连续子串；多空格分隔多词全部命中（AND）。
- 优先级：标题完全相等 > 标题前缀 > 标题子串 > 关键词命中 > 描述命中；
  同级按索引顺序稳定排序；上限 `limit=30`。
- 无结果返回 `[]`，UI 显示空状态；请求标识 `requestId` 保证快速连跳只执行最后一次。

## 5. 定位链路

1. 识别目标 `sectionId`；
2. 若折叠则 `setSectionOpen(id, true)`（持久化）；
3. 双 rAF 等待 React 提交（复用现有模式，`useRef` 数组统一取消，卸载取消）；
4. 优先找可选 `[data-setting-item]`（一期暂无则回退分组根），`scrollIntoView({block:start})`；
5. 加一次性高亮类（`settings-highlight`），动画结束/超时后移除，高亮不改业务值；
6. 目标不存在时 toast 提示「目标不可用」并保持原状态，不抛错。

## 6. 快速分类与批量折叠

- 分类：`DropdownMenu` 22 项内滚动，`placement=bottom-start`，`matchWidth`，
  选项 = 16 真实分组（标题取 i18n），选中关闭并走同一 `revealSection`。
- 批量：一次状态更新 + 一次 `persistSettingsSectionOpenState`；
  全部折叠常驻；当全部已展开时按钮切换为「全部展开」禁用态，避免重型挂载轰炸；
  「全部展开」允许但挂载即现有各子模块守卫加载（tts 读语音 / hotkeys 加载 / resource 快照），
  不做额外预热/预取，文档记录风险。

## 7. Sticky 与窄窗

- 工具栏 `position:sticky; top:-10px`（抵消 `.tab-content` padding）+ 背景/模糊/边框，
  高度 ≤ 76px，单一个 sticky，不多层固定；分组 `scroll-margin-top:88px`。
- 425px 窄窗：搜索占满width；分类+批量同行 wrap，文字省略；Popover/菜单 flip/shift 不越界。

## 8. 国际化与可访问

- 新增键：`settings.toolbar.searchPlaceholder` / `searchLabel` / `clearSearch` /
  `allSections` / `collapseAll` / `expandAll` / `noResults` / `resultCount` /
  `sectionLabel` / `targetUnavailable`（双语）。
- `aria-label` 明确、`aria-activedescendant` + `aria-controls`、
  结果计数 `aria-live=polite`、Focus 不丢失、Esc 只关一层（接入 `overlayStack`/`Popover`）。

## 9. 测试与验收

- 单测：`settingsSearchIndex.test.ts`（中文/大小写/别名/排序/空结果/重复名/失效项）；
  `SettingsPanel` 交互扩展（折叠内可搜、展开定位、连跳只最后一次、批量持久化、重进恢复）。
- 回归：保存/快捷键/导航/备份/主题/跨模块定位（`requestSettingsSectionReveal("navigation")`）。
- 真机：425px、深浅主题、滚动/越界/Sticky/高亮，以 `tmp/acceptance/settings-navigation/` 报告留证。

## 10. 已知风险

- 全部展开会同时挂载重型子模块（见 §6），一期不加延迟/虚拟化，后续真机证据再定。
- 设置项级精确锚点列入二期；一期点击只到分组头。
- 工作区并行改动多，编辑必须靶向合并，不得整文件覆盖。
