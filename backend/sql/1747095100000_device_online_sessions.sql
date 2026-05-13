-- Up Migration
-- 设备在线时段记录: Agent WS 连上时 INSERT, 断开时 UPDATE disconnected_at + duration_seconds
-- 给家长后台看"今天 Agent 跑了多久 / 哪几段在线"
SET search_path TO "NinoGame", public;

CREATE TABLE IF NOT EXISTS device_online_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  duration_seconds INT,
  remote_ip       VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_dos_device_time ON device_online_sessions(device_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS idx_dos_open ON device_online_sessions(device_id) WHERE disconnected_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS "NinoGame".device_online_sessions CASCADE;
