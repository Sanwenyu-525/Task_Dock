# 候选包构建与载荷一致性校验

## 1. 起因与结论更正

2026-11-24 候选包 `tmp/release-candidate/20261124-1958` 验收时发现 NSIS 载荷 `D2D948D4…`、MSI 载荷 `37CEE140…`、`target-integration/release/task-dock.exe` `93225713…` 三个哈希不同，当时判断为并行构建覆盖了共享 `CARGO_TARGET_DIR`（P1）。

用独立 target 目录重新构建（`tmp/release-candidate/20261124-204524`）后复核，**该判断不成立**：

- 构建日志明确有 `Patching …\release\task-dock.exe with bundle type information: nsis`，随后 `…: msi`；
- 把 MSI 管理安装解包出的 `task-dock.exe` 与构建结束时的 `release\task-dock.exe` 逐字节比较：43,452,416 字节完全相同，**只有 3 字节不同**，位置在 `.rdata` 的 `__TAURI_BUNDLE_TYPE_VAR_` 标记之后：
  - 构建结束时：`…_VAR_UNK.svgb…`
  - MSI 载荷：`…_VAR_MSI.svgb…`
- 其余 PE 段（`.text`、`.data`、`.pdata`、`.reloc`、`.rsrc`）哈希完全一致。

即：Tauri 在每次打包前把该 3 字节改成对应 bundle 类型，打包结束后磁盘上的 exe 恢复为 `UNK`。**安装包内嵌的 exe 与磁盘上的 exe 必然不同，NSIS 与 MSI 之间也必然不同**，直接比完整 SHA256 会稳定产生假阳性。

因此 `20261124-1958` 的「三份不同二进制」不再作为打包缺陷证据；由于当时 NSIS 载荷文件已被卸载删除，无法回溯证明那一次构建是否真的被覆盖，只能确认：**当时的结论依据（哈希不同）不成立**。

## 2. 仍然保留的构建纪律

并行构建确实可能覆盖共享 target，且 `tauri:raw` 会绕过 `pretauri` 的 build-guard 预检，所以候选包改用独立目录与互斥锁：

`scripts/build-candidate.mjs`（`npm run build:candidate`）：

1. **独立 target 目录**：默认 `src-tauri/target-candidate-<yyyyMMdd-HHmmss>`，不与 `target-integration` 共享；可用 `--target-dir` 指定。
2. **构建互斥锁**：仓库根 `.build-candidate.lock`（已加入 `.gitignore`），`wx` 独占创建，退出时释放；冲突即失败并打印占用信息。
3. **先跑磁盘预检**：调用 `scripts/build-guard.mjs precheck`，失败不构建。
4. **记录二进制事实**：写 `binary.json`（size、完整 SHA256、归零 bundle 标记后的指纹、bundle 类型）、`binary.sha256`、`BUILD_INFO.md`。
5. **载荷校验**：安装包复制进候选目录后解包比对：
   - MSI：`msiexec /a <msi> /qn TARGETDIR=...`（无副作用，总是执行）；
   - NSIS：有 7-Zip 时 `7z x`；没有 7-Zip 时默认跳过并标注 `skipped`。`--nsis-install-extract` 可改用静默安装解包，但会写注册表/快捷方式，且**检测到本机已安装 Task Dock 时自动拒绝**，除非再加 `--force-nsis-install`（仅限干净机器/CI）。

## 3. 判定规则

- **指纹**：把 `__TAURI_BUNDLE_TYPE_VAR_` 之后的 4 字节归零后再算 SHA256（兼容 `UNK` / `NSI` / `NSIS` / `MSI` 写法），其余字节全部参与哈希。
- 两个载荷都解包：指纹必须相同，且与构建产物的指纹相同 → `complete`；
- 只解包一个：与该产物指纹相同 → 部分完成（退出码 0，明确标注未覆盖 NSIS）；
- 指纹不同、大小不同、或安装包 SHA256 与 `SHA256SUMS.txt` 不符 → 退出码 **2**，该目录不得作为候选包验收。

`npm run verify:candidate -- --dir <目录>` 对已有目录重跑同一套校验，输出 `payload-check.json`；`--file <exe> --out <json>` 可单独为已有构建产物生成 `binary.json`。

## 4. 实测证据（20261124-204524）

命令：`npm run build:candidate`（独立 target `src-tauri/target-candidate-20261124-204524`），`npm run verify:candidate -- --dir tmp\release-candidate\20261124-204524`。

| 产物 | 字节 | 完整 SHA256 | 指纹（归零 bundle 标记） |
|---|---|---|---|
| `release\task-dock.exe`（构建结束时） | 43,452,416 | `35D11033…B617B963` | `99959B8B…B0462ED` |
| MSI 载荷（`msiexec /a`） | 43,452,416 | `9C780819…97E0AD8F` | `99959B8B…B0462ED` |

- `payload-check.json`：`ok=true`、`complete=false`（NSIS 跳过，缺 7-Zip 且本机已有安装）。
- NSIS 未直接解包；但 `installer.nsi` 的 `MAINBINARYSRCPATH` 指向同一 `release\task-dock.exe`，且日志显示 makensis 在 msi 补丁之前执行，按同一机制推断其载荷仅 bundle 标记不同。

## 5. 限制

- 没有 7-Zip 的机器无法零副作用解包 NSIS，默认校验只覆盖 MSI；要完整覆盖需装 7-Zip 或在干净机器上用安装方式解包。
- 正式 Release 仍走 `npm run integrate -- build --snapshot <快照>` 与共享 `target-integration`；并发由集成台账与构建锁约束，不走本脚本。
- `20261124-1958` 与 `20261124-204524` 都是候选包（dirty 工作区、未签名），不能用于 `integrate accept`。
