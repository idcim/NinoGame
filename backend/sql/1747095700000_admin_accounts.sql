-- Up Migration
-- v0.4.0+ 独立管理后台: admin_accounts + admin_settings + parents.tenant_id 接缝.
-- admin_accounts 与 parents 完全分离, JWT kind 字段区分, 不能跨调用 API.
-- admin_settings 是通用 KV (LLM 配置 / 默认配额 / 推送通道 / 系统限额 等).
SET search_path TO "NinoGame", public;

CREATE TABLE IF NOT EXISTS admin_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(64) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(128),
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_settings (
  key         VARCHAR(64) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES admin_accounts(id)
);

-- 多租户接缝: 现在所有 parents 视为 tenant_id=NULL (默认租户),
-- 未来切多租户时把现有数据 backfill 一个固定 UUID 即可。
ALTER TABLE parents ADD COLUMN IF NOT EXISTS tenant_id UUID;
CREATE INDEX IF NOT EXISTS parents_tenant_idx ON parents(tenant_id) WHERE tenant_id IS NOT NULL;

-- Down Migration
SET search_path TO "NinoGame", public;
DROP INDEX IF EXISTS "NinoGame".parents_tenant_idx;
ALTER TABLE parents DROP COLUMN IF EXISTS tenant_id;
DROP TABLE IF EXISTS "NinoGame".admin_settings CASCADE;
DROP TABLE IF EXISTS "NinoGame".admin_accounts CASCADE;
