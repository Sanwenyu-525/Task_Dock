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
停靠（左缘）时窗口布局（CSS px，窗口 408×440 或 508×440）
┌──────────────────────────── 窗口（贴边齐平，位置固定） ────────────────────────────┐
│ ┌──────┐    ┌──────────────────────────────┐                                       │
│ │ 轨道 │ 12 │          功能面板            │   ← 区域外不绘制、不接收鼠标           │
│ │56×400│ px │          340×440             │                                       │
│ └──────┘    └──────────────────────────────┘                                       │
└────────────────────────────────────────────────────────────────────────────────────┘
轨道外框 400 = 平直主体 224 + 两侧液态肩部各 88；
折叠态区域 = 翼片多边形；展开态区域 = 翼片 ∪ 面板（间隙不连通）
```

- **轨道**永远贴停靠边（left→左、right→右、top→上、bottom→下），**面板**永远朝
  屏幕内部展开；二者同轴居中，间隙 12px（效果图里是**真实负空间**：翼片内侧高光 →
  接触暗部 → 桌面 → 面板外缘高光，不是实心桥接）。
- 区域由 `capsule_regions()`（Rust，纯函数）计算：轨道是**多边形**（`CreatePolygonRgn`），
  面板用**逐行像素支撑形状**（`support_rect_rgn()`，与主窗圆角同一策略：
  每行按 CSS 圆弧的解析解取覆盖矩形再并集），`CombineRgn(RGN_OR)` 合并；
  应用后用 `GetWindowRgn` 回读验证：
  包围盒一致 + 轨道/面板中心在区域内 + 间隙中点在区域外 + **外框缺角在区域外**
  （后者证明裁的是翼片轮廓而不是外框矩形）。验证失败视为未应用，前端记录并保持原状态。
- **区域相对 CSS 轮廓外扩 2 物理像素**（`REGION_AA_INSET`）：`SetWindowRgn` 是
  二值裁剪、没有抗锯齿；区域与 CSS 轮廓重合时 GDI 硬边会切进 WebView 的平滑弧线，
  形成第二圈阶梯状轮廓。外扩后区域是 CSS 可见像素的**超集**，可见外轮廓只由 CSS
  曲线定义；代价是轮廓外 ≤2px 的透明命中带。
- 窗口尺寸在停靠时**归一**为「胶囊容器」（垂直 408×440、水平 508×440）；
  大于容器时也收拢（例如 Windows Aero Snap 先把窗口吸成 1280×690），
  避免停靠期留下尺寸异常的大窗口。解除吸附时恢复当前模式尺寸（`apply_mode`）。
  停靠期间 `window_rect` 不落库。
- **区域 → 相位的提交协议**：先应用区域并回读成功，才推进 React 相位；
  失败先校准回当前相位对应的形态（= 上一个已确认区域）。若校准也失败，保持相位、
  标记 `regionUnsynced` 并按 300/600/1200ms 最多重试 3 次——**绝不**把「发出了
  off 请求」当成「原生已取消裁剪」而进入 `free`。自动解除失败有 500ms 冷却，
  停靠失败有 500ms 冷却，避免逐 tick 的 IPC 风暴。
- **停靠事务回滚**：`dockTo` 把用户窗口矩形记为事务起点；尺寸/移动/区域任一步失败，
  恢复原尺寸与位置（只对确实变化的维度各发一次 IPC），并在 2.5s 内抑制
  `window_rect` 持久化。回滚失败只记录一次警告，不自动重试。
- **Aero Snap 冲突**：原生拖拽走 `data-tauri-drag-region` → `start_dragging` →
  `WM_NCLBUTTONDOWN(HTCAPTION)`，系统会在光标触边时先吸成半屏（如 1280×690）。
  本轮**不关闭全局 Aero Snap、不删除原生拖拽**，而是在 `dockTo` 的几何事务里把窗口
  **归一为容器尺寸**并贴边齐平；解除吸附时 `apply_mode` 恢复模式尺寸。这样系统吸附
  只影响拖拽中的瞬时尺寸，不会成为停靠期或持久化的窗口几何。
- **渲染门控**：App 用 `isCapsuleMode(phase, dockedEdge)` 同时判定「相位已停靠」
  与「停靠边已知」；只有相位没有边时不隐藏主界面、也不挂载空胶囊。
  `setPhase` 拒绝进入无边停靠相位，把不变量锁在唯一提交点。
- **重启恢复**：`pendingRestore` 在 `dockTo` 失败时**不丢弃**，按 500ms 有界重试
  （最多 6 次）。首拍可能在窗口尚未显示时 `currentMonitor()` 返回 null，
  旧实现一次性清空会永久停在自由态。
- **解除后的模式尺寸**：`apply_mode` 的 `set_size` 可能被原生拖拽循环吞掉或在松手时
  回弹；`restoreModeSize` 先等窗口静止（`lastMoveAt ≥ SNAP_DRAG_SETTLE_MS`），
  应用后回读、再等 600ms 二次回读，仍在胶囊容器尺寸则有界重试（最多 4 次）。
  成功前持续抑制 `window_rect` 持久化，容器尺寸永不写入用户几何。

**为什么这样就不抖了**：轨道在屏幕上的位置、尺寸、命中区在整个停靠期间是常量；
展开只是把一块新的矩形并进区域。没有任何"窗口追上鼠标"的时序问题，
也不需要靠延迟去掩盖命中区错误。

## 二·五、液态融合翼片几何（2026-11-01 方案 B；2026-11-02 高保真修正）

轨道不再是「四周圆角的独立悬浮条」，而是**贴边一侧与屏幕边缘齐平、两侧经单段
三次贝塞尔肩部平滑隆起**的翼片。几何唯一定义在 `src/lib/capsuleShape.ts`，Rust
`window_shape::wing_outline` 是同一算法的镜像实现。

> **2026-11-02 更正**：方案 B 首版用「四分之一椭圆外扩（26×18）+ 垂直直壁 +
> 26px 内侧圆角」。真机截图与 `停靠效果图.png` 对照后确认这就是「圆角长条」观感
> 的直接来源——直壁是肉眼可识别的竖直长边，两端只是两个小外扩。现已改为单段
> 贝塞尔肩部，参数由效果图像素拟合得到（见下）。

### 参数（CSS px，两端常量同名）

| 参数 | 值 | 说明 |
|---|---|---|
| 厚度 `WING_THICKNESS_CSS` | 56 | 垂直停靠为宽、水平停靠为高 |
| 平直主体 `WING_LENGTH_CSS` | 224 | 两侧肩部之间的平直段 |
| 单侧肩宽 `WING_SHOULDER_CSS` | 88 | 厚度的 **1.57 倍**（像素实测值） |
| 肩部起点控制柄 `WING_CREST_RATIO` | 0.435 | 占肩宽比例，拟合值 |
| 肩部终点控制柄 `WING_TAIL_RATIO` | 0.565 | 占肩宽比例，拟合值 |
| 采样段数 | 18（每肩） | 两端必须相同 |
| 区域外扩 `WING_AA_INSET` | 2（物理 px） | 见 §二 |

外框沿边尺寸 = 224 + 2×88 = **400**（面板 340×440，间隙 12，容器 408×440 / 508×440；
400 < 440，翼片两端与窗口上下各留 20px 余量，四边都不裁切）。

**比例是量出来的，不是估的**：`停靠效果图.png` 的「胶囊形态与规格」图给出
300–420px × 56px 的标注，按像素量得肩宽 47px、厚 30px（比值 1.57）；对同一段
轮廓做最小二乘拟合得到两个控制柄比例，56px 厚下 RMS 残差 1.32px。
旧版 26px（0.46 倍）正是「短、圆、陡」的来源。

### 边空间定义

用「边空间」描述：`u` 沿屏幕边缘（中线为 0）、`v` 由边缘指向屏幕内部。四边只换
映射、不换形状：

```
 v=T        ┌──────────── 平直主体 224 ────────────┐
            ╱                                      ╲
           ╱  单段三次贝塞尔：两端切线都水平        ╲
 v=0  ────╯                                          ╰────   ← 屏幕边缘
      u=-200                                       u=+200
```

三条不可妥协的性质，也是「液态融合」与「圆角胶囊靠近边缘」的区别：

1. **贴边切线水平**：肩部在 `v=0` 处的切线平行于屏幕边缘，翼片是从边缘
   「长出来」的，因此不会在边缘处留下直角、缝隙或悬浮间隔；
2. **无直壁、无 90° 拐角**：整条轮廓只有一段贝塞尔 + 两条直线（平直主体与贴边
   基线），最陡采样段约 60°（单测锁定 < 65°），曲率符号在肩部中段翻转一次；
3. **肩部不吃操作区**：按钮命中区 36px，内容组 240px 居中后落在 ±120，
   仍在「肩部厚度 ≥ 36px」的范围（±121）内——端点按钮不会被曲线切到。

### 为什么两端都用采样折线而不是 `C` 弧命令

GDI 区域只能是整数多边形。若 SVG 用曲线命令、Rust 用折线，两者必然有亚像素偏差；
这里让**两端都从同一个采样函数取点**（同样的 18 段、同样的 `floor(x+0.5)` 取整），
于是「CSS 可见轮廓 = Win32 区域」是构造性成立的，而不是靠容差凑。
18 段/肩部的弦长 ≈ 3.3px、弦高误差 < 0.05px，与抗锯齿曲线无法区分。

外扩时平滑顶点走角平分线 + 斜接补偿，**尖点用斜切**（两个偏移点）：肩部贴边尖端
的内角极小，斜接会把区域顶出 delta 的十倍以上，斜切则保证「区域到轮廓的距离
处处 ≤ 2px」，与 AA 外扩的语义一致。

### 命中判定

`pointInCapsule()` 对轨道用**轮廓多边形**（已含 2px 外扩、已钳制进窗口），
面板用**圆角矩形**（半径 24，物理值 = floor(24×scale)−2，与原生区域同源），
再用 12px 容差覆盖间隙。外框的四个「缺角」是桌面，不能算作胶囊——
否则光标停在翼片端头的桌面上时，自动收起永远不触发。

### 表面材质（2026-11-02 重做）

四层同轮廓填充，方向按停靠边换算，四边共用一套语义 Token：

| 层 | 作用 | Token |
|---|---|---|
| `cap-wing-face` | 跨厚度三段冷蓝白基底（near→mid→far） | `--wing-near/mid/far` |
| `cap-wing-shade` | 贴边一侧窄暗部（环境遮蔽） | `--wing-shade` |
| `cap-wing-haze` | 中部环境色反射（accent 径向） | `--wing-haze` |
| `cap-wing-spec` | 内侧高光带（沿 v 自然淡出到尖端） | `--wing-spec` |
| `cap-wing-rim` | 沿边渐变的轮廓高光（贴边段不画） | `--wing-rim-a/b` |

**没有整圈描边**：旧版 `stroke: 1px` 的蓝紫环读起来就是普通 UI border。透明感由
「稳定实色 + 分层高光」制造，不靠降低 alpha（降低 alpha 会让胶囊在深色桌面消失）。

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
- **单一事实来源**：`useCapsuleStore.active` **恒有值**，收起面板不清空它；
  面板是否可见只由引擎相位决定。不要再用 `active = null` 表示折叠——两处提交时机不同
  （store 立即生效、相位要等 Win32 区域写回），会产生「相位已展开、分类为空」的中间帧。
- **Esc**：胶囊外壳以最低优先级（`kind: "drawer"`）注册到弹层栈，一次 Esc 只收面板，
  不会把窗口藏进托盘。
- **自动收起**：光标离开「可见区域 ∪ 12px」持续 450ms 后收起（不是隐藏窗口）。
  判定用**可见区域**（折叠只有轨道），不是窗口矩形——否则 408×440 的窗口会让
  自动收起永不触发。间隙由 12px 容差覆盖，鼠标从轨道移到面板不算离开。
- **不做悬停自动展开**：轨道本身就是可点击控件，悬停展开只会制造"反复展开/收起"。
- **拖离解除**：胶囊空白处可拖动（`data-tauri-drag-region`），**沿法向**偏离停靠位
  >24 CSS px（`SNAP_UNDOCK_DRAG_PX`）即解除：清区域 → 恢复模式尺寸 → 收回工作区 → 清持久化。
  解除同时请求**鼠标锚定**——恢复后的普通窗口以「标题栏中心 = 光标」出现，
  用户无需松手重抓标题栏（机制与边界取舍见 §12.5a）。
  判定只看停靠边法向分量：沿边滑动 200px 也不会误解除（旧实现用「两轴绝对值 >24px」，
  沿边拖动会误判）。
  **2026-11-06 再吸附修复**：解除后的几何恢复改为后台事务（不再占住引擎互斥区），
  解除提交即重置手势起点/轨迹——「拖离 → 恢复完整面板 → 立即反向拖回」与普通自由
  窗口首次吸附同一口径，偏好为胶囊时必回胶囊（偏好为完整面板时回完整面板，不变）。
  恢复期间候选确认延迟到恢复收尾，避免两路几何写入交错；详见
  `tmp/acceptance/capsule-redock/report.md`。
  **2026-11-08 越出轴遮蔽修复**：恢复后的用户矩形底部越出工作区时（停靠位靠下 +
  自由矩形较高），候选选边的 argmin 被越出轴负距离恒占、整体判 null——拖到左/右
  齐平位也进不了候选（「拖离后仍可能无法再吸附」的第二个根因，前端与原生磁吸
  同口径修复）。同轮：candidate 换边更新补程序性移动守卫，恢复期搬运不得翻转
  已选定的候选边。回归 D11/D12 与真机隔离实例复核见同报告 2026-11-08 追加节。
- **托盘/快捷键唤回**：`snap-recall` → 展开功能面板（窗口始终可见，无需"找回"）。
- **工具面板标题也可拖动窗口**（2026-11-06）：面板标题背景与标题/说明文字都是
  拖拽热区（`PanelKit.PanelHead`），拖动的是同一个原生窗口，轨道与面板不会分离；
  标题右侧操作按钮、面板正文与列表不参与拖动。命中边界与光标口径见 §12.11。
- **吸附反馈**：拖拽阶段有光晕 + 高亮细线 + 「松开吸附到 X 侧」；停靠完成时轨道
  播放一次 0.34s 的轻微缩放脉冲（只播一次，不循环）。

## 六、视觉规范

- 轨道是**翼片表面**（`CapsuleWing` 的 SVG，见 §二·五），面板是圆角玻璃卡片（24px，
  与 `PANEL_RADIUS_CSS` / Rust `CAPSULE_PANEL_RADIUS_CSS` 同源）。
  2026-11-02：面板改为与翼片同一套冷蓝玻璃（`--wing-panel-base` + `--wing-panel-face`
  + `--wing-panel-border`），不再是白卡片 + `--card-face`。
  两层结构：
  1. `cap-wing-face`：`--capsule-face`（预设 × 明暗对应的**不透明**底色）打底；
  2. `cap-wing-sheen`：自上而下的玻璃光泽，只用 `--c-paper` 的中性明暗；
  3. `cap-wing-rim`：**不闭合**描边（`--c-paper` → `--c-accent` 渐变）——
     贴边那一段刻意不描，否则会在屏幕边缘画出一条 1px 亮线。
  **根窗口透明不等于胶囊透明**：停靠期根容器必须透明（区域外不能绘制），
  `--card-face` 只是叠在窗口底色上的半透明渐变（深色预设仅 7.5% 白），
  只写它会让胶囊在深色桌面上「整个消失」。`styles-themes.test.ts` 守卫
  `--capsule-face` 在四个上下文里不含 alpha。
- 轨道容器上**不得**再写 `background` / `border` / `box-shadow` / `border-radius`：
  任何一条都会沿外框画出一整块矩形（历史回归路径）。立体感只由光泽与描边承担；
  不使用 `filter: drop-shadow`——SVG 视口会把它裁成直角切口，反而露出矩形痕迹。
- 光泽强度用 `--wing-sheen-*` / `--wing-rim-*` 两个主题变量组（浅色 0.58/0.2/0.04，
  深色 0.16/0.06/0.02），悬停只改合成层不透明度（0.85 → 1），不跑滤镜动画。
- 强调色（蓝紫 `--accent` / `--accent-gradient`）只出现在：Agent 状态球、
  选中分类的背景提亮、徽标、链接按钮。**不做常驻外发光**。
- 选中态用「背景提亮 + 1px 内描边 + 图标变色」，不用竖线 + 双圆弧。
- 文字层级：标题 12.5px/650、正文 12px、辅助 10.5px（`--text-primary/secondary/tertiary`）。
- 深色主题与浅色主题共用同一套结构与 Token，只有 Token 取值不同；
  应用图标头像在深色下单独调整对比度。
- 动效：面板入场 0.16s 淡入 + 2px 位移；吸附脉冲 0.34s 单次；
  全局 `prefers-reduced-motion` 规则会把动画时长压到 0.01ms。

## 六·五、四面板统一视觉基元（2026-11-02 高保真）

四张效果图（`docs/design-refs/v07/停靠效果图/01-tasks.png` … `04-apps.png`）是同一套语言的四个实例，
因此四个面板共用 `src/components/capsule/PanelKit.tsx` 的基元，而不是各写一套：

| 基元 | 类名 | 用途 |
| --- | --- | --- |
| `PanelHead` | `.cap-head` / `.cap-title`(19px) / `.cap-sub` / `.cap-actions` / `.cap-iconbtn` | 标题 + 一句说明 + 右侧 1–2 颗**可用**按钮 |
| `Segmented` | `.cap-seg` / `.cap-seg-btn`（`role=tablist` + `aria-selected`） | 分类/类型筛选，全部本地过滤 |
| 卡片 | `.cap-item` / `.cap-tile` / `.cap-item-title` / `.cap-item-sub` / `.cap-tag` / `.cap-pill` / `.cap-state` | 列表行与状态胶囊（状态**必须带文字**） |
| `EmptyState` | `.cap-empty` | 空态：一句说明 + 一个真实动作 |
| 底栏 | `.cap-foot` / `.cap-progress` / `.cap-link` | 计数 + 进度 + 去完整页 |

数据来源（全部是既有 store / 既有 IPC，没有第二套状态源）：

- **任务** `TasksLite`：一次 `list_tasks({view:"all", status:"all", sort:"due"})`，
  五个分段（全部/待办/今日/日程/已完成）在本地切分；完成走 `useTasksStore.toggle`，
  失败回滚并重拉，成功先给 320ms 勾选反馈再移出。
  （2026-11-04 更正：分段已改为各自的真实查询——全部 `status=all, sort=created`、
  待办 `status=pending, sort=due`、今日 `view=due_today, status=pending`、
  日程 `view=scheduled, status=pending`、已完成 `status=completed, sort=completed`；
  后端先过滤/排序再 `LIMIT 12`，本地不再二次截断，避免逾期任务挤掉今天到期项。
  2026-11-04 再更正：日程改用 `sort=scheduled`（未来/未逾期在前、逾期在后），
  成员不变（逾期仍属日程），面板保留后端顺序、不再本地按逾期优先重排。）
- **Agent** `AgentsLite`：`useAgentsStore.snapshot` 派生 `liveRuns` / `liveSummary`，
  按 failed → waiting → running → disconnected 排序；会话数/运行数/时间全部来自快照，
  不写死名称、不伪造进度；每个 Agent 只有「打开会话」「查看」两个真实动作。
- **剪贴板** `ClipboardLite`：`clipboard_view({limit:20})`；复制不写回历史、不刷新顺序，
  失败不显示「已复制」；截图组用三张叠放封面（`clipboardGroup` 最多 2 组）。
- **应用** `AppsLite`：`useNavigationStore.targets`（用户已配置目标），4 列网格最多 7 个 +
  「添加」；搜索是本地过滤；`navNavigate` 的 `success/actual_action/fallback_used/reason`
  逐项映射为提示，不把失败说成已启动。

图标：任务=清单、Agent=机器人、剪贴板=剪贴板、应用=四宫格、总状态=蓝紫主按钮（Sparkles）、
收起=朝屏幕边缘的箭头，全部取自 Lucide，尺寸 15–18 / stroke 1.7–2。

**总状态球的语义色只做外圈环**：球体恒为蓝紫渐变（效果图口径，也是品牌锚点），
waiting/failed/disconnected 用 2px 环 + 徽标表达，避免整颗球变橙把品牌色让位给告警色。

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

- 纯函数几何：`src/lib/capsuleShape.test.ts`（金标准点位、四边镜像、贴边切线、
  外扩单调性、SVG 路径闭合规则）与 `src/lib/capsuleLayout.test.ts`
  （容器/摆放/可见区域/命中判定）、`src/components/capsule/format.test.ts`。
- 组件：`src/components/capsule/CapsuleDock.test.tsx`、`src/components/SnapOverlay.test.tsx`。
- 引擎集成（mock Tauri）：`src/hooks/useEdgeSnap.integration.test.tsx`，
  含"展开/收起不移动窗口"的回归断言。
- Win32 区域：`src-tauri/src/window_shape.rs` 的 `capsule_*` / `wing_*` 单测
  （含与前端同一组金标准点位、四边镜像、DPI 125/150%、缺角探针）+
  真实（不可见）Win32 窗口上的 `CreatePolygonRgn` → `GetWindowRgn` 回读验证。
- 真机（可见窗口、多显示器、DPI、吸附手感）**未执行**，见验收报告"未验证项"。
  2026-11-01 补充：四边停靠、明暗、玻璃、展开、解除与区域回读已在 125% DPI 真机执行，
  证据见 `tmp/acceptance/capsule-visibility-fix/` 与
  `tmp/acceptance/capsule-native-composition/`；多显示器与 Win10 仍未覆盖。
  2026-11-01（方案 B 翼片）真机结果见 `tmp/acceptance/liquid-edge-wing/report.md`。
  2026-11-02 补充：停靠态「只露出翼片轨道、其余区域透出真实桌面」已在 125% DPI 单显示器
  真机复验（四边 + 明暗 × 材质矩阵 + 白/黑/灰/棋盘外部底色 + 真实鼠标拖离与重新吸附 +
  12 轮展开/收起无残留），结论与未覆盖项见 `tmp/acceptance/capsule-docking/report.md`；
  多显示器热插拔与其他 DPI（100%/150%）仍未覆盖。

## 十、停靠态原生合成策略（2026-11-01 修复）

**真机证据**（`tmp/acceptance/capsule-native-composition/`，Windows 11 23H2、125% DPI）：
强制 `TASK_DOCK_GLASS_BACKEND=mica`（或 `acrylic`）时，`GetWindowRgn` 回读只有轨道
（`bounds=62,535,437,605`），但屏幕上出现**整个 500×605 胶囊容器矩形**的原生底色：
浅色下近似白色、深色下近似黑色，区域外的桌面只能部分透出。Solid / `css` 后端无此现象。
原因与主窗圆角暗楔同源（[03-window-composition.md](03-window-composition.md) §3.0）：
**DWM 的 Mica / Acrylic SystemBackdrop 按整个窗口矩形绘制，`SetWindowRgn` 约束不到它**。

因此「胶囊停靠态」是一条**独立的合成策略**，与普通主窗材质无关：

| 状态 | 原生背景 | 玻璃来源 | 说明 |
|---|---|---|---|
| 普通主窗（未停靠） | 按设置（css / mica / acrylic / blur） | 原生或 CSS | 行为不变 |
| 胶囊停靠（rail / panel） | **一律停用**（清除 Mica/Acrylic/blur） | 仅 CSS（`--capsule-face` + `--card-face`） | 原生背景会越过区域，必须停用 |
| 解除吸附（区域恢复整窗后） | 按「未停靠时应生效」记录的效果恢复 | 原生或 CSS | 区域写失败则不恢复 |

实现（`src-tauri/src/commands/system.rs`）：

- `NATIVE_DESIRE` 记录每个 hwnd「未停靠时应生效」的原生效果；
  `NATIVE_SUSPENDED` 记录因胶囊被临时停用的窗口；`CAPSULE_OWNER` 记录胶囊归属 hwnd。
- `apply_window_capsule`：进入 rail/panel 前先 `suspend_native_backdrop`（清原生层），
  再写区域；`off` 且区域**确实恢复整窗**（`applied=true`）后才
  `restore_native_backdrop`。区域写失败时保持停用——否则原生底色会立刻画到仍是
  胶囊形状的窗口矩形之外。
- `apply_material_to_window`：停靠期间请求 glass 只记录期望效果并保持 CSS 玻璃，
  返回 `effect="css"`；不会在停靠期重新挂上原生层。未停靠时行为与原来完全一致
  （含 Win11+区域裁剪默认 `css`、Win10 `acrylic`、显式后端矩阵）。
- 停靠期间切换材质（托盘菜单 / 设置 / 系统偏好）同样受该守卫保护；
  解除吸附后按最新期望恢复。
- 不新建窗口、不改系统级 DWM 设置，也不需要修改 `window_shape.rs` 的区域逻辑。

残余风险：若 `clear_mica/clear_acrylic/clear_blur` 全部失败（极旧系统或远程桌面），
胶囊容器矩形仍可能出现原生底色；代码会记录 `warn` 并继续（胶囊自身仍可见）。

**2026-11-02 更正（胶囊停靠态必须保持 DONOTROUND）**：本节的原生层停用策略之外还有
第二层 DWM 越界——胶囊停靠期间窗口的 `cornerPref` 曾被 `apply_capsule_pass` 末尾的
`apply_dwm(hwnd, true)` 设为 `DWMWCP_ROUND`。该窗口仍带 `WS_CAPTION|WS_THICKFRAME`
（tao 行为），ROUND 会让 DWM 沿**整个窗口矩形**绘制圆角系统边框 + 外部投影；窗口内部
仍然透明（像素级 diff：差异全部是「比背景更暗」的边框/投影像素，窗口中心与背景同色），
浅色桌面/背景透出即形成「大面积白板」观感。`SetWindowRgn` 裁不到 DWM 的 NC 合成层：
真机同刻 `PrintWindow` 只有胶囊、`CopyFromScreen` 却是整窗轮廓 + 阴影（A/B 数字与证据见
[03-window-composition.md](03-window-composition.md) §9、
`tmp/acceptance/docked-window-residual-fix/`）。现胶囊态固定 `DWMWCP_DONOTROUND`，
可见外形只由区域定义；本节的「停靠期停用原生背景」策略保持不变，二者叠加才能保证
停靠态「只见胶囊」。

## 十一、启动停靠恢复：先裁空白再显示（2026-11-02）

**问题**：`setup` 里 `win.show()` 立即执行，而停靠恢复要等 webview 加载 → 设置加载
→ `get_snap_state` → 150ms tick → `setSize` / `setPosition` / `apply_window_capsule`
三次 IPC。这段时间窗口是**完整主界面**，Win32 区域也还是整窗圆角区域——真机实测
1.87s（125% DPI、debug 构建）。

**修复**：把「显示」与「露出主窗口」拆开。上次退出为停靠态（`snap_enabled` 且
`snap_state.edge` 有效）时：

1. `window_shape::set_blank(hwnd, true)` + `apply` → 区域裁成 **1×1**；
2. 然后才 `show()`：窗口是 `WS_VISIBLE`（浏览器定时器不被后台节流，恢复更快），
   但屏幕上没有任何主窗口像素，1×1 区域也不可点击；
3. 前端在**停靠几何 + 轨道区域回读成功之后**调用 `notify_ui_ready`
   （`useEdgeSnap` 的 `markReady`：无记录 / 读取失败 / 恢复成功 / 恢复放弃四个
   结论点各一次，幂等）→ 撤销空白标记并重算区域（此时已是轨道，视觉无变化）；
4. 兜底：`BLANK_REGION_FALLBACK_MS`（4s）内前端未确认就绪则撤销空白，
   绝不留下一个不可见的窗口。

**顺序约束**（不可交换）：

- `set_blank` 后必须**先 apply 再 show**：否则第一帧带着上一次的整窗区域；
- `apply_pass` 里**胶囊优先于空白**：前端恢复事务会先写胶囊区域，空白若优先会
  吞掉这次写入，`GetWindowRgn` 回读失败会让前端判定「区域写入失败」并回滚停靠；
- 空白写入失败（`SetWindowRgn` 拒绝 / 回读不符）立即撤销标记并退回正常区域——
  宁可露出窗口，也不能留一个看不见的窗口。

**验收口径**：启动后以 250ms 采样 `GetWindowRgn`，直到出现轨道区域；任何一次采样
都不得出现「包围盒 = 整窗」的区域。证据见
`tmp/acceptance/docked-window-hidden/`（`startup-timeline.png`、`report.md` §4.3）。

## 十二、拖拽磁力：双向手感（2026-11-02）

目标：吸附时窗口像被边缘「吸过去」，取消吸附时像从磁铁上「拉开」。
逐帧工作在原生层完成，前端不参与逐帧定位。

### 12.1 为什么必须是 `WM_MOVING`

`data-tauri-drag-region` → `drag.js` → `plugin:window|start_dragging` → tao
`handle_os_dragging()` 用 `PostMessageW(WM_NCLBUTTONDOWN, HTCAPTION)` 起拖，系统进入
**模态移动循环**。tao 只处理 `WM_ENTERSIZEMOVE` / `WM_EXITSIZEMOVE` / `WM_DPICHANGED`，
**不处理 `WM_MOVING`**，该消息落 `DefWindowProc`，因此可以用 `SetWindowLongPtrW`
子类化改写 `lParam` 的 `RECT` 实现磁力。`PostMessageW` 起拖也保证了 IPC 线程不被阻塞。

> 不能用 React 逐帧 `setPosition`：系统移动循环同时也在改窗口位置，两股力量互相
> 追赶会抖动、丢拖拽。

### 12.2 系统移动循环**不是**无反馈的（实测结论）

真机采样（`tmp/acceptance/magnetic-drag-resistance/trace.csv`）显示：

```
prop= 64 appl= 64 lead=0
prop= 62 appl= 61 lead=1
...
prop= 16 appl=  0 lead=16      ← 本帧施加 16px 领先
prop= -2 appl= -2 lead=0       ← 下一帧提案直接吃掉这 16px
```

即 `propₙ₊₁ = appliedₙ + Δcursor`。若拿提案当基准算距离，领先量每帧被吸收成新基准，
`d` 重新变大，领先量逐帧累积（实测累积到 48px，超上限 3 倍），窗口永久偏移且贴边时
吸引「消失」。

**对策**：`DragAnchor`（`magnetic.rs`）自己维护锚点——`WM_ENTERSIZEMOVE` 记下起点矩形
与光标，每帧用「起点矩形 + 光标累积位移」还原**未施加磁力的 1:1 矩形**，磁力只作用在
还原矩形上，结果不再回流。尺寸被系统改动（Aero Snap）时返回 `None` 并重锚，跳过磁力。

### 12.3 两条曲线

| 阶段 | 量 | 公式 | 参数（CSS px） |
| --- | --- | --- | --- |
| 吸附吸引 | 额外领先 `lead` | `M·smoothstep(1 − d/R)`，且 `lead ≤ d` | `R = 50`，`M = 16` |
| 取消阻力 | 实际位移 `disp` | `d²/(2D)`（`d < D`），`d = D` 一次性释放 | `D = 32` |

- 吸引：`d ≥ R` 完全 1:1；`d → 0` 单调增到 `M`，被 `d` 钳住所以**绝不把窗口推出屏幕边**。
  平滑、连续、有界，不随时间演化（无常驻动画循环）。
- 阻力：起点斜率 0（刚开始拉几乎不动 = 被吸住），`d = 16` 时约 4px 位移，
  `d = 24` 时约 9px（可见弹性），`d = 32` 一次性释放。
- 释放后残留滞后 `lag = D/2`，按 `LAG_DECAY_MS = 110` 指数衰减到 0，此后 1:1 跟手，
  **不跳到远处**。
- 2026-11-02 更正：`R` 由 56 收窄到 50（用户反馈磁吸介入过早）；吸引方向、
  阻力强度（`M`/`D`）与滞回结构不变。

### 12.4 法向坐标 + 四边一致

所有判定只用**停靠边法向**分量（`normal_offset`，外法向为正），沿边分量（`along_offset`）
不参与解除判定。四条边共用同一套 `Edge{Left,Right,Top,Bottom}`（`outward_sign` /
`normal_is_x`），因此四边行为对称。

### 12.5 滞回

| 量 | 值 | 作用 |
| --- | --- | --- |
| `SNAP_CANDIDATE_ENTER_DIST` | 24 | 进入候选（前端；2026-11-02 由 28 收窄） |
| `SNAP_CANDIDATE_EXIT_DIST` | 38 | 退出候选（前端；2026-11-02 由 42 收窄，滞回死区 24–38） |
| `SNAP_UNDOCK_DRAG_PX` | 24 | 法向拖离解除（前端，= `COMMIT_DRAG_CSS`） |
| `SNAP_MAGNET_RELEASE` | 32 | 原生阻力释放 |
| `SNAP_MAGNET_REARM` | 96 | 脱离后需离开边缘 > 96 才重新受吸引 |

`REARM (96) > RANGE (50)`：解除后不会立刻被吸回，避免「反复吸附/解除」抖动。

### 12.5a 拖离解除的鼠标锚定（2026-11-02 新增）

用户**拖离**胶囊的解除路径（`undockByDrag` 与 onMoved 的磁吸区退出路径）在解除时
把「恢复模式尺寸」与「标题栏中心对齐光标」合成**一个拖拽帧内**的原生操作：

1. 前端判定拖离意图后 `set_undock_anchor(mode, titlebar_css)` 挂起一次锚定请求。
   `titlebar_css` 由 `measureTitlebarHeight()` 从真实标题栏布局量取并缓存，
   不可测（停靠期主界面 display:none）时回退设计常量 `TITLEBAR_HEIGHT_CSS = 41`
   （styles-themes 层 padding 9+6 + 内容 26；App 在非胶囊态预热缓存）。
2. 下一帧 `WM_MOVING`（仍在系统模态移动循环内）按 `magnetic::undock_anchor_rect`
   改写提议矩形：目标 = `(cursor − w/2, cursor − titlebar/2)`（物理像素，
   尺寸 = 模式尺寸 × 当时 DPI）；随后重锚 `DragAnchor`、模型切回 Free——窗口继续
   1:1 跟手，**用户无需松手重抓标题栏**。若系统未立即接受新尺寸，锚定强制期
   （≤500ms，有界）按同规则继续改写，直到提案尺寸一致或超时交给前端兜底。
3. 边界取舍（与前端 `undockAnchorTarget` 同口径，两端单测 + 不变量用例互锁）：
   光标参考值先钳进工作区；结果保证**光标落在窗口矩形内**；光标贴近边缘导致
   「窗口完整可见」与「光标在标题栏带」不可兼得时，完整可见优先（最小位移）。
   不调用 `SetCursorPos`，不动系统鼠标。
4. 解除发生在拖拽静止后（tick 补判定路径）时请求等不到 `WM_MOVING`：前端在尺寸
   恢复确认后查询 `take_undock_anchor_applied`，返回 false 则按**实际恢复后**的
   窗口尺寸（回读值，而非理论模式尺寸）回退定位。
5. 请求生命周期有界：`WM_EXITSIZEMOVE` / `WM_ENTERSIZEMOVE` / 关闭吸附 / 卸载
   均作废残留请求，绝不泄漏到后续无关拖拽；解除中止（区域清理失败）时前端
   `cancel_undock_anchor` 防御性取消。
6. **只有拖离路径锚定**：按钮解除、点击胶囊功能打开完整窗口、托盘/快捷键唤回、
   启动恢复、显示器断连恢复、程序切换模式等路径保持各自原有定位策略，
   不得把窗口挪到鼠标下方。

### 12.6 职责边界

- **原生**：逐帧位移（`WM_MOVING`）、阻力/释放、回弹（`WM_EXITSIZEMOVE` 后
  `PostMessageW` 延后一拍 `SetWindowPos`，不在退出消息里嵌套定位）。
- **前端**：只做低频动作——挂载时下发一次参数（`set_magnetic_drag_config`）、
  停靠/解除/沿边重定位后同步基准（`set_magnetic_dock`）、法向 24px 解除判定与持久化、
  拖离解除时请求鼠标锚定（`set_undock_anchor` / `take_undock_anchor_applied` /
  `cancel_undock_anchor`，见 §12.5a）。
  沿边拖动中**不**逐帧落库，静止后只落一次（`commitAlong`）。
- **关闭吸附**：`set_magnetic_drag_config(false, …)` + `set_magnetic_dock(null)`，
  原生 wndproc 在 `enabled == false` 时**完全旁路**（不读状态、不改矩形）。

### 12.7 失败降级

`install()` 幂等；拿不到 `HWND` 或子类化失败只记 `warn`，吸附退化为纯阈值行为，
不影响停靠事务与区域裁剪。`WindowEvent::Destroyed` 时 `uninstall` 还原原 wndproc。


### 12.8 Windows Snap 抑制（停靠期，2026-11-02）

**问题**：停靠态胶囊齐平贴在屏幕边上，向外拖动时**原生拖拽循环的起点光标就落在
系统贴靠区里**（顶边 = Snap Bar，左右边 = 贴靠飞出）。窗口若具备「可最大化」资格，
Windows 11 会在拖拽悬停时弹出分屏布局；系统贴靠还会改窗口尺寸，与磁力锚点冲突。
这是「解除吸附误触发系统分屏」的根因。

**依据**：Aero Snap / Snap Layouts 只作用于**可最大化**窗口（顶部贴靠 = 最大化，
微软文档《Support snap layouts for desktop apps on Windows 11》将飞出菜单与最大化
能力绑定；Windows 7 起沿用「无 `WS_MAXIMIZEBOX` 即不参与 Aero Snap」的行为）。
`WS_MAXIMIZEBOX` 与 `WS_SIZEBOX`（手动缩放）互相独立，清除前者不影响普通拖拽与缩放。

**实现**（`magnetic.rs`，按窗口、按状态，不动系统设置、不影响其他窗口）：

- 停靠事务提交（`set_dock(Some)`）经 `WM_MAGNET_STYLE_SYNC` 投递到窗口线程清除
  `WS_MAXIMIZEBOX`；解除（`set_dock(None)`）恢复。样式写入都在窗口线程（`apply_snap_suppression`）。
- 解除若发生在**拖拽循环内**（用户拖出阈值触发），恢复推迟到 `WM_EXITSIZEMOVE`：
  保证「从吸附状态拖出」的整个手势期间系统贴靠 UI 不介入。
- `WM_ENTERSIZEMOVE` 时若仍停靠则**重申清除**（自愈：tao 的 `WindowFlags::apply_diff`
  在任何标志位变化时都会整窗重写样式并还原该位）。
- `install()` 记录原始样式（`ORIGINAL_MAXBOX`）：原窗口不可最大化时永不改动样式，
  恢复只还原原本存在的位。`uninstall` 前若仍处于抑制态先恢复。
- 吸附总开关关闭（`enabled=false`）时无条件恢复系统默认样式。
- **中途解除不回弹**：`WM_EXITSIZEMOVE` 时若前端已解除停靠（`DOCKED=false`），
  跳过 `finish()` 回弹——其停靠基准是拖拽起点的快照，按它回弹会把刚解除的窗口拽回停靠位。

**真机验证**（`tmp/acceptance/windows-snap-conflict/`，Win11 23H2，DPI 125%）：
停靠态（左/右/顶/底四边 + 启动恢复）样式回读 `maximizebox=false`；从顶缘
Snap Bar 核心区（光标距顶缘 ~8px）悬停 900ms 拖出，`NEWWINCOUNT=0`（无
`XamlExplorerHostIslandWindow` 等贴靠 UI）；同一位置自由窗口对照悬停 1s，
Snap Bar 出现（探针有效性 + 自由态保留系统行为）；未达阈值松手精确回弹；
连续 20 轮停靠/解除样式与几何零漂移。解除后样式与模式尺寸均恢复。

**已知边界**：
- 候选相位（自由窗口被拖向边缘）不抑制——那是普通窗口的正常 Windows 行为，
  用户松手时由吸附确认流程接管。
- 若未来有代码在停靠期间调用 tao 的标志位 setter（`set_resizable` 等），样式会被
  tao 重写回可最大化；`WM_ENTERSIZEMOVE` 的重申清除保证**拖拽开始时**必然处于
  抑制态，两次拖拽之间的窗口外观不受影响。

### 12.9 轨道提示气泡方向：一律朝屏幕内侧（2026-11-03）

**规则**（`CapsuleRail.railTipPlacement`）：展开态气泡统一指向**屏幕内侧（面板侧）**，
四个停靠边严格镜像——左停靠 `right`、右停靠 `left`、上停靠 `bottom`、下停靠 `top`。
Agent 状态球与四个分类共用同一张方向表，不再有「端头一个方向、分类另一个方向」的分叉。

**为什么不能沿轨道向上/向下**：胶囊窗口由 `SetWindowRgn` 裁剪，气泡画在区域外不会被
绘制。展开态可见区域 = 翼片多边形 ∪ 面板矩形，内侧才有空间；折叠态可见区域只剩 56px
翼片，内侧没有像素，因此折叠态退回「沿轨道朝中心」（垂直停靠向上、水平停靠向左，
端头状态球贴肩部收窄段，改为向下/向右）。

**决策记录（2026-11-03，已确认）**：折叠态沿用「沿轨道朝中心」方向属于**已确认的设计
取舍**，不是待修缺陷——折叠态可见区域只有翼片，内侧没有任何可绘制像素，要让它朝内只能
改原生区域或加一条透明可绘制带，两者都会引入不可见却拦截鼠标的区域，收益不成立。除非
未来折叠态窗口的可见区域本身发生变化，否则不因「为什么不是在图标右侧」重新开单。

**不被裁切的两个约束**：

1. 方向必须镜像：右侧停靠时右侧是屏幕外，朝右的气泡会整块落在区域外；
2. 距离必须越过间隙：气泡起点 = 锚点内侧边 + `capsuleTipInwardOffset(锚点边长)`
   （基准 = 半轨道厚 28 + gap 8 + 区域 AA 内收 2 = 38，再减去锚点半边长），
   落到面板矩形内。36px 图标/状态球是 `38-18=20`；26px 收起按钮是 `38-13=25`
   （2026-11-03 修正：此前收起按钮也套用 20，气泡起点会落在 gap 内 3px，被裁出一条缺边）。
   轨道与面板之间的 `gap` 既不属于区域也不拦截鼠标，气泡若从 6px 默认距离起画会被裁出缺边。

回归测试：`src/components/capsule/CapsuleRail.tooltip.test.tsx` 按四个边分别断言
展开态方向、折叠态方向，以及气泡矩形是否完整落在面板矩形 / 翼片多边形内。

**补充（2026-11-03）：区分停靠坞与完整悬浮栏，并对齐图标中心**

- 形态是显式输入：`railTipPlacement(form, edge, expanded, lead)`。只有 `form="docked"` 才套
  四边镜像；完整悬浮栏（未贴边停靠 / 自由位置，如主窗口左导航 `FullView`）固定为 `right`，
  与 Agent 面板提示一致，不因 `edge` 取值被误判。
- 展开态气泡以图标**中心**对齐：`TooltipLayer.computeTooltipPosition` 对 top/bottom 用
  `anchorLeft + anchorWidth/2 - tipWidth/2`，对 left/right 用
  `anchorTop + anchorHeight/2 - tipHeight/2`；`data-tip-offset` 只调主方向距离，不参与居中。
- 边界收敛在居中之后：主方向放不下返回 `null` 交回 `flip`；横跨轴只在屏幕边缘内 clamp
  （被夹住时允许相对图标轻微不对称，但不压图标、不出界）。
- 气泡尺寸取 `offsetWidth/offsetHeight`（布局尺寸）。入场动画对浮层做了 scale，若按首帧
  `getBoundingClientRect` 计算，动画结束后会残留半条尺寸差造成的偏移。

**补充（2026-11-04）：胶囊导航独立配置**

- 胶囊轨道的图标可见性与排序来自 `navigationRegistry` 的 capsule 面，与完整面板的左侧导航
  完全独立（隐藏完整面板的剪贴板不影响胶囊）。
- 配置只改变 `CapsuleRail` 内部按钮的渲染集合与顺序；原生窗口尺寸、四边停靠、区域裁剪、
  点击命中区与几何契约不变，不随可见图标数量变化。
- 当前激活分类被隐藏时切到仍可见分类（优先 Agent 状态球），全部隐藏时收起面板；
  设置页提供单面恢复默认，胶囊轨道始终保留「回到完整面板 / 收起」控件作为恢复路径。
- 回归：`CapsuleDock.test.tsx`、`CapsulePanels.test.tsx`、`CapsuleRail.tooltip.test.tsx`。

**补充（2026-11-04）：胶囊入口扩展原则与改动清单**

本节只沉淀扩展规则与约束，不新增入口，也不改现有外观。

**结论**：胶囊入口的身份、默认顺序/显隐已由 `navigationRegistry.ts` 单一事实源驱动，
`CapsuleRail` 按 `layout.capsule` 渲染、`CapsuleDock` 按 `capsuleCategory` 选面板；
显隐/排序经 `navigationLayout.ts` 写入 SQLite 且两套配置独立。**现有架构已满足扩展**，
不需要为未来入口重构轨道、注册中心或配置层。

**入口分两类**（先分类，再决定是否进胶囊）：

| 类型 | 判定 | 处理 |
|---|---|---|
| **Lite 面板型** | 高频查看、操作简单（≤1 步主操作）、数据量小、可复用现有后端能力，无需复杂表单 | 可作为胶囊分类，复用 `Lite` 面板 |
| **快捷跳转型** | 完整配置页、复杂编辑、大量历史/图表数据、规划中心等重型界面 | 直接进完整工作区，**不造** Lite 页 |

判定顺序：先问「用户会不会一天打开多次且只看一眼」，再问「Lite 面板能否在不新增
IPC/轮询的前提下完成核心动作」。两者任一不成立即为快捷跳转型。禁止把完整页面塞进
340×440 面板，也禁止为凑入口新建后端聚合接口。

**新增一个胶囊入口的改动清单**（当前实现下的真实分散点）：

| # | 位置 | 改动 | 是否可省 |
|---|---|---|---|
| 1 | `src/lib/capsuleModel.ts:21` `RailCategory` | 加分类字面量 | 否（类型） |
| 2 | `src/lib/capsuleModel.ts:24` `CapsuleCategory` | 随 `RailCategory` 自动扩展 | 否 |
| 3 | `src/lib/capsuleModel.ts:26` `RAIL_CATEGORIES` | 加分类（顺序契约） | 否 |
| 4 | `src/lib/navigationRegistry.ts:52-64` `NavEntryId` | 加稳定 ID | 否 |
| 5 | `src/lib/navigationRegistry.ts:103-293` `NAV_ENTRIES` | 加入口（`surfaces`、`tabs`、`capsuleCategory`、`defaults.capsule`） | 否 |
| 6 | `src/components/capsule/CapsuleDock.tsx:32-38` `PANELS` | 加面板组件映射（`Record<CapsuleCategory, …>` 会强制编译报错） | 否 |
| 7 | `src/components/capsule/CapsuleRail.tsx:37-53` `CATEGORY_LABELS` | 加 getter（同样受 `Record` 穷尽检查） | 否 |
| 8 | `src/locales/zh-CN/index.ts:155-159`、`src/locales/en-US/index.ts:140-144` | 加 `capsule.category.<id>` 文案 | 否（`MessageKey` 强约束） |
| 9 | `src/components/capsule/CapsuleRail.tsx:182,184` | 状态球/category 分组以 `id === "agents"` 判定 | 仅当新入口也是 `agent-status` 类才需动 |
| 10 | `src/components/capsule/CapsuleRail.tsx:249` | 徽标只对 tasks/inbox 取值 | 否（新分类无徽标属预期） |
| 11 | `src/store/useCapsuleStore.ts:16` | 默认分类 | 仅当默认入口变更 |
| 12 | `src/styles.css:7473-7477` | 轨道几何（400 长、内容组 212/±106、可点击 ±121） | **受几何上限约束，见下** |

测试侧也要同步：`src/lib/capsuleModel.test.ts:123-124`（分类顺序）、
`src/components/capsule/CapsuleRail.tooltip.test.tsx`（按四个分类/六个锚点断言命中区）。

**几何上限（当前只支持「状态球 + 4 个分类」）**：轨道固定 400 CSS px，内容组
36 + 8 + 4×36 + 3×8 = 212 居中落在 ±106，端头按钮仍在肩部厚度 ≥36 的可点击区 ±121 内。
再加一个 44px 节距的分类，内容组变 256 → ±128，端头图标进入曲面肩部，会被
`SetWindowRgn` 区域裁掉命中区。因此：

- 新增第 5 个胶囊分类**不能只加数据**，必须同时改 `styles.css` 几何与
  `src-tauri/src/window_shape.rs` 的 `capsule_regions`（尺寸三端同步：`src/lib/capsuleLayout.ts`
  + `src/styles.css` + `window_shape.rs`），属于视觉/原生改动，需单独任务评估；
- 在几何未变之前，新增入口应优先走「快捷跳转型」进完整工作区，或**替换**现有分类，
  不得挤压现有四个分类的命中区。

> **更正（2026-11-07）**：第 5 个分类「规划中心」已按本文 §十八 扩展几何
> （平直主体 224→270、外框 400→446），本段「只支持状态球 + 4 分类」的结论被取代；
> 旧内容保留作为历史记录。

**可见性边界结论**：

- 状态球（`kind: "agent-status"`）是全局状态入口，不是第 5 个页签：它不进 `.cap-nav`，
  不参与分类排序（胶囊顺序里把 `agents` 排到末尾，球仍固定在轨道端头）；
- 隐藏当前分类时静默切到仍可见的第一个分类（优先状态球），隐藏非当前分类不重开面板；
- 只留状态球时仍可停在 Agent 面板；**全部隐藏时收起面板**，轨道仍保留「切换为完整面板 /
  收起」控件，所以不存在「把自己锁死」的空白死入口；胶囊不强制至少保留一个分类入口；
- 折叠态只挂载轨道，不渲染 `.capsule-panel`，不存在空面板容器。

回归：`src/components/capsule/capsuleNavigationContract.test.tsx`（集合一致、分类有面板、
状态球不计分类、隐藏/全隐行为、持久化与两面独立）。

### 12.10 拖拽光标会话与「原生循环退出」信号（2026-11-06）

**问题**：从轨道或标题栏按住拖动时，Windows 进入系统模态移动循环；循环期间 WebView2
收不到指针事件，**松手没有 `pointerup`**。旧实现只能等下一次 `pointermove`
（`buttons === 0`）才摘掉 `is-dragging`，表现为「左键松开后光标要再动一下才从
`grabbing` 回到 `grab`」。

**根因层**：结束信号本来就在窗口过程里——`WM_EXITSIZEMOVE`。前端拿不到它，
所以只在浏览器事件层打补丁必然有残留。

**方案（两层，不引入第二套引擎）**：

1. **原生**：主窗 `magnetic.rs` 在 `WM_ENTERSIZEMOVE` / `WM_EXITSIZEMOVE` 后各
   `PostMessage` 一条自定义消息（`WM_APP + 0x55`），在消息处理里回调
   `register_drag_hook` 注册的钩子。延后一拍的理由与 `WM_MAGNET_SNAP` 相同：
   不在模态循环内执行宿主代码，且循环退出后 Windows 还会重设一次光标。
   若消息送达时 `IN_SIZE_MOVE` 已重新置位（用户已开始下一次拖动），这条信号
   属于上一轮，直接丢弃——否则新会话刚进入的 `grabbing` 会被误清
   （`magnetic::win::drag_phase_tests` 锁定）。
2. **前端**：`lib.rs` 把钩子接到**该窗口**的 `window-drag` 事件（窗口级 emit，
   不广播，天然不串台）；`src/lib/dragCursorSession.ts` 收到后按相位处理。

**相位协议与代次（2026-11-06 二次验收补强）**：

事件载荷为 `{ phase: "start" | "end", generation: n }`（见 `src-tauri/src/drag_signal.rs`）。
`generation` 在每次 `WM_ENTERSIZEMOVE` 递增，同一轮拖拽的开始与结束携带同一值。
为什么需要它：事件是异步的，旧拖拽的结束信号可能在用户**已经开始下一次拖拽**之后才被
前端消费；若「收到结束就结束全部会话」，会出现「鼠标还按着、抓手指针却没了」。
前端规则：

- 会话收到 `phase: "start"` 时绑定该代次；
- 只有代次**完全匹配**的 `phase: "end"` 才结束它；
- 尚未绑定代次的会话（例如 `startDragging` 没走到原生循环）不受任何原生结束信号影响，
  继续由指针事件兜底；
- 重复结束信号幂等（会话结束即从活动集合移除）。

类名一变，Blink 按指针下元素重算 CSS `cursor` 并 `SetCursor`，
**鼠标完全静止也能立刻复位**，不需要模拟鼠标移动、轮询或固定 timeout。

**统一实现**：标题栏、胶囊轨道、工具面板标题、桌面微件共用
`attachDragCursorSession()`；`pointerup` / `pointercancel` / `visibilitychange`
仍是兜底路径（覆盖不走原生循环的普通点击与中断），`blur` 只在起始 120ms 之后生效
（起始内是 `startDragging` 激活窗口造成的焦点扰动）。会话结束（任何路径）即从活动
集合移除；`dispose()` 成对摘除监听（`dragCursorSession.test.tsx` 断言每次拖拽后
活动会话数回到 0）。

**边界**：微件窗口走 `drag_watch.rs` 的**同一协议**——只关心两段相位的轻量窗口过程
（不动几何、不碰光标、`WM_NCDESTROY` 还原原过程并摘表项），经 `run_on_main_thread`
在窗口所属线程安装；不加载磁吸状态机，也不在主窗上重复安装子类化。

**start 归属校验（2026-11-07 三轮验收补强）**：

只比较结束代次仍不充分：旧拖拽的 **start** 也可能迟到。若此时用户已开始新会话 B，
无条件 `bind(start.generation)` 会把旧代次写给 B，随后迟到的旧 end 就会清掉 B。
原生事件本身不携带前端会话身份，因此补两个**确定性**条件（不使用固定延时、模拟移动
或轮询）：

1. **会话快照**：收到 `start` 时先冻结当前存活会话；查询期间才创建的新会话不在快照里，
   旧 start 无法认领它。
2. **原生实时确认**：新增异步命令 `drag_loop_active(generation)`（主窗读
   `magnetic::DRAG_LOOP_ACTIVE` + `DRAG_GEN`，微件读 `drag_watch::Watch.active` + 代次，
   按调用窗口隔离）。系统模态循环期间 WebView2 收不到指针事件，所以「循环仍活跃时
   存在的会话」只可能是它的发起者；循环已退出则说明 start 属于已结束的拖拽，不绑定。
   命令必须是 `async fn`：同步命令在主线程执行，会被模态循环本身排队，永远只能读到
   「已结束」。

另加结束水位线：若查询结果在对应 `end` 之后才返回（快速拖拽），直接收尾快照里的会话，
避免留下一个永远等不到 `pointerup` 的 `grabbing`；查询失败/协议不完整时不绑定，
仍由指针事件兜底。重复 start 幂等（只绑定尚未绑定代次的会话），旧查询结果不会覆盖
新代次。回归测试见 `dragCursorSession.test.tsx`（旧 start+end 同时迟到、快速拖拽、
查询不可用、重复 start、连续拖拽、卸载后迟到事件）。

### 12.11 工具面板标题 = 窗口拖拽热区（2026-11-06）

胶囊与工具面板在**同一个原生窗口**里（区域裁剪，见 §二），所以「拖面板」与
「拖轨道」本质是同一件事：拖动整个窗口。因此标题区直接挂
`data-tauri-drag-region`，不做 CSS `transform` 跟随，也不新增定位引擎——
轨道与面板的相对位置由窗口几何天然保证，磁吸/解除/多显示器全部沿用既有路径。

命中范围按 Tauri 语义划分（**属性只对事件 target 自身生效，不向下传递**）：

| 元素 | 可起拖 | 说明 |
|---|---|---|
| `header.cap-head`（背景/内边距） | ✅ | `PanelHead` 统一挂载 |
| `.cap-title` / `.cap-sub` 文字 | ✅ | 标题与说明都是抓手 |
| `.cap-actions` 内按钮 | ❌ | 返回/刷新/新建/筛选/搜索不挂属性 |
| 面板正文、列表、输入框、卡片 | ❌ | 不挂属性，交互不被抢占 |
| 剪贴板二级页标题（`cap-clip-head`） | ✅ | 与一级面板同一套命中规则 |

光标语义由 `.ui-drag-surface`（`grab`）+ `.ui-drag-session.is-dragging`（`grabbing`）
承担；`PanelKit.PanelHead` 与两个剪贴板二级标题都用 `useDragRegion()` 复用同一会话。

## 十三、极简吸附态 Edge Tab（2026-11-05）

**三种停靠形态**：完整面板（`snap_display_mode=full`，`docked-full`）· 胶囊（默认，
`docked-visible` / `docked-hidden` / `docked-revealed`）· 极简标签（`docked-tab`）。
三者统一由 `useEdgeSnap` 相位机管理，不新增并列布尔量。

**转换**：胶囊「收起为极简标签」→ `docked-tab`；标签单击 / 明显向内拖动 → `docked-visible`；
胶囊「完整面板」仍走既有会话形态切换（`requestSessionForm`），不接入完整面板收缩逻辑。
`edgeSnap.ts::LEGAL_TRANSITIONS` 是唯一守卫，`free → docked-tab` 只用于重启恢复。

**双击收缩（2026-11-07）**：完整面板（`docked-full`）双击标题栏拖拽面 = 收缩为胶囊
（`formSwitch("capsule")`，会话语义，与贴边箭头 `cap-form-toggle` 一致）。`TitleBar` 在
元素级拦截 `mousedown detail≥2` 并 `stopPropagation`，替代 Tauri drag-region 脚本对双击
的默认 `internal_toggle_maximize`——该默认是程序化最大化，不受停靠期清除的
`WS_MAXIMIZEBOX` 限制，停靠窗口被最大化后引擎按法向偏离判定拖离、自动解除停靠。
自由窗口保持常规双击最大化；单击拖拽路径不变；菜单/窗口按钮等交互子元素按
drag-region bare 语义不会误触。

**几何与命中**：标签 `10×46 CSS`（水平边 `46×10`），贴屏幕边为直边、内侧两角 8px 圆角；
前端常量在 `capsuleLayout.ts`（`TAB_WIDTH_CSS` / `TAB_HEIGHT_CSS`），原生区域在
`window_shape.rs::edge_tab_regions`，双端单测锁定；区域外另有缺口探针，避免隐形可点击区。
标签纵向位置沿用胶囊中心并 clamp 在显示器工作区内，多显示器 / DPI 变化按既有收敛逻辑重贴。

**动画**：`CapsuleDock` 在 `tabTransition` 非空时同时渲染轨道与标签，`is-to-tab` 时轨道
`transform` 向屏幕边侧滑、`clip-path` 收成 46px 高的长条，图标随透明度降低；标签从 38%
进度开始交叉渐显，保证在收纳完成前接替；`is-from-tab` 反向复用同一组关键帧。
300ms、`cubic-bezier(0.22, 1, 0.36, 1)`，只动画 `transform` / `opacity` / `clip-path`，
不压扁图标、不做 `scale`；`prefers-reduced-motion` 直接落到终点。窗口区域只在过渡结束
提交一次，过渡期间 `tabAnimating` 拒绝重复请求，快速连点不会叠加动画。

**交互**：标签单击恢复；垂直拖动只改中心，不切形态、不改吸附边；明显向内拖动超过
`TAB_RESTORE_DRAG_CSS` 才恢复，拖动结束的 `pointerup` 不再触发点击恢复（`click` 仅接
键盘激活）。工具提示沿用 `data-tip`，文案「收起为极简标签 / 完整面板」。

**持久化**：`snap_state` 追加可选 `form`；重启按 `form=tab` 直接恢复标签，缺失时兼容为
胶囊。恢复点按显示器几何重新 clamp，标签不会落在屏外。

**证据**：本轮真机验证（真实 WebView2 + CDP + Win32 命中测试）记录在
`tmp/acceptance/edge-tab/report.md`。

**二轮修订（2026-11-05）**：

- 面板展开态收起不再「相位推进即卸载」：`useEdgeSnapStore.panelExiting` 先置位，播放
  `PANEL_EXIT_MS`（160ms，`capsule-panel-out`）的离场动画，再写轨道区域并推进
  `docked-visible`；`CapsuleDock` 在 `expanded || panelExiting` 期间保持面板挂载并加
  `is-closing`。`prefers-reduced-motion` 跳过等待与长动画。
- 标签可见性改由语义 Token 驱动：`--cap-tab-face` / `--cap-tab-face-hover` /
  `--cap-tab-ring` / `--cap-tab-ring-hover` / `--cap-tab-edge` / `--cap-tab-focus`；
  浅色靠墨色内描边提供轮廓、纸白内侧高光提供体积，深色只覆盖透明度。只做内描边——
  窗口区域恰好等于标签矩形，外投影会被 `SetWindowRgn` 裁掉。
- 底部「完整面板 / 极简标签 / 收起」三个按钮继续复用 `.cap-collapse`，纵向间距统一
  4px（横向边距沿用轨道布局），不新建重复组件、不放大点击区。
- 二轮真机证据记录在 `tmp/acceptance/edge-tab-round2/report.md`（含 EXE 溯源、面板离场
  采样、深浅主题原生截图、左右边缘 `WindowFromPoint` 命中测试、拖动与重启持久化）。

**异步拖动一致性修订（2026-11-06）：**

- Edge Tab 沿边拖动保留单飞调度（只保留最新目标，不恢复逐帧 IPC），但松手不再同步把
  目标中心写入 `snap_state`：终态先等待单飞任务收口，再回读实际窗口矩形，按实际中心
  落库；回读与目标差 ≥1 物理像素时记录警告。IPC 失败、成功但位置未生效、回读失败时
  不写幻影目标位。
- 排队移动与终态落库带会话代次：形态切换（收起/恢复/解除）、引擎卸载、下一轮按下后，
  尚未启动的过期目标不执行，旧终态落库不覆盖新事务。已在途的单次 IPC 无法撤回，
  其后排队的过期目标会被代次丢弃。

**过期在途移动收口修订（2026-11-06，round3）：**

- 窗口移动经模块级串行链（`windowMoveChain`），单窗口 `setPosition` 不得重叠在途；
  恢复胶囊/解除停靠前有界（2s）等待 Edge Tab 单飞收口，旧 IPC 先落地、新几何后落地，
  已在途请求超时未返回时新移动仍排在旧移动之后。
- 回读有界重试 1 次（共 2 次）；仍失败时不写持久化并清空未确认的内存中心，
  恢复胶囊回退到真实矩形，后续巡检用真实位重建。

**工具面板与完整面板整合修订（2026-11-06）：**

- **跨面板跳转必须是单一导航事务**：胶囊里「打开完整面板并执行一个动作」统一走
  `openFullApp(tab, after)`，`after` 只在导航成功（含用户确认放弃草稿后的强制导航）后执行，
  返回值区分 `switched / pending / blocked`。任务编辑新增 `openTaskEditor(task)`（一次
  `setTab` + `openEditorNow`）；禁止拆成 `openEditor(task)` + `openFullApp("tasks")`——
  第二次导航会覆盖 `pendingTab.after`，有未保存草稿时编辑意图丢失。
- **一次性意图一律放在 `after` 内**：逐项粘贴、暂存定位、添加应用、目标管理、快速笔记；
  取消/保存中拦截时不残留。`InboxDropPane` 的「管理」由「先置位再导航」改为 after，
  修复了导航被拦截后、下次进入暂存架突然展开管理面板的问题。
- **胶囊内的未保存草稿确认**：胶囊模式 `.dock-app` 是 `display:none` + `inert`，全局
  `TabLeaveGuard` 不可见；`CapsuleDock` 面板内新增 `CapsuleLeaveGuard`（复用 `cap-confirm`），
  只在 `pendingTab` 与当前活动守卫一致时显示「继续编辑 / 放弃并切换」；面板收起或切换分类
  即取消待决意图，不把 `after` 留给下一次进入。
- **轻量入口**：Agent 面板底栏「行动」只导航到完整行动中心（不订阅行动 feed；用户在设置中
  关闭行动中心时隐藏）；收集箱「快速笔记」导航到完整收集箱的笔记子页（胶囊不新建笔记编辑器）。
- **不新增胶囊分类**：轨道几何只支持「状态球 + 4 分类」，第 5 个分类会挤压命中区，且需要
  `styles.css` 与 `window_shape.rs` 三端同步改动；本次不扩大几何。
  **更正（2026-11-07）**：该约束已在单独任务中解除——规划中心作为第 5 个分类进入胶囊，
  轨道外框扩到 446，三端同步并按 §十八 验收。
- 回归：`src/components/capsule/taskEditorNavigation.test.tsx`、`CapsuleDock.test.tsx`、
  `CapsulePanels.test.tsx`、`InboxDropPane.test.tsx`、`InboxLite.test.tsx`、
  `capsuleNavigationContract.test.tsx`。

**拖拽光标与稳定态渲染契约修订（2026-11-06）：**

- **光标只有一套来源**：标签悬停 `grab`、超过拖动阈值 `grabbing`、松手/取消回到 `grab`，
  全部由 WebView2 的 CSS `cursor` 表达（`.capsule-tab` / `.capsule-tab.is-dragging`），
  与轨道空白处的 `.ui-drag-surface` 同一语义。标签是「可抓取的细柄」，不是普通按钮，
  因此不再使用 `pointer`。
- **原生侧不得覆盖标签光标**：原来的 `refresh_edge_tab_cursor`（`WM_CURSOR_EDGE_TAB` →
  `SetCursor(IDC_HAND/IDC_ARROW)`）已整条移除。它有两个必然偏差：Win32 没有与 Chromium
  `grab/grabbing` 等价的系统光标（`IDC_HAND` 是手形，不是抓手）；且在鼠标静止时不再有
  `WM_SETCURSOR`，一旦写错就会停在手形/箭头，表现为「必须动一下鼠标才恢复」。
  `EdgeTab` 摘掉 `.is-dragging` 会让 Blink 按指针下元素重算 `cursor` 并下发 `SetCursor`，
  鼠标完全静止也能立即恢复。
- **稳定 `docked-tab` 只允许标签一个子节点**：`CapsuleDock` 在 `stableTab`（相位为
  `docked-tab` 且 `tabTransition === null`）时**不挂载** `CapsuleRail`，也就没有 `.cap-nav`、
  `.cap-edge-tab`、`.cap-sep`、面板与 `snap-dock-line`。轨道只在 `to-tab` / `from-tab`
  过渡的 320ms 窗口内与标签共存（交叉淡出），过渡结束立即卸载。该约束由
  `CapsuleDock.test.tsx` 的「稳定极简态只挂载标签」用例锁定。
- **拖动结束的收尾必须唯一**：`pointerup` 已收尾时，随后的 `lostpointercapture` 只复位光标，
  不得再次 `endTabDrag`（否则位置回读与持久化跑两遍）；窗口失焦/页面隐藏按取消处理。
- **主窗根容器必须占满窗口**：`.dock-window` 增加 `width: 100%`。胶囊态的可见内容全是绝对
  定位（`.capsule-dock` 是 `inset: 0`），自身没有内在宽度；一旦 `#root` 的 `display` 不是
  block（多入口构建 `cssCodeSplit: false` 时，弹窗页的 `#root{display:flex}` 会进入主窗样式），
  `.dock-window` 会塌成 0，右/上/下停靠的标签与轨道被排到窗口之外——原生区域正常、区域里
  却没有内容。真机证据：修复前右边缘标签 DOM `x=-10`（区域 492..505 全空），修复后
  `x=394..404` 与区域一致。
- 诊断与真机取证见 `tmp/acceptance/edge-tab-visual-cursor/report.md`。

**共享 CSS 作用域与悬停提示会话（2026-11-06 二轮修订）：**

- **入口 CSS 必须页面级作用域**：`vite.config.ts` 关闭了 CSS 拆分（`cssCodeSplit: false`，
  保证 styles-themes 与 styles 的层叠顺序），六个入口共享同一份打包 CSS。因此**任何**入口
  的无作用域 `html / body / #root` 布局规则都会同时作用到主窗。tab-hint 页的根规则已全部
  改挂 `<html class="tab-hint-page">`（`styles-tab-hint.css` 顶部有约定说明）；
  `src/styles-entry-scope.test.ts` 做结构级守卫（裸根选择器不得声明 position/display/flex/
  inset 等布局属性），`scripts/check-entry-css.mjs` 在 `npm run build` 之后的**打包产物**上
  复查同样规则。`.dock-window{width:100%}` 保留：它与作用域无关，是主窗几何的独立约束。
- **悬停提示是「显示会话」，不是状态开关**：`show → 前端渲染/测量 → fit → 真显` 三段式
  链路必须可取消。后端用单调**代次**管理（`tab_hint.rs::HintState`，单锁，tao 调用在锁外）：
  每次 `show`/`hide` 推进代次，`tab-hint-show { id, text }` 把代次发给提示窗，前端测量后回传
  `fit_tab_hint { width, height, id }`；代次不匹配的 fit 一律丢弃，**hide 之后到达的旧测量
  绝不能让窗口重新显示**。同文案重复悬停也必须重新走完整事务——只靠 `text` 变化驱动测量
  会让第二次悬停静默失败（旧缺陷）。
- **前端测量不再依赖 rAF**：提示窗长期处于隐藏态，隐藏窗口的帧调度可能被节流；
  `useLayoutEffect` 阶段 DOM 已提交，同步读 `offsetWidth/offsetHeight` 是有效且更可靠的。
- **前端 `hintVisible` 只做 hide 去重**：它以后端 `show` 的返回值为准（受理才算显示），
  用会话代次丢弃迟到结果，并且**不拦截新的 show**——任何能永久阻止显示的缓存都是缺陷。
- 提示窗圆角 `HINT_RADIUS = 8.0` 与 CSS `border-radius: 8px` **相等**：区域是 CSS 圆弧的
  像素支撑形状，半径偏大会切进气泡四角（"角被削掉一圈"）。跨端契约由两端测试锁定。
- 二轮真机证据见 `tmp/acceptance/edge-tab-visual-cursor-round2/report.md`。

## 十四、应用工具面板交互修订（2026-11-06）

用户对照 Win11 开始菜单提出：应用磁贴需要轻量悬停反馈、标题说明同行、启动与拖拽反馈必须与
真实状态一致。本节记录**长期有效的交互契约**；具体视觉数值以 `styles.css` 为准。

**磁贴状态（`.cap-app` / `.cap-app-add`）**

- 普通态仍是透明底 + 真实图标，不铺卡片、不投外阴影。
- Hover：整格一层半透明中性底（`color-mix(--cap-text-1 6%)`）+ 1px **inset** 内描边
  （12%）。用 inset 阴影而不是 `border`，因为 border 参与盒模型会让 4 列网格抖动；
  同时不允许放大图标、缩放磁贴、改行列间距。
- Active：底色/描边加强到 10%/18%，图标位置不变。
- Hover 作用在 `.cap-app-slot` 而不是按钮本身：右上角删除按钮是并列兄弟，悬停删除时
  父级磁贴必须同步高亮。
- Dragging：`.is-dragging` 复位 hover 底色，只保留 0.55 透明度、`grabbing` 光标与落点竖线，
  避免 Hover / Dragging / Active 三层叠加。
- Disabled / Launching：不显示 hover 底色（否则仍像可点击），加载反馈只画在 36px 图标片内。
- Focus-visible：始终是独立的 2px `outline`，不依赖 hover 底色表达键盘焦点。
- 主题适配：底色/描边全部由 `--cap-text-1` 派生，浅色得到深色淡底、深色得到浅色淡光。

**标题布局**：`PanelHead` 新增 `layout="inline"`（默认 `stack`）。只有应用面板使用，
说明文字移到标题右侧、12px→11px、基线对齐、可省略；其余面板结构与高度不变。

**启动状态**：胶囊应用网格从「单个 `busyId`」改为「按目标 id 的 `launchingIds`」，
与完整应用中心一致。后端每次 `nav_navigate` 是独立 `spawn_blocking` 任务、没有全局串行锁，
因此不同应用可以并发启动，各自显示/恢复忙碌态；同一目标在途时忽略重复请求（同步 ref 兜住
setState 前的连点）。禁止再用全局忙态把整组磁贴一起禁用。

**拖放后的误点击防护**：不再用「距上次 drop 的时间窗」，改为「是否有新的按下」——
`dragstart` 清标记、`dragend` 置标记，网格捕获阶段的 `pointerdown` / `keydown` 清标记，
`click` 只在标记仍在时被忽略一次。这样浏览器补发的 click 不会误启动，拖完立刻点击其他应用、
加号或按 Enter 也不会被吞掉；拖拽取消只清理拖动状态，光标立即恢复 `grab`。

**名称提示**：统一走 `lib/nameTip.ts`（应用中心 / 选择器 / 胶囊网格 / 网址胶囊共用）。
只有名称真的被布局截断（宽或高溢出）时才挂 `data-tip`，值为完整名称；完整显示不弹同名提示，
exe 路径与网址不再作为提示内容。键盘 Focus 截断名称同样能拿到完整信息。

**全部隐藏的空态**：按真实对象区分「应用均隐藏 / 网址·文件夹·文件均隐藏 / 快捷目标均隐藏」，
不再把网址全隐藏说成应用全隐藏；网格收起时在该空态保留「添加应用」入口（复用同一个
`openAppsAdd` 一次性意图，不新建第二套添加流程），恢复入口仍逐项列出、绝不自动取消隐藏。

回归：`AppsLite.test.tsx`、`PanelKit.test.tsx`、`styles-themes.test.ts`（磁贴样式契约）。

## 十五、工具面板关闭入口与应用磁贴居中（2026-11-06 晚）

**统一关闭入口**

- 五个工具面板（任务 / Agent / 剪贴板 / 收集箱 / 应用）的右上角都有同一个 X，由
  `PanelKit.PanelHead` 渲染，不重复实现按钮；动作经 `panelClose.tsx` 的轻量 Context
  由 `CapsuleDock.closePanel` 提供（→ `useEdgeSnapStore.collapse`），**没有第二套关闭状态机**。
- 视觉：28×28 热区 + 15px Lucide `X`，透明底、10px 圆角（与 `cap-iconbtn` 一致），
  hover 7%、active 11% 中性半透明底，focus-visible 2px `outline`，无阴影、无常驻红色。
- 布局：始终排在 `cap-actions` 最后（= 标题栏最右）；28px 热区用 `margin-block: -3px`
  只贡献 22px 高度，标题行不会被撑高（应用面板压缩后的标题区与搜索框位置不变）。
  空间不足时只省略说明文字，标题不换行、面板无横向溢出。
- 命中：按钮与其内部 `svg` 都**不带** `data-tauri-drag-region`，点击不会被当成窗口拖拽；
  标题背景/标题/说明仍是拖拽热区，二者互不影响。
- 语义：只收起当前工具面板——不退出应用、不关主窗、不隐藏胶囊、不切极简标签、不改分类、
  不重置排序或停靠设置。Esc、再次点击当前分类、点击 X 走的是同一个 `closePanel`；
  `collapsePanel` 在相位已不是 `docked-revealed` 时直接返回，重复点击不会反复切相位。
  面板卸载后焦点回到 `body`（不留在已移除的按钮上），复用分类与排序状态不变。

**应用磁贴视觉居中**

- `.cap-app` 改用 `justify-content: center`：图标与名称作为一个整体在整格（= hover 背景
  范围）内垂直居中，实测组中心偏移 0；同一行图标顶部位置一致，图标与名称间距恒为 4px。
- 名称仍固定保留两行槽位（`height: 2.4em` + 两行 clamp）：这是同一行图标对齐与网格高度
  稳定的前提。**单行名称的第二行留白是有意代价**：若把单行文字在自己的槽位里居中，会让
  同一行首行文字参差（1 行名称比 2 行名称低约 6px），因此不做逐格视觉居中。
- Hover 覆盖整格不变（`.cap-app-slot:hover .cap-app`），尺寸、行列间距、图标大小、
  Active / Focus-visible / Dragging / Launching 规则均不变。

**拖拽热区边界**：关闭按钮、搜索框、磁贴、加号、删除按钮都不是窗口拖拽热区；
只有标题背景与两段标题文字带 `data-tauri-drag-region`。应用网格内部排序仍是 HTML5 DnD，
与窗口拖动互不影响。

## 十六、极简标签交互契约：单击展开 / 悬停提示 / 右键菜单（2026-11-06 晚）

极简吸附态的外观保持不变（10×46 CSS px、单条状态线、贴边直角+内侧圆角、玻璃 Token），
本节只新增**输入与浮层**契约。核心前提：标签的可见区由 `SetWindowRgn` 收紧到标签矩形，
**任何主窗内的浮层都会被裁成残片**，所以提示与菜单都走独立弹窗，主窗区域与命中范围不扩大。

**单击 = 恢复 + 展开（同一事务）**

- `EdgeTab` 只在 `pointerup` 里按 `classifyTabGesture` 判定一次：位移 < 4px 为单击、
  法向 ≥ 28px 且方向占优为「向内拖动恢复」、其余为沿边拖动；指针 `click`（`detail !== 0`）
  一律忽略，键盘 Enter/Space 才走 `click`。因此拖动结束不会再触发一次恢复。
- 单击与向内拖动都调用 `restoreTab({ reveal: true })`：引擎在**同一个串行槽**里
  `await restoreFromTab()` 成功后再 `expandPanel()`，不是两段靠固定延迟拼接的调用；
  恢复失败则不开面板，面板展开失败则停在轨道并沿用既有失败提示。单击不会出现
  「面板先开、轨道后回」的竞争或闪烁。
- 标签拖动仍是 `dragTabBy(累计位移)` 只管沿边位置；法向位置由贴边几何固定，
  松手后终态回读一次再落库（既有逻辑未改）。

**光标（与并行会话的 drag-cursor-feedback 合并后的最终语义）**

- `.capsule-tab` 默认与悬停都是 `grab`；超过点击阈值（`is-dragging`）切 `grabbing`；
  `pointerup` / 真正的 `pointercancel` / 窗口 `blur` / 页面隐藏 / 卸载都会立即摘类，
  Blink 据此在同一次事件里重算并下发光标，鼠标静止也能恢复。
  正常松手后的 `lostpointercapture` 不再重复收尾；**按键仍按下时**的提前丢失捕获
  不结束手势（见本轮补充的降级契约）。
- 光标**只由 WebView2 的 CSS 决定**：原生侧不再 `SetCursor(IDC_HAND)` 覆盖
  （那会让松手后的光标变成手形/箭头，且静止时不再有 `WM_SETCURSOR` 纠正）。

**悬停提示（独立 `tab-hint` 窗口）**

- 主窗不挂 `data-tip`（TooltipLayer 在主窗内绘制，必被区域裁切）。`EdgeTab` 悬停 350ms
  （与 TooltipLayer 的 SHOW_DELAY 同口径）后发送 `show_tab_hint { edge, text }`；
  离开 / 按下 / 开始拖动 / 右键 / 窗口失焦 / 页面隐藏 / 卸载都会 `hide_tab_hint`。
- `tab-hint` 窗口 `focus: false`（tao 据此加 `WS_EX_NOACTIVATE`，显示不抢焦点），
  启动时 `set_ignore_cursor_events(true)`（`WS_EX_TRANSPARENT`，永不接收鼠标）；
  从不调用 `set_focus()`。因此提示不会拦截单击、拖动或右键。
- **先量后显**：`tab-hint-show { id, text }` → 前端渲染后回传
  `fit_tab_hint { width, height, id }` → 后端校验代次后按实测尺寸 `set_size` + 定位 +
  `apply_with_radius(8)` 才 `show()`。前端在**显示事件订阅兑现后**才回传
  `tab_hint_ready`；就绪前的显示请求由后端排队并在 ready 时补发，不用兜底尺寸
  提前显示一个没有文字的空提示条。
- 文案与轨道状态球**同源**（`railStatus().agentTone`，见 `tabHintKey`）：
  running / waiting / failed / disconnected 各有专属文案，`unknown`（快照未加载）
  与 `idle` 回落为「点击展开 · 拖拽移动」——未知状态绝不宣称运行中。无新增订阅与轮询。

**右键菜单（复用 `context-menu` 弹窗的 tab 变体）**

- 标签 `contextmenu` 上 `preventDefault` 后调用 `show_tab_context_menu { edge }`；
  不进入拖动、不触发恢复、不重复打开。
- 同一个 `context-menu` 窗口与同一套键盘/Escape/失焦关闭/圆角区域逻辑，只按
  `context-menu-show { variant: "tray" | "tab" }` 切换条目：tab 变体**恰好三项**
  （展开工具面板 / 打开完整面板 / 退出吸附），无分组标题、无勾选态；
  结构由 `validateTabMenuConfig()` 与 `items.test.ts` 锁定（防止长出第四项）。
- 动作执行不复制业务逻辑：`context_menu_action("tab:expand|full|undock")` 只向主窗
  emit `edge-tab-action`，由 `useEdgeTabMenuActions` 交给唯一的状态机——
  `expand` → `restoreTab({ reveal: true })`；`full` → `formSwitch("full")`
  （本次会话临时形态，不写 `snap_display_mode`）；`undock` → `undock()`（既有解除事务，
  恢复用户窗口几何，不影响下次吸附）。
- 定位由 `tab_popups::place_beside` 统一计算：朝**屏幕内部**展开、横跨轴以标签中心对齐、
  再收进该显示器工作区；水平/垂直/四角、125%/150%/200% DPI、副屏负坐标都有单测。
  提示窗与菜单共用这一个函数，不再各自实现一套 `place_menu` 变体。

**状态指示线与残影（有界排查，未改样式）**

- `data-tone` 六值（idle / running / waiting / failed / disconnected / unknown）分别映射到
  `--wing-badge` / `--status-*`，明暗主题各自有定义；状态变化只改 `background`，
  不改变标签尺寸（线固定 2×18），无闪烁动画、无额外订阅。
- 「右侧第二条细长残影」静态审计结论：标签内只有**一个** `.capsule-tab-line`，没有
  `::before/::after` 伪元素，也没有第二条描边/阴影；`to-tab` 过渡期轨道仍在 DOM，
  其 `--tab-clip` 切片与 `capsule-rail-to-tab` 的位移会让轨道右缘在 300ms 内从标签右侧
  滑过——形态上就是「标签旁多一条细线」，动画结束（opacity 0，`both` 填充）后消失。
  本轮未在真机上稳定复现动画结束后的残留；不通过隐藏正常元素掩盖，也不改动画节奏
  （见验收报告的 P3 记录）。

**二级页面复用同一个关闭入口（2026-11-06 补齐）**

- `PanelCloseButton` 从 `PanelHead` 中提取为独立展示组件：一级标题栏与剪贴板二级页面
  （`ClipboardLiteShell` 的图片/文本/文件/分组预览、`ClipboardTargetView` 复制并切换）
  共用同一个按钮、同一套 `.cap-close` 样式与同一个收起动作（→ `CapsuleDock.closePanel`）。
- 二级标题栏结构是 `← 返回 | 标题 + 说明 | 操作按钮 ×`：返回只退当前层（`onBack`），
  X 收起整个工具面板；两者是不同的按钮、不同的语义，X 不冒充返回、返回也不触发收起。
- 下层二级视图保持挂载（`hidden`）时只有最上层可见，不会出现视觉上的重复 X；
  无 `PanelCloseProvider`（组件单独复用）时 X 不渲染。
- 关闭动作只收起面板：进行中的复制/读取异步任务照常完成，`aliveRef` + 请求序号保证
  迟到响应不会写入已卸载组件；已发出的外部操作（复制/切换窗口）不虚构「已取消」。

**应用磁贴删除按钮精修（2026-11-06 补齐）**

- `.cap-app-del` 从 22×22 收成 18×18（图标仍 12px）：原 22px 热区在 72px 磁贴里与 34px
  图标的包围盒重叠 3px（窄窗 65px 磁贴重叠 6.5px），实测约 8% 的磁贴采样点命中删除
  而不是启动；18px 后名义尺寸下两者分离（1px 间隙），X 与图标视觉间距 1px → 4px。
- 图标容器仍是 36×36、位置不变（不允许为避让而偏移/缩小应用图标）；删除仍必须经过
  面板内确认条，磁贴 X（删除快捷方式）与标题栏 X（收起面板）语义不同。
- 长名称 Tooltip 复核：提示条 `pointer-events: none`，命中测试证明悬停其覆盖区域时
  点击仍落在关闭按钮上；未改提示定位策略。

**单行名称视觉重心（不改）**：名称槽固定两行是同一行图标对齐的前提；把单行文字在槽内
居中会让同行首行参差约 6px，因此维持整组居中 + 顶部对齐的现状。

**第二轮交互可靠性契约（2026-11-07）**

- **捕获丢失 ≠ 取消**：拖动期间窗口 `setPosition` / 独立提示窗显隐会让 WebView2 提前
  丢失元素级指针捕获。按键仍按下（`buttons !== 0`）时会话保留，窗口级 `pointermove`
  （捕获阶段）继续沿边移动，最终由窗口级 `pointerup/pointercancel` 收尾；元素与窗口两条
  路径共用唯一 `completeRelease`，重复事件只 `endTabDrag` 一次。不同 `pointerId` 的
  取消/丢失事件被忽略；正常松手后的 `lostpointercapture` 因会话已清空而自然跳过。
  若 `pointerup` 也丢失，只提交最后一次按键按下时的可信位移并无恢复收尾，不把
  「指针在标签外松开后又移回」误判成向内恢复。
- **菜单动作以事务结果为准**：`context_menu_action("tab:*")` 生成单调请求 id，向主窗
  emit `edge-tab-action { id, action }`，并等待主窗回传
  `tab_menu_action_result { id, ok, error }`（上限 8s）。主窗把
  `restoreTab` / `formSwitch` / `undock` 的 Promise 真实结果原样回执；只有 `ok` 才隐藏
  菜单。失败保留菜单并用既有 `.menu-feedback` 行内显示可重试原因；主窗不存在 / 未响应 /
  超时同样返回失败，不静默关闭。动作在途时菜单忽略重复点击/回车（`aria-busy`），
  失焦自动关闭在动作在途期间被抑制，避免失败反馈被藏进已隐藏窗口。
- **提示窗就绪 / 乱序**：`show_tab_hint` 在 `ready=false` 时只排队（不 emit）；前端在
  `tab-hint-show` 订阅兑现后调用 `tab_hint_ready`，后端补发最近一次请求。前端按单调
  `id` 丢弃重复/乱序旧事件；后端 `fit_tab_hint` 继续按代次拒绝过期测量
  （show → hide → fit 不会重新显示）。同文案重复悬停由新代次驱动，仍会重新测量。
- **残影（P3，未改动画）**：既有 16 帧证据中只有轨道滑出过程的中间帧会在标签右侧留下
  轨道边缘列，落定后（约第 6 帧起）完全干净；不是重复伪元素/重复节点，也未在动画结束后
  复现。保留 300ms 过渡，不通过隐藏正常元素或关闭动画掩盖。

## 十六、应用网格按面板宽度收敛列数（2026-11-07）

**问题**：`.cap-app-grid` 固定四列时，磁贴宽度随面板线性缩小，而图标（34px）与删除按钮
（18px，绝对定位在格子右上角）是固定尺寸。34px 图标在 W 宽磁贴里距右边缘 `(W-34)/2`，
要完整放下 18px 按钮需 `W ≥ 70`；原生 4 列是 71px（0.5px 间隙），面板 312（磁贴 65）与
232（磁贴 45）分别重叠 2.5×10.6px 与 12.5×10.6px，`elementFromPoint` 采样显示
312 有 2.34%、232 有 11.76% 的图标面积命中删除按钮 → 点图标会误进删除确认。

**真实宽度口径**（本轮复核发现）：原生胶囊窗口是 404×440 CSS px（`CAPSULE_CONTAINER_W_CSS`），
`@media (max-width: 407px)` 的窄窗兜底因此**总是**生效，面板实际是 `100vw - 68px` = **336px**，
不是设计常量 340。列数分档必须按 336 判定，否则原生默认布局会从 4 列掉到 3 列。
（Win32 区域仍按 340 裁，内缘 4px 透明带是既有行为，本轮不改窗口契约。）

**决定**：不改按钮热区（18px 已是可点下限）、不缩图标，改为**收敛列数**。

- 容器查询参照 `.capsule-panel[data-panel="apps"]` 的**内容盒**（容器属性只挂在应用面板上，
  其他面板不引入额外包含块语义）。参照面板而不是列表滚动盒：列表出现滚动条（4px）时
  列数不会抖动。
- 契约：内容盒 ≥ 308（面板 ≥ 336，即原生默认）→ 4 列 × 71px（0.5px 间隙）；≤ 307 → 3 列；
  ≤ 233（面板 262 以下）→ 2 列；≤ 155（面板 184 以下）→ 1 列。
- 保证：任一模式下每列 ≥ 71px，删除按钮与 34px 图标包围盒零重叠、图标区域内
  `elementFromPoint` 从不命中删除；「添加」磁贴仍是普通网格项，与普通磁贴同高。
- 搜索、排序、持久化顺序、拖拽/Alt+方向键逻辑均不受影响（纯 CSS 布局变化）。
- 浏览器合成实测（`tmp/acceptance/capsule-close-final-review/`）：原生 336 与
  339/335/312/262/261/232/184/183 九个宽度 + 三个滚动组合 + 深色主题，重叠面积 0、
  图标采样命中删除 0、图标右上角内侧命中启动、面板/网格/页面横向溢出 0。
  窄窗列数只在窗口被系统压到 400px 以下（面板 ≤ 335）的回退场景出现。

## 十七、极简吸附态第三轮：分组选择器、就绪握手与提示随状态更新（2026-11-07）

**CSS 作用域检查的分组盲区（P2，已修）**：`isBareRootSelector()` 遇到逗号直接返回
false，`html, body, #root { display:flex }` 会整条绕过裸根布局属性检查。现在
`splitSelectorList()` 按**顶层**逗号拆分（括号/字符串内逗号不拆），逐项判定：
同组里只要有一个裸根就报一条，不因另一个选择器已限定作用域而放行；独立的
`:is(html, body)` / `:where(...)` 递归展开。`@layer` / `@media` 嵌套路径继续保留，
压缩 CSS（`html,body,#root{display:flex}`）同样可识别。校验分两层：源码
`src/styles-entry-scope.test.ts`（12 项，含合法规则零误报、压缩输入、嵌套 at 规则）
与打包产物 `scripts/check-entry-css.mjs`。

**就绪握手（P2，已修）**：`listen()` 是 Promise，旧顺序「先 ready 再订阅」会让首次
show 在监听器建立前 emit 而丢失。现在前端先建立 `tab-hint-show` 订阅、成功后才
`tab_hint_ready`；订阅失败/卸载期间不报 ready（`SubscriptionScope.add()` 的
`Promise<boolean>` 就是建立结果），StrictMode 重挂载只会握手一次。后端三态：
窗口不存在 → show 返回 false / ready 不生效；未就绪 → 只排队；已就绪 → emit 并清掉
同代次排队载荷。`Destroyed` 复位为未就绪并清空目标。不用固定延迟、不轮询。

**提示随 Agent 状态原地更新（P2，已修）**：此前提示只在 `pointerenter` 后 350ms
显示一次，`hintVisible` 还会挡住后续 show。现在 `EdgeTab` 维护悬停会话：
- 只有「提示已显示 + 鼠标仍在标签上 + 文案真正变化」才重新下发；后端推进代次、
  提示窗重测尺寸，全程不 hide（无先隐藏再闪现）；
- 350ms 计时器回调读最新文案，延迟期间的状态变化最终显示最新值；
- 请求单飞 + 合并：在途时只记最新文案，兑现后补发一次，连续快速变化不放大 IPC；
- 鼠标离开、按下/拖动、右键菜单、形态过渡、窗口失焦、卸载都会结束会话并 hide；
- 同文案重复悬停仍能重新显示（hide 清空会话，下一次进入重新计时）；同一次悬停里的
  同文案重复调用由 `edgeTabActions` 按「edge + 当前显示文案」去重。
- 纯函数 `tabHintKey()` 未改：unknown/idle 继续回落到中性文案，不宣称具体状态。

**命令执行模型（P2，复核结论：无需改动）**：四个 tab-hint 命令都是同步命令。
wry 在 WebView2 的 `WebMessageReceived` / `WebResourceRequested` 回调里内联调用
`ipc_handler`，Tauri 在其中同步执行 `run_invoke_handler`；两个回调都由创建 WebView2
的 Windows 主线程投递，所以不同 WebView 的 show/fit/hide 与 `Destroyed` 严格串行，
「旧 reveal 校验 → hide → 旧 show」不可能发生。`reveal` 的两次复核收敛为
`commit_allowed()`（代次当前 + 目标仍在），并新增 6 项交错顺序单测。**契约**：
这些命令不得改成 `async fn`（会转到 async runtime 线程池），否则必须引入提交序号
或主线程封送。锁内不调用窗口 API、无全局锁、无后台线程/轮询。

## 十八、第 5 个胶囊分类：规划中心与轨道几何扩展（2026-11-07）

**决策**：在胶囊工具面板增加「规划中心」（稳定 ID `roadmap`，Ctrl+9 语义不变）。
用户明确要求第 5 个分类 + Lite 面板，并接受原生几何扩展；本文 §12.9「只支持状态球 + 4 分类」
与「不新增胶囊分类」的历史结论自此被取代（旧文本保留）。

**几何（三端同步）**：
- 平直主体 224 → 270，单侧肩部 88 不变，外框 400 → 446；容器沿边方向取
  `max(面板高 440, 轨道 446)`：
  - 垂直停靠 404×446（原 404×440）；
  - 水平停靠 446×504（原 404×504）。
- 同步点：`src/lib/capsuleShape.ts`（`WING_LENGTH_CSS`）、`src/lib/capsuleLayout.ts`
  （`RAIL_SPAN_CSS` / `capsuleContainerSize`）、`src/styles.css`（`.cap-v` / `.cap-h`）、
  `src-tauri/src/window_shape.rs`（区域几何与金标准点位）、
  `src-tauri/src/commands/system.rs`（`CAPSULE_LENGTH_CSS = 270`）。
- 内容组 = 状态球 36 + 间距 10 + 分类组 212（5×36 + 4×8）+ 分隔线 13 + 底部两个 30
  = 331，居中落在 ±165.5；平直主体覆盖 ±135，端点进入肩部 30.5px 处厚度约 36.6px，
  仍满足「肩部厚度 ≥36px」的命中区约束；125% / 150% DPI 下按比例保持（558 / 669 物理 px）。
- 真实 Win32 窗口区域回读测试（`capsule_region_applies_and_verifies_on_real_win32_window`）
  已按 446 更新并通过；原生窗口尺寸同步改为 446×504。

**Lite 面板边界**：`PlanningLite` 只做高频轻操作：
- 当前项目功能列表（状态徽标 / 优先级 / 里程碑 / 步骤进度）；
- 步骤勾选（`planning_update_step`，失败保留原状并提示）；
- 项目切换用面板内二级视图（弹出到面板外的下拉菜单会被 `SetWindowRgn` 裁掉）；
- 底栏「完整规划」走 `openFullApp("roadmap")`；项目 / 功能 / 里程碑 CRUD、看板与历史
  仍在完整规划中心。不新增 IPC、不新增轮询，复用 `usePlanningStore` 与 `planning-changed`。

**双数据来源（2026-11-08 补充）**：首版 Lite 只读用户项目，用户库里没有 `planning_*`
项目时面板只剩「还没有规划项目」空态，内置路线图（`featureCatalog.ts`，31 项）看不到。
现按完整规划中心的口径增加来源分段：
- 顶部固定「我的项目 / 内置路线图」分段；内置路线图按五个分类分组、只读，行内展示
  状态与优先级，展开显示目录详情与阻塞原因，不发 IPC；
- 用户没有任何项目（且项目读取成功）时默认落到内置路线图，避免空态被误认为
  「路线图未显示」；读取失败仍停留「我的项目」并给重试，不拿静态目录掩盖错误；
- 有项目时保持「我的项目」为默认，来源切换只影响视图，不改变 store 的当前项目。

**提示气泡修正**：
- 折叠态第一个分类位于轨道中心之前，「朝中心」方向改为向下 / 向右（`railTipPlacement`
  新增 `first` 参数）；否则 3 字气泡会伸进肩部曲面被裁掉。
- 新增 `.ui-tooltip.is-compact`（10.5px / padding 3×6）：折叠态全部使用，Agent 端头球
  展开态也使用，避免水平停靠时气泡越出面板左缘。
- 水平停靠端头球额外内推 24px（`TIP_ORB_HORIZONTAL_EXTRA_CSS`），越过面板 24px 圆角切点。

**回归**：`PlanningLite.test.tsx`（9 项，含无项目默认内置路线图与来源切换）、
`capsuleNavigationContract.test.tsx`（17 项）、
`CapsuleRail.tooltip.test.tsx`（32 项）、几何单测、`useEdgeSnap.integration.test.tsx`（130 项）；
前端全量 217 文件 / 3218 项；Rust `cargo test --lib` 1452 通过 / 8 ignored。
