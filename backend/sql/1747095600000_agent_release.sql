-- Up Migration
-- 无感软件更新 (v0.3.0 起): server 持有最新 Agent 包, hello 时比对版本, 落后则推 update_self.
--   - devices.agent_version: 最后一次 hello 时的版本号 (家长后台显示 + server 判定)
--   - agent_releases: 每个上传的 Agent 包一条; is_target=TRUE 行最多一条 (partial unique)
SET search_path TO "NinoGame", public;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS agent_version VARCHAR(16);

CREATE TABLE IF NOT EXISTS agent_releases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version      VARCHAR(16) NOT NULL UNIQUE,
  filename     VARCHAR(255) NOT NULL,
  size_bytes   BIGINT NOT NULL,
  sha256       CHAR(64) NOT NULL,
  is_target    BOOLEAN NOT NULL DEFAULT FALSE,
  notes        TEXT,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 全表只能有一行 is_target=TRUE (partial unique index, 比 trigger 简单)
CREATE UNIQUE INDEX IF NOT EXISTS agent_releases_one_target
  ON agent_releases((1)) WHERE is_target = TRUE;

-- Down Migration
SET search_path TO "NinoGame", public;
DROP INDEX IF EXISTS "NinoGame".agent_releases_one_target;
DROP TABLE IF EXISTS "NinoGame".agent_releases CASCADE;
ALTER TABLE devices DROP COLUMN IF EXISTS agent_version;
