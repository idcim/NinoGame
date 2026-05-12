import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  // 业务表都在 "NinoGame" schema 下; SQL 里用双引号
  // 也可以在连接上 SET search_path, 但显式 schema 名更清晰
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err: Error) => {
  // 后台连接断开等; pino logger 在 server.ts 加 handler
  console.error("[db] pool error:", err);
});

export async function ping(): Promise<{ now: string; version: string }> {
  const r = await pool.query<{ now: string; version: string }>(
    "SELECT NOW()::text AS now, version() AS version",
  );
  return r.rows[0];
}

export async function close(): Promise<void> {
  await pool.end();
}
