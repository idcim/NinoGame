/** Storage driver 工厂.
 *
 * 启动时按 STORAGE_DRIVER 环境变量选驱动. 缺必要 env 时打日志警告 + fallback local
 * (server 仍然能起来; admin UI 显示警告). 这样配错不会把服务搞挂.
 */
import type { FastifyBaseLogger } from "fastify";
import { config } from "../../config.js";
import { AliyunOssStorage } from "./aliyun_oss.js";
import { LocalStorage } from "./local.js";
import { S3Storage } from "./s3.js";
import type { SignedUrlContext, StorageDriver } from "./interface.js";

let cachedDriver: StorageDriver | null = null;
let cachedStatus: { id: string; configured: boolean; warning: string | null } = {
  id: "local", configured: true, warning: null,
};

/** 由 server.ts 启动时注入 — local 驱动签 download token 用. */
export function initStorage(
  logger: FastifyBaseLogger,
  signToken: (ctx: SignedUrlContext, ttlSeconds: number) => string,
): StorageDriver {
  const driver = config.storageDriver;

  if (driver === "s3") {
    const cfg = config.storageS3;
    const missing = [
      !cfg.bucket && "S3_BUCKET",
      !cfg.accessKeyId && "S3_ACCESS_KEY",
      !cfg.secretAccessKey && "S3_SECRET_KEY",
    ].filter(Boolean);
    if (missing.length > 0) {
      const warning = `STORAGE_DRIVER=s3 但缺 ${missing.join(", ")}, 回退到 local`;
      logger.warn(warning);
      cachedStatus = { id: "local", configured: false, warning };
      cachedDriver = new LocalStorage(config.artifactsDir, signToken);
      return cachedDriver;
    }
    logger.info({ bucket: cfg.bucket, endpoint: cfg.endpoint || "aws-default" }, "storage: S3");
    cachedDriver = new S3Storage(cfg);
    cachedStatus = { id: "s3", configured: true, warning: null };
    return cachedDriver;
  }

  if (driver === "aliyun_oss") {
    const cfg = config.storageAliyunOss;
    const missing = [
      !cfg.bucket && "OSS_BUCKET",
      !cfg.accessKeyId && "OSS_ACCESS_KEY",
      !cfg.accessKeySecret && "OSS_SECRET_KEY",
      !cfg.region && "OSS_REGION",
    ].filter(Boolean);
    if (missing.length > 0) {
      const warning = `STORAGE_DRIVER=aliyun_oss 但缺 ${missing.join(", ")}, 回退到 local`;
      logger.warn(warning);
      cachedStatus = { id: "local", configured: false, warning };
      cachedDriver = new LocalStorage(config.artifactsDir, signToken);
      return cachedDriver;
    }
    logger.info({ bucket: cfg.bucket, region: cfg.region }, "storage: Aliyun OSS");
    cachedDriver = new AliyunOssStorage(cfg);
    cachedStatus = { id: "aliyun_oss", configured: true, warning: null };
    return cachedDriver;
  }

  // 默认 / 显式 local
  logger.info({ root: config.artifactsDir }, "storage: local fs");
  cachedDriver = new LocalStorage(config.artifactsDir, signToken);
  cachedStatus = { id: "local", configured: true, warning: null };
  return cachedDriver;
}

/** 已初始化的驱动. server.ts 启动后才能拿. */
export function getStorage(): StorageDriver {
  if (!cachedDriver) {
    throw new Error("storage not initialized; call initStorage() in server.ts first");
  }
  return cachedDriver;
}

export function getStorageStatus(): typeof cachedStatus {
  return { ...cachedStatus };
}
