# 10 · 剪贴板导航迁移说明（v0.6）

> 目标：把「智能剪贴板」从**标题栏按钮 + 全屏抽屉**升级为**侧边栏第 4 个独立页面**，
> 同时**完整保留**任务关联流程与紧凑模式下的临时抽屉。
>
> 约束：**不重写剪贴板 Rust 后端与数据模型**；**不复制两套独立的加载 / 监听 / 操作逻辑**。

---

## 1. 迁移前 → 迁移后

| 维度 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 入口 | 标题栏一个「打开智能剪贴板」图标按钮 | 侧边栏第 4 项「剪贴板」（Clipboard 图标） |
| 导航项数 | 5（任务 / Agent / 行动 / 历史 / 设置） | **6**（任务 / Agent / 行动 / **剪贴板** / 历史 / 设置） |
| 完整模式形态 | 全屏抽屉盖住整个内容区 | 右侧内容区直接渲染剪贴板工作区 |
| 标题栏按钮 | 有 | **已移除**（剪贴板入口统一到侧边栏，避免两个入口语义重复） |
| 快捷键 | Ctrl+Shift+C 开关抽屉 | 完整模式 → 切到剪贴板页；紧凑/最小模式 → 开关抽屉 |
| 数字快捷键 | Ctrl+1…5 | **Ctrl+1…6**（顺序与侧边栏一致） |
| 任务关联 | 抽屉 + `linkTask` 上下文 | **保留**：仍以抽屉形态出现，关联后回到来源上下文 |

## 2. 导航顺序的单一事实来源

`src/store/useUiStore.ts`：

```ts
export type Tab = "tasks" | "agents" | "actions" | "clipboard" | "history" | "settings";

/** 完整模式侧边栏顺序：导航渲染、Ctrl+1…6、快捷键说明共用这一处定义。 */
export const TAB_ORDER: readonly Tab[] = [
  "tasks", "agents", "actions", "clipboard", "history", "settings",
] as const;
```

三处消费方：

| 消费方 | 用法 |
| --- | --- |
| `src/components/FullView.tsx` | `TAB_ORDER.map((id) => ({ id, ...TAB_META[id] }))` → 渲染侧边栏 |
| `src/hooks/useGlobalShortcuts.ts` | `TAB_ORDER[index]` → Ctrl+1…6 的目标页 |
| 文档 / 快捷键说明 | 直接引用同一顺序 |

**任何新增标签页只需改这一处**，导航渲染、数字快捷键、说明文档不会各自漂移。

> 历史原因：原先数字快捷键是手写 `switch`，标签页一多就容易漏。
> 现在把快捷键抽成 `src/hooks/useGlobalShortcuts.ts`（可单测），App.tsx 里只剩一行调用。

## 3. 组件拆分：一份逻辑，两个外壳

```
ClipboardWorkspace.tsx      ← 全部业务：列表 / 分组 / 过滤 / 复制 / 关联 / 暂停捕获 / 配置
   ├── ClipboardPanel.tsx   ← 完整模式「页面」外壳（variant="page"）
   └── ClipboardDrawer.tsx  ← 抽屉外壳：任务关联 + 紧凑模式（variant="drawer"）
```

| 组件 | 职责 | 不负责 |
| --- | --- | --- |
| `ClipboardWorkspace` | 数据加载、过滤、复制粘贴、关联、事件订阅、详情弹层 | 决定自己以什么形态出现 |
| `ClipboardPanel` | 判断「页面是否应当激活」 | 任何数据加载 |
| `ClipboardDrawer` | 读 `clipboardOpen` 决定开合；提供 `onClose` | 任何数据加载 |

**没有第二套加载 / 监听 / 操作逻辑**——两个外壳渲染的是同一个 `ClipboardWorkspace`，
数据源、动作实现、订阅代码完全共用。

### 3.1 不会重复监听剪贴板事件

`src/store/useClipboardStore.ts` 用**全局引用计数**管理唯一一条 `onClipboardChanged` 监听：

```ts
let liveScope: ReturnType<typeof createSubscriptionScope> | null = null;
let liveRefs = 0;

setLive: (active) => {
  if (active) {
    liveRefs += 1;
    if (liveScope) return;   // ← 已有监听，直接复用
    liveScope = createSubscriptionScope();
    liveScope.add(onClipboardChanged(/* 300ms 去抖后刷新 */));
  } else {
    liveRefs = Math.max(0, liveRefs - 1);
    if (liveRefs > 0) return;
    liveScope?.dispose();     // ← 最后一个引用离开才真正退订
    liveScope = null;
  }
}
```

即使页面与抽屉同时存在（理论上抽屉打开时页面会让位），
底层也只有 **一条** Tauri 事件监听，且高频采集事件合并为一次刷新。

### 3.2 按需加载与退订

`ClipboardPanel` 把「当前是否应当工作」算成 `active`：

```ts
const active = tab === "clipboard" && !clipboardOpen;
```

`ClipboardWorkspace` 内部所有副作用都以此为前提：

| 副作用 | `active === false` 时 |
| --- | --- |
| 首次 `load()` | 不执行 |
| `setLive(true)` 订阅实时变更 | 不订阅 |
| 后端状态轮询 | 不轮询 |
| 退订（`setLive(false)`） | 已在 effect 清理里执行 |

所以**不在剪贴板页时没有任何后台开销**：不轮询、不订阅、不刷新。

## 4. 抽屉模式保留了什么

任务编辑器与任务上下文抽屉里的「关联剪贴板」入口**逻辑与调用方式完全不变**：

```tsx
// src/components/tasks/TaskEditor.tsx
openClipboard({ linkTask: task });

// src/components/context/TaskContextDrawer.tsx
openClipboard({ linkTask: task });
```

`useUiStore` 里的状态机：

```ts
openClipboard: (opts) =>
  set((s) => ({
    clipboardOpen: true,
    clipboardLinkTask: opts?.linkTask ?? null,
    // 与上下文抽屉互斥：不能同时开两个抽屉
    context: opts?.linkTask ? { ...s.context, open: false } : s.context,
  })),
closeClipboard: () => set({ clipboardOpen: false, clipboardLinkTask: null }),
```

| 规则 | 说明 |
| --- | --- |
| `clipboardOpen` 与 `context` 互斥 | 打开一个必然关掉另一个 |
| `clipboardLinkTask` 非空 | 抽屉以「关联模式」渲染：关联后回到来源上下文 |
| `setTab("clipboard")` **不**打开抽屉 | 切标签页 ≠ 打开抽屉，二者语义分离 |
| 抽屉在弹层栈里是 `drawer` 层 | Escape 优先级低于菜单与确认框 |

`src/store/useUiStore.test.ts` 守住以上全部规则。

## 5. 快捷键变化

| 快捷键 | 完整模式 | 紧凑 / 最小模式 |
| --- | --- | --- |
| Ctrl+1 / 2 / 3 / 4 / 5 / 6 | 依次切到 任务 / Agent / 行动 / **剪贴板** / 历史 / 设置 | 无效（这些页面只在完整模式存在） |
| Ctrl+7 及以上 | 无效 | 无效 |
| Ctrl+K | 快速添加 | 快速添加 |
| Ctrl+Shift+C | **切到剪贴板页**（并确保抽屉关闭） | 开关剪贴板抽屉 |

实现见 `src/hooks/useGlobalShortcuts.ts`，行为细节：

- 输入框 / textarea / contenteditable 内打字时，Ctrl+K 与 Ctrl+数字**不劫持**按键
  （Ctrl+Shift+C 例外：它是全局的，但剪贴板页仍保留焦点）。
- 紧凑模式下 Ctrl+Shift+C 仍是**可用**的临时剪贴板入口（满足「紧凑/最小模式保留可用入口」）。

## 6. 视觉与布局影响

| 项 | 结论 |
| --- | --- |
| 侧边栏第 4 项 | 窄窗下收起为纯图标，可访问名由 `aria-label="剪贴板"` 兜底 |
| 底部快速添加按钮 | 新增第 6 项后**不得被遮挡**——由 `scripts/layout-regression.mjs` 的 `elementFromPoint` 命中测试守住 |
| 低窗口高度 | 导航区允许滚动，六项**始终可达**（`entriesReachable` 断言） |
| 剪贴板页面宽度 | 复用内容区宽度，不额外挤压主区 |

## 7. 回归清单

- [x] 侧边栏渲染 6 项，顺序 = `TAB_ORDER`
- [x] `Ctrl+1…6` 分别切到对应页；`Ctrl+7` 无效
- [x] 完整模式点「剪贴板」→ 右侧内容区显示剪贴板工作区（不是抽屉）
- [x] 标题栏不再有剪贴板按钮
- [x] 任务编辑器「关联剪贴板」→ 抽屉形态 → 关联后回到任务编辑器
- [x] 任务上下文抽屉「关联剪贴板」→ 抽屉 → 关闭后回到上下文抽屉
- [x] 抽屉与上下文抽屉互斥
- [x] 剪贴板页与抽屉**共用**一份数据加载 / 监听逻辑
- [x] 页面与抽屉同时存在时底层只有一条 `onClipboardChanged` 监听
- [x] 紧凑模式 Ctrl+Shift+C 仍可打开临时剪贴板

## 8. 不在本次范围内

- 剪贴板 **Rust 后端与数据模型**未做任何改动（`src-tauri/src/clipboard/**`）。
- 智能分组算法、复制粘贴策略、剪贴板历史保留策略均保持原样。
- 本次只调整「剪贴板在 UI 上如何被打开与呈现」。
