/** S3-compatible 驱动 — 同一套代码吃多家:
 *   - AWS S3 (官方; endpoint 不填)
 *   - MinIO (endpoint=http://minio:9000, forcePathStyle=true)
 *   - Backblaze B2 (endpoint=https://s3.<region>.backblazeb2.com)
 *   - Cloudflare R2 (endpoint=https://<account>.r2.cloudflarestorage.com)
 *   - 腾讯 COS (endpoint=https://cos.<region>.myqcloud.com, forcePathStyle=true)
 *   - 七牛 (endpoint=https://s3-cn-east-1.qiniucs.com)
 *
 * 走 @aws-sdk/client-s3 + s3-request-presigner. signedUrl 直接生成
 * presigned GET URL, 客户端直连云存储下载, server 不代理流量。
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import type { StorageDriver, PutOptions, SignedUrlContext } from "./interface.js";

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;    // 空 = 用 AWS 默认; 自托管 MinIO 等填 http://minio:9000
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO / 腾讯 COS 不支持 virtual-host style, 必须 path-style. */
  forcePathStyle?: boolean;
}

export class S3Storage implements StorageDriver {
  readonly id = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region || "us-east-1",
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  async put(key: string, stream: Readable, opts: PutOptions = {}): Promise<void> {
    // 大对象走 multipart (≥ 5MB), 小对象一次性. @aws-sdk/lib-storage 自动处理。
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: stream,
        ContentType: opts.contentType,
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err: unknown) {
      // S3 删除不存在的 key 也不报错; 其它驱动可能 throw NoSuchKey, 静默吞
      const name = (err as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err: unknown) {
      const name = (err as { name?: string }).name;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (name === "NotFound" || name === "NoSuchKey" || status === 404) return false;
      throw err;
    }
  }

  async signedUrl(key: string, ttlSeconds: number, _ctx: SignedUrlContext = {}): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
  }

  async list(prefix: string): Promise<Array<{ key: string; sizeBytes: number; lastModified: Date }>> {
    const r = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      MaxKeys: 100,
    }));
    return (r.Contents || []).map((o) => ({
      key: o.Key || "",
      sizeBytes: o.Size || 0,
      lastModified: o.LastModified || new Date(0),
    }));
  }

  // 用于 admin /system 显示驱动状态时连通性自检
  async ping(): Promise<void> {
    await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
  }
}
