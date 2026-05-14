/** 存储驱动抽象 (v0.4.0+, SaaS 方向).
 *
 * 应用层 (admin_releases / 将来任务证据图 / 报表导出) 全部走这个接口,
 * 不关心后端是本地 fs / S3 / OSS。
 *
 * 路径模型: 用 "key" 而不是 "path", 含义类似 S3 object key —
 *   "agent-releases/NinoGame-0.4.0.zip"
 *   "task-evidence/<uuid>.jpg"
 * 调用方负责构造合理的 key prefix.
 */
import type { Readable } from "node:stream";

export interface PutOptions {
  /** Content-Type, 仅 S3 / OSS 用; local 不存. */
  contentType?: string;
  /** 大小提示 (用于 multipart 阈值; 不知道传 undefined). */
  sizeBytes?: number;
}

export interface SignedUrlContext {
  /** 一些驱动需要 device_id / version 等元信息做 audit log; 透传给 driver. */
  device_id?: string;
  version?: string;
}

export interface StorageDriver {
  /** 驱动 ID, 用于 /api/admin/system 显示当前后端. */
  readonly id: "local" | "s3" | "aliyun_oss";

  /** 写入. stream 不应在调用方提前消费。 */
  put(key: string, stream: Readable, opts?: PutOptions): Promise<void>;

  /** 删除. key 不存在视为成功 (幂等). */
  delete(key: string): Promise<void>;

  /** 是否存在. */
  exists(key: string): Promise<boolean>;

  /** 返回给客户端的下载 URL. ttl 单位秒.
   *  - local 驱动: 拼 `/artifacts/<key>?token=<server-jwt>` (token 由 caller 签)
   *  - S3 / OSS 驱动: 返回 presigned URL, 直连云存储 (server 不代理流量)
   *  caller 不应该假设 host — 仅 local 驱动会返回相对路径, 其它返回 https://...
   */
  signedUrl(key: string, ttlSeconds: number, ctx?: SignedUrlContext): Promise<string>;

  /** 算 sha256 (local 直接读; S3/OSS 从 head object 拿 ETag 不一定是 sha256, 需读流算).
   *  在 admin_releases 流程里, 上传前已经在 server 流式算过 sha256, 这个方法主要
   *  给 "check existing object integrity" 用, v0.4.0 不一定要实现 — 留接口. */
  sha256OfStream?(stream: Readable): Promise<string>;

  /** 列 prefix 下的所有 key (admin 后台显示存储用量). 不需要分页, 数量级 <100. */
  list(prefix: string): Promise<Array<{ key: string; sizeBytes: number; lastModified: Date }>>;
}
