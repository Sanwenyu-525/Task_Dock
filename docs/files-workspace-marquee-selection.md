# 文件工作区矩形框选与选择状态

日期：2026-11-17
范围：`src/components/files/FileList.tsx`、`FilePane.tsx`、`files.css`、
`src/lib/filesWorkspace/marqueeSelection.ts`

本文件记录文件工作区第七轮的选择交互约定。实现不改变文件操作协议，也不引入第二套
全局拖拽框架；框选只改变选择集合，实际复制/移动仍由既有 `startFwDrag` +
`finishFwDrag` 路径执行。

## 1. 手势互斥

| 按下位置 | 手势 |
|---|---|
| 文件行/网格卡片 | 单击选择或文件拖拽候选 |
| 内容区空白 | 框选候选；未超过 5px 阈值时视为普通空白点击 |
| 表头、工具栏、标签栏、按钮、输入控件、滚动条 | 不启动框选 |
| 分割线、布局编辑模式 | 不启动文件框选 |

`FileList` 只在空白命中时注册框选指针监听；`FilePane` 只在条目命中时注册文件拖拽候选。
两者通过 pointerdown 的命中目标互斥，不使用两个同时争抢 `pointermove` 的全局监听器。

## 2. 框选状态机

```
idle --空白按下--> pending --移动 >= 5px--> active --pointerup--> idle（commit）
                         |                         |
                         +--pointerup（未越阈值）--> idle（blank click，清空选择）
                         +--Escape/PointerCancel/blur/卸载--> idle（cancel，恢复基准）
```

- 只有鼠标左键（`pointerType === "mouse"` 且 `button === 0`）可以启动框选。
- `start` 在越过阈值后才发给 `FilePane`；`preview` 由 `requestAnimationFrame` 合并；
  `commit` 在 pointerup 时提交最终集合。
- 取消时完整恢复 `pointerdown` 时的 `{ paths, anchor }`，不仅清空矩形。
- 组件卸载、窗口 blur、`pointercancel`、Escape 都走同一清理函数；自动滚动与移动帧一起取消。

## 3. 选择语义

以 `pointerdown` 时的选择集合为基准，一次拖拽期间语义稳定，不随每帧翻转：

| 修饰键 | 结果 |
|---|---|
| 无 | 候选集合替换基准 |
| Shift | 基准 ∪ 候选（并集、去重） |
| Ctrl/Meta | 基准与候选的对称差（切换命中项） |

空白处未形成框选的单击在 pointerup 后清空选择；在文件行上按下不会触发空白清空。
Escape 恢复基准；PointerCancel/blur 同样恢复基准并释放指针捕获资源。

## 4. 虚拟几何

框选命中不查询 DOM 行，而是按虚拟条目几何计算：

- 列表：固定行槽 `26px`，内容坐标减去吸顶表头 `26px`；只遍历矩形覆盖的行号。
- 网格：使用实际列数、卡片 `104×116`、水平/垂直间隔 `8px`、内容左内边距 `4px`；
  列数由容器宽度测量并通过 `onGridColsChange` 同步给键盘焦点移动。
- `rectsIntersect` 采用左闭右开/上闭下开：贴边不算命中，零面积矩形不命中。
- 复杂度与矩形覆盖的候选行列相关，不扫描 25000 条全部记录。

## 5. 视觉通道

- 行槽高度不因视觉间距改变；`.fw-row::before` 在槽内 `inset: 1px 2px` 绘制独立背景，
  不使用 margin，避免虚拟高度、滚动锚点与框选坐标错位。
- 选中：强调色 15% 背景 + 42% 细边框 + 独立圆角；连续多选不连成通栏。
- 焦点：独立 `outline` 通道，Active 不需要同时 Selected。
- 投递目标：虚线描边 + 24% 背景，与普通选中区分。
- 框选矩形：视口 fixed、`pointer-events: none`、1px 强调色描边 + 16% 填充，无阴影/动画。

## 6. 键盘与焦点

`FilePane` 维护 `focusedPath`，与 `selection.paths`、`selection.anchor` 分离：

- 方向键移动焦点；列表上下 ±1，网格上下 ±实际列数，左右 ±1。
- Shift+方向从锚点扩展选择；Ctrl/Meta+方向只移动焦点，不改变选择。
- Enter 打开焦点项；Home/End 跳到首/末项。
- 输入框、textarea、select、contenteditable 不消费文件选择键盘事件。
- 右键已选项保留整组；右键未选项把选择替换为该项，同时更新焦点。

## 7. 安全边界

框选与选择合并不调用 `fsCopyPaths`、`fsMovePaths`、`fsDeletePaths`。只有用户从已选条目
开始拖拽并在合法目标释放，既有拖拽协调器才会执行一次复制/移动。取消框选、取消拖拽、
PointerCancel、blur、Escape 均不产生文件系统 IPC。

## 8. 回归测试

- `src/lib/filesWorkspace/marqueeSelection.test.ts`：矩形规范化/相交、列表与网格几何、
  25000 项候选行、replace/add/toggle、自动滚动速度、键盘索引。
- `src/components/files/FileList.marquee.test.tsx`：阈值、Escape/PointerCancel、命中互斥、
  自动滚动单循环、网格列数、视觉契约。
- `src/components/files/FilePane.selection.test.tsx`：焦点/选中分离、键盘范围选择、
  Escape 恢复、右键多选、框选后整组拖拽载荷、选择期零文件 IPC。
