/** 本地文件系统驱动 — 现状; Docker 卷挂载点.
 *
 * key 直接对应到磁盘路径 `<root>/<key>` (key 里的 / 是真目录分隔)。
 * 上传时把 key 里的目录提前 mkdir -p。
 *
 * signedUrl: 返回相对路径 `/artifacts/<key>?token=<jwt>`, jwt 由 caller 签;
 * server.ts 上的 onRequest hook + @fastify/static 真正把字节给出去。
 */
import { createWriteStream, promises as fsp } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { StorageDriver, PutOptions, SignedUrlContext } from "./interface.js";

export class LocalStorage implements StorageDriver {
  readonly id = "local" as const;
  private readonly root: string;
  /** signedUrl 时挂 token; caller 提供 (server 启动时注入). */
  private readonly signToken: (ctx: SignedUrlContext, ttlSeconds: number) => string;

  constructor(root: string, signToken: (ctx: SignedUrlContext, ttlSeconds: number) => string) {
    this.root = path.resolve(root);
    this.signToken = signToken;
  }

  private full(key: string): string {
    // 防 key 里有 ".." 跳出 root
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
      throw new Error(`invalid key (path traversal): ${key}`);
    }
    return resolved;
  }

  async put(key: string, stream: Readable, _opts?: PutOptions): Promise<void> {
    const dest = this.full(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await pipeline(stream, createWriteStream(dest));
  }

  async delete(key: string): Promise<void> {
    try {
      await fsp.unlink(this.full(key));
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fsp.access(this.full(key));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds: number, ctx: SignedUrlContext = {}): Promise<string> {
    const token = this.signToken(ctx, ttlSeconds);
    // 不 encode "/" 分隔符让 @fastify/static 能跟到子目录;
    // 仅 encode 文件名里可能的特殊字符 (上传时已做白名单, 实际不会有空格/中文)
    const safe = key.split("/").map(encodeURIComponent).join("/");
    return `/artifacts/${safe}?token=${token}`;
  }

  async list(prefix: string): Promise<Array<{ key: string; sizeBytes: number; lastModified: Date }>> {
    const base = this.full(prefix);
    try {
      const entries = await fsp.readdir(base, { withFileTypes: true });
      const out: Array<{ key: string; sizeBytes: number; lastModified: Date }> = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const full = path.join(base, e.name);
        const stat = await fsp.stat(full);
        out.push({
          key: path.posix.join(prefix, e.name),
          sizeBytes: stat.size,
          lastModified: stat.mtime,
        });
      }
      return out;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }
  }
}
