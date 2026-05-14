/** /api/admin/releases: Agent 包 (zip) 上传 / 列表 / 设为目标 / 删除.
 *
 * 设计:
 *   - 任何已登录家长都能操作 (单家庭场景, 不分管理员;
 *     真要分级以后再加 parent.role 字段)
 *   - 上传走 multipart, 写到 ARTIFACTS_DIR 下, 同步计算 sha256
 *   - promote: 把某 release 设成 is_target=TRUE (事务里翻其它为 false)
 *     之后 onHello 时所有落后设备会自动入队 update_self
 *   - delete: 不允许删 is_target=TRUE 的 release (防把 server 挖空)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import path from "node:path";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { pool } from "../db.js";
import {
  maybeQueueUpdateForDevice,
  sha256OfFile,
} from "../services/agent_release.js";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FILENAME_SAFE_RE = /^[A-Za-z0-9_.-]+$/;

export async function registerAdminReleaseRoutes(app: FastifyInstance) {
  // ── 列表 ──────────────────────────────────────────────────
  app.get("/api/admin/releases", { preHandler: app.parentAuth }, async () => {
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
  app.post("/api/admin/releases", { preHandler: app.parentAuth }, async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.badRequest("expected multipart/form-data");
    }
    const parts = (req as FastifyRequest).parts();
    let version: string | null = null;
    let notes: string | null = null;
    let saved: { path: string; filename: string; size: number } | null = null;

    try {
      for await (const part of parts) {
        if (part.type === "file") {
          if (saved) {
            // 已经收过一个文件了, 第二个忽略 (multipart limit=1 也会兜底)
            await part.file.resume();
            continue;
          }
          const filename = path.basename(part.filename || "agent.zip");
          if (!FILENAME_SAFE_RE.test(filename)) {
            return reply.badRequest("filename 只能含 [A-Za-z0-9_.-]");
          }
          const dest = path.join(path.resolve(config.artifactsDir), filename);
          const stream = fs.createWriteStream(dest);
          await pipeline(part.file, stream);
          const stat = fs.statSync(dest);
          saved = { path: dest, filename, size: stat.size };
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
      return reply.internalServerError("upload failed");
    }

    if (!saved) return reply.badRequest("missing file");
    if (!version || !VERSION_RE.test(version)) {
      // 清理已落地的文件
      try { fs.unlinkSync(saved.path); } catch { /* ignore */ }
      return reply.badRequest("version 必须是 x.y.z 格式");
    }

    const sha256 = await sha256OfFile(saved.path);

    try {
      const r = await pool.query(
        `INSERT INTO "NinoGame".agent_releases
           (version, filename, size_bytes, sha256, is_target, notes)
         VALUES ($1, $2, $3, $4, FALSE, $5)
         RETURNING id, version, filename, size_bytes::text, sha256, is_target, notes, uploaded_at`,
        [version, saved.filename, saved.size, sha256, notes],
      );
      const row = r.rows[0];
      app.log.info(
        { version, filename: saved.filename, size: saved.size, sha256 },
        "release uploaded",
      );
      return {
        release: { ...row, size_bytes: Number(row.size_bytes) },
      };
    } catch (err) {
      // 版本号 / 文件名冲突 → 清掉刚落地的文件, 返回 409
      try { fs.unlinkSync(saved.path); } catch { /* ignore */ }
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
    { preHandler: app.parentAuth },
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
    { preHandler: app.parentAuth },
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
      try {
        fs.unlinkSync(path.join(path.resolve(config.artifactsDir), r.rows[0].filename));
      } catch { /* 文件不在了就算了 */ }
      app.log.info({ id, filename: r.rows[0].filename }, "release deleted");
      return { ok: true };
    },
  );
}
