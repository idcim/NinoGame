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
  /** Agent 包存盘目录 (Docker 卷挂载点). 默认 /var/lib/ninogame/artifacts.
   *  仅 STORAGE_DRIVER=local 时有意义. */
  artifactsDir: optional("ARTIFACTS_DIR", "/var/lib/ninogame/artifacts"),

  /** 存储驱动 (v0.4.0+): local | s3 | aliyun_oss. */
  storageDriver: (optional("STORAGE_DRIVER", "local") as "local" | "s3" | "aliyun_oss"),

  /** S3-compatible 驱动配置 (AWS S3 / MinIO / B2 / R2 / 腾讯 COS / 七牛). */
  storageS3: {
    bucket: optional("S3_BUCKET", ""),
    region: optional("S3_REGION", "us-east-1"),
    endpoint: optional("S3_ENDPOINT", ""),
    accessKeyId: optional("S3_ACCESS_KEY", ""),
    secretAccessKey: optional("S3_SECRET_KEY", ""),
    forcePathStyle: optional("S3_FORCE_PATH_STYLE", "") === "true",
  },

  /** 阿里云 OSS 驱动配置. */
  storageAliyunOss: {
    bucket: optional("OSS_BUCKET", ""),
    region: optional("OSS_REGION", ""),
    accessKeyId: optional("OSS_ACCESS_KEY", ""),
    accessKeySecret: optional("OSS_SECRET_KEY", ""),
    endpoint: optional("OSS_ENDPOINT", "") || undefined,
    secure: optional("OSS_SECURE", "true") !== "false",
  },

  /** Admin 首次启动 bootstrap (v0.4.0+). admin_accounts 空时按这里写一行. */
  adminBootstrap: {
    username: optional("ADMIN_BOOTSTRAP_USERNAME", ""),
    password: optional("ADMIN_BOOTSTRAP_PASSWORD", ""),
  },
} as const;

export type Config = typeof config;
