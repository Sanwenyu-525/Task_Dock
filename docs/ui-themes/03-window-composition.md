# 03 · Windows 窗口合成（透明 / 圆角 / 阴影 / 原生材质）

> 适用：Task Dock 的无边框悬浮窗口（`decorations: false` + `transparent: true` + `shadow: false`）。
> 本文记录**真实原生实现**，以及 v0.5 遗留的「四角黑色直角」问题的根因与修复。
>
> **2026-10-31 更正**：本文第 3 节原先「`SetWindowRgn` 会把 DWM 背景一起裁掉」的结论
> 已被真机像素证伪——Win11 的 Mica/Acrylic SystemBackdrop 按整个窗口矩形绘制，
> 不受区域约束；Solid 模式也测到半径 31.75 vs 22 与 1px 描边。
> 修复必须同时包含「区域 + 原生后端选择 + DWM 边框策略」，详见
> **[12-v06-window-corners.md](12-v06-window-corners.md)**。本文 3.0 节已补上原因。

---

## 1. 当前窗口配置

`src-tauri/tauri.conf.json`：

```json
{
  "label": "main", "width": 400, "height": 560,
  "minWidth": 240, "minHeight": 96,
  "decorations": false, "transparent": true, "shadow": false,
  "alwaysOnTop": true, "skipTaskbar": true, "resizable": true, "visible": false
}
```

| 配置 | 作用 | 不能改的原因 |
| --- | --- | --- |
| `decorations: false` | 自绘标题栏 | 保留拖动区与最小化/关闭按钮的完全控制权 |
| `transparent: true` | WebView2 背景透明，让原生 Mica/Acrylic 与桌面透出 | 去掉后毛玻璃彻底失效（只剩 CSS 假玻璃） |
| `shadow: false` | 不使用 Tauri 的无边框阴影 | Tauri 的 `undecorated_shadow` 会额外加 1px 边框与阴影，Windows 上表现为「双层边框 + 生硬外框」，与「轻盈悬浮」目标冲突 |
| `alwaysOnTop` | 常驻桌面工具 | 业务需求 |
| `visible: false` | 先建窗、后显示 | 避免透明闪烁；`setup` 里显示 |

---

## 2. v0.5 的「四角黑色直角」：根因

现象：窗口四角出现近乎黑色的直角块。

根因链：

1. 应用了原生 **Mica / Acrylic**（`window-vibrancy`）。DWM 的系统背景是按**整个窗口矩形**绘制的，
   它不受 WebView2 内容里的 CSS `border-radius` 影响。
2. 页面里 `.dock-window` 用 `border-radius: 18px` + `overflow: hidden` 裁掉了**自己的内容**，
   但裁不掉 **DWM 绘制的系统背景**。
3. 结果：内容是圆角，系统背景是直角 → 四角露出深色（近黑）的直角区域。

因此「只加 `border-radius`」不可能修复，必须在**窗口几何层面**裁剪。

---

## 3. v0.6 的修复：窗口区域 + 原生后端 + DWM 边框

### 3.0 为什么仅靠 `SetWindowRgn` 不够

真机受控背景采集（`lab-glass-region-dwm.json`）显示：

- `region_probe=00001 bounds=0,0,500,700`（区域已设置、四角点在区域外）；
- 玻璃（`system_backdrop=2`）四角仍有 44–45 个深色像素、49 个非背景像素；
- Solid（`system_backdrop=1`）四角虽无深色连通块，但半径实测 31.75 vs 22，
  且底/右仍有 1px 描边（ΔL=101.0 / 59.3）。

`SetWindowRgn` 只约束 GDI/窗口自身合成层；DWM 的 Mica/Acrylic SystemBackdrop
按窗口矩形绘制，仍会在区域外留黑月牙。因此修复分三层：

| 层 | 实现 | 作用 |
| --- | --- | --- |
| 1 | `SetWindowRgn(CreateRoundRectRgn(0,0,w+1,h+1,2r,2r))` | 裁掉 WebView2/GDI 内容 |
| 2 | `effective_backend`：Win11 + 区域裁剪时 default 用 **css**（不挂原生材质，CSS 玻璃；2026-10-31 晚更正，原为 blur） | 圆角外无原生层，直接透出桌面；显式 `mica/acrylic/blur/css/none` 保留供矩阵对照 |
| 3 | `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE` + `DWMWA_WINDOW_CORNER_PREFERENCE` | 去掉默认 1px 边框，保留系统圆角偏好 |

文件：`src-tauri/src/window_shape.rs`、`src-tauri/src/commands/system.rs`。

### 3.1 半径来源

前端在应用预设后调用 `apply_window_radius(radius)`：

- 梦幻渐变 `18px`
- 液态玻璃 `20px`

Rust 端 `window_shape::set_radius()` 把半径夹取到 `0..=40`，非法值（NaN）回退 18。
半径以「逻辑像素」存储，实际裁剪时乘以 `scale_factor()` 得到物理像素。

**2026-11-01 晚更正（把区域换成矩形，轮廓交给 CSS）**：上一条「区域半径内收 2px」
在真机复测中被推翻——DWM 的圆角裁剪（约 8 DIP）与区域圆角在同一个窗口矩形上**不是
同心弧**，两者相交，中间露出透明月牙；区域硬边仍会切进 CSS 抗锯齿像素，形成
「外圈平滑 + 内圈阶梯」。主窗现在的做法是：

1. `SetWindowRgn` 只设**整窗矩形**（`CreateRectRgn(0,0,w+1,h+1)`）：窗口仍可见、
   仍可合成、区域缓存/回读口径不变，但 GDI 不再提供任何圆角硬边；
2. `DWMWA_WINDOW_CORNER_PREFERENCE = DONOTROUND` + `DWMWA_BORDER_COLOR = NONE`：
   去掉 DWM 的 8 DIP 圆角与描边，避免系统弧线与 CSS 弧线再次相交；
3. 可见轮廓完全由 WebView2 的 CSS `border-radius`（18/20px）抗锯齿弧定义，
   渐变/玻璃材质覆盖到该弧线，没有月牙，也没有 `SetWindowRgn` 的阶梯硬边；
4. 透明角命中由 `WM_NCHITTEST` 子类化按 `point_in_rounded_rect()` 判定；WebView2 的
   真实鼠标命中走子窗口，实测透明角的点击/拖动与原生 Win11 圆角窗口一致
   （见验收报告「遗留问题」）。

胶囊模式与右键菜单弹窗**不受影响**：右键菜单仍用 `CreateRoundRectRgn`；
分类胶囊自 2026-11-01 方案 B 起，**轨道改用 `CreatePolygonRgn`**（液态翼片轮廓，
见 [13-capsule-redesign.md](13-capsule-redesign.md) §二·五），面板仍是圆角矩形，
两者 `CombineRgn(RGN_OR)` 合并。胶囊几何与主窗独立。
`GetWindowRgn` 回读校验包围盒与关键点，胶囊额外要求「外框缺角必须在区域外」。

**2026-11-01 深夜二轮更正（矩形区域方案被真机推翻，主窗恢复圆角区域）**：
上一条「整窗矩形 + CSS 轮廓」在**非激活态**复现出白色直角三角。受控灰底（200,200,200）
下，隐藏窗口基线帧与可见帧逐像素对比：CSS 渐变内部仍是圆角，但窗口矩形四角为纯白
`255,255,255`（背景为 `200,200,200`），在灰底/浅灰底上就是用户看到的「浅灰色三角」；
纯白/纯黑桌面下几乎不可见。根因是 WebView2 在失焦/非激活后会按窗口矩形回填默认底色，
矩形 `SetWindowRgn` 不裁它，`DWMWCP_DONOTROUND` 与边框色 NONE 也管不到。
DWM 原生圆角半径固定为 8 DIP（`DWMWCP_ROUND` 不可配置，`ROUNDSMALL` 更小），无法匹配
18/20 CSS px 的设计半径，也不能作为修复。

主窗现在的做法（`src-tauri/src/window_shape.rs`）：

1. **圆角区域 = CSS 像素支撑形状**：不再用单个 `CreateRoundRectRgn`，而是按行计算
   `css_support_left(y, h, r)`（像素 `[x,x+1]×[y,y+1]` 与圆角圆相交的最小 x），把连续
   同起点的行合并成矩形并集。这样区域**恰好覆盖 CSS 真正触及的像素**（含极低 alpha
   的抗锯齿外沿），又**不覆盖任何完全透明像素**：既不会把 AA 切成 GDI 硬边，也不会让
   非激活态白色回填从透明像素露出，圆角外也不会多出命中。
   125% 下 dream 18px（物理 22.5）实测首行起点 x=15/13/11/9/7/3（y=0/1/2/3/5/10），
   与公式逐行一致；单测 `css_support_left_matches_real_aa_pixels` 锁定。固定内收 2px
   或单一圆半径都无法同时满足这两个约束（实测内收 2px 会切掉 x=15..19）。
2. `DWMWCP_DONOTROUND` 保留：否则 8 DIP 系统弧会在自定义大圆角内部再切一刀，形成双弧。
3. CSS `border-radius` 只负责边缘抗锯齿，可见轮廓 = 区域裁剪 + CSS AA 弧。
4. 删除 `WM_NCHITTEST` 子类化：圆角区域本身就是窗口命中区，圆角外不再属于窗口。
5. 胶囊与右键菜单弹窗保持各自独立的区域几何；主窗不再有「CSS 轮廓模式」分支。

真机证据：`tmp/acceptance/window-corner-unification/grey-20261101/` 中
`exp-inactive-rect-grey200`（旧方案：四角白色）与 `exp-inactive-round20-grey200`
（圆角区域：四角为背景色）；修复后构建的完整矩阵见同目录 `round2-*`。

### 3.2 尺寸与 DPI 变化

`restore_window()` 里额外注册了一个窗口事件监听：

```rust
win.on_window_event(move |event| {
    if matches!(
        event,
        WindowEvent::Resized(_)
            | WindowEvent::ScaleFactorChanged { .. }
            | WindowEvent::Focused(true)
    ) {
        window_shape::apply(&win);
    }
});
```

窗口缩放、贴边吸附、DPI 切换、从最小化/托盘恢复（`show_and_focus` 也补一次重算）
都会重新校验。

配套处理：

| 处理 | 原因 |
| --- | --- |
| `RegionStamp` 缓存（`hwnd`/物理宽高/半径/DPI） | 句柄、尺寸、DPI、半径任一变化都失效，不能只看宽高与半径 |
| `region_is_current()` 回读 `GetWindowRgn`/`GetRgnBox`/`PtInRegion` | 系统重置区域后即使缓存参数相同也必须重设；无区域/包围盒不符/角落仍实心都判失效 |
| `APPLYING + PENDING` | 重入请求不再丢弃：内层置 PENDING，外层按最新尺寸最多 8 次重算，收尾再补一次异步应用 |
| `schedule_reapply()`（150/500/1200/2500 ms 四次延迟重算） | 启动阶段窗口会连续变化（模式尺寸 → 记忆矩形 → 前端布局稳定），延迟重算保证区域最终与窗口尺寸一致 |

### 3.2.1 顺带修掉的 v0.5 缺陷：窗口尺寸逐次放大

前端保存窗口矩形用的是**物理像素**（`outerPosition()` / `outerSize()`），
而 `restore_window()` 却按**逻辑像素**还原：

```rust
// v0.5：按逻辑像素还原 → 125% 缩放下每次启动窗口放大 25%
win.set_size(tauri::LogicalSize::new(rect.w as f64, rect.h as f64));
// v0.6：按物理像素还原，与前端保存口径一致
win.set_size(tauri::PhysicalSize::new(rect.w, rect.h));
```

该缺陷会让「窗口区域半径」与「窗口实际尺寸」持续错位，也是四角裁剪看起来时灵时不灵的原因之一。

### 3.3 资源所有权

`SetWindowRgn` 成功后 **region 归系统所有**，不得再 `DeleteObject`；
失败时系统不接管，必须由调用方 `DeleteObject`，否则会泄漏 GDI 对象。
代码里按返回值分支处理。

### 3.4 防重入

`APPLYING` 只表示「外层正在应用」；期间到达的请求置 `PENDING`，由外层合并重算，
不能在重入时直接 return——否则拖拽缩放的最后一帧可能永远得不到圆角。
外层结束后若仍有 PENDING，投递一次异步应用兜底（见 3.2 表）。

### 3.5 诊断开关

原生材质（Mica/Acrylic）与无边框分层窗口之间存在组合风险（分层窗口 + 窗口区域可能影响
WebView2 合成）。为了能在真机上快速定位，保留两个环境变量开关：

| 环境变量 | 作用 |
| --- | --- |
| `TASK_DOCK_WINDOW_REGION=0` | 不设置 Win32 窗口区域（仅保留 CSS 圆角），用于判断「区域裁剪」是否是合成问题的来源 |
| `TASK_DOCK_WINDOW_DWM_CORNER=0` | 不设置 DWM 圆角偏好，用于判断「DWM 圆角」是否是合成问题的来源 |

配套脚本：`scripts/diagnose-corner.ps1`（四种组合 × solid/glass 的抓屏矩阵）。

> 结论以真机矩阵为准，见 [07-visual-acceptance.md](07-visual-acceptance.md) 第 3 节。

---

## 4. 为什么没有「外部投影」

窗口外形被 `SetWindowRgn` 裁剪后，DWM 不会再为该窗口绘制外部阴影，
CSS `box-shadow` 的外部部分也被裁掉。这是「真圆角」的代价。

替代方案（本项目采用）：**内边光 + 底部内阴影**表达悬浮层次：

```css
--window-edge:
  inset 0 0 0 1px rgba(255, 255, 255, 0.6),
  inset 0 1px 0 rgba(255, 255, 255, 0.9),
  inset 0 -24px 48px -34px rgba(90, 96, 170, 0.22);
```

- 第一层：1px 内描边代替外框（无「双层边框」感）
- 第二层：顶部高光（模拟玻璃/亚克力受光）
- 第三层：底部内阴影（把窗口从背景里「抬起来」）

Win11 上 `DWMWCP_ROUND` 会额外提供系统级阴影与抗锯齿圆角（若系统主题允许）。

### 4.1 2026-11-03：玻璃外壳 Token（`--shell-wall`）

主窗最外 1–6px 增加一层语义化壳体，不改变内容区、不新增 DOM、不新增层叠上下文：

- `--window-edge` 统一为 6 层 inset：1px 轮廓环、顶部 1px 高光、窄幅顶部泛光、
  左侧环境反射、右侧弱边光、内侧柔和环境遮蔽（AO）。浅色主题轮廓取中性蓝紫
  （dream `rgba(74,78,148,.30)` / glass `rgba(80,104,146,.30)`），深色主题取低亮度冷光
  （`.18` / `.20`），保证白桌面上仍有可辨识边界。
- `--shell-wall` 描述 1–6px 的玻璃侧壁（上/左/右/下四段 + 左上、右下角部径向光），
  由 `.dock-window::before` 以 `background-image: var(--shell-wall), var(--decor)` 绘制。
- `::before` 自 `inset: 1px`、`border-radius: calc(var(--radius-window) - 1px)` 起绘制，
  让最外 1px 轮廓不被伪元素背景覆盖（这是白桌面上边缘发灰的根因）。
- 胶囊停靠态继续由 `.dock-window.is-capsule::before { content: none }` 与
  根规则 `box-shadow: none` 整体关闭，不会在整窗矩形上出现外壳。

**限制（如实表述）**：主窗区域由 `SetWindowRgn` 裁剪，DWM 不绘制外部阴影，CSS 外部
`box-shadow` 也被裁掉。上述全部是**窗口内**的立体表达，**不是**桌面上的真实外投影；
真实外投影需要改窗口区域/原生阴影方案（会影响圆角、命中与贴边），不在本次范围。

### 4.2 2026-11-03：材质三态（Native Glass / CSS Glass / Solid）

`applied` 只回答「玻璃渲染有没有起来」，`material=glass` 在 CSS 路径下同样会返回
`applied=true`；**不能用 `applied` 推断原生模糊是否生效**。后端因此新增 `native` 字段
（`src-tauri/src/commands/system.rs::MaterialResult`），与 `effect` 一起构成三段语义：

| 字段组合 | 渲染态 | 含义 |
| --- | --- | --- |
| `applied=true, native=true, effect=mica/acrylic/blur` | Native Glass | DWM/系统模糊真正生效，窗口可以更低不透明度让桌面透出 |
| `applied=true, native=false, effect=css` | CSS Glass | 只有 CSS 半透明/高光，**没有原生模糊**，必须用高不透明度霜面保证可读性 |
| `applied=false` 或 `material=solid` | Solid | 完全不透明兜底 |

前端（`src/lib/theme.ts`、`src/store/useSettingsStore.ts`）把三态显式落到
`html[data-material]`、`html[data-glass-render]`、`html[data-native-glass]`；
`data-glass-render` 是 CSS 选择参数集的唯一依据，`data-native-glass` 只表达
「是否原生模糊」，二者不再混用。

- **CSS Glass（`[data-glass-render="css"]`）**：Win11 + 区域裁剪的默认路径。填充不透明度
  保持 97% 左右（`--window-fill` 的 `rgba(...,.973–.982)`），冰蓝霜面由顶部冰白高光、
  中部浅冰蓝、底部偏冷三段落差表达；桌面只贡献极轻色温，背景文字/图标不可辨认
  （v0.7 真机截图曾因 0.88–0.95 不透明度出现「桌面文字穿过窗口」，已复现并修正）。
  外壳在该态额外强化 `--window-edge`：冷灰发丝环 + 左冰蓝反射 + 顶部冰白高光 +
  很轻的底部内暗部，仍为单环，不叠加第二圈边框。
  2026-11-03 追加：`--window-fill` 增加 112° 斜向霜带（36% 处约 0.34 白、44% 回落到
  0.06）与略深的底部冷色，用静态渐变表达磨砂玻璃的侧光散射；不改变 97% 级不透明度，
  桌面文字仍不可辨认。深色卡片的 `--card-shadow` / `--rail-active-shadow` 改用
  `rgba(2, 6, 18, …)` 低不透明度扩散，替换纯黑 0.9–1.0，避免深色主题出现厚重黑边。
- **Native Glass**：沿用基础 `--window-fill`（0.88–0.95）与默认外壳，让系统模糊自然透出；
  只在 `native=true` 时生效。
- **Solid（`[data-material="solid"]`）**：完全不透明渐变（浅色 `#fbfdff…#f1f8ff`、
  深色 `#1a1d2c…#181c2a`），菜单/弹窗同样走不透明面，保证任何桌面下都可读。
- **异步一致性**：`applyMaterial()` 带自增 `materialEpoch`，每次 await 后校验；
  旧的原生探测响应不会覆盖之后用户新选的材质/主题。
- **胶囊态**：`.dock-window.is-capsule` 继续整体关闭主窗背景、外壳与装饰；材质三态
  不影响胶囊的 `SetWindowRgn` 外形。注意覆盖规则必须写成
  `:root[data-theme] .dock-window.is-capsule(.material-glass)`：深色主题下
  `:root[data-theme="dark"] .dock-window.material-glass` 的 `box-shadow: var(--window-edge)`
  与旧覆盖同权重且更早出现，曾导致胶囊整窗仍带内阴影（2026-11-03 真机检查发现并修复）。

单测：`src/lib/theme.test.ts`（`resolveGlassRender` / `hasNativeGlass` 的 native/css/solid
矩阵）、`src/store/useSettingsStore.test.ts`（CSS 玻璃不得标记 native、旧后端缺 `native`
字段按 css 处理、减少透明降级、过期响应丢弃）。

---

## 5. 材质（Mica / Acrylic）

`src-tauri/src/commands/system.rs::apply_window_material`：

| 系统 | build | 效果 |
| --- | --- | --- |
| Windows 11 + 区域裁剪（默认） | ≥ 22000 | **css**：不挂原生材质，玻璃由 CSS 半透明承担（无圆角暗楔） |
| Windows 11 关闭区域裁剪（矩阵对照） | ≥ 22000 | `apply_mica` |
| Windows 10 | ≥ 17134 | `apply_acrylic` |
| 更早 / 失败 | — | `applied=false`，前端回退 solid |

> 2026-11-03：`css` 分支返回 `applied=true / native=false / effect="css"`；只有
> `mica/acrylic/blur` 分支返回 `native=true`。前端据此选择 CSS 霜面或原生半透明参数，
> 详见 §4.2。

> **2026-10-31 更正**：Win11 22631 的 legacy `ACCENT_ENABLE_BLURBEHIND` 也被真机像素
> 证明会在区域圆角外留下暗楔（角部 `[1,11,1]`，solid 同位置为背景色），
> `SetWindowRgn` 无法裁剪原生层。默认后端因此从 `blur` 改为 `css`；
> 显式 `TASK_DOCK_GLASS_BACKEND=blur` 仍可用于矩阵复现。证据见
> `tmp/acceptance/dock-line-undock-20261031/report.md`。

- 使用 `window-vibrancy`（Tauri 自身的 Windows 传递依赖，**不新增 crate**）。
  之所以不用 `tauri::Window::set_effects`：它在 Windows 上吞掉底层错误（恒返回 Ok），
  无法判断是否真的生效。
- 调用必须回到**主线程**（Win32 窗口操作），Rust 端用 `run_on_main_thread` + 2 秒超时保护。
- 前端每次重算材质都会真正调用一次该命令（幂等），
  保证「系统减少透明 → 关闭」后能真正重新应用，而不是只恢复 CSS 半透明。
- **胶囊停靠态例外（2026-11-01 修复）**：DWM 原生背景按整个窗口矩形绘制，
  不受 `SetWindowRgn` 约束；因此胶囊停靠期间会临时停用 Mica/Acrylic/blur，
  只用 CSS 玻璃，解除吸附后按记录的效果恢复。详见
  [13-capsule-redesign.md](13-capsule-redesign.md) 第十节。

---

## 6. 拖动 / 缩放 / 贴边 / 托盘 / 位置记忆

全部沿用 v0.5 实现，未因视觉重构改动：

| 能力 | 实现位置 | v0.6 是否改动 |
| --- | --- | --- |
| 窗口拖动 | `data-tauri-drag-region`（标题栏与品牌区） | 保留；新增的按钮均未加该属性，点击不受影响 |
| 缩放 | 无边框窗口右下角 6px 命中区 | 保留（圆角区域不覆盖缩放热区） |
| 贴边吸附 | `src/hooks/useEdgeSnap.ts` | 未改动 |
| 托盘隐藏 | 标题栏「×」/ Esc → `getCurrentWindow().hide()` | 未改动 |
| 位置/尺寸记忆 | `window_rect` 设置 + `restore_window` | 未改动 |

---

## 7. 已知限制

| 限制 | 说明 | 影响面 |
| --- | --- | --- |
| 区域裁剪边缘无抗锯齿 | 主窗区域按 `css_support_left()` 逐行贴合 CSS 抗锯齿支撑形状（二值边落在约 0 alpha 的最外像素），可见边缘由 WebView2 抗锯齿弧定义；胶囊轨道用同轮廓**外扩 2px** 的多边形区域、面板用半径内收 2px 的圆角矩形，弹窗同理 | 主窗平滑；胶囊/弹窗边缘为二值裁剪，但硬边落在完全透明的像素上，可见轮廓仍由 CSS 曲线定义 |
| 透明角命中 | 主窗逐行像素支撑区域定义窗口命中区，圆角外像素不属于窗口；不再依赖 `WM_NCHITTEST` 子类化（已删除） | 真机点击：四角精确点均穿透到桌面；透明条（局部 5,5）也穿透；可见弧（10,10）与中心命中应用 |
| 无外部投影 | 见第 4 节 | 悬浮感靠内边光表达 |
| Mica 跟随系统明暗 | `apply_mica(win, None)` 使用系统主题色，应用自身 light/dark 与系统不一致时，玻璃底色会偏 | 液态玻璃在「应用浅色 + 系统深色」时最明显 |
| 远程桌面 / 虚拟机 | 无 GPU 合成时 Acrylic 可能不可用 | 自动回退 solid |
| 多显示器 DPI 不一致 | 已按 `scale_factor()` 换算；跨屏拖动会触发 `ScaleFactorChanged` 重算 | 已覆盖 |

---

## 8. 验收方法（可复现）

**旧的「`region_probe=00001` + 同帧像素差 0.0」不能作为圆角通过依据**：
区域成功不代表 DWM 没在区域外绘制，同帧自比也发现不了黑角。

现行方法（`scripts/corner-lab.ps1` + `scripts/check-corners.py`）：

```powershell
# 1) 受控纯色背景上采集：隐藏窗口的基线帧 + 显示窗口的可见帧
powershell -ExecutionPolicy Bypass -NoProfile -File scripts/native-verify.ps1 `
  -Out docs/screenshots/v07/lab-solid-region-dwm.png `
  -Material solid -Preset dream-gradient -Width 500 -Height 700
powershell -ExecutionPolicy Bypass -NoProfile -File scripts/native-verify.ps1 `
  -Out docs/screenshots/v07/lab-glass-region-dwm.png `
  -Material glass -Preset liquid-glass -Backend blur -Width 500 -Height 700

# 2) 独立基线判定（0 PASS / 1 FAIL / 2 UNVERIFIED）
python scripts/check-corners.py docs/screenshots/v07/lab-*-region-dwm.json --summary

# 3) 几何矩阵（Region/DWM × Solid/Glass，按需加 -Backends mica,blur,none）
powershell -ExecutionPolicy Bypass -NoProfile -File scripts/diagnose-corner.ps1 `
  -Out docs/screenshots/v07/matrix
```

判定项：基线纯色有效性、圆角外像素与基线吻合、深色连通块、1px 描边/外扩阴影、
半径拟合（逻辑半径 × DPI）、DWM 角偏好与边框可读性、区域包围盒。
缺少有效基线 → `UNVERIFIED`，绝不以 `GetWindowRgn` 成功代替。

---

## 9. 2026-11-02 更正：停靠胶囊的「整窗轮廓 + 外阴影」根因与修复

**现象**：窗口吸附屏幕边缘进入胶囊停靠态后，屏幕上仍出现**整个窗口矩形的浅/白色圆角矩形 +
明显外部阴影**，右侧同时显示胶囊轨道（浅色主题下最明显，即用户截图的形态）。此前
`docked-window-hidden` 验收用纯黑背景 + 激活态截图，阴影/轮廓被背景掩盖，未发现。

**真机 A/B**（隔离数据、125% DPI、edge=right 折叠、窗口 510×550、受控纯色背景 `#D3D3D3`；
证据 `tmp/acceptance/docked-window-residual-fix/raw/ab3-*`）：

| 组 | cornerPref | 区域外 DWM 边框/内缘暗像素 | 区域外白簇 | 窗口矩形外 60px 阴影像素 | 判定 |
|---|---|---|---|---|---|
| round | ROUND(2) | 1,696–1,709 px | 1–32 px（轨道 AA） | 47,966 px | 残留 |
| dontround | DONOTROUND(1) | 50–63 px | 1 px | 120 px | 干净 |
| ncr-off | DONOTROUND + NCRENDERING=DISABLED | 50 px | 1 px | 120 px | 干净（无额外收益） |

同条件回读：两种策略 `GetWindowRgn` 都是 `kind=3 box=438,25,510,525`（只右轨道），胶囊轨道
像素逐像素一致（AA 未退化）；`PrintWindow` 只有胶囊，而 `CopyFromScreen` 在 ROUND 下是整窗
圆角系统边框 + 柔和外阴影。激活/失焦截图哈希相同 → 与 WebView2 失焦回填无关。
ROUND 与 DONOTROUND 的逐像素 diff 共 86,123 px，**全部是「比背景更暗」的像素（86,123 darker /
0 lighter）**，且窗口内部中心像素两者都与背景同色 `(211,211,211)`：**DWM 只画了系统边框 +
投影，窗口内部仍然透明**，没有不透明背板。

**机制**：停靠期间窗口仍带 `WS_CAPTION | WS_THICKFRAME`（tao 对所有窗口无条件设置 CAPTION、
RESIZABLE 时加 THICKFRAME；其 `WM_NCCALCSIZE` 返回 0 使客户区=整窗，所以平时看不到 NC 边框）。
`DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND` 会让 Win11 DWM 在**整个窗口矩形**上绘制圆角
系统边框 + 外部投影。`SetWindowRgn` 只定义窗口**内容表面**的可见区域（GDI/WebView2 合成），
裁不到 DWM 的非客户区合成层——同一窗口上「区域 = 胶囊」与「DWM 边框/投影 = 整窗」可以同时成立。
这与 §3.0 记录的 SystemBackdrop 越界同源。

用户看到的「大面积白色主窗口矩形」= 浅色桌面/背景从透明窗口矩形透出 + DWM 整窗边框/阴影把
矩形勾出来，二者叠加的观感（不是 DWM 填充了不透明背板）：像素证据显示窗口内部保持透明；
深色背景上同一残留表现为「整窗轮廓 + 阴影」，不出现白板。

**修复**（`src-tauri/src/window_shape.rs`）：胶囊区域应用后**不再**把 DWM 角偏好设为 ROUND，
而是与主窗正常态一致的 `DWMWCP_DONOTROUND`；胶囊可见外形完全由 `SetWindowRgn`（翼片多边形外扩
2px / 面板圆角支撑形状）定义。DWM 角偏好选择收敛为纯函数 `dwm_rounded_for(MainRegionShape)`：
`Capsule` / `Full` → false，仅 `FullFallback`（整窗区域写入失败的系统圆角兜底）→ true；单测
`dwm_round_is_never_used_for_capsule_or_full_region` 锁定该契约。另有真实 Win32 窗口单测
`window_region_survives_style_change_and_dwm_attributes` 证明：`SetWindowLongW(GWL_STYLE)` +
`SWP_FRAMECHANGED` 不会重置窗口区域；DWM 角偏好可写可读且不影响区域——「区域」与「DWM 合成层」
互不替代。

**回归口径**：停靠态验证必须用 `CopyFromScreen` 像素统计（区域外白簇、DWM 边框/内缘暗像素、
窗口矩形外投影像素）而不是只看 `GetWindowRgn` 回读；背景不能用纯黑/纯白掩盖阴影；必须覆盖
激活/离焦两态与浅/深主题。

**旧结论更正**：§4「Win11 上 `DWMWCP_ROUND` 会额外提供系统级阴影与抗锯齿圆角」在**胶囊小区域**
场景下不成立且有害——它让 DWM 在整窗矩形上画出系统边框 + 外部投影；该条仅对「区域≈整窗」的
主窗兜底路径（`FullFallback`）保留。

---

## 10. 2026-11-04 更正：右键菜单圆角改「CSS 像素支撑区域 + DONOTROUND」

**更正对象**：§3.1 中「右键菜单仍用 `CreateRoundRectRgn`」「胶囊与右键菜单弹窗保持各自独立
的区域几何」的旧实现描述（保留原文，不再按该描述实现）。右键菜单仍是独立窗口、独立几何，
但**不再使用 GDI 硬边圆角椭圆**。

**现象**：右键菜单四角出现阶梯锯齿，部分条件下叠加双圆角/月牙缝与异常系统边框。

**根因（真机几何 + 静态代码双向确认）**：

1. `context_menu` 独立窗口此前走 Popup 分支 `CreateRoundRectRgn(0,0,w,h,2r,2r)`；
   `CreateRoundRectRgn` 是**二值区域**，没有抗锯齿，16 CSS px 的弧被 GDI 按物理像素切出
   阶梯；同时该区域的弧线与 CSS `border-radius` 的 AA 外沿不完全重合，会切进 CSS 的半透明
   边缘像素（深色桌面上表现为一圈白色/浅色阶梯）。
2. Popup 分支成功写区域后**仍**把 `DWMWA_WINDOW_CORNER_PREFERENCE` 设为 `DWMWCP_ROUND`。
   DWM 的 8 DIP 系统弧与区域/CSS 的 16px 弧不是同心弧，两者相交 → **双圆角 + 透明月牙缝**；
   `DWMWCP_ROUND` 还会沿整窗矩形画系统边框/投影（机制同 §9），在区域外或边缘形成异常边框。
   即：**同一窗口被 Win32 区域与 DWM 系统角同时裁剪**，这是锯齿之外的第二层缺陷。

**修复**（`src-tauri/src/window_shape.rs`、`src-tauri/src/context_menu.rs`）：

1. Popup 分支改用与主窗同一套 `support_rect_rgn()`（逐行 CSS 弧像素支撑形状）：覆盖 CSS
   真正触及的像素（含极低 alpha AA 外沿），排除完全透明像素；右/下边界用开区间，不引入
   `+1` 容差。区域随 `Resized` / `ScaleFactorChanged` 重新应用（`apply_with_radius`），
   缓存 stamp 含 hwnd/物理宽高/半径/DPI，尺寸变化与 DPI 变化都会失效重算。
2. 区域写入成功 → `DWMWCP_DONOTROUND`（`dwm_rounded_for_popup(true) == false`）；仅区域
   失败退化为直角矩形时用 `ROUND` 兜底，避免完全失去圆角。单测
   `dwm_round_is_never_used_for_popup_region` 锁定该契约。
3. 表面不再叠原生材质/整菜单 `backdrop-filter`，可见外形完全由「区域 + CSS AA 弧」定义。
4. 未采用「整窗矩形区域」方案：§3.1 已记录非激活态 WebView2 矩形白底回填，菜单窗口同样不适用。

**真机证据**（`tmp/acceptance/context-menu-visual-fix/`，125% DPI，真实 Tauri 窗口桌面合成截图）：

- 菜单窗口 `rect=2035,621,313,751`，`GetWindowRgn` 回读 `regionType=3(COMPLEX)`、
  `regionBox=[0,0,313,751]`，`dwmCornerPreference=1(DONOTROUND)`，`dwmBorderColor=-1`；
- 反复打开两次几何完全一致（无 resize 漂移）；
- 四角 6× 放大（`screenshots/corners.png`、`light-corners.png`、`dark-corners.png`、
  `light-on-dark-corners.png`）无阶梯、无第二道系统弧、无矩形回填、无系统边框；
- 失焦关闭后原菜单区域无残留（`screenshots/blur-leftover.png`）。

**回归口径**：菜单圆角验收必须同时看「区域类型/包围盒」与「桌面合成截图四角放大」；只看
`GetWindowRgn` 成功不能证明无锯齿，只截 WebView2 页面也不能证明区域裁剪。

**限制**：区域仍是二值裁剪，最终 1px 级平滑由 CSS AA 弧提供；在 100/150/200% DPI 上只有
几何单测（`popup_support_region_scales_with_dpi`）覆盖，本机实机仅 125%。

## 11. 2026-11-04 第二轮：圆角重入调度与菜单工作区高度

### 11.1 Popup 圆角重入必须保留 ShapeTarget 与半径

**根因**：`window_shape::apply_impl` 的重入处理用全局 `APPLYING` / `PENDING` 布尔，检测到
重入时再次调用 `apply(&win)`（等价 `ShapeTarget::Main`），**丢失了调用方传入的
`ShapeTarget` 与 `logical_radius`**。右键菜单（Popup / 16px）在 `Resized` /
`ScaleFactorChanged` 连续触发时会被按 Main / 18px 重算：Popup 区域包围盒按主窗规则多 1px、
弧半径变大；同时全局布尔让不同 HWND（主窗与菜单）互相阻塞或覆盖。

**修复**：改为按 **HWND** 的 `ApplyGate`：

- `applying: HashSet<isize>`：仅同 hwnd 视为重入；不同 hwnd 各自进入，不互相等待；
- `pending: HashMap<isize, PendingShape>`：`PendingShape { target, radius_milli }`，
  半径以「逻辑像素 × 1000」整数保存（与 `set_radius` 同一夹取规则，NaN→18、0..40），
  重入不丢精度、不回落默认形态；
- `apply_impl` 循环消费本 hwnd 的最新请求（后到覆盖先到），离开临界区与取剩余请求在同一把
  锁内完成，避免丢请求；仍在临界区外时用 `run_on_main_thread` 补偿，且补偿直接调用
  `apply_impl(..., radius, target)`，不再调用 `apply()`；
- 每窗口最多 8 轮收敛，正常 1–2 轮（尺寸稳定即退出），不无限重试。

**契约**：任何延迟/补偿重算都必须携带原始 `ShapeTarget` 与逻辑半径；Main 与 Popup 的区域
策略（`main_region_rgn` 含 +1 边界 / `support_rect_rgn` 不含）不得混用。

**测试与真机**：`cargo test --lib window_shape` 30 passed，新增
`popup_reentry_preserves_target_and_radius`、`main_and_popup_requests_do_not_cross`、
`latest_reentry_request_wins_per_hwnd`、`radius_milli_clamps_and_rounds_like_set_radius`、
`forget_window_clears_stamp_and_stability`、`popup_stamp_invalidates_on_dpi_change`。
125% DPI 真机对菜单连续 `SetWindowPos`（751→300→600→400→751→240→700→751）后：
`regionBox=[0,0,313,751]` 与窗口宽高一致（回落 Main 会多 1px）、`dwmCornerPreference=1`。

### 11.2 菜单高度按锚点所在工作区收放

**根因**：`fit_context_menu()` 把窗口高度固定夹在 80–900 逻辑像素，`place_menu()` 只算位置，
高 DPI 小屏上窗口底部会超出工作区，末项不可达。

**策略**（`src-tauri/src/context_menu.rs`）：

- **自然高度与实际窗口高度分离**：`MENU_NATURAL_HEIGHT`（前端 `scrollHeight` 实测）与
  `MENU_WINDOW_HEIGHT`（实际写入窗口）各自保存；被小屏裁剪不反向污染自然高度，回到大屏可恢复。
- **按工作区 + DPI 收放**：`max_window_height(wa, scale) = (wa.h − 2·EDGE_MARGIN) / scale`，
  `resolve_menu_height = clamp(natural, 80, 2000) ∩ max_window_height`；工作区取**锚点所在显示器**
  的工作区（不是物理分辨率）。
- **不足不拉伸**：内容小于窗口时窗口取自然高度，不拉高、不留空；超出部分由菜单内部滚动承接
  （CSS `max-height:100vh; overflow-y:auto`，键盘 `focus()` 自动滚入视）。
- **避免 fit ↔ resize 回环**：只有前端在 show 后回传自然高度时调 `fit_context_menu`；后端
  `Resized` 只重设区域、不调 fit；高度差 <0.5 逻辑像素不 `set_size`（吸收 DPI/测量舍入，
  避免 125%/150% 出现的 1px 幽灵滚动条）。
- **显示器变化**：`ScaleFactorChanged` 触发 `refit_visible`（重算高度 + 位置）；`show_at` 在
  显示前按当前工作区计算，切换显示器后重开即按新工作区收放。

**验证**：`cargo test --lib context_menu` 17 passed（含 1366×768、1280×720、极小工作区、
分数 DPI、高度阈值、自然高度恢复等 9 个纯函数测试）。125% 真机：菜单自然高度 601 逻辑 /
物理 751，本机工作区逻辑 2048×1104 未触发钳制（如实标注）；把窗口压到 300 物理高后内部滚动
生效，`End` 把焦点落到「退出」并滚入视，恢复后窗口回到 313×751。

## 12. 2026-11-04 第三轮：重入时序复核与销毁清理

### 12.1 P2-01 / P2-02：在当前调用模型下不可达（未改调度逻辑）

两条推测竞态的前提都是「`apply_impl` 执行期间，同 HWND 又进入一次 `apply_impl`」，
即 `ApplyGate::try_enter` 返回 false 并写入 `pending`。逐条核对了全部入口后结论是
**该风险在当前代码中不存在**：

- 所有 `window_shape::apply` / `apply_with_radius` 入口都在窗口线程：`on_window_event`
  回调（`Resized` / `Moved` / `ScaleFactorChanged` / `Focused`）、`setup`、托盘/命令路径，
  命令路径统一经 `apply_on_main_thread`（`run_on_main_thread` + 2s 超时）。
- 窗口事件由事件循环派发（`tauri-runtime-wry 2.12.3` 的 `handle_event_loop` 收到
  `RunEvent::WindowEvent` 后调用回调），不在 `SetWindowPos` / `SetWindowRgn` 调用栈内同步
  回调；`apply_pass` 内部也没有会泵消息或同步触发窗口事件的调用。
- 因此同 HWND 的 `apply_impl` 天然串行，`applying` 在入口时不可能已包含该 HWND，
  `pending` 不会被写入；「同参数 pending 落在稳定性检查之后」没有可达路径。
- P2-02 的补偿路径同样成立：`apply_impl` 只在窗口线程执行，而 `run_on_main_thread` 在
  主线程上会**同步内联执行**（`tauri-runtime-wry` 的 `send_user_message`：主线程直接
  `handle_user_message` → `Message::Task(task) => task()`），不存在「补偿排队期间新请求
  先执行、旧补偿再覆盖」的时间窗；且每次 pass 都重新读取窗口尺寸，不会回写旧尺寸。

结论：不引入版本号/代际序号，不改循环收敛条件（保持 8 轮上限、最新请求覆盖旧请求、
不同 HWND 独立）。后续若引入跨线程 `apply`，需同时满足「同 HWND 的进入与 pending 取走
在同一临界区」并补对应并发测试。

### 12.2 P3-01：销毁清理补齐 `ApplyGate`

`forget_window(hwnd)` 原本只清 `RegionCache`、胶囊区域状态、启动空白标记与拖拽延迟校准；
本轮补上 `ApplyGate::forget(hwnd)`（`applying` + `pending` 一并移除，同一把锁内完成）。
正常路径下这两者离开 `apply_impl` 即为空，此清理是为窗口销毁/句柄复用边界补全生命周期，
不新增锁层级、不改变重入判定。销毁与重入交错时：销毁回调与 `apply_impl` 同在窗口线程，
不存在「销毁时仍在 apply」的交错；若未来出现，`forget` 也保证复用后的新窗口不吃旧请求。

### 12.3 新增确定性测试（`cargo test --lib window_shape`，36 passed）

- `same_shape_reentry_is_kept_and_consumed_once`：同参数重入按最新一条记录、只取走一次；
- `latest_pending_replaces_older_target_and_radius`：期间目标/半径变化时旧请求不得回写；
- `gate_forget_clears_pending_and_applying_before_hwnd_reuse`：销毁后无未决请求，HWND
  复用可重新进入；
- `gate_serializes_same_hwnd_across_threads`：channel 作同步点（不 sleep）验证同 HWND
  后到请求被延后且不丢失；
- `gate_allows_different_hwnds_concurrently`：Barrier 同点放行，不同 HWND 不互相阻塞；
- `repeated_resize_passes_settle_on_latest_size_per_hwnd`：连续尺寸变化只保留最新 pass 尺寸。

### 12.4 「外部 `SetWindowPos` 改高度后 `set_size` 不落地」判定

判定为**验收工具造成的外部状态分叉，不是产品缺陷**，机制已按当前代码复核：

- `MENU_WINDOW_HEIGHT` 是产品自维护的**逻辑高度缓存**，只在 `apply_window_height`
  成功 `set_size` 后更新；产品写尺寸的唯一入口是 `show_at` / `refit_visible` /
  `fit_context_menu`，菜单又是 `resizable:false`，正常用户无法绕过。
- 验收脚本用外部 `SetWindowPos` 把窗口压到 300 物理像素时缓存仍是自然高度 601；
  重开时 `apply_window_height(601)` 判定 `|601-601| < 0.5`（`height_needs_resize`）→
  **根本不调用 `set_size`**，窗口保留外部高度。现象看似「隐藏态 set_size 不落地」，
  实为「判定无需 resize」。
- 同高度的 `fit_context_menu` 也不会修复该分叉；只有目标高度与缓存差 ≥0.5（内容高度
  变化、DPI/工作区变化）才会再次 `set_size`。启动时窗口隐藏、前端首次 fit 把 620
  改到 601 并落地，说明隐藏态 `set_size` 本身可达。
- 结论：不为异常测试手段增加「每次显示强制回读真实窗口尺寸」的分支；产品路径不可复现，
  边界记录在验收报告 §9.5。外部改高后若要恢复，重启实例或让内容高度产生 ≥0.5 变化。

### 12.5 第三轮验证（2026-11-04）

- 命令：`npx vitest run src/context-menu` 35 passed；`cargo test --lib window_shape`
  36 passed；`cargo test --lib context_menu` 17 passed；`cargo check --lib` 通过；
  隔离构建 `target-context-menu-r3` 成功。`npm run build` 本次因其他会话未完成的
  `WidgetDesktopBridge.tsx` 类型错误失败（与本模块无关，见验收报告 §9.4）。
- 真机（125% DPI、单显示器、隔离实例）：菜单 `rect=2035,621,313,751`、
  `regionBox=[0,0,313,751]`（与窗口一致，未回落 Main 的 +1px）、`regionType=3`、
  `dwmCornerPreference=1`、`dwmBorderColor=-1`；resize 风暴
  751→300→600→400→751→240→700→751 后仍 313×751、区域一致、DONOTROUND 保持。
- 视觉：深/浅主题桌面合成与四角 6× 放大（`r3-dark*.png`、`r3-light*.png`）表面不透明、
  文字/图标可读，四角平滑、无双弧/白三角/系统矩形；与第二轮 `r2-dark-corners.png` 同形态。
- 主题同步：菜单「跟随系统」下用 CDP 媒体模拟 dark/light，`data-theme` 实时跟随
  （通道 C，不代表 OS 级切换）；验收期间系统主题被外部切换导致两张旧截图明暗不一致，
  查清非产品问题。
- 300 物理高：`scrollHeight=599 / clientHeight=238 / maxScroll=361`，`End` 后
  `scrollTop=360.8`、焦点末项「退出」可见（`r3-scroll-end.png`）。
- 限制：仅 125% DPI 与单显示器；100/150/200%、多显示器与小工作区钳制仍由单测覆盖，
  不声称真机全 DPI 通过。

