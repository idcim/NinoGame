import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`环境变量 ${name} 未设置；先拷贝 .env.example 为 .env`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  env: optional("NODE_ENV", "development"),
  host: optional("HOST", "127.0.0.1"),
  port: Number(optional("PORT", "8088")),

  databaseUrl: required("DATABASE_URL"),

  jwtSecret: optional("JWT_SECRET", "dev-secret-change-me"),
  jwtExpiresIn: optional("JWT_EXPIRES_IN", "7d"),

  logLevel: optional("LOG_LEVEL", "info"),
  logPretty: optional("LOG_PRETTY", "true") === "true",

  /** Agent 端拼接下载 URL 时用. 生产: https://ninogame.{domain};
   *  开发: http://127.0.0.1:8088. 末尾不要带 /。 */
  publicBaseUrl: optional("PUBLIC_BASE_URL", "http://127.0.0.1:8088"),
  /** Agent 包存盘目录 (Docker 卷挂载点). 默认 /var/lib/ninogame/artifacts. */
  artifactsDir: optional("ARTIFACTS_DIR", "/var/lib/ninogame/artifacts"),
} as const;

export type Config = typeof config;
