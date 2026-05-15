-- Up Migration
-- v0.4.3: PIN 主从同步 — server 主导, 各端通过 WS 自动同步.
--
-- 之前 PIN 只存在 Agent 本地, server 不知道:
--   - 多设备绑同一孩子时, 每台都要单独 set_pin (家长不知道, 漏设)
--   - 设备重装 / 重新配对后 PIN 丢失, 没人通知
--   - "设 PIN 按钮"推的是明文, server 临时持有不安全
--
-- 新设计 (跟 CLAUDE.md §3.2 "PIN 由家长设置, 多设备共享" 对齐):
--   - children 加 parent_pin_hash + parent_pin_salt 存 PBKDF2 hash (32B/16B salt)
--   - 家长后台设 PIN → server hash → 存 → 推 pin_sync(hash, salt) 给所有该 child 设备
--   - hello_ack 也带 parent_pin_sync, 新设备配对 / Agent 重启自动同步
--   - Agent 拿到 hash+salt 直接存本地 (PinManager.set_pin_raw_hash), 不再自己 hash
--
-- devices.agent_pin_set 仍保留作可见性: Agent hello 上报当前本地 PIN 状态,
-- 家长后台能看到"哪些设备同步到了 PIN" — 检测同步链路问题用.
SET search_path TO "NinoGame", public;

ALTER TABLE children
  ADD COLUMN IF NOT EXISTS parent_pin_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS parent_pin_salt VARCHAR(32);

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS agent_pin_set BOOLEAN NOT NULL DEFAULT FALSE;

-- Down Migration
SET search_path TO "NinoGame", public;
ALTER TABLE devices DROP COLUMN IF EXISTS agent_pin_set;
ALTER TABLE children DROP COLUMN IF EXISTS parent_pin_hash;
ALTER TABLE children DROP COLUMN IF EXISTS parent_pin_salt;
