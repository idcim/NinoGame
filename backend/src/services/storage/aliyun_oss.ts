/** 阿里云 OSS 驱动 — 用 ali-oss SDK.
 *
 * 阿里 OSS 跟 S3 兼容性有限 (签名版本 / multipart 协议都有差异),
 * 直接用官方 SDK 最稳。腾讯 COS / 七牛建议用 S3-compatible 模式 (s3.ts);
 * 此驱动专给阿里云。
 */
import OSS from "ali-oss";
import { Readable } from "node:stream";
import type { StorageDriver, PutOptions, SignedUrlContext } from "./interface.js";

export interface AliyunOssConfig {
  bucket: string;
  region: string;          // 例: "oss-cn-hangzhou"
  accessKeyId: string;
  accessKeySecret: string;
  /** 自定义 endpoint, 如 "oss-cn-hangzhou-internal.aliyuncs.com" (VPC 内网更快免流量费). */
  endpoint?: string;
  /** STS 临时凭证, 需要时用 (默认不用). */
  stsToken?: string;
  /** 是否走 HTTPS. */
  secure?: boolean;
}

export class AliyunOssStorage implements StorageDriver {
  readonly id = "aliyun_oss" as const;
  private readonly client: OSS;
  private readonly bucket: string;

  constructor(cfg: AliyunOssConfig) {
    this.bucket = cfg.bucket;
    this.client = new OSS({
      bucket: cfg.bucket,
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      endpoint: cfg.endpoint,
      stsToken: cfg.stsToken,
      secure: cfg.secure ?? true,
    });
  }

  async put(key: string, stream: Readable, opts: PutOptions = {}): Promise<void> {
    // ali-oss putStream 走分块上传, 自动处理大文件
    await this.client.putStream(key, stream, {
      mime: opts.contentType,
      contentLength: opts.sizeBytes,
    } as OSS.PutStreamOptions);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.delete(key);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404) return;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.head(key);
      return true;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404) return false;
      throw err;
    }
  }

  async signedUrl(key: string, ttlSeconds: number, _ctx: SignedUrlContext = {}): Promise<string> {
    // ali-oss signatureUrl 同步返回 presigned URL
    return this.client.signatureUrl(key, { expires: ttlSeconds, method: "GET" });
  }

  async list(prefix: string): Promise<Array<{ key: string; sizeBytes: number; lastModified: Date }>> {
    const r = await this.client.list({
      prefix,
      "max-keys": 100,
    }, { timeout: 30_000 });
    return (r.objects || []).map((o) => ({
      key: o.name,
      sizeBytes: o.size,
      lastModified: new Date(o.lastModified),
    }));
  }

  async ping(): Promise<void> {
    await this.client.list({ "max-keys": 1, prefix: "" }, { timeout: 10_000 });
  }
}
