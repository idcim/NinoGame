/** admin_settings 表的通用读写 helper.
 *
 * KV 风格: key 是命名好的字符串 ('llm_config' / 'defaults' / 'system' / 'push'),
 * value 是 JSONB. 全部业务约束在调用方做 (zod 校验) — 这里只管读写.
 *
 * 写入时记录 updated_by (admin UUID), audit 用.
 */
import { pool } from "../db.js";

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const r = await pool.query<{ value: T }>(
    `SELECT value FROM "NinoGame".admin_settings WHERE key = $1`,
    [key],
  );
  return r.rows[0]?.value ?? null;
}

export async function putSetting(
  key: string,
  value: unknown,
  updated_by: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO "NinoGame".admin_settings (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [key, JSON.stringify(value), updated_by],
  );
}

export async function deleteSetting(key: string): Promise<void> {
  await pool.query(`DELETE FROM "NinoGame".admin_settings WHERE key = $1`, [key]);
}
