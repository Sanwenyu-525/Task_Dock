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
- **托盘/快捷键唤回**：`snap-recall` → 展开功能面板（窗口始终可见，无需"找回"）。
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

**可见性边界结论**：

- 状态球（`kind: "agent-status"`）是全局状态入口，不是第 5 个页签：它不进 `.cap-nav`，
  不参与分类排序（胶囊顺序里把 `agents` 排到末尾，球仍固定在轨道端头）；
- 隐藏当前分类时静默切到仍可见的第一个分类（优先状态球），隐藏非当前分类不重开面板；
- 只留状态球时仍可停在 Agent 面板；**全部隐藏时收起面板**，轨道仍保留「切换为完整面板 /
  收起」控件，所以不存在「把自己锁死」的空白死入口；胶囊不强制至少保留一个分类入口；
- 折叠态只挂载轨道，不渲染 `.capsule-panel`，不存在空面板容器。

回归：`src/components/capsule/capsuleNavigationContract.test.tsx`（集合一致、分类有面板、
状态球不计分类、隐藏/全隐行为、持久化与两面独立）。

## 十三、极简吸附态 Edge Tab（2026-11-05）

**三种停靠形态**：完整面板（`snap_display_mode=full`，`docked-full`）· 胶囊（默认，
`docked-visible` / `docked-hidden` / `docked-revealed`）· 极简标签（`docked-tab`）。
三者统一由 `useEdgeSnap` 相位机管理，不新增并列布尔量。

**转换**：胶囊「收起为极简标签」→ `docked-tab`；标签单击 / 明显向内拖动 → `docked-visible`；
胶囊「完整面板」仍走既有会话形态切换（`requestSessionForm`），不接入完整面板收缩逻辑。
`edgeSnap.ts::LEGAL_TRANSITIONS` 是唯一守卫，`free → docked-tab` 只用于重启恢复。

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
