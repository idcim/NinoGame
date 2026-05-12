-- Up Migration
-- 初始化 NinoGame schema (CLAUDE.md §18)
--
-- 设计原则:
--   - 所有业务表都在 "NinoGame" schema (与生产 1Panel 实例保持一致)
--   - 主键 UUID, 用 pgcrypto.gen_random_uuid()
--   - 时间戳 TIMESTAMPTZ + DEFAULT NOW()
--   - 索引按 (child_id, occurred_at DESC) 之类的高频查询模式建

SET search_path TO "NinoGame", public;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ────────────────────────────────────────────────────────────
-- 1. 账号
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        VARCHAR(64) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  push_config     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS children (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  username        VARCHAR(32) UNIQUE NOT NULL,
  display_name    VARCHAR(64),
  birth_year      INT,
  pin_hash        VARCHAR(255),
  maturity_mode   VARCHAR(16) NOT NULL DEFAULT 'negotiable',
  quota_package   VARCHAR(16) NOT NULL DEFAULT 'balanced',
  quota_overrides JSONB,
  trust_level     INT NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_children_parent ON children(parent_id);

-- ────────────────────────────────────────────────────────────
-- 2. 设备 + 绑定
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_type       VARCHAR(16) NOT NULL DEFAULT 'child_primary',
  default_mode      VARCHAR(16) NOT NULL DEFAULT 'auto_child',
  idle_lock_minutes INT NOT NULL DEFAULT 10,
  name              VARCHAR(128),
  pairing_code      VARCHAR(16),
  agent_token       VARCHAR(64) UNIQUE,
  os_info           JSONB,
  platform          VARCHAR(16),
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_bindings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  child_id    UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  bound_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unbound_at  TIMESTAMPTZ,
  is_shared   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_device_bindings_device ON device_bindings(device_id);
CREATE INDEX IF NOT EXISTS idx_device_bindings_child  ON device_bindings(child_id);

-- ────────────────────────────────────────────────────────────
-- 3. 会话
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id              UUID REFERENCES devices(id) ON DELETE SET NULL,
  child_id               UUID REFERENCES children(id) ON DELETE SET NULL,
  mode                   VARCHAR(16) NOT NULL,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at               TIMESTAMPTZ,
  end_reason             VARCHAR(32),
  total_active_seconds   INT NOT NULL DEFAULT 0,
  total_tokens_consumed  INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_child_time ON sessions(child_id, started_at DESC);

-- ────────────────────────────────────────────────────────────
-- 4. 钱包 + 账本
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id    UUID NOT NULL UNIQUE REFERENCES children(id) ON DELETE CASCADE,
  balance     INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id              BIGSERIAL PRIMARY KEY,
  wallet_id       UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  delta           INT NOT NULL,
  balance_after   INT NOT NULL,
  reason          VARCHAR(32) NOT NULL,
  ref_id          UUID,
  device_id       UUID REFERENCES devices(id) ON DELETE SET NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet_time ON token_ledger(wallet_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_reason_date ON token_ledger(reason, occurred_at DESC);

-- ────────────────────────────────────────────────────────────
-- 5. 规则 + 应用分类
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id    UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  name        VARCHAR(128) NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  spec        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rules_child ON rules(child_id);

CREATE TABLE IF NOT EXISTS app_categories (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_identifier        VARCHAR(255) NOT NULL,
  category              VARCHAR(16) NOT NULL,
  sub_type              VARCHAR(32),
  rate_multiplier       NUMERIC(3,2) NOT NULL DEFAULT 1.0,
  classification_source VARCHAR(16) NOT NULL DEFAULT 'system',
  child_id              UUID REFERENCES children(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_identifier, child_id)
);
CREATE INDEX IF NOT EXISTS idx_app_categories_ident ON app_categories(app_identifier);

-- ────────────────────────────────────────────────────────────
-- 6. 任务
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_templates (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id               UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  name                   VARCHAR(128) NOT NULL,
  category               VARCHAR(32) NOT NULL DEFAULT 'incentive',
  reward_tokens          INT NOT NULL DEFAULT 0,
  daily_max_completions  INT NOT NULL DEFAULT 1,
  verification           VARCHAR(16) NOT NULL DEFAULT 'parent_approve',
  schedule               VARCHAR(16) NOT NULL DEFAULT 'daily',
  active                 BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_task_templates_child ON task_templates(child_id);

CREATE TABLE IF NOT EXISTS task_completions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             UUID NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  child_id            UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  status              VARCHAR(16) NOT NULL DEFAULT 'pending',
  photo_url           TEXT,
  child_note          TEXT,
  llm_summary         TEXT,
  parent_decision_at  TIMESTAMPTZ,
  parent_comment      TEXT,
  reward_granted      INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_completions_child_time ON task_completions(child_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_completions_status ON task_completions(status, created_at DESC);

-- 责任清单完成情况 (无 token)
CREATE TABLE IF NOT EXISTS responsibility_checks (
  id          BIGSERIAL PRIMARY KEY,
  task_id     UUID NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  child_id    UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  check_date  DATE NOT NULL,
  completed   BOOLEAN NOT NULL,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, check_date)
);
CREATE INDEX IF NOT EXISTS idx_resp_checks_child_date ON responsibility_checks(child_id, check_date DESC);

-- ────────────────────────────────────────────────────────────
-- 7. App 使用 + 解锁 + 申请
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id        UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  device_id       UUID REFERENCES devices(id) ON DELETE SET NULL,
  app_identifier  VARCHAR(255) NOT NULL,
  category        VARCHAR(16) NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  active_seconds  INT NOT NULL DEFAULT 0,
  tokens_consumed INT NOT NULL DEFAULT 0,
  unlock_id       UUID
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_child_time ON app_sessions(child_id, started_at DESC);

CREATE TABLE IF NOT EXISTS unlocks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id          UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  rule_id           UUID REFERENCES rules(id) ON DELETE SET NULL,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  prepaid_tokens    INT NOT NULL DEFAULT 0,
  consumed_tokens   INT NOT NULL DEFAULT 0,
  refunded_tokens   INT NOT NULL DEFAULT 0,
  source            VARCHAR(16) NOT NULL DEFAULT 'parent_approval',
  request_id        UUID
);
CREATE INDEX IF NOT EXISTS idx_unlocks_child_time ON unlocks(child_id, granted_at DESC);

CREATE TABLE IF NOT EXISTS free_pass_periods (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id                  UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  device_id                 UUID REFERENCES devices(id) ON DELETE SET NULL,
  started_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at                  TIMESTAMPTZ,
  expected_duration_minutes INT,
  reason                    TEXT,
  ended_by                  VARCHAR(16),
  created_by_parent         UUID REFERENCES parents(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_free_pass_child_time ON free_pass_periods(child_id, started_at DESC);

CREATE TABLE IF NOT EXISTS unlock_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id            UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  request_text        TEXT NOT NULL,
  structured_request  JSONB,
  llm_summary         TEXT,
  status              VARCHAR(16) NOT NULL DEFAULT 'pending',
  parent_decision_at  TIMESTAMPTZ,
  parent_comment      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_unlock_requests_child_status ON unlock_requests(child_id, status, created_at DESC);

-- ────────────────────────────────────────────────────────────
-- 8. 调账 + 事件 + 反思
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_adjustments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID REFERENCES sessions(id) ON DELETE SET NULL,
  parent_id          UUID REFERENCES parents(id) ON DELETE SET NULL,
  original_consumed  INT NOT NULL,
  adjusted_consumed  INT NOT NULL,
  delta_tokens       INT NOT NULL,
  reason             TEXT,
  visible_to_child   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_adjustments_session ON billing_adjustments(session_id);

CREATE TABLE IF NOT EXISTS events (
  id            BIGSERIAL PRIMARY KEY,
  child_id      UUID REFERENCES children(id) ON DELETE CASCADE,
  device_id     UUID REFERENCES devices(id) ON DELETE SET NULL,
  event_type    VARCHAR(32) NOT NULL,
  payload       JSONB,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_child_time ON events(child_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_time  ON events(event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS session_reflections (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID REFERENCES sessions(id) ON DELETE SET NULL,
  child_id           UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  app_identifier     VARCHAR(255),
  satisfaction       VARCHAR(8) NOT NULL,
  visible_to_parent  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reflections_child_time ON session_reflections(child_id, created_at DESC);

-- ────────────────────────────────────────────────────────────
-- 9. 命令队列 + 信任值
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commands (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_type  VARCHAR(32) NOT NULL,
  payload       JSONB,
  status        VARCHAR(16) NOT NULL DEFAULT 'pending',
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_commands_device_status ON commands(device_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS trust_changes (
  id            BIGSERIAL PRIMARY KEY,
  child_id      UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  delta         INT NOT NULL,
  new_level     INT NOT NULL,
  reason        VARCHAR(64),
  triggered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trust_changes_child_time ON trust_changes(child_id, triggered_at DESC);

-- Down Migration
-- 反向丢库（开发用）
-- 注意: 真生产不要 down 这套；这只是开发回滚方便。
-- 依赖反向: trust_changes → commands → reflections → events → adjustments
--           → unlock_requests → free_pass → unlocks → app_sessions
--           → responsibility_checks → task_completions → task_templates
--           → app_categories → rules → token_ledger → wallets
--           → sessions → device_bindings → devices → children → parents

-- node-pg-migrate 用 -- Down Migration 分割; 上面是 up, 下面是 down

DROP TABLE IF EXISTS "NinoGame".trust_changes CASCADE;
DROP TABLE IF EXISTS "NinoGame".commands CASCADE;
DROP TABLE IF EXISTS "NinoGame".session_reflections CASCADE;
DROP TABLE IF EXISTS "NinoGame".events CASCADE;
DROP TABLE IF EXISTS "NinoGame".billing_adjustments CASCADE;
DROP TABLE IF EXISTS "NinoGame".unlock_requests CASCADE;
DROP TABLE IF EXISTS "NinoGame".free_pass_periods CASCADE;
DROP TABLE IF EXISTS "NinoGame".unlocks CASCADE;
DROP TABLE IF EXISTS "NinoGame".app_sessions CASCADE;
DROP TABLE IF EXISTS "NinoGame".responsibility_checks CASCADE;
DROP TABLE IF EXISTS "NinoGame".task_completions CASCADE;
DROP TABLE IF EXISTS "NinoGame".task_templates CASCADE;
DROP TABLE IF EXISTS "NinoGame".app_categories CASCADE;
DROP TABLE IF EXISTS "NinoGame".rules CASCADE;
DROP TABLE IF EXISTS "NinoGame".token_ledger CASCADE;
DROP TABLE IF EXISTS "NinoGame".wallets CASCADE;
DROP TABLE IF EXISTS "NinoGame".sessions CASCADE;
DROP TABLE IF EXISTS "NinoGame".device_bindings CASCADE;
DROP TABLE IF EXISTS "NinoGame".devices CASCADE;
DROP TABLE IF EXISTS "NinoGame".children CASCADE;
DROP TABLE IF EXISTS "NinoGame".parents CASCADE;
