/** /api/changelog: 公开拉项目根 CHANGELOG.md.
 *
 * v0.4.9+: 让 admin 后台 / Android About 不用各自维护一份变更日志,
 * 都从这一个真相源拉. 无鉴权 — 跟 /health 一样属于"公开元数据".
 *
 * CHANGELOG.md 文件位置: 项目根 (跟 backend/ 同级). 部署到 Docker 时通过 volume
 * 或 build-stage COPY 进容器. 找不到文件返回 404.
 */
import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";

const CANDIDATE_PATHS = [
  // 容器内常见位置
  "/app/CHANGELOG.md",
  // dev / 本地: backend 工作目录在 backend/, 项目根在 ../
  path.resolve(process.cwd(), "CHANGELOG.md"),
  path.resolve(process.cwd(), "..", "CHANGELOG.md"),
];

let cachedContent: string | null = null;
let cachedAtMs = 0;
const CACHE_TTL_MS = 60_000;

async function findAndRead(): Promise<string | null> {
  const now = Date.now();
  if (cachedContent !== null && now - cachedAtMs < CACHE_TTL_MS) {
    return cachedContent;
  }
  for (const p of CANDIDATE_PATHS) {
    try {
      const buf = await fs.readFile(p, "utf-8");
      cachedContent = buf;
      cachedAtMs = now;
      return buf;
    } catch {
      // try next
    }
  }
  return null;
}

export async function registerChangelogRoutes(app: FastifyInstance) {
  app.get("/api/changelog", async (_req, reply) => {
    const content = await findAndRead();
    if (content === null) {
      return reply.notFound("CHANGELOG.md 不在镜像里 — 部署时漏拷贝了");
    }
    reply.header("Cache-Control", "public, max-age=60");
    return { content, format: "markdown" };
  });
}
