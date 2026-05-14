/** /api/admin/releases: Agent 包 (zip) 上传 / 列表 / 设为目标 / 删除.
 *
 * v0.4.0+: 仅 admin 可操作 (走 app.adminAuth, parent token 401).
 * Storage 抽象后, 上传走 storage.put (local fs / S3 / OSS 任选), 流式算 sha256.
 * promote: 把某 release 设成 is_target=TRUE (事务里翻其它为 false)
 *   之后 onHello 时所有落后设备会自动入队 update_self.
 * delete: 不允许删 is_target=TRUE 的 release (防把 server 挖空).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { pool } from "../../db.js";
import {
  maybeQueueUpdateForDevice,
} from "../../services/agent_release.js";
import { getStorage } from "../../services/storage/factory.js";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FILENAME_SAFE_RE = /^[A-Za-z0-9_.-]+$/;

export async function registerAdminReleaseRoutes(app: FastifyInstance) {
  // ── 列表 ──────────────────────────────────────────────────
  app.get("/api/admin/releases", { preHandler: app.adminAuth }, async () => {
    const r = await pool.query(
      `SELECT id, version, filename, size_bytes::text, sha256, is_target, notes, uploaded_at
         FROM "NinoGame".agent_releases
        ORDER BY uploaded_at DESC`,
    );
    return {
      releases: r.rows.map((row) => ({
        ...row,
        size_bytes: Number(row.size_bytes),
      })),
    };
  });

  // ── 上传 ──────────────────────────────────────────────────
  // 用 storage 抽象, 上传时流式算 sha256 + 写入驱动 (local fs / S3 / OSS).
  // 失败时 best-effort 清理已落地的 key.
  app.post("/api/admin/releases", { preHandler: app.adminAuth }, async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.badRequest("expected multipart/form-data");
    }
    const parts = (req as FastifyRequest).parts();
    const storage = getStorage();
    let version: string | null = null;
    let notes: string | null = null;
    let savedKey: string | null = null;
    let savedFilename: string | null = null;
    let savedSize = 0;
    let savedSha256 = "";

    try {
      for await (const part of parts) {
        if (part.type === "file") {
          if (savedKey) {
            await part.file.resume();
            continue;
          }
          const filename = (part.filename || "agent.zip").split(/[/\\]/).pop()!;
          if (!FILENAME_SAFE_RE.test(filename)) {
            return reply.badRequest("filename 只能含 [A-Za-z0-9_.-]");
          }
          // tee stream: 一边送给 storage.put, 一边喂 sha256
          const tee = new PassThrough();
          const hash = crypto.createHash("sha256");
          let bytes = 0;
          part.file.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            hash.update(chunk);
            tee.write(chunk);
          });
          part.file.on("end", () => tee.end());
          part.file.on("error", (err) => tee.destroy(err));

          await storage.put(filename, tee, { contentType: "application/zip" });
          savedKey = filename;
          savedFilename = filename;
          savedSize = bytes;
          savedSha256 = hash.digest("hex");
        } else {
          if (part.fieldname === "version") {
            version = String(part.value).trim();
          } else if (part.fieldname === "notes") {
            notes = String(part.value).slice(0, 1024);
          }
        }
      }
    } catch (err) {
      app.log.error({ err }, "upload stream failed");
      if (savedKey) await storage.delete(savedKey).catch(() => undefined);
      return reply.internalServerError("upload failed");
    }

    if (!savedKey || !savedFilename) return reply.badRequest("missing file");
    if (!version || !VERSION_RE.test(version)) {
      await storage.delete(savedKey).catch(() => undefined);
      return reply.badRequest("version 必须是 x.y.z 格式");
    }

    try {
      const r = await pool.query(
        `INSERT INTO "NinoGame".agent_releases
           (version, filename, size_bytes, sha256, is_target, notes)
         VALUES ($1, $2, $3, $4, FALSE, $5)
         RETURNING id, version, filename, size_bytes::text, sha256, is_target, notes, uploaded_at`,
        [version, savedFilename, savedSize, savedSha256, notes],
      );
      const row = r.rows[0];
      app.log.info(
        { version, filename: savedFilename, size: savedSize, sha256: savedSha256 },
        "release uploaded",
      );
      return {
        release: { ...row, size_bytes: Number(row.size_bytes) },
      };
    } catch (err) {
      await storage.delete(savedKey).catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("agent_releases_version_key") || msg.includes("duplicate")) {
        return reply.conflict(`version ${version} 已存在`);
      }
      throw err;
    }
  });

  // ── 设为目标版本 ────────────────────────────────────────────
  app.post(
    "/api/admin/releases/:id/promote",
    { preHandler: app.adminAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const exists = await pool.query<{ version: string }>(
        `SELECT version FROM "NinoGame".agent_releases WHERE id = $1`,
        [id],
      );
      if (exists.rows.length === 0) return reply.notFound("release not found");

      // 事务: 先把所有翻 false, 再把这一行翻 true.
      // (UNIQUE INDEX 是 partial WHERE is_target=TRUE, 单事务内顺序保 OK)
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE "NinoGame".agent_releases SET is_target = FALSE WHERE is_target = TRUE`,
        );
        await client.query(
          `UPDATE "NinoGame".agent_releases SET is_target = TRUE WHERE id = $1`,
          [id],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }

      app.log.info({ id, version: exists.rows[0].version }, "release promoted");

      // 给所有在线 / 未来 hello 的设备入队 update_self.
      // 拉所有 devices 异步推 (新版本可能 50+ 设备, 串行无所谓 server 写 DB
      // 几十次, 别 await pushToDevice 阻塞 response).
      void (async () => {
        try {
          const ds = await pool.query<{ id: string; agent_version: string | null }>(
            `SELECT id, agent_version FROM "NinoGame".devices`,
          );
          for (const d of ds.rows) {
            await maybeQueueUpdateForDevice(app, d.id, d.agent_version);
          }
        } catch (err) {
          app.log.warn({ err }, "promote fanout failed");
        }
      })();

      return { ok: true, version: exists.rows[0].version };
    },
  );

  // ── 删除 ──────────────────────────────────────────────────
  app.delete(
    "/api/admin/releases/:id",
    { preHandler: app.adminAuth },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const r = await pool.query<{ filename: string; is_target: boolean }>(
        `SELECT filename, is_target FROM "NinoGame".agent_releases WHERE id = $1`,
        [id],
      );
      if (r.rows.length === 0) return reply.notFound("release not found");
      if (r.rows[0].is_target) {
        return reply.badRequest("不能删除当前 target release, 先 promote 别的");
      }
      await pool.query(`DELETE FROM "NinoGame".agent_releases WHERE id = $1`, [id]);
      await getStorage().delete(r.rows[0].filename).catch(() => undefined);
      app.log.info({ id, filename: r.rows[0].filename }, "release deleted");
      return { ok: true };
    },
  );
}
