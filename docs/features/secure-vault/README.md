# 安全保险箱（Secure Vault）

> Task Dock 的**个人敏感信息保险箱**：保存"不常用但不能忘"的账号、密钥、许可证、恢复码与私密资料。
> 它不是笔记、不是任务、不是普通密码管理器的皮肤——它有**独立的安全边界**。

- 阶段：**P1 本地 MVP 代码完成（P1 Gate 未通过，待真机验收；集成任务 `secure-vault-p1` 为待集成，快照受基线漂移阻断，交付提交见集成台账）**
- 日期：2026-11-18
- 代码状态：Rust 独立库 + 桌面工作台 UI 已实现；移动端/同步未开始
- 目录：`docs/features/secure-vault/`

---

## 1. 四类信息的分工

| 模块 | 保存什么 | 典型内容 | 安全边界 |
|---|---|---|---|
| 知识库 | 知识、资料、经验 | 文档、摘录、教程 | 普通库，可被搜索/导出/Agent 读 |
| 任务系统 | 要做的事 | 待办、项目、截止日 | 普通库 |
| 生活记录 | 买过什么、发生过什么 | 订单、票据、日常 | 普通库 |
| **安全保险箱** | **不能忘的敏感凭据** | 密码、API Key、许可证、恢复码、设备凭据、私密备忘 | **独立库 + 独立密钥 + 默认拒绝外部访问** |

**判断标准**：如果这条信息泄露会让"某个账号被登入、某个服务被调用、某台设备被控制"，
它就该进保险箱，而不是笔记。

---

## 2. 当前状态（诚实表）

| 项 | 状态 |
|---|---|
| 现状调研（读代码、追调用链） | ✅ 完成，见 [current-architecture-analysis.md](current-architecture-analysis.md) |
| 产品需求与功能矩阵（25 项） | ✅ 完成 |
| 威胁模型（15 类攻击 + 22 条剩余风险） | ✅ 完成 |
| 安全架构（算法/密钥层级/锁定/隔离） | ✅ 完成 |
| 数据模型（实体/字段/DDL） | ✅ 完成 |
| 方法级接口（签名/错误码/调用链） | ✅ 完成 |
| 桌面端 + 移动端交互 | ✅ 完成（移动端为 P2 规划） |
| 备份格式与恢复流程 | ✅ 完成 |
| 多设备同步架构 | ✅ 完成（**仅架构，不实现**） |
| 测试与验收计划 | ✅ 完成（**用例未执行**） |
| 开发路线图 P0–P3 | ✅ 完成 |
| 依赖新增（6 个 crate） | ✅ 已批准并接入（P-01 方案 A） |
| P1 后端（加密库/命令/备份） | ✅ 已实现，`cargo check` exit 0 |
| P1 前端（工作台面板） | ✅ 已实现，`npm run build`（tsc + vite）exit 0；1280/400 视觉走查通过 |
| P1 自动化测试 | ✅ 23 项 Rust 单测 + 1 项前端 store 测试通过；KDF 基准已跑；真机、320 窄窗与其余视觉项未执行 |
| P1 发布门 | ❌ 未通过（证据不足，12 条 Gate 详见 test-and-acceptance §13） |
| 移动端改动 | ❌ 未开始（P2） |
| 实测性能数字 | ❌ 无（文档中所有阈值都是"目标"，不是实测） |

> 已实现 ≠ 已验收：真机锁屏/休眠/剪贴板、320 窄窗、其余视觉主题与 1000 条性能仍未执行，报告中保留 `unverified`。

---

## 3. 文档导航

| 文档 | 回答什么问题 | 读者 |
|---|---|---|
| [product-requirements.md](product-requirements.md) | 为什么做、给谁做、做哪些、不做哪些、每项怎么用/怎么存/怎么测 | 产品、开发 |
| [current-architecture-analysis.md](current-architecture-analysis.md) | 现有项目长什么样、能复用什么、哪里挡路、F-01..F-08 八条硬结论 | 开发、架构 |
| [threat-model.md](threat-model.md) | 谁会怎么攻击、我们怎么防、防不住什么（T-01..T-15 / R-01..R-22） | 安全、评审 |
| [security-architecture.md](security-architecture.md) | 用什么算法、密钥怎么分层、怎么锁定、怎么隔离 Agent | 开发、安全 |
| [data-model.md](data-model.md) | 有哪些表/字段、哪些必须加密、明文白名单、DDL | 开发、DBA |
| [api-and-method-design.md](api-and-method-design.md) | 每个方法的签名/参数/返回/错误/前置后置/并发/测试 | 开发 |
| [desktop-mobile-ux.md](desktop-mobile-ux.md) | 16 个桌面页面、移动端页面、状态机、窄窗与无障碍 | 设计、开发 |
| [backup-and-recovery.md](backup-and-recovery.md) | `.tdvault` 格式、导出/导入状态机、失败处理、版本兼容 | 开发、支持 |
| [multi-device-sync.md](multi-device-sync.md) | 设备授权、DEK 信封、撤销与轮换、中继可见性 | 架构（P2） |
| [test-and-acceptance.md](test-and-acceptance.md) | 14 组用例、阻断项、P1 Gate、证据规范 | 测试、验收 |
| [implementation-roadmap.md](implementation-roadmap.md) | P0–P3 工作包、依赖、顺序、里程碑 | 项目 |
| [decision-log.md](decision-log.md) | 13 条已定决策 + 8 条待你拍板 + 8 个未解技术问题 | 所有人 |

**建议阅读顺序**：README → product-requirements → current-architecture-analysis →
threat-model → security-architecture →（开发再看 data-model / api）→ decision-log。

---

## 4. 十条核心结论（先看这个）

1. **必须独立库**：主库所有表被强制登记备份（`backup.rs:4742` 测试会 panic），CLI 无令牌等同 UI
   权限（`agent_access/permissions.rs:43-46`），全局搜索直接持主库读连接。放主库 = 迟早被带走。
2. **记录级 AEAD，而不是"整库加密"**：AES-256-GCM + 每载荷独立 HKDF 子密钥 + AAD 绑定
   `id/purpose/版本`。库文件里只有密文与不透明 id。
3. **密钥三层**：主密码 →（Argon2id）→ KEK → 解封装 DEK →（HKDF 子密钥）→ 加密记录。
   改主密码只重封装 DEK，**不重加密记录**。
4. **恢复密钥独立**：20 字节 CSPRNG（160-bit），HKDF 派生 KEK，解**同一个** DEK；
   与主密码是两条路径，互不替代。
5. **两级载荷**：`meta_blob`（解锁即解密，供列表/搜索）+ `secret_blob`（按需解密）。
   内存里不长期持有全部密码。
6. **锁定在后端**：闲置 5 分钟 / 后台 60 秒（可配）；锁屏、休眠、窗口隐藏、退出**强制立即**。
   前端定时器不可靠，不作为安全机制。
7. **剪贴板受控**：只在用户点击时写；30 秒清除；清除前比对指纹，**绝不删用户后来复制的内容**；
   明确告知系统剪贴板历史可能留副本。
8. **Agent/MCP/CLI 结构性不可达**：不加能力位、不注册工具、不加 CLI 子命令、不加 REST 端点、
   不进全局搜索。不是"约定不要读"，而是"没有通道"。
9. **备份是独立格式**：`.tdvault` 用独立 `file_key` + 独立口令；P1 只支持空库导入为新保险箱，
   不覆盖/合并已有库（staging + 原子替换 + `.pre-restore` 属 P2）。
   **默认没有明文导出**；备份文件不得写入 `<数据目录>/backups/`（会被主备份保留策略删掉）。
10. **诚实边界**：设备被管理员级恶意软件控制、屏幕录制、用户主动外发、系统剪贴板历史——
    这些**防不住**。文档与 UI 都要写清楚，不吹"绝对安全"。

---

## 5. 技术栈落点

| 层 | 现有 | 保险箱新增 |
|---|---|---|
| 桌面壳 | Tauri 2 + Rust 1.85（`src-tauri/`） | `secure_vault/` 模块 + `commands/secure_vault.rs` |
| 前端 | React 19 + TS + Vite + Zustand | `components/vault/`、`lib/vault.ts`、`store/useVaultStore.ts` |
| 数据库 | SQLite（rusqlite bundled），单写多读 + WAL | 独立 `secure-vault.db`（**不复用** `db::MIGRATIONS`） |
| 移动端 | Expo / RN（Android），expo-sqlite / SecureStore | P2：JCA + Keystore 原生模块 |
| 传输 | 局域网 TLS + SPKI 固定 | P2 复用传输，**不复用其密钥派生** |
| 诊断 | 单写线程 + 有界队列 + 闭集白名单 | 新增 6 个 metadata key，禁止记录 id/标题/搜索词 |

---

## 6. 与现有功能的职责边界

| 功能 | 边界 |
|---|---|
| 笔记 / 知识库 | **不互相引用**。保险箱不提供"插入到笔记"；笔记不提供"存到保险箱" |
| 任务 | 任务标题里不允许出现密码；保险箱不创建任务（P3 的到期提醒只做本地提示） |
| 生活记录 | 订单号可以进生活记录；**支付密码/卡号 CVV 只能进保险箱** |
| 全局搜索 | 只搜主库；**永不**返回保险箱内容；保险箱内有独立搜索 |
| 主备份 | 不包含保险箱（按表枚举，不遍历目录）；保险箱有自己的 `.tdvault` |
| Agent / MCP | 默认拒绝；P3 才评估"用户当场授权的短时租约" |
| 剪贴板 | 复用同一平台层，但保险箱走**专用命令**（受控写入 + 指纹 + 定时清除） |

---

## 7. 本阶段明确没做的事

- 没有写任何 Rust / TS 业务代码（`src-tauri/src/secure_vault/` 不存在）
- 没有改任何数据库结构或迁移（主库 `MIGRATIONS` 未动）
- 没有安装任何新依赖（`Cargo.toml` 未动）
- 没有改 `featureCatalog.ts` / 契约测试（它们正被其他会话修改）
- 没有跑任何性能基准（文档里的 1.2 s / 2.5 s 是**目标**）
- 没有做真机锁屏/休眠/剪贴板历史验证（P1 才做）
- 没有开始 P1，也没有"顺手"实现任何 UI

---

## 8. 术语

| 术语 | 含义 |
|---|---|
| DEK | Data Encryption Key，32 字节随机，真正加密记录的钥匙 |
| KEK | Key Encryption Key，用来封装/解封 DEK 的钥匙（由主密码或恢复密钥派生） |
| 信封（envelope） | 存放"被 KEK 加密后的 DEK"的 JSON 结构，含 KDF 参数与 nonce |
| `dek_ver` | DEK 世代；设备撤销/轮换时 +1，记录按世代重加密 |
| `meta_blob` | 加密后的"非秘密但敏感"信息（标题、账号、URL、标签…） |
| `secret_blob` | 加密后的秘密（密码、密钥、恢复码、自定义字段值…） |
| `.tdvault` | 加密备份文件格式（头部明文 + 载荷密文） |
| 恢复密钥 | 建库时生成的 32 字符随机码，可绕过主密码解锁本机库 |
| 备份口令 | 导出 `.tdvault` 时设置的口令，只能解那个备份文件 |

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-18 | P0 初版：13 篇文档、18 张 Mermaid 图（覆盖 10 类必需图）、D-01..D-13、P-01..P-08 |
