# 04 · 动效、玻璃效果与性能控制

> 原则：**视觉质量与性能同时验收**。空闲状态不得产生持续的大量动画帧，
> 不得用「好看」换「常驻桌面工具该有的安静」。

---

## 1. 分层渐进增强

| 层 | 内容 | 实现 | 降级 |
| --- | --- | --- | --- |
| 第 1 层 | 原生背景材质（Mica / Acrylic） | `window-vibrancy`，Win32 | 不支持 → `data-material="solid"`，界面改不透明表面，视觉语言不变 |
| 第 2 层 | 半透明 tint、渐变、内高光、玻璃胶囊 | CSS 渐变 + `box-shadow` | 始终可用（纯 CSS） |
| 第 3 层 | 轻量动态反馈 | 仅 `transition`（颜色/阴影/位移 ≤ 200ms） | `prefers-reduced-motion` 下全部关闭 |

**没有第 4 层**：不引入 WebGL / Canvas / 自定义着色器 / 实时折射。
理由见第 4 节。

---

## 2. 静态即默认

| 手段 | 做法 |
| --- | --- |
| 背景装饰 | 单个 `::before` 伪元素 + 4 个 `radial-gradient`，**一次绘制，零动画** |
| 玻璃质感 | 渐变 + `inset` 高光 + 外发光，全部静态 |
| 状态反馈 | 过渡 0.12–0.16s，只在交互时触发 |
| 空状态插画 | 纯 CSS 渐变气泡 + 2 个 SVG 图标，静态 |

页面里**没有 `requestAnimationFrame` 循环**、没有 CSS `animation` 驱动的装饰、
没有 `@keyframes` 背景漂移。唯一的常驻动画是 v0.5 已有的 Agent 状态点呼吸（`opacity`，2.4s/1.6s），
它在 `prefers-reduced-motion: reduce` 下被全局关闭。

---

## 3. 明确不做的事

| 诱惑 | 为什么不做 |
| --- | --- |
| 全窗口 `backdrop-filter: blur()` | WebView2 里 `backdrop-filter` 模糊的是**页面自身背景**，不是桌面；真正模糊桌面必须靠 Mica。且大面积 blur 会显著抬高合成开销 |
| 大量子节点叠加 `backdrop-filter` | 每个都是独立合成层，滚动时重绘成本随列表长度线性增长 |
| 实时折射（WebGL/着色器） | 需要常驻渲染循环（持续占用 GPU/CPU），与「空闲 0 帧」冲突；收益是装饰性 |
| 动画背景光斑漂移 | 常驻动画帧；在 400×560 的常驻小窗上，收益远小于代价 |
| `will-change` 滥用 | 会长期占用合成层内存；本项目只在 hover/active 期间用过渡，不预提升 |

当前实现中 **`backdrop-filter` 数量为 0**（由 `scripts/theme-perf.mjs` 自动核对）。

---

## 4. 性能测量（Chromium / 预览 harness 实测）

`node scripts/theme-perf.mjs`（需先 `node scripts/serve-preview.mjs`）：

| 用例 | 空闲 3s 主线程耗时 | 空闲布局次数 | 样式重算 | 脚本耗时 | 元素数 | backdrop-filter | 常驻动画 | 连续切换 20 次 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dream-gradient（浅） | 6.9 ms | 0 | 8 | 0.7 ms | 416 | 0 | 1 | 34.3 ms |
| liquid-glass（浅） | 5.8 ms | 0 | 9 | 0.5 ms | 416 | 0 | 1 | 33.5 ms |
| dream-gradient（深） | 6.1 ms | 0 | 9 | 0.5 ms | 408 | 0 | 1 | 31.0 ms |
| liquid-glass（深） | 6.4 ms | 0 | 9 | 0.6 ms | 408 | 0 | 1 | 31.6 ms |

解读：

- **空闲 3 秒主线程占用 ≈ 0.2%**，两套预设没有差异 → 玻璃层没有带来额外持续开销。
- **空闲期间 0 次布局** → 没有「每帧重排」。
- 连续切换 20 次主题共 31–34 ms（单次 ≈1.6 ms），无卡顿。
- 唯一的常驻动画是 Agent 状态点（1 个），8px 元素，`opacity` 合成，不触发布局。

---

## 5. 与高频数据的关系

主题层与数据层**完全解耦**：

- 主题只改 `document.documentElement.dataset` 上的变量与一次 Win32 调用；
- Agent 高频事件仍走原有的节流 + 单飞 + 合并调度（`scheduleAgentRefresh` / `scheduleTaskRefresh`），
  与视觉层没有共享状态；
- 切换主题**不会**重建组件树（React 树不变，只有 CSS 变量变），因此 Agent 消息积压风险不增加；
- 剪贴板监听与任务提醒在后台线程，主题切换不影响其生命周期。

---

## 6. 系统偏好与降级

| 偏好 | 检测方式 | 行为 |
| --- | --- | --- |
| `prefers-reduced-motion: reduce` | `matchMedia` | 全局过渡/动画时长压到 0.01ms（v0.5 已有）；v0.6 新增的位移动画（预设卡 hover）单独取消 |
| `prefers-contrast: more` | `matchMedia` | 装饰层隐藏、卡片改实心、边框改 `currentColor`、阴影退化为 1px 描边 |
| `prefers-reduced-transparency: more` | `matchMedia` | 材质回退 solid（原生效果同时被清除），界面改不透明表面 |
| 原生材质不可用 | Rust 返回 `applied=false` | `data-material="solid"` + `data-native-glass="false"`，玻璃语言保留但不透明 |

三者的检测都在 `useSettingsStore` 的同一条管道里，重算时**重新探测原生材质**，
因此「关闭减少透明」能真正恢复 Mica/Acrylic（v0.5 缺陷已修，见 02 文档 3.2）。

---

## 7. 合成与绘制成本

| 手段 | 成本 | 说明 |
| --- | --- | --- |
| 渐变背景（窗口/卡片） | 低 | 一次绘制，缓存为层 |
| `box-shadow` 多层内阴影 | 低 | 无模糊半径的大范围阴影由 GPU 一次填充 |
| `filter: blur()` | 中 | 仅用于 1 个 0.4px 的云团效果，可用渐变替代（已避免） |
| `backdrop-filter` | 高 | **未使用** |
| 列表滚动 | 与 v0.5 相同 | 任务卡结构未变，仅换背景 |

---

## 8. 验收清单

- [x] 空闲 3s 主线程占用 < 1%（实测 6.4–8.9 ms）
- [x] 空闲期间布局次数 = 0
- [x] 页面 `backdrop-filter` 元素数 = 0
- [x] 连续切换主题 20 次 < 100 ms
- [x] `prefers-reduced-motion` 下无位移/缩放动画
- [x] `prefers-contrast: more` 下装饰层隐藏、描边加强
- [x] 主题切换不重建组件树（不影响 Agent/剪贴板/任务状态）
- [ ] 原生窗口下的 GPU/内存占用需在真机长时间运行时复核（**当前环境未覆盖，见 07 文档**）
