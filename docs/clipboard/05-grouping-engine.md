# 05 · 自动分组引擎

> 代码位置：`src-tauri/src/clipboard/engine.rs`（`decide_group` 等纯函数）、
> `src-tauri/src/clipboard/store.rs`（`record_capture` / `open_group` / 手动整理）
> 单测：`engine.rs::tests::grouping_window_and_interleaving`、
> `store.rs::tests` 的分组/排序/拆分/合并/引用安全用例

## 一、设计目标

- 分组决策与 UI、数据库、系统时钟解耦：时间由调用方传入，输入只有
  “内容类型、开关、当前时间、窗口秒数、最后一张截图时间、组内条数”。
- 顺序即事实：组内 `position` 按内容实际进入顺序递增，文字插入不改变截图相对顺序。
- 失败不产生半状态：条目入库与自动分组在同一 SQLite 事务中完成。
- 可解释：自动组命名“截图组 N”，状态 `collecting` / `closed`，来源标记 `auto`。

## 二、决策表

`engine::decide_group(kind, auto_group, now, window_secs, open_last_image_at, open_item_count)`

| 条件 | 结果 |
|---|---|
| 自动分组关闭 | `None` |
| `kind = files` | `None`（文件列表不参与截图分组） |
| 存在收集组，`now - 最后截图时间 ≤ 窗口`，且组内条数 < 300 | `Append`（任何非文件类型） |
| 不满足追加，且 `kind = image` | `Create`（先关闭所有 `collecting` 组，再建新组） |
| 不满足追加，且类型为 text/html/url | `None`（不新建组；若窗口已过期，顺手关闭残留收集组） |

补充规则：

- “最后截图时间”取组内最新 **image** 条目的 `created_at`，不是组更新时间；
  因此组内插入文字不会延长截图窗口。
- 窗口默认 45 秒，可在 5–600 秒配置；比较使用 `≤`。
- 组内条数上限 300；达到后下一张截图 `Create` 新组。
- 无收集组时，第一张截图 `Create`；第一段文字不会凭空建组。
- 应用重启后不会恢复 `collecting` 组：启动清理会关闭最后截图早于窗口的组，
  之后的截图开新组（不跨重启续接）。
- 手动“结束收集”将状态置为 `closed`，后续截图开新组。

## 三、组内顺序

- `clipboard_group_items.position` 从 0 递增；`append_group_item` 取
  `MAX(position)+1`，因此“截图 A → 文字 → 截图 B”得到 A、文字、B 的实际顺序。
- 自动追加 `origin='auto'`，手动加入/拆分/合并 `origin='manual'`；
  来源仅用于审计，不参与排序。
- 同一分组不允许重复条目（复合主键 + `INSERT OR IGNORE`）。
- 重排：`move_group_item` 在事务中读取完整顺序、移除目标、按 `new_index`
  插入（clamp 到 `[0, len]`）、整体重写 position，避免中间态冲突。
- 拆分：按源组当前顺序筛选选中项，保持相对顺序写入新组（`manual`/`closed`），
  再从源组移除；源组为空时自动删除并清理分组任务关联。
- 合并：按用户选择分组的顺序依次追加，跨组重复条目只保留第一次出现；
  新组为 `manual`/`closed`，源分组保留（不自动删除）。

## 四、自动组生命周期

```
第一张截图
  → close_all_collecting()
  → create_group("截图组 N", mode=auto, status=collecting)
  → append(image)

窗口内：截图 / 文字 / HTML / URL
  → append(..., origin=auto)，position 递增

窗口过期后的下一张截图
  → 先关闭旧组（closed_at/updated_at）
  → 新建下一组

窗口过期后的文字
  → 不新建组；若存在残留 collecting 组则关闭

手动结束 / 后台清理 / 应用重启
  → status=closed
```

组命名序号存放在 `application_settings.clipboard_group_seq`，事务内自增，
删除组不会回退序号（避免重名歧义）。

## 五、手动整理能力

| 操作 | 命令 | 行为 |
|---|---|---|
| 新建手动分组 | `clipboard_create_group` | 选中的有效条目按选择顺序加入；新组 `manual`/`closed`；无有效条目报错 |
| 重命名 | `clipboard_rename_group` | 去空白，空则“未命名分组”，≤80 字符 |
| 结束收集 | `clipboard_close_group` | 只对 `collecting` 生效 |
| 收藏/置顶 | `clipboard_toggle_group` | 自动清理不触碰 |
| 组内上移/下移 | `clipboard_move_group_item` | 前端换算 `newIndex`，后端 clamp |
| 移除条目 | `clipboard_remove_group_item` | 只删关系，不删内容 |
| 拆分 | `clipboard_split_group` | 选中项移到新组；源组可被清空删除 |
| 合并 | `clipboard_merge_groups` | 至少两个组；按选择顺序；去重 |
| 删除分组 | `clipboard_delete_group` | 默认保留内容；可显式连带删除未共享/未保护条目 |
| 添加到组 | `clipboard_add_to_group` | 只追加有效且未在组内的条目 |

所有破坏性操作在前端二次确认；删除分组默认“保留条目”，并在确认框中说明。

## 六、测试覆盖

| 测试 | 验证点 |
|---|---|
| `engine::grouping_window_and_interleaving` | 首图建组、窗口内图片/文字追加、超窗图片新建、超窗文字不建组、文件不参与、关闭开关不动作、达到 300 条新建 |
| `store::interleaved_text_keeps_screenshot_group_order` | 真实入库后组内顺序为图→文→图，`position` 正确 |
| `store::separate_sessions_create_new_group_after_window` | 超窗后新组、旧组 closed |
| `store::reorder_remove_and_split_persist` | 重排/移除/拆分落库并可读回 |
| `store::group_deletion_is_reference_safe` | 删除分组保留共享条目，连带删除只清未保护项 |
| `store::records_text_and_dedupes_without_new_row` | 去重不新建行、计数/时间更新 |
| `store::html_is_sanitized_before_storage` | 入库前清洗主动内容 |

边界与已知限制：

- 自动组只由截图触发；纯文字连续复制不会自动成组（设计如此）。
- 自动组不跨重启续接；重启后的第一张截图开新组。
- 文件列表永远不进入自动组，但可手动加入任意分组。
- 组内条目上限只约束自动追加；手动加入不受 300 限制（仍受历史总量约束）。
- 分组决策发生在采集过滤之后的 worker 入库阶段：被敏感过滤跳过、采集类型关闭、
  队列丢弃的复制不会参与分组；自动组只包含真正入库的截图。
- 分组顺序以入库顺序为准；事件队列合并只保留最新序列号，极端高频下中间截图可能
  不入库（计数可见），因此组内顺序不会颠倒，但可能缺少未捕获的项。
