/** 无感软件更新 (CLAUDE.md §17, P3.5): 服务端持有最新 Agent 包,
 * hello 时比对版本, 落后则推 update_self command. 调用方:
 *   - ws/agent.ts onHello: 写 devices.agent_version + 调 maybeQueueUpdate
 *   - routes/admin_releases.ts: 上传 / promote 后, 对所有设备调一次 maybeQueueUpdate
 *
 * SafeMoment 由 Agent 端决策 (锁屏态 + 无对话框 + 30s 稳定), server 只负责
 * 把命令推到位 — 离线设备 hello 时拿到 pending command, 重连即生效。
 */
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { config } from "../config.js";
import { pushToDevice } from "../ws/agent.js";
import { getStorage } from "./storage/factory.js";
import crypto from "node:crypto";

export interface AgentReleaseRow {
  id: string;
  version: string;
  filename: string;
  size_bytes: string;
  sha256: string;
  is_target: boolean;
  notes: string | null;
  uploaded_at: string;
}

/** 拿当前 target release; 没设置 target 时返回 null (服务端没准备好分发). */
export async function getTargetRelease(): Promise<AgentReleaseRow | null> {
  const r = await pool.query<AgentReleaseRow>(
    `SELECT id, version, filename, size_bytes::text, sha256, is_target, notes, uploaded_at
       FROM "NinoGame".agent_releases
      WHERE is_target = TRUE
      LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

/** 简易 semver 比较 — Agent 版本只走 x.y.z 三段无 prerelease, 不需要 npm semver lib.
 *  返回 -1 (a<b), 0 (相等), 1 (a>b). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/** 给 Agent 签发一个 30 分钟有效期的下载 token (local 驱动用).
 *  S3/OSS 驱动走 presigned URL, 不调用此函数. 留接口给 admin /system 测试用. */
export function signArtifactToken(
  app: FastifyInstance,
  device_id: string,
  version: string,
): string {
  return app.jwt.sign(
    { device_id, version, kind: "artifact" },
    { expiresIn: "30m" },
  );
}

/** 校验 artifact token. 不通过时抛错给路由层. */
export interface ArtifactTokenPayload {
  device_id: string;
  version: string;
  kind: "artifact";
}
export function verifyArtifactToken(
  app: FastifyInstance,
  token: string,
): ArtifactTokenPayload {
  const decoded = app.jwt.verify(token) as Record<string, unknown>;
  if (decoded.kind !== "artifact" || typeof decoded.device_id !== "string"
      || typeof decoded.version !== "string") {
    throw new Error("not an artifact token");
  }
  return {
    device_id: decoded.device_id,
    version: decoded.version,
    kind: "artifact",
  };
}

/** 把 agent_version 写入 devices.
 *  null / undefined / 非法格式直接跳过 (不报错, hello 主流程不能因为版本字段挂了). */
export async function persistAgentVersion(
  device_id: string,
  version: string | undefined | null,
): Promise<void> {
  if (!version || typeof version !== "string") return;
  if (!/^\d+\.\d+\.\d+$/.test(version)) return;
  try {
    await pool.query(
      `UPDATE "NinoGame".devices SET agent_version = $1 WHERE id = $2`,
      [version.slice(0, 16), device_id],
    );
  } catch {
    /* 版本字段挂了不影响 hello 主流程 */
  }
}

/** 给指定设备入队 update_self command (如果落后于 target 且没排过队).
 *  - 没设 target → 不做事 (服务端还没准备好)
 *  - 设备 agent_version 未知 → 假设落后, 推命令 (兼容首次升级场景)
 *  - 已经 ≥ target → 不做事
 *  - 已经有同 version 的 pending update_self 命令 → 不重复推
 *
 *  返回值: pushed=true 表示这次确实推了 / 入了队. */
export async function maybeQueueUpdateForDevice(
  app: FastifyInstance,
  device_id: string,
  current_version: string | null,
): Promise<{ pushed: boolean; reason: string }> {
  const target = await getTargetRelease();
  if (!target) return { pushed: false, reason: "no target release" };
  if (current_version && compareSemver(current_version, target.version) >= 0) {
    return { pushed: false, reason: "up to date" };
  }

  // 已有同版本的 pending update_self → 跳过 (Agent 重连 hello_ack 会拿到老的)
  const dup = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM "NinoGame".commands
      WHERE device_id = $1
        AND command_type = 'update_self'
        AND status IN ('pending', 'delivered')
        AND created_at > NOW() - INTERVAL '24 hours'
        AND (payload->>'version') = $2`,
    [device_id, target.version],
  );
  if (Number(dup.rows[0].count) > 0) {
    return { pushed: false, reason: "already queued" };
  }

  // 让存储驱动签 URL: local → 相对路径 /artifacts/?token=jwt; s3/oss → presigned URL.
  // 拼绝对 URL 让 local 驱动也能让 Agent 直连 (Agent 不可能跟 server 共享 host header).
  const storage = getStorage();
  const signed = await storage.signedUrl(
    target.filename,
    30 * 60, // 30 min
    { device_id, version: target.version },
  );
  const url = signed.startsWith("http")
    ? signed
    : `${config.publicBaseUrl}${signed}`;
  const payload = {
    version: target.version,
    url,
    sha256: target.sha256,
    size_bytes: Number(target.size_bytes),
  };

  // 落 commands 表 (走老的 pending → delivered 链路, 离线设备 hello_ack 也会拿到)
  await pool.query(
    `INSERT INTO "NinoGame".commands (device_id, command_type, payload, status)
     VALUES ($1, 'update_self', $2::jsonb, 'pending')`,
    [device_id, JSON.stringify(payload)],
  );

  // 在线 → 实时推 (不在线时不报错, 等 hello_ack 时随 pending 一起带过去)
  pushToDevice(device_id, {
    type: "command",
    payload: { command_type: "update_self", payload },
  });

  app.log.info(
    { device_id, from: current_version, to: target.version, url },
    "update_self command queued",
  );
  return { pushed: true, reason: "queued" };
}

/** sha256 计算 (上传时校验文件完整性用). */
export async function sha256OfFile(path: string): Promise<string> {
  const fs = await import("node:fs");
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
