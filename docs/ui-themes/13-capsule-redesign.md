# 分类胶囊（Smart Dock Capsule v0.7）设计与实现

> 适用范围：屏幕边缘吸附胶囊的形态、状态机、命中区、数据来源与验收口径。
> 代码入口：`src/components/capsule/`、`src/lib/capsuleLayout.ts`、
> `src/hooks/useEdgeSnap.ts`、`src-tauri/src/window_shape.rs`。
> 相关文档：[01-design-spec.md](01-design-spec.md)、[03-window-composition.md](03-window-composition.md)、
> [12-v06-window-corners.md](12-v06-window-corners.md)。

## 一、要解决的问题

v0.6 的隐藏态胶囊是「32×120 的状态条」：窗口整体滑出屏幕，只留一条窄边，
再用 Win32 区域裁成短胶囊。它带来三个结构性问题：

1. **胶囊承载不了功能**：32px 宽只能放数字，任何操作都要先把整窗唤出。
2. **命中区跟着窗口跑**：胶囊画在窗口「停靠边的对侧」，唤出时窗口移回原位、
   胶囊还要换到另一侧；窗口移动（异步 IPC）与命中区更新无法同帧完成，
   鼠标跨越吸附条与悬浮窗口时会反复进出判定区——这就是"来回跳动"。
3. **信息层级混乱**：待办数、Agent 数、展开箭头挤在一条窄条里，没有分类。

## 二、架构：窗口不动，只切区域

v0.7 的核心决定：**停靠期间窗口不移动、不缩放**，唯一的视觉状态变化是
Win32 区域（`SetWindowRgn`）在「轨道」与「轨道 ∪ 面板」之间切换。

```
停靠（左缘）时窗口布局（CSS px，窗口 400×420 或 400×484）
┌──────────────────────────── 窗口（贴边齐平，位置固定） ────────────────────────────┐
│ ┌──────┐   ┌──────────────────────────────┐                                        │
│ │ 轨道 │ 8 │          功能面板            │   ← 区域外不绘制、不接收鼠标            │
│ │56×300│px │          336×420             │                                        │
│ └──────┘   └──────────────────────────────┘                                        │
└────────────────────────────────────────────────────────────────────────────────────┘
折叠态区域 = 轨道圆角矩形；展开态区域 = 轨道 ∪ 面板（两块矩形，间隙不连通）
```

- **轨道**永远贴停靠边（left→左、right→右、top→上、bottom→下），**面板**永远朝
  屏幕内部展开；二者同轴居中，间隙 8px。
- 区域由 `capsule_regions()`（Rust，纯函数）计算，`CombineRgn(RGN_OR)` 合并；
  应用后用 `GetWindowRgn` 回读验证：包围盒一致 + 轨道/面板中心在区域内 +
  间隙中点在区域外。验证失败视为未应用，前端记录并保持原状态。
- 窗口尺寸在停靠时撑到「胶囊容器」（垂直 400×420、水平 400×484），
  解除吸附时恢复当前模式尺寸（`apply_mode`）。停靠期间 `window_rect` 不落库。

**为什么这样就不抖了**：轨道在屏幕上的位置、尺寸、命中区在整个停靠期间是常量；
展开只是把一块新的矩形并进区域。没有任何"窗口追上鼠标"的时序问题，
也不需要靠延迟去掩盖命中区错误。

## 三、状态机

相位定义（`src/lib/edgeSnap.ts`）：

| 相位 | 含义 | 窗口几何 | 区域 | 界面 |
|---|---|---|---|---|
| `free` | 未停靠 | 模式尺寸 | off | 完整主界面 |
| `candidate` | 拖动中贴近边缘 | 随拖动 | off | 完整主界面 + 光晕/细线 |
| `docked-visible` | 已停靠，刚吸附 | 容器 | rail | 轨道 |
| `docked-hidden` | 已停靠，折叠常驻 | 容器 | rail | 轨道 |
| `docked-revealed` | 已停靠，面板展开 | 容器 | panel | 轨道 + 面板 |

转移（`LEGAL_TRANSITIONS`）：

```
free → candidate | docked-visible | docked-hidden(仅重启恢复)
candidate → free | docked-visible
docked-visible → docked-hidden | docked-revealed | free
docked-hidden → docked-revealed | free
docked-revealed → docked-hidden | docked-visible | free
```

`docked-visible` 与 `docked-hidden` 的界面完全相同（都是轨道），区别只在语义与
持久化（`snap_state.hidden`）；折叠是"收起面板"的自然结果，不是"把窗口藏起来"。

## 四、分类与数据来源

| 分类 | 数据来源（既有，不新增轮询/状态源） | 徽标口径 | 空状态 |
|---|---|---|---|
| Agent 总状态（顶部球） | `useAgentsStore.snapshot` → `liveSummary()` | 待处理数 = waiting + failed | 未加载 → 中性球，不伪装空闲 |
| 任务 | `list_tasks`（view=all, status=pending） | 待办数，>99 显示 `99+`，0 不显示 | 「暂无待办」+ 新建入口 |
| Agent | `liveRuns(snapshot.runs)` | 状态点（running/waiting/failed/disconnected） | 「未检测到运行中的 Agent」+ 接入配置 |
| 剪贴板 | `clipboard_view`（limit 8）+ 组详情（最多 2 组封面） | 无数字徽标 | 「剪贴板暂无记录」+ 打开剪贴板 |
| 应用 | `useNavigationStore.targets` → `nav_navigate` | 无数字徽标 | 「尚未配置快捷应用」+ 去配置 |

**Agent 数字口径**：徽标只表示"需要人处理"的数量（waiting + failed），
不显示累计消息数或历史运行总数——后者只会单调增长，对用户没有决策价值。
运行中用状态点与色调表达，不用数字。

**敏感信息边界**：轨道常驻，永远不出现任务标题、Agent 名称、剪贴板正文、路径；
这些只在展开面板内出现（与主窗口同等可见性）。

## 五、交互规则

- **点击分类**：折叠态 → 展开该分类；展开态点其他分类 → 切换内容（不重新展开）。
- **再次点击当前分类** → 收起面板（回到轨道）。
- **Esc**：胶囊外壳以最低优先级（`kind: "drawer"`）注册到弹层栈，一次 Esc 只收面板，
  不会把窗口藏进托盘。
- **自动收起**：光标离开「可见区域 ∪ 8px」持续 450ms 后收起（不是隐藏窗口）。
  判定用**可见区域**（折叠只有轨道），不是窗口矩形——否则 400×420 的窗口会让
  自动收起永不触发。间隙由 8px 容差覆盖，鼠标从轨道移到面板不算离开。
- **不做悬停自动展开**：轨道本身就是可点击控件，悬停展开只会制造"反复展开/收起"。
- **拖离解除**：胶囊空白处可拖动（`data-tauri-drag-region`），偏离停靠位 >24px
  或离开磁吸区（>42px）即解除：清区域 → 恢复模式尺寸 → 收回工作区 → 清持久化。
- **托盘/快捷键唤回**：`snap-recall` → 展开功能面板（窗口始终可见，无需"找回"）。
- **吸附反馈**：拖拽阶段有光晕 + 高亮细线 + 「松开吸附到 X 侧」；停靠完成时轨道
  播放一次 0.34s 的轻微缩放脉冲（只播一次，不循环）。

## 六、视觉规范

- 轨道与面板是两块独立的圆角玻璃卡片：轨道全圆角（28px），面板 22px；
  背景用语义 Token `--card-face`、边框 `--border-subtle`、内高光用 `--c-paper`
  低透明度，阴影 `--shadow-raised`。
- 强调色（蓝紫 `--accent` / `--accent-gradient`）只出现在：Agent 状态球、
  选中分类的背景提亮、徽标、链接按钮。**不做常驻外发光**。
- 选中态用「背景提亮 + 1px 内描边 + 图标变色」，不用竖线 + 双圆弧。
- 文字层级：标题 12.5px/650、正文 12px、辅助 10.5px（`--text-primary/secondary/tertiary`）。
- 深色主题与浅色主题共用同一套结构与 Token，只有 Token 取值不同；
  应用图标头像在深色下单独调整对比度。
- 动效：面板入场 0.16s 淡入 + 2px 位移；吸附脉冲 0.34s 单次；
  全局 `prefers-reduced-motion` 规则会把动画时长压到 0.01ms。

## 七、性能与资源

- **IPC 收敛**：折叠态 tick 不再轮询光标（点击展开，无需悬停判定），只每 20 tick
  做一次可见性健康检查；展开态 tick 沿用既有 150ms 轮询，读取光标与窗口矩形各 1 次。
- **区域切换有序号防护**：迟到的响应不会覆盖新状态，且会按最新期望重同步一次。
- **面板数据按需读取**：任务/剪贴板在面板挂载时读一次（面板每次展开都会重新挂载），
  不做常驻轮询；Agent 走既有 `scheduleAgentRefresh` 的节流 + 单飞机制。
- **缩略图**：复用 `ClipboardThumb` 的进程内缓存（上限 240），只为最多 2 个截图组
  读详情，失败静默降级为图标。
- **卸载清理**：`useEdgeSnap` 卸载时清 interval、DOM 指针监听、Tauri 订阅、
  注入到 store 的三个动作，并关闭胶囊区域、恢复模式尺寸、清持久化。
- **无重复监听**：胶囊不新增任何全局事件订阅；剪贴板实时流仍由既有的单一监听承担。

## 八、兼容性

- `snap_state` 新增可选字段 `center`（胶囊沿边中心，物理像素）。
  旧记录没有该字段时按当前窗口中心重新停靠（`#[serde(default)]`），不会失效。
- 停靠期间不写 `window_rect`（窗口是胶囊容器尺寸，不是用户窗口几何）；
  解除吸附后按模式尺寸恢复并重新写入。
- 旧版「隐藏态短胶囊」相关样式（`.snap-capsule` / `--snap-capsule-*`）保留未删，
  已无组件引用，属可清理的历史样式（见验收报告 P3）。
- `apply_window_capsule` 命令签名由 `(enabled: bool, edge)` 改为
  `(mode: "off"|"rail"|"panel", edge)`；仅吸附引擎调用，无外部契约。

## 九、验证

- 纯函数：`src/lib/capsuleLayout.test.ts`、`src/components/capsule/format.test.ts`。
- 组件：`src/components/capsule/CapsuleDock.test.tsx`、`src/components/SnapOverlay.test.tsx`。
- 引擎集成（mock Tauri）：`src/hooks/useEdgeSnap.integration.test.tsx`，
  含"展开/收起不移动窗口"的回归断言。
- Win32 区域：`src-tauri/src/window_shape.rs` 的 `capsule_region_*` 单测 +
  真实（不可见）Win32 窗口上的 SetWindowRgn/CombineRgn 回读验证。
- 真机（可见窗口、多显示器、DPI、吸附手感）**未执行**，见验收报告"未验证项"。
