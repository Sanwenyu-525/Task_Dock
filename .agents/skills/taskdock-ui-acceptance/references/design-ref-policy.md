# 设计参考图与动态验收产物的边界

## 分类规则（A/B/C/D）

| 分类 | 定义 | 是否可作为强制视觉基准 | 存放/索引 |
|---|---|---|---|
| A 正式基准 | 仓库内有明确批准依据：设计文档写明“最终效果图/视觉基准”，或用户在本任务中明确确认 | 可以 | `assets/design-refs/{module}/` + `manifest.json`（`status=approved`） |
| B 候选 | 有设计参考价值，但未见最终确认，或属于多方案对比板 | 不可以 | 只登记 `assets/design-refs/candidates.json`，不复制图片、不标 approved |
| C 真实验收证据 | 真实运行截图、历史验收产物、DWM/原生合成截图 | 不可以 | 留在 `docs/screenshots/`、`tmp/acceptance/...` 等原目录 |
| D 其余 | 临时实验、过期方案、重复图、品牌图标、用途不明 | 不可以 | 不导入；用途不明的记“待确认” |

判断依据必须落到具体文件（哪个文档哪一节、哪次确认）；无法确定的宁可保留为 B 候选。不得因文件名含“效果图”就自动标 approved。

## 2026-11-03 分类结果

### A 正式基准（5 张，已导入）

| 源文件 | 批准依据 |
|---|---|
| `docs/design-refs/v07/停靠效果图/01-tasks.png` | `src/styles.css` 第 6345 行明确写“视觉基准：`docs/design-refs/v07/停靠效果图/01..04`”；`docs/ui-themes/13-capsule-redesign.md` 以四图为分类胶囊规格与负空间依据 |
| `docs/design-refs/v07/停靠效果图/02-agents.png` | 同上 |
| `docs/design-refs/v07/停靠效果图/03-clipboard.png` | 同上 |
| `docs/design-refs/v07/停靠效果图/04-apps.png` | 同上 |
| `docs/design-refs/v07/任务卡效果图/d24e75d6-9d39-47e4-8a93-64dcf57c1149.png` | `docs/ui-themes/01-design-spec.md` 第 12 节明确采用“任务卡效果图方案 D”，并声明本节取代旧任务卡规范 |

### B 候选（7 张，仅索引，不复制）

| 源文件 | 保留为候选的原因 |
|---|---|
| `docs/design-refs/v07/通知效果图/task_dock_notification_preview_light.png` | `src/notifications/styles-notifications.css` 第 6 行仅称 HTML 原型为“视觉来源”，未写“视觉基准”；且是 HTML 原型截图，不是原生运行证据 |
| `docs/design-refs/v07/通知效果图/task_dock_notification_preview_stack.png` | 同上；堆叠态同样未获最终确认 |
| `docs/design-refs/v07/规划中心效果图.png` | `docs/roadmap/planning-center.md` 未指定其为最终效果图；README 仅称 v07 为“设计输入稿”；该图包含多个视图，未见逐视图确认 |
| `docs/design-refs/v07/3D效果图/3D效果图.png` | v0.6 主题/材质/3D 层多方案探索板，未见最终批准语句 |
| `docs/design-refs/v07/capsule-design-options-20261101.png` | 胶囊方案 A–G 对比板；最终实现为“分类胶囊 + 液态融合翼片”，文档未指定某单一方案为最终效果图 |
| `docs/design-refs/v07/液态玻璃效果图-v07.png` | 主面板液态玻璃效果图；用户仅要求“保存为设计参考”，未说批准为视觉基准，故登记候选 |
| `docs/design-refs/v07/液态玻璃效果图-绝对透明版-v07.png` | 同布局的“绝对透明版”，玻璃更通透、背景可见度更高；与上一张并列保留，同样未获批准，仅作透明强度的方向参考 |

> 2026-11-03 补充：原导入的 `d1e75e77…` 版本已按用户改口撤回（删除图片并移除候选条目），只保留上述两张新图；撤回不影响其他既有参考图。

### D 其余（1 张，不导入）

| 源文件 | 原因 |
|---|---|
| `docs/design-refs/v07/任务卡效果图/de6830da-6c9e-4d8d-912c-1364336405bd.png` | 旧任务卡单面板方案，已被 `01-design-spec.md` 第 12 节的“方案 D”取代，属于过期方案 |

### C 真实验收证据（留在原目录）

- `docs/screenshots/`：历史真机/原生合成验收截图，含 v07 明暗、窄窗、弹层、DWM 区域对照。
- `tmp/acceptance/`、`tmp/{context-menu-liquid-glass,ui-layout-refinement,3dpolish-run,agent,ui-polish-round2}/`：任务验收与调试产物。
- 这些文件可按需作为历史对照，但不能登记为设计基准，也不能替代本轮真机证据。

## 缺失与断链的基准引用
- `docs/ui-themes/01-design-spec.md` 与 `07-visual-acceptance.md` 声称视觉第一依据是 `docs/ui-themes/images/` 两张效果图，但该目录在仓库中不存在。
- `docs/ui-themes/13-capsule-redesign.md`（第 89、108 行）与 `src/lib/capsuleShape.ts` 引用 `停靠效果图.png`（规格图），但仓库中只有 `停靠效果图/01..04`，没有该单图。
- 这两项只能记为“引用断链/基准缺失”，不得用现有候选图冒充。

## 基准管理约束

1. 正式清单唯一权威：`assets/design-refs/manifest.json`；候选唯一权威：`assets/design-refs/candidates.json`。不得在 `docs/design-refs/` 与 Skill 内维护两套并行基准。
2. 导入只复制，不移动、不删除源文件；`manifest.json` 同时记录 `source` 与 `sha256`，用于去重、迁移和漂移检测。
3. 同一组件同一主题/状态只保留一个 approved ID；旧版必须显式标记 historical 或移出清单，不能靠文件名排序猜最新版。
4. 导入/登记必须幂等：重复执行相同命令返回 `ALREADY_IMPORTED` / `ALREADY_REGISTERED`，不重复创建、不覆盖已有文件。
5. 候选提升为正式基准必须有新的批准依据；不得只改 `status`，必须重新走导入流程并写清 `spec` / `uncovered`。
6. 设计图元数据字段至少覆盖：唯一 ID、组件、模块、资源路径、来源路径、浅/深主题、UI 状态、哈希、是否正式基准、对应规范说明、未覆盖场景。

## 命令

```powershell
# 校验（strict 会额外要求 module/spec/uncovered 与模块目录一致）
python .agents/skills/taskdock-ui-acceptance/scripts/verify_design_refs.py --repo . --strict --require-approved

# 正式基准：先预览，确认批准依据后加 --approved --apply
python .agents/skills/taskdock-ui-acceptance/scripts/import_design_reference.py --repo . `
  --source "docs/design-refs/v07/停靠效果图/01-tasks.png" `
  --id capsule-dock-tasks-v07 --module dock --component capsule-dock `
  --state expanded-tasks --theme light --note "批准依据" `
  --spec "docs/ui-themes/13-capsule-redesign.md" --uncovered "深色/四边/DPI/原生合成"

# 候选：只登记，不复制，不标 approved
python .agents/skills/taskdock-ui-acceptance/scripts/import_design_reference.py --repo . `
  --source "docs/design-refs/v07/规划中心效果图.png" `
  --id planning-center-views-v07 --module planning --component planning-center `
  --state multi-view-overview --theme light --note "未获最终确认，候选" `
  --spec "docs/roadmap/planning-center.md" --uncovered "深色/交互/窄窗" --candidate --apply
```

若 `docs/design-refs/` 中只有历史调试截图或用途不明图片，继续视为 C/D，**不要导入**。
