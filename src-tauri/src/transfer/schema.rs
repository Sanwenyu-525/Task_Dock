//! 全局工作篮表结构（迁移 v79，纯追加）。
//!
//! 设计边界：
//! - 只新增表与索引，不改既有表；旧版本应用打开新库时忽略这些表；
//! - 不存二进制：图片只引用 `clipboard_items.id`，文件只存规范化绝对路径；
//! - 业务实体（任务/项目/规划/知识/采集）只存 id，不复制业务正文；
//! - 去重唯一索引只覆盖「仍在篮中」的状态（ready/sending/failed），发送后可再次加入；
//! - 批次表存逐条结果与撤销信息，不承担业务状态机（条目状态单独维护）。

pub const MIGRATION_79: (i64, &str) = (
    79,
    r#"
-- 工作篮条目：临时收集的跨模块内容。
CREATE TABLE transfer_items (
  id TEXT PRIMARY KEY NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN (
    'text','richtext','image','file','directory','url','clipboard',
    'task','project','planning','knowledge','capture'
  )),
  source_module TEXT NOT NULL CHECK (source_module IN (
    'clipboard','files','tasks','projects','planning','knowledge','capture',
    'mobile','resource','shelf','tray','manual'
  )),
  source_id TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  content_ref TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  sort_order REAL NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready','sending','sent','failed','expired')),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  last_target TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  expires_at TEXT
);

CREATE INDEX idx_transfer_items_order
  ON transfer_items(status, pinned DESC, sort_order, created_at);
CREATE INDEX idx_transfer_items_type
  ON transfer_items(item_type, status);
CREATE INDEX idx_transfer_items_source
  ON transfer_items(source_module, source_id);
-- 只对仍在篮中的状态去重：发送成功/过期后同一内容可以再次加入。
CREATE UNIQUE INDEX idx_transfer_items_dedupe
  ON transfer_items(dedupe_key)
  WHERE status IN ('ready','sending','failed');

-- 长文本独立存放：列表查询不读取大字段。
CREATE TABLE transfer_contents (
  id TEXT PRIMARY KEY NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 批次：一次批量发送的真实结果、进度来源与撤销信息。
CREATE TABLE transfer_batches (
  id TEXT PRIMARY KEY NOT NULL,
  target_module TEXT NOT NULL,
  target_ref TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','partial','failed','cancelled')),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  ok INTEGER NOT NULL DEFAULT 0 CHECK (ok >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  job_ids_json TEXT NOT NULL DEFAULT '[]',
  plan_json TEXT NOT NULL DEFAULT '[]',
  results_json TEXT NOT NULL DEFAULT '[]',
  undo_kind TEXT NOT NULL DEFAULT 'none'
    CHECK (undo_kind IN ('none','recycle','unlink')),
  undo_state TEXT NOT NULL DEFAULT 'unavailable'
    CHECK (undo_state IN ('available','partial','used','unavailable')),
  undo_payload_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_transfer_batches_created
  ON transfer_batches(created_at DESC);

-- 通用实体关联：只用于没有归属表的实体对。
-- 知识 / 暂存架 / 项目任务关联分别复用既有表，不在此重复建关系。
CREATE TABLE entity_links (
  id TEXT PRIMARY KEY NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'task','workspace_project','planning_project','planning_feature','planning_step',
    'knowledge_doc','capture','shelf_item','clipboard_item','file'
  )),
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN (
    'task','workspace_project','planning_project','planning_feature','planning_step',
    'knowledge_doc','capture','shelf_item','clipboard_item','file'
  )),
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL
    CHECK (relation IN ('reference','attachment','parent','derived')),
  label TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_entity_links_unique
  ON entity_links(source_type, source_id, target_type, target_id, relation);
CREATE INDEX idx_entity_links_target
  ON entity_links(target_type, target_id, relation);
CREATE INDEX idx_entity_links_source
  ON entity_links(source_type, source_id, relation);
"#,
);
