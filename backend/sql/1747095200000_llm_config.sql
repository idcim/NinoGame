-- Up Migration
-- LLM 配置 (家长后台填写, 单家长一份)
-- 支持任意 OpenAI-compatible API (DeepSeek / Qwen / Moonshot / 自建等),
-- 只需 base_url + api_key + model 三件套即可切换
SET search_path TO "NinoGame", public;

CREATE TABLE IF NOT EXISTS llm_config (
  parent_id   UUID PRIMARY KEY REFERENCES parents(id) ON DELETE CASCADE,
  provider    VARCHAR(32) NOT NULL DEFAULT 'openai_compatible',
  api_key     TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  model       VARCHAR(128) NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down Migration
DROP TABLE IF EXISTS "NinoGame".llm_config CASCADE;
