-- Up Migration
-- v0.4.2: 自动 maturity_mode 升级建议 (P4, CLAUDE.md §8.7 + 决策 #43).
-- 当 trust_level 升到 4/5 时, 系统自动向家长推一条"建议升级到 advisory/self_regulated"通知,
-- 写一笔 events(maturity_upgrade_suggestion). last_maturity_suggestion_at 字段用于
-- 30 天 cooldown — 同一 (child, suggested_mode) 30 天内不再重复建议。
SET search_path TO "NinoGame", public;

ALTER TABLE children
  ADD COLUMN IF NOT EXISTS last_maturity_suggestion_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dismissed_maturity_target VARCHAR(16);
-- dismissed_maturity_target: 家长一键"暂不升级"后写入 (例 'advisory'),
-- 同 target 的建议不再展示在 dashboard; 下次系统发新 target 的建议时
-- 自动清空 (见 maturity_upgrade_suggester.ts).

-- Down Migration
SET search_path TO "NinoGame", public;
ALTER TABLE children
  DROP COLUMN IF EXISTS dismissed_maturity_target,
  DROP COLUMN IF EXISTS last_maturity_suggestion_at;
