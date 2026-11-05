# 05 · 自动分组引擎

> 代码位置：`src-tauri/src/clipboard/engine.rs`（`decide_group` / `compatible` /
> `candidate_joins` 纯函数）、`src-tauri/src/clipboard/store.rs`（`record_capture`、
> 候选持久化、会话解析、手动整理）
> 单测：`engine.rs::tests`、`store.rs::tests` 的分组/候选/去重/上限/重启用例
>
> **2026-11-05 更正**：“连续截图自动分组”已升级为“智能连续收集”。本文第一～四节描述
> 当前契约；第五节保留旧版规则与历史更正，供追溯，不再作为实现依据。

## 一、当前规则（智能连续收集，2026-11-05）

### 1.1 内容家族

| 家族 | 命中类型 | 说明 |
|---|---|---|
| 图片 | `image` | 截图/图片流，可与文字、链接按实际顺序混排 |
| 文本 | `text`、`html` | 纯文本与富文本视为同一家族（富文本常带纯文本回退） |
| 链接 | `url` | 仅纯 URL 文本（`http(s)://` 且无空白/引号/尖括号，≤4096 字符） |
| 文件 | `files` | 文件列表独立收集，不与图片/文本混合 |

分类顺序：文件 > 图片 > 纯 URL > 富文本 > 纯文本（`engine::classify`）。

### 1.2 候选机制：首条只作候选

单条复制不会立即建组。第一条内容只写入候选（`application_settings` 的
`clipboard_group_candidate`，仅含 item id / 家族 / 时间 / 来源 / 来源是否已知），
**第二条兼容内容到来时才成立正式分组**，候选条目与当前条目一起入组。

- 候选不持有正文或图片字节，只存轻量元数据。
- 候选带启动代次（boot id）；应用重启后旧候选失效，不会跨重启成组。
- 候选被手动分组、删除、并入其它组后不再参与晋升；由 `item_grouped` 复核，
  避免“候选已被手动收走还继续建自动组”。
- 候选与当前条目不兼容时，当前条目替换为新候选（旧候选丢弃，不建组）。

### 1.3 决策表

`engine::decide_group(kind, auto_group, now, window_secs, session, candidate,
item_source_app, item_source_known)`

| 条件 | 动作 | 落库行为 |
|---|---|---|
| 自动分组关闭 | `None` | 不入组 |
| 存在收集会话，条数 < `MAX_AUTO_GROUP_ITEMS`，`now - last_at ≤ 窗口`，且家族/来源兼容 | `Append` | 追加到现有会话，`position` 递增 |
| 会话不可追加（过期/已满/不兼容），候选存在且窗口内兼容 | `CreateWithCandidate` | 先关闭所有 `collecting` 组，再用候选 + 当前条目建新组 |
| 会话不可追加，无可晋升候选 | `Candidate` | 当前条目成为新候选；若会话已过期/已满则顺手关闭 |
| 无会话，候选窗口内兼容 | `CreateWithCandidate` | 候选 + 当前条目建组 |
| 无会话，无兼容候选 | `Candidate` | 当前条目成为候选 |

补充：

- 窗口默认 45 秒，可在 5–600 秒配置；比较使用 `≤`（边界秒内仍算同一次收集）。
- `last_at` 取组内最后一条任意类型内容的时间；组内插入文字同样刷新会话窗口。
- 会话不存在时不会凭单条内容建组；只有“候选 + 兼容的第二条”才建组。
- 关闭开关不会清理已有分组，只是停止新的收集动作。
- 每条结论都由纯函数给出；SQLite、系统时钟、UI 状态不进入决策函数。

### 1.4 兼容性判定（避免误分组）

`engine::compatible` 按会话当前内容判断：

| 会话现状 | 当前条目 | 允许并入的条件 |
|---|---|---|
| 任意（含文件会话） | 文件 | 双方都是文件家族，且双方来源**均已知且相同** |
| 文件会话 | 图片/文本/链接 | 不允许（文件流不混入其它类型） |
| 已含图片的会话 | 图片 | 与组内**最后一张图片**来源均已知且相同 |
| 已含图片的会话 | 文本/链接 | 允许：保留“截图 A → 文字说明 → 截图 B”的真实顺序 |
| 不含图片的文本/链接会话 | 图片 | 双方来源均已知且相同 |
| 不含图片的文本/链接会话 | 文本/链接/HTML | 双方来源均已知且相同 |

原则：

- “连续发生”不等于“同一工作会话”：必须落在同一时间窗内，且家族/来源兼容。
- 来源未知一律保守：除“截图流内夹杂文字/链接”这一已验证工作流外，来源未知不并组。
- 不同来源的混合需要额外依据（同已知来源）；不做相似度、AI 猜测或 OCR。
- 单次复制多个文件仍是一条 `files` 条目，不因文件数量自动拆组；连续多次文件复制
  才可能形成文件收集组。
- 图片数量与消息数量都有上限，达到上限的会话在下一条内容到来时关闭并重新开始。

### 1.5 会话与组生命周期

```
第一条内容
  → Candidate（不建组）

窗口内第二条兼容内容
  → close_all_collecting()
  → create_group("<家族>组 N", mode=auto, status=collecting)
  → append(candidate) → append(current)

窗口内：同类/兼容内容
  → append(..., origin=auto)，position 递增

窗口过期 / 组内达到 MAX_AUTO_GROUP_ITEMS 后的下一条
  → 先关闭旧会话；旧组状态 closed
  → 当前条目成为新候选（或与候选直接成组）

手动结束收集
  → status=closed；后续内容重新走候选流程

应用重启
  → 旧候选失效；启动清理关闭超窗的 collecting 组；不跨重启续接
```

`close_all_collecting` 保证同一时刻最多一个开放收集会话；候选回退逻辑允许另一个应用
在已有会话进行中先落候选，等第二条同源内容到来时另起新组，不被当前会话挡住。

组命名序号存放在 `application_settings.clipboard_group_seq`，事务内自增；删除组
不回退序号（避免重名歧义）。

## 二、组内顺序

- `clipboard_group_items.position` 从 0 递增；`append_group_item` 取
  `MAX(position)+1`，因此“截图 A → 文字 → 截图 B”得到 A、文字、B 的实际顺序。
- 自动追加 `origin='auto'`，手动加入/拆分/合并 `origin='manual'`；
  来源仅用于审计，不参与排序。
- 同一分组不允许重复条目（复合主键 + `INSERT OR IGNORE`）。
- 重排：`move_group_item` 在事务中读取完整顺序、移除目标、按 `new_index`
  插入（clamp 到 `[0, len]`），整体重写 position，避免中间态冲突。
- 拆分：按源组当前顺序筛选选中项，保持相对顺序写入新组（`manual`/`closed`），
  再从源组移除；源组为空时自动删除并清理分组任务关联。
- 合并：按用户选择分组的顺序依次追加，跨组重复条目只保留第一次出现；
  新组为 `manual`/`closed`，源分组保留（不自动删除）。

## 三、列表契约（`kind_counts` / `cover_items`）

分组列表与详情 IPC 在返回分组时补充两个派生字段（不落库、不改变表结构）：

- `kind_counts`：`{ image, text, html, url, files }`，按组内条目类型批量统计；
  `text` 与 `html` 分列，前端展示时合并为“段文本”。
- `cover_items`：最多 3 条**图片条目**的轻量元数据（不含正文/原图字节），
  按组内 `position` 升序；仅图片类型，非图片组为空数组。

实现由 `store::enrich_groups` 用两次批量查询完成（类型计数一次、封面窗口函数一次），
不产生 N+1 查询；列表接口不返回分组明细 `items`，明细仍由 `clipboard_group` 提供。

前端对旧数据/旧备份做回退：缺少 `kind_counts` 时用 `item_count` 与 `image_count`
推导“图片数 + 文本数”，缺少 `cover_items` 时显示统一占位，不凭空猜文件/链接数量。

## 四、手动整理能力

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

手动分组与自动收集互斥：条目被手动分入任意组后，候选晋升会复核归属并停止，
不会把已有归属的条目再拉进自动组。

## 五、旧版规则（2026-11-05 前，仅作追溯）

> 以下为升级前“连续截图自动分组”的实现描述，保留用于对照；当前实现以上文为准。

- 旧决策函数签名只有“截图时间 + 组内条数 + 截图来源”，文字/HTML/URL 只能追加到
  **已存在**的截图会话；纯文字连续复制永远不成组，文件永不参与。
- 旧版第一条截图会直接建组（无候选阶段）。
- 旧版文件与文本不会形成独立收集组；组内上限 300，仅约束自动追加。
- 2026-11-03 旧更正：“跨来源文本不并入截图组”曾破坏“截图→文字说明→截图”的真实顺序，
  已回退；新版继续允许截图流内夹杂任意来源的文字/链接。

## 六、测试覆盖（2026-11-05）

| 测试 | 验证点 |
|---|---|
| `engine::grouping_window_and_interleaving` | 窗口边界、图片/文字追加、超窗新建、文件不参与、关闭开关 |
| `engine::candidate_can_start_group_while_another_session_collects` | 已有会话不阻断另一应用的候选晋升；来源未知候选保持保守；不同来源图片另起组；与 `store::*` 候选用例共同覆盖“首条只作候选、第二条才成组” |
| `engine::auto_title_rules_per_kind` | 文字/长文/URL/HTML/代码/图片/文件的标题规则、≤30 字符上限 |
| `store::consecutive_text_link_and_file_copies_collect_by_type` | 连续文本/链接/文件各自成组，类型计数与封面正确 |
| `store::single_multi_file_copy_only_becomes_candidate` | 单次复制多个文件仍是一条条目，且只作候选 |
| `store::unknown_source_text_copies_stay_ungrouped` | 来源未知的连续文本不误分组 |
| `store::manual_grouping_clears_candidate_promotion` | 手动分组后候选不再晋升 |
| `store::manual_close_starts_a_new_collection_session` | 手动结束后重新走候选流程 |
| `store::other_app_collection_is_not_blocked_by_open_session` | 另一应用连续复制不被现有会话挡住 |
| `store::auto_group_stops_at_item_limit_and_restarts` | 达到组内上限后下一条关闭旧会话并新起候选 |
| `store::duplicate_capture_keeps_candidate_and_creates_no_group` | 同内容重复复制遵守去重，候选保留、不建组 |
| `store::candidate_from_previous_boot_is_not_reused` | 跨启动候选失效 |
| `store::auto_title_covers_image_and_files_kinds` | 图片标题含尺寸、文件标题含首名与数量 |
| `store::interleaved_text_keeps_screenshot_group_order` | 图→文→图的实际顺序与 position |
| `store::separate_sessions_create_new_group_after_window` | 超窗新组、旧组 closed |
| `store::reorder_remove_and_split_persist` | 重排/移除/拆分落库并可读回 |
| `store::group_deletion_is_reference_safe` | 删除分组保留共享条目，连带删除只清未保护项 |
| `store::records_text_and_dedupes_without_new_row` | 去重不新建行、计数/时间更新 |
| `store::html_is_sanitized_before_storage` | 入库前清洗主动内容 |

边界与已知限制：

- 自动组只包含真正入库的内容；被敏感过滤、类型关闭、队列丢弃的复制不参与分组。
- 分组顺序以入库顺序为准；极端高频下中间内容可能不入库（计数可见），但顺序不颠倒。
- 组内数量上限只约束自动收集；手动加入不受该上限限制（仍受历史总量约束）。
- 不做内容相似度、AI 推断、OCR 或网络元数据抓取；“相关”仅由时间、来源、类型决定。
- 来源未知时保守不并组，因此来源识别失败的连续复制可能保持为单条/候选。
- 自动组不跨重启续接；重启后的第一条内容重新成为候选。
