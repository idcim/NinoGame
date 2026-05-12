-- 容器首次启动时自动执行（docker-entrypoint-initdb.d）
-- 创建 NinoGame schema + 必要扩展。
-- 业务表迁移由 Backend (P2) 通过迁移工具管理；此文件只做最小骨架。

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

CREATE SCHEMA IF NOT EXISTS "NinoGame";

-- 默认让 ninogame 用户走该 schema
ALTER ROLE ninogame SET search_path TO "NinoGame", public;

COMMENT ON SCHEMA "NinoGame" IS 'NinoGame 家长控制系统数据 schema (P2 起使用)';
