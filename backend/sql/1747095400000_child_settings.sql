-- Up Migration
-- 孩子端 Agent 设置上云: 家长在后台编辑, server 推 Agent 写本地 settings.json.
-- JSONB 灵活, 加新字段不需要 schema 改动.
-- 不上云的字段 (保留本地, 不进此表): pin_hash/pin_salt/agent_token/device_id/
-- child_id/backend_url/_migrated_* (PIN 加密敏感 + 身份配对 + 一次性迁移标记)
SET search_path TO "NinoGame", public;

CREATE TABLE IF NOT EXISTS child_settings (
  child_id    UUID PRIMARY KEY REFERENCES children(id) ON DELETE CASCADE,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down Migration
DROP TABLE IF EXISTS "NinoGame".child_settings CASCADE;
