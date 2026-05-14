import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Parent JWT claim 形状. v0.4.0+ 加 kind 字段, admin token 不能拿来调 parent API. */
export interface ParentClaim {
  sub: string;       // parent UUID
  username: string;
  /** v0.4.0+ 加, 老 token 没有这个字段 — 兼容处理: 没 kind 视为 parent (1 个版本过渡期). */
  kind?: "parent";
  iat?: number;
  exp?: number;
}

/** Admin JWT claim 形状. */
export interface AdminClaim {
  sub: string;       // admin UUID
  username: string;
  kind: "admin";
  iat?: number;
  exp?: number;
}

declare module "fastify" {
  interface FastifyRequest {
    parent?: ParentClaim;
    admin?: AdminClaim;
  }
}

/** 要求请求头携带合法家长 JWT, 解析后挂到 request.parent.
 *  admin token 调此 middleware 也会被拒 (kind=admin 时 401).
 *
 *  用法:
 *    app.get("/protected", { preHandler: app.parentAuth }, handler)
 */
export async function registerParentAuth(app: FastifyInstance) {
  app.decorate(
    "parentAuth",
    async function (req: FastifyRequest, reply: FastifyReply) {
      const header = req.headers["authorization"];
      if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) {
        return reply.unauthorized("缺少 Bearer token");
      }
      try {
        const claim = (await req.jwtVerify({ onlyCookie: false })) as ParentClaim & { kind?: string };
        // 兼容老 token (无 kind): 视为 parent. 老 token 自然过期后 (默认 7d)
        // 都会换成新形态。如果显式标了 admin/artifact, 一律拒绝。
        if (claim.kind && claim.kind !== "parent") {
          return reply.unauthorized("token 无效或过期");
        }
        req.parent = claim;
      } catch {
        return reply.unauthorized("token 无效或过期");
      }
    },
  );
}

/** 要求请求头携带合法 admin JWT (kind=admin), 解析后挂到 request.admin. */
export async function registerAdminAuth(app: FastifyInstance) {
  app.decorate(
    "adminAuth",
    async function (req: FastifyRequest, reply: FastifyReply) {
      const header = req.headers["authorization"];
      if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) {
        return reply.unauthorized("缺少 Bearer token");
      }
      try {
        const claim = (await req.jwtVerify({ onlyCookie: false })) as AdminClaim & { kind?: string };
        if (claim.kind !== "admin") {
          return reply.unauthorized("非 admin token");
        }
        req.admin = claim;
      } catch {
        return reply.unauthorized("token 无效或过期");
      }
    },
  );
}

declare module "fastify" {
  interface FastifyInstance {
    parentAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    adminAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
