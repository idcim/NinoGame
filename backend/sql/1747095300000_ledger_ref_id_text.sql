-- Up Migration
-- token_ledger.ref_id 原本是 UUID 类型, 仅能存 child_id / task_id 等 UUID 引用.
-- 决策 #34 后 onTokenTick 想用它存 app 名 (e.g. "windowsterminal.exe"),
-- INSERT 时 PG 抛 "invalid input syntax for type uuid: \"windowsterminal.exe\"",
-- ROLLBACK -> server 端 token_tick 静默不扣 -> 用户报"server 在扣但 Agent 不动".
-- 改成 TEXT 让 ref_id 通用 (UUID / app 名 / 任意短引用串都能存).
SET search_path TO "NinoGame", public;

ALTER TABLE token_ledger ALTER COLUMN ref_id TYPE TEXT USING ref_id::TEXT;

-- Down Migration
ALTER TABLE "NinoGame".token_ledger ALTER COLUMN ref_id TYPE UUID USING ref_id::UUID;
