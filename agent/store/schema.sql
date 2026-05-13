-- NinoGame Agent 本地 SQLite Schema (P1)
-- 设计原则：几乎每张业务表都有 synced_to_server 字段，P1 写 0，
-- P2 上线后老数据可批量回传补上。

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ────────────────────────────────────────────────────────────────
-- 钱包：单行表
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  balance INTEGER NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMP,
  last_daily_grant_date DATE
);

-- ────────────────────────────────────────────────────────────────
-- 账本（不可变）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_id TEXT,
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_to_server INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ledger_synced
  ON token_ledger(synced_to_server, occurred_at);

CREATE INDEX IF NOT EXISTS idx_ledger_reason_date
  ON token_ledger(reason, occurred_at);

-- ────────────────────────────────────────────────────────────────
-- 会话
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  end_reason TEXT,
  total_active_seconds INTEGER DEFAULT 0,
  total_tokens_consumed INTEGER DEFAULT 0,
  synced_to_server INTEGER DEFAULT 0
);

-- ────────────────────────────────────────────────────────────────
-- App 使用片段
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  app_identifier TEXT,
  category TEXT,
  rate_multiplier REAL,
  active_seconds INTEGER,
  idle_seconds INTEGER,
  period_start TIMESTAMP,
  period_end TIMESTAMP,
  tokens_consumed INTEGER DEFAULT 0,
  synced_to_server INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_segments_synced
  ON app_segments(synced_to_server, period_start);

CREATE INDEX IF NOT EXISTS idx_segments_app_date
  ON app_segments(app_identifier, period_start);

-- ────────────────────────────────────────────────────────────────
-- 事件（审计）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT,
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_to_server INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_synced
  ON events(synced_to_server, occurred_at);

CREATE INDEX IF NOT EXISTS idx_events_type_date
  ON events(event_type, occurred_at);

-- ────────────────────────────────────────────────────────────────
-- 应用分类（与 config/app_categories.json 互为镜像；DB 是运行时权威源）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_categories (
  app_identifier TEXT PRIMARY KEY,
  category TEXT,
  sub_type TEXT,
  rate_multiplier REAL DEFAULT 1.0,
  source TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────────
-- 责任清单完成
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS responsibility_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  check_date DATE,
  completed INTEGER,
  checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_to_server INTEGER DEFAULT 0,
  UNIQUE (task_id, check_date)
);

-- ────────────────────────────────────────────────────────────────
-- 任务完成
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  status TEXT DEFAULT 'pending',
  evidence_path TEXT,
  child_note TEXT,
  reward_granted INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_to_server INTEGER DEFAULT 0
);

-- ────────────────────────────────────────────────────────────────
-- 通知历史 (托盘"我的消息..."窗口数据源)
--   notifier.info_async / warn_async 弹通知时同步写一条
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info',  -- info / warn
  title TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notification_history(created_at DESC);

-- ────────────────────────────────────────────────────────────────
-- 未知 App 队列（P2 让后端 LLM 分类）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unknown_apps_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_identifier TEXT,
  exe_path TEXT,
  window_title TEXT,
  first_seen_at TIMESTAMP,
  processed INTEGER DEFAULT 0,
  UNIQUE (app_identifier)
);
