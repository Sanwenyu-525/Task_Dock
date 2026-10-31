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
| 2 | `effective_backend`：Win11 + 区域裁剪时 default 用 **blur**（窗口自身合成） | 不再让 DWM 背景画到区域外；显式 `mica/acrylic/none` 保留供矩阵对照 |
| 3 | `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE` + `DWMWA_WINDOW_CORNER_PREFERENCE` | 去掉默认 1px 边框，保留系统圆角偏好 |

文件：`src-tauri/src/window_shape.rs`、`src-tauri/src/commands/system.rs`。

### 3.1 半径来源

前端在应用预设后调用 `apply_window_radius(radius)`：

- 梦幻渐变 `18px`
- 液态玻璃 `20px`

Rust 端 `window_shape::set_radius()` 把半径夹取到 `0..=40`，非法值（NaN）回退 18。
半径以「逻辑像素」存储，实际裁剪时乘以 `scale_factor()` 得到物理像素，
因此 **100% / 125% / 150% DPI 下 CSS 圆角与原生裁剪一致**。

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

---

## 5. 材质（Mica / Acrylic）

`src-tauri/src/commands/system.rs::apply_window_material`：

| 系统 | build | 效果 |
| --- | --- | --- |
| Windows 11 | ≥ 22000 | `apply_mica`（首选，性能好） |
| Windows 10 | ≥ 17134 | `apply_acrylic` |
| 更早 / 失败 | — | `applied=false`，前端回退 solid |

- 使用 `window-vibrancy`（Tauri 自身的 Windows 传递依赖，**不新增 crate**）。
  之所以不用 `tauri::Window::set_effects`：它在 Windows 上吞掉底层错误（恒返回 Ok），
  无法判断是否真的生效。
- 调用必须回到**主线程**（Win32 窗口操作），Rust 端用 `run_on_main_thread` + 2 秒超时保护。
- 前端每次重算材质都会真正调用一次该命令（幂等），
  保证「系统减少透明 → 关闭」后能真正重新应用，而不是只恢复 CSS 半透明。

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
| 区域裁剪边缘无抗锯齿 | `SetWindowRgn` 是硬边；Win11 靠 `DWMWCP_ROUND` 补足，Win10 无解 | Windows 10 圆角边缘略有锯齿 |
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
